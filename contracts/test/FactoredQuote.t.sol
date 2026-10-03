// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredQuote as Q} from "../src/FactoredQuote.sol";
import {FactoredCost as F} from "../src/FactoredCost.sol";
import {QuoteMath} from "../src/QuoteMath.sol";

contract FactoredQuoteHarness {
    function buy(Q.Market memory m, uint32 scope, uint256 mask, uint128 qty, uint128 limit)
        external
        pure
        returns (Q.Quote memory)
    {
        return Q.buy(m, scope, mask, qty, limit);
    }

    function sell(Q.Market memory m, uint32 scope, uint256 mask, uint128 qty, uint128 limit)
        external
        pure
        returns (Q.Quote memory)
    {
        return Q.sell(m, scope, mask, qty, limit);
    }
}

contract FactoredQuoteTest {
    FactoredQuoteHarness private harness = new FactoredQuoteHarness();

    function market(uint8 events) private pure returns (Q.Market memory m) {
        m.events = events;
        m.liquidity = 100e6;
        m.decimals = 6;
        m.factors = new Q.Factor[](0);
        m.order = new uint8[](events);
        for (uint8 i; i < events; i++) {
            m.order[i] = i;
        }
    }

    function testInclusiveLimitsAndFreshArrays() public {
        Q.Market memory m = market(2);
        m.factors = new Q.Factor[](1);
        m.factors[0] = factor(0, 1);
        m.factors[0].values[0] = 7e6;
        bytes32 before_ = keccak256(abi.encode(m));
        Q.Quote memory bought = Q.buy(m, 3, 8, 10e6, 2595302);
        assert(bought.collateral == 2595302 && bought.maxLiabilityAfter == 17e6);
        assert(keccak256(abi.encode(m)) == before_);
        bought.factorsAfter[0].values[0]++;
        assert(m.factors[0].values[0] == 7e6);
        bought.factorsAfter[0].values[0]--;
        rejects(abi.encodeCall(harness.buy, (m, 3, 8, 10e6, 2595301)), Q.MaxCostExceeded.selector);
        m.factors = bought.factorsAfter;
        Q.Quote memory sold = Q.sell(m, 3, 8, 10e6, 2595301);
        assert(sold.collateral == 2595301 && sold.maxLiabilityAfter == 7e6);
        assert(m.factors[1].values[3] == 10e6);
        rejects(abi.encodeCall(harness.sell, (m, 3, 8, 10e6, 2595302)), Q.MinProceedsNotMet.selector);
    }

    function testFuzzLocalBooleanRoundTrip(uint8 scopeSeed, uint8 maskSeed, uint128 quantitySeed) public pure {
        Q.Market memory m = market(3);
        uint32 scope = 1 + uint32(scopeSeed) % 7;
        uint256 size;
        for (uint32 s = scope; s != 0; s &= s - 1) {
            size++;
        }
        uint256 mask = 1 + uint256(maskSeed) % ((uint256(1) << (uint256(1) << size)) - 2);
        uint128 quantity = 1e6 + quantitySeed % (99e6 + 1);
        Q.Quote memory bought = Q.buy(m, scope, mask, quantity, quantity);
        assert(bought.maxLiabilityAfter == quantity && m.factors.length == 0);
        for (uint256 i; i < bought.factorsAfter[0].values.length; i++) {
            assert(bought.factorsAfter[0].values[i] == (mask & (uint256(1) << i) != 0 ? quantity : 0));
        }
        m.factors = bought.factorsAfter;
        Q.Quote memory sold = Q.sell(m, scope, mask, quantity, 1);
        assert(sold.maxLiabilityAfter == 0 && sold.factorsAfter.length == 1);
        assert(sold.collateral <= bought.collateral && bought.collateral - sold.collateral <= 2);
        for (uint256 i; i < sold.factorsAfter[0].values.length; i++) {
            assert(sold.factorsAfter[0].values[i] == 0);
        }
    }

    function testCapacityReuseAndExactScopeSelling() public {
        Q.Market memory m = market(2);
        m.factors = new Q.Factor[](64);
        for (uint256 i; i < 64; i++) {
            m.factors[i] = factor(i < 62 ? 0 : 1, i < 62 ? 1 : 2);
        }
        m.factors[62].values[1] = 5e6;
        m.factors[63].values[1] = 5e6;
        rejects(abi.encodeCall(harness.buy, (m, 2, 2, 1e6, 1e6)), F.TooManyFactors.selector);
        Q.Quote memory sold = Q.sell(m, 1, 2, 10e6, 1);
        assert(sold.factorsAfter.length == 63 && sold.maxLiabilityAfter == 0);
        m.factors = sold.factorsAfter;
        assert(Q.buy(m, 2, 2, 1e6, 1e6).factorsAfter.length == 64);
        m = market(2);
        m.factors = new Q.Factor[](1);
        m.factors[0] = factor(3, 4);
        for (uint256 i; i < 4; i++) {
            m.factors[0].values[i] = 10e6;
        }
        rejects(abi.encodeCall(harness.sell, (m, 1, 2, 1e6, 0)), Q.InsufficientLiability.selector);
    }

    function testRejectsInvalidClaimsDomainsAndUnquotableSizes() public {
        Q.Market memory m = market(2);
        for (uint256 mask; mask < 5; mask++) {
            if (mask == 1 || mask == 2) continue;
            rejects(abi.encodeCall(harness.buy, (m, 1, mask, 1e6, 1e6)), Q.InvalidMask.selector);
        }
        rejects(abi.encodeCall(harness.buy, (m, 0, 1, 1e6, 1e6)), F.InvalidScope.selector);
        rejects(abi.encodeCall(harness.buy, (m, 4, 2, 1e6, 1e6)), F.InvalidScope.selector);
        rejects(abi.encodeCall(harness.buy, (m, 1, 2, 0, 0)), Q.InvalidQuantity.selector);
        rejects(abi.encodeCall(harness.sell, (m, 1, 2, 100e6 + 1, 0)), Q.InvalidQuantity.selector);
        m.decimals = 19;
        rejects(abi.encodeCall(harness.buy, (m, 1, 2, 1, 1)), QuoteMath.UnsupportedDecimals.selector);
        m = market(2);
        m.factors = new Q.Factor[](1);
        m.factors[0] = factor(1, 2);
        m.factors[0].values[1] = 100 * m.liquidity;
        rejects(abi.encodeCall(harness.buy, (m, 1, 2, 1e6, 1e6)), F.InvalidValues.selector);
        m.factors[0].values[0] = 100 * m.liquidity + 1;
        rejects(abi.encodeCall(harness.sell, (m, 1, 2, 1e6, 0)), F.InvalidValues.selector);
        m = market(2);
        m.liquidity = 100e18;
        m.decimals = 18;
        rejects(abi.encodeCall(harness.buy, (m, 3, 8, 1, 1)), Q.UnquotableTrade.selector);
        m.factors = new Q.Factor[](1);
        m.factors[0] = factor(3, 4);
        m.factors[0].values[3] = 1;
        rejects(abi.encodeCall(harness.sell, (m, 3, 8, 1, 0)), QuoteMath.UnresolvedDirection.selector);
        m = market(2);
        m.factors = new Q.Factor[](1);
        m.factors[0] = factor(3, 4);
        for (uint256 i; i < 4; i++) {
            m.factors[0].values[i] = 1;
        }
        rejects(abi.encodeCall(harness.sell, (m, 3, 8, 1, 0)), Q.UnquotableTrade.selector);
    }

    function testThirtyTwoEventQuoteUsesHighAndNoncontiguousBits() public pure {
        Q.Market memory m = market(32);
        Q.Quote memory bought = Q.buy(m, 0x80008001, 128, 10e6, 10e6);
        assert(bought.maxLiabilityAfter == 10e6 && bought.factorsAfter[0].scope == 0x80008001);
        m.factors = bought.factorsAfter;
        Q.Quote memory sold = Q.sell(m, 0x80008001, 128, 10e6, 1);
        assert(sold.maxLiabilityAfter == 0);
        assert(sold.collateral <= bought.collateral && bought.collateral - sold.collateral <= 2);
    }

    function testProposedScopeMustPreserveWidth() public {
        Q.Market memory m = market(4);
        m.factors = new Q.Factor[](3);
        m.factors[0] = factor(3, 4);
        m.factors[1] = factor(5, 4);
        m.factors[2] = factor(9, 4);
        m.order[0] = 1;
        m.order[1] = 2;
        m.order[2] = 3;
        m.order[3] = 0;
        rejects(abi.encodeCall(harness.buy, (m, 14, 128, 1e6, 1e6)), F.WidthExceeded.selector);
        assert(Q.buy(m, 6, 8, 1e6, 1e6).maxLiabilityAfter == 1e6);
    }

    function factor(uint32 scope, uint256 count) private pure returns (Q.Factor memory) {
        return Q.Factor(scope, new uint128[](count));
    }

    function rejects(bytes memory data, bytes4 expected) private {
        (bool ok, bytes memory result) = address(harness).call(data);
        assert(!ok && result.length == 4 && bytes4(result) == expected);
    }
}
