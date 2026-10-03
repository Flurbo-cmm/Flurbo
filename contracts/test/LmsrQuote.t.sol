// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {LmsrQuote} from "../src/LmsrQuote.sol";
import {LmsrCost} from "../src/LmsrCost.sol";
import {QuoteMath} from "../src/QuoteMath.sol";

contract LmsrQuoteHarness {
    function buy(LmsrQuote.Market memory market, uint256 mask, uint128 quantity, uint128 limit)
        external
        pure
        returns (LmsrQuote.Quote memory)
    {
        return LmsrQuote.buy(market, mask, quantity, limit);
    }

    function sell(LmsrQuote.Market memory market, uint256 mask, uint128 quantity, uint128 limit)
        external
        pure
        returns (LmsrQuote.Quote memory)
    {
        return LmsrQuote.sell(market, mask, quantity, limit);
    }
}

contract LmsrQuoteTest {
    LmsrQuoteHarness private harness = new LmsrQuoteHarness();

    function market() private pure returns (LmsrQuote.Market memory) {
        return LmsrQuote.Market(new uint128[](4), 100e6, 6);
    }

    function testLimitsAreInclusiveAndSimulationDoesNotMutateInput() public {
        LmsrQuote.Market memory m = market();
        bytes32 initial = keccak256(abi.encode(m));
        LmsrQuote.Quote memory bought = LmsrQuote.buy(m, 8, 10e6, 2595302);
        assert(bought.collateral == 2595302);
        assert(bought.liabilitiesAfter[3] == 10e6 && bought.liabilitiesAfter[0] == 0);
        assert(keccak256(abi.encode(m)) == initial);
        rejects(abi.encodeCall(harness.buy, (m, 8, 10e6, 2595301)), LmsrQuote.MaxCostExceeded.selector);
        m.liabilities = bought.liabilitiesAfter;
        initial = keccak256(abi.encode(m));
        LmsrQuote.Quote memory sold = LmsrQuote.sell(m, 8, 10e6, 2595301);
        assert(sold.collateral == 2595301 && sold.liabilitiesAfter[3] == 0);
        assert(keccak256(abi.encode(m)) == initial);
        rejects(abi.encodeCall(harness.sell, (m, 8, 10e6, 2595302)), LmsrQuote.MinProceedsNotMet.selector);
    }

    function testRejectsInvalidMasksQuantitiesAndDecimals() public {
        LmsrQuote.Market memory m = market();
        uint256[4] memory masks = [uint256(0), 15, 16, type(uint256).max];
        for (uint256 i; i < masks.length; i++) {
            rejects(abi.encodeCall(harness.buy, (m, masks[i], 1e6, type(uint128).max)), LmsrQuote.InvalidMask.selector);
        }
        rejects(abi.encodeCall(harness.buy, (m, 8, 0, type(uint128).max)), LmsrQuote.InvalidQuantity.selector);
        rejects(abi.encodeCall(harness.sell, (m, 8, 100e6 + 1, 0)), LmsrQuote.InvalidQuantity.selector);
        m.decimals = 19;
        rejects(abi.encodeCall(harness.buy, (m, 8, 1, type(uint128).max)), QuoteMath.UnsupportedDecimals.selector);
    }

    function testRejectsUnsupportedStatesAndLiabilityChanges() public {
        LmsrQuote.Market memory m = market();
        rejects(abi.encodeCall(harness.sell, (m, 8, 1e6, 0)), LmsrQuote.InsufficientLiability.selector);
        m.liabilities[3] = 100 * m.liquidity;
        rejects(abi.encodeCall(harness.buy, (m, 8, 1, type(uint128).max)), LmsrCost.LiabilityOutOfRange.selector);
        m.liabilities[0] = 100 * m.liquidity + 1; // invalid even though not selected
        rejects(abi.encodeCall(harness.sell, (m, 8, 1, 0)), LmsrCost.LiabilityOutOfRange.selector);
        m.liabilities = new uint128[](3);
        rejects(abi.encodeCall(harness.buy, (m, 1, 1, type(uint128).max)), LmsrCost.InvalidStateCount.selector);
        m = market();
        m.decimals = 18; // b = 1e-10 tokens, below supported cost domain
        rejects(abi.encodeCall(harness.buy, (m, 8, 1, type(uint128).max)), LmsrCost.InvalidLiquidity.selector);
    }

    function testRejectsUnresolvedAndZeroPayoutTrades() public {
        LmsrQuote.Market memory m = market();
        m.liquidity = 100e18;
        m.decimals = 18;
        rejects(abi.encodeCall(harness.buy, (m, 8, 1, type(uint128).max)), LmsrQuote.UnquotableTrade.selector);
        m.liabilities[3] = 1;
        rejects(abi.encodeCall(harness.sell, (m, 8, 1, 0)), QuoteMath.UnresolvedDirection.selector);
        m = market();
        for (uint256 i; i < 4; i++) {
            m.liabilities[i] = 1;
        }
        rejects(abi.encodeCall(harness.sell, (m, 8, 1, 0)), LmsrQuote.UnquotableTrade.selector);
    }

    function testFuzzBuySellRoundTrip(uint8 eventSeed, uint8 maskSeed, uint128 quantitySeed) public pure {
        uint256 n = 2 ** (1 + eventSeed % 3);
        uint256 mask = 1 + uint256(maskSeed) % ((uint256(1) << n) - 2);
        uint128 quantity = 1e6 + quantitySeed % (99e6 + 1);
        LmsrQuote.Market memory m = LmsrQuote.Market(new uint128[](n), 100e6, 6);
        LmsrQuote.Quote memory bought = LmsrQuote.buy(m, mask, quantity, quantity);
        for (uint256 i; i < n; i++) {
            assert(m.liabilities[i] == 0);
            assert(bought.liabilitiesAfter[i] == (mask & (uint256(1) << i) != 0 ? quantity : 0));
        }
        m.liabilities = bought.liabilitiesAfter;
        LmsrQuote.Quote memory sold = LmsrQuote.sell(m, mask, quantity, 1);
        assert(sold.collateral <= bought.collateral && bought.collateral - sold.collateral <= 2);
        for (uint256 i; i < n; i++) {
            assert(sold.liabilitiesAfter[i] == 0);
        }
    }

    function rejects(bytes memory data, bytes4 expected) private {
        (bool ok, bytes memory result) = address(harness).call(data);
        assert(!ok && result.length == 4 && bytes4(result) == expected);
    }
}
