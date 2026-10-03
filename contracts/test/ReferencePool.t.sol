// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ReferencePool} from "../src/ReferencePool.sol";
import {LmsrQuote} from "../src/LmsrQuote.sol";
import {LmsrCost} from "../src/LmsrCost.sol";
import {QuoteMath} from "../src/QuoteMath.sol";
import {PoolTestBase} from "./helpers/PoolTestBase.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";

contract ReferencePoolTest is PoolTestBase {
    function testFixedFundingAndUnfundedRejections() public {
        rejects(ALICE, abi.encodeCall(pool.quoteBuy, (8, 10e6)), ReferencePool.NotFunded.selector);
        rejects(ALICE, abi.encodeCall(pool.buy, (8, 10e6, 10e6, block.timestamp)), ReferencePool.NotFunded.selector);
        // ceil(100 * ln(4) * 1e6), including the sub-atom cost error allowance.
        assert(pool.requiredFunding() == 138629437);
        uint256 before_ = token.balanceOf(address(this));
        pool.fund();
        assert(pool.funded() && pool.liquidity() == 100e6 && pool.collateralDecimals() == 6);
        assert(token.balanceOf(address(pool)) == pool.requiredFunding());
        assert(before_ - token.balanceOf(address(this)) == pool.requiredFunding());
        assert(pool.requiredCollateral() == 0);
        rejects(BOB, abi.encodeCall(pool.fund, ()), ReferencePool.AlreadyFunded.selector);
    }

    function testOverlappingClaimsAndPartialSalesShareCollateral() public {
        pool.fund();
        uint256 initial = token.balanceOf(address(pool));
        uint128 a = buy(ALICE, 10, 20e6); // A
        uint128 ab = buy(BOB, 8, 10e6); // A AND B
        uint128 either = buy(ALICE, 14, 30e6); // A OR B
        uint128[] memory q = pool.liabilities();
        assert(q[0] == 0 && q[1] == 50e6 && q[2] == 30e6 && q[3] == 60e6);
        uint128 returned = sell(ALICE, 10, 5e6);
        assert(pool.holdings(ALICE, 10) == 15e6 && pool.holdings(BOB, 8) == 10e6);
        assert(token.balanceOf(address(pool)) == initial + a + ab + either - returned);
        returned += sell(ALICE, 10, 15e6);
        returned += sell(BOB, 8, 10e6);
        returned += sell(ALICE, 14, 30e6);
        assert(pool.requiredCollateral() == 0);
        assert(token.balanceOf(address(pool)) == initial + a + ab + either - returned);
        assert(token.balanceOf(address(pool)) >= initial);
    }

    function testOwnershipCannotBeReplacedByAggregateLiability() public {
        pool.fund();
        buy(ALICE, 10, 20e6);
        rejects(
            BOB, abi.encodeCall(pool.sell, (10, 1e6, 0, block.timestamp)), ReferencePool.InsufficientHoldings.selector
        );
        rejects(
            ALICE, abi.encodeCall(pool.sell, (8, 1e6, 0, block.timestamp)), ReferencePool.InsufficientHoldings.selector
        );
        rejects(
            ALICE,
            abi.encodeCall(pool.sell, (10, 20e6 + 1, 0, block.timestamp)),
            ReferencePool.InsufficientHoldings.selector
        );
    }

    function testExecutionRepricesAndEnforcesBothSlippageLimits() public {
        pool.fund();
        uint128 stale = pool.quoteBuy(8, 10e6);
        buy(BOB, 8, 10e6);
        assert(pool.quoteBuy(8, 10e6) > stale);
        rejects(ALICE, abi.encodeCall(pool.buy, (8, 10e6, stale, block.timestamp)), LmsrQuote.MaxCostExceeded.selector);
        buy(ALICE, 8, 10e6);
        stale = pool.quoteSell(8, 10e6);
        sell(BOB, 8, 10e6);
        assert(pool.quoteSell(8, 10e6) < stale);
        rejects(
            ALICE, abi.encodeCall(pool.sell, (8, 10e6, stale, block.timestamp)), LmsrQuote.MinProceedsNotMet.selector
        );
        sell(ALICE, 8, 10e6);
    }

    function testDeadlineAndTradingClose() public {
        pool.fund();
        vm.warp(block.timestamp + 10);
        rejects(
            ALICE,
            abi.encodeCall(pool.buy, (8, 10e6, 10e6, block.timestamp - 1)),
            ReferencePool.ExpiredDeadline.selector
        );
        buy(ALICE, 8, 10e6); // deadline equal to current timestamp is valid
        rejects(
            ALICE, abi.encodeCall(pool.sell, (8, 10e6, 0, block.timestamp - 1)), ReferencePool.ExpiredDeadline.selector
        );
        vm.warp(pool.closesAt());
        rejects(ALICE, abi.encodeCall(pool.buy, (8, 10e6, 10e6, block.timestamp)), ReferencePool.Closed.selector);
        rejects(ALICE, abi.encodeCall(pool.sell, (8, 10e6, 0, block.timestamp)), ReferencePool.Closed.selector);
        rejects(ALICE, abi.encodeCall(pool.quoteBuy, (8, 10e6)), ReferencePool.Closed.selector);
        rejects(ALICE, abi.encodeCall(pool.quoteSell, (8, 10e6)), ReferencePool.Closed.selector);
    }

    function testClosedUnfundedPoolCannotBeFunded() public {
        vm.warp(pool.closesAt());
        rejects(address(this), abi.encodeCall(pool.fund, ()), ReferencePool.Closed.selector);
    }

    function testDonationsDoNotActivatePoolOrChangeLiquidity() public {
        token.transfer(address(pool), 1e6);
        assert(!pool.funded());
        pool.fund();
        assert(token.balanceOf(address(pool)) == pool.requiredFunding() + 1e6);
        assert(pool.liquidity() == 100e6);
    }

    function testInvalidConfigurationAndNumericalDomain() public {
        badConfiguration(address(0), 2, 100e6, uint64(block.timestamp + 1), ReferencePool.InvalidConfiguration.selector);
        badConfiguration(
            address(token), 0, 100e6, uint64(block.timestamp + 1), ReferencePool.InvalidConfiguration.selector
        );
        badConfiguration(
            address(token), 4, 100e6, uint64(block.timestamp + 1), ReferencePool.InvalidConfiguration.selector
        );
        badConfiguration(address(token), 2, 100e6, uint64(block.timestamp), ReferencePool.InvalidConfiguration.selector);
        badConfiguration(address(token), 2, 0, uint64(block.timestamp + 1), LmsrCost.InvalidLiquidity.selector);
        badConfiguration(
            address(new MockCollateral(19)),
            2,
            100e6,
            uint64(block.timestamp + 1),
            QuoteMath.UnsupportedDecimals.selector
        );
    }

    function testFuzzMixedTradesPreserveHoldingsAndCoverage(uint256 seed) public {
        pool.fund();
        for (uint256 i; i < 12; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address trader = seed & 1 == 0 ? ALICE : BOB;
            uint256 mask = 1 + ((seed >> 1) % 14);
            uint128 owned = pool.holdings(trader, mask);
            if (owned >= 2e6 && seed & 32 != 0) {
                sell(trader, mask, owned / 2 > 100e6 ? 100e6 : owned / 2);
            } else {
                buy(trader, mask, uint128(1e6 + ((seed >> 8) % 99e6)));
            }
        }
    }

    function testFuzzSupportedConfigurations(uint8 eventSeed, uint8 decimalSeed) public {
        uint8 events_ = 1 + eventSeed % 3;
        uint8[3] memory precisions = [uint8(0), 6, 18];
        uint8 decimals_ = precisions[decimalSeed % 3];
        uint128 unit = uint128(10 ** uint256(decimals_));
        MockCollateral otherToken = new MockCollateral(decimals_);
        ReferencePool other = new ReferencePool(
            address(otherToken), events_, 100 * unit, uint64(block.timestamp + 1), address(this), RULES_HASH
        );
        otherToken.mint(address(this), 1000 * unit);
        otherToken.approve(address(other), type(uint256).max);
        other.fund();
        uint128 quantity = 20 * unit;
        uint128 paid = other.buy(1, quantity, quantity, block.timestamp);
        uint128[] memory q = other.liabilities();
        assert(q.length == uint256(1) << events_ && q[0] == quantity);
        for (uint256 i = 1; i < q.length; i++) {
            assert(q[i] == 0);
        }
        assert(other.holdings(address(this), 1) == quantity);
        assert(otherToken.balanceOf(address(other)) >= other.requiredCollateral());
        uint128 received = other.sell(1, quantity, 0, block.timestamp);
        assert(received <= paid && other.requiredCollateral() == 0);
        assert(other.holdings(address(this), 1) == 0);
        assert(otherToken.balanceOf(address(other)) == other.requiredFunding() + paid - received);
    }

    function badConfiguration(address t, uint8 events_, uint128 b, uint64 close, bytes4 expected) private {
        try new ReferencePool(t, events_, b, close, address(this), RULES_HASH) {
            assert(false);
        } catch (bytes memory reason) {
            assert(reason.length >= 4 && bytes4(reason) == expected);
        }
    }
}
