// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ReferencePool} from "../src/ReferencePool.sol";
import {LmsrQuote} from "../src/LmsrQuote.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
import {PoolTestBase} from "./helpers/PoolTestBase.sol";

contract ReferencePoolSettlementTest is PoolTestBase {
    event Resolved(uint8 indexed terminalState, bytes32 indexed rulesHash);
    event Redeemed(address indexed holder, uint256 indexed mask, uint128 quantity, uint128 collateralAmount);

    function testRejectsMissingResolverOrRules() public {
        try new ReferencePool(address(token), 2, 100e6, uint64(block.timestamp + 1), address(0), RULES_HASH) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == ReferencePool.InvalidConfiguration.selector);
        }
        try new ReferencePool(address(token), 2, 100e6, uint64(block.timestamp + 1), address(this), bytes32(0)) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == ReferencePool.InvalidConfiguration.selector);
        }
        assert(pool.resolver() == address(this) && pool.settlementRulesHash() == RULES_HASH);
    }

    function testResolutionRequiresFundingAuthorityCloseAndValidState() public {
        rejects(address(this), abi.encodeCall(pool.resolve, (0)), ReferencePool.NotFunded.selector);
        pool.fund();
        rejects(BOB, abi.encodeCall(pool.resolve, (0)), ReferencePool.UnauthorizedResolver.selector);
        vm.warp(pool.closesAt() - 1);
        rejects(address(this), abi.encodeCall(pool.resolve, (0)), ReferencePool.NotClosed.selector);
        vm.warp(pool.closesAt());
        rejects(address(this), abi.encodeCall(pool.resolve, (4)), ReferencePool.InvalidOutcome.selector);
        rejects(address(this), abi.encodeCall(pool.resolve, (255)), ReferencePool.InvalidOutcome.selector);
        rejects(BOB, abi.encodeCall(pool.resolve, (0)), ReferencePool.UnauthorizedResolver.selector);
        vm.expectEmit(true, true, false, true, address(pool));
        emit Resolved(0, RULES_HASH);
        pool.resolve(0); // zero is a valid final state, distinct from unresolved
        assert(pool.resolved() && pool.resolvedState() == 0);
        rejects(address(this), abi.encodeCall(pool.resolve, (0)), ReferencePool.AlreadyResolved.selector);
        rejects(address(this), abi.encodeCall(pool.resolve, (1)), ReferencePool.AlreadyResolved.selector);
    }

    function testCannotRedeemBeforeResolutionOrTradeAfterIt() public {
        rejects(ALICE, abi.encodeCall(pool.redeem, (8, 1e6)), ReferencePool.NotResolved.selector);
        pool.fund();
        buy(ALICE, 8, 10e6);
        rejects(ALICE, abi.encodeCall(pool.redeem, (8, 1e6)), ReferencePool.NotResolved.selector);
        vm.warp(pool.closesAt());
        rejects(ALICE, abi.encodeCall(pool.redeem, (8, 1e6)), ReferencePool.NotResolved.selector);
        pool.resolve(3);
        rejects(ALICE, abi.encodeCall(pool.buy, (8, 1e6, 1e6, block.timestamp)), ReferencePool.Closed.selector);
        rejects(ALICE, abi.encodeCall(pool.sell, (8, 1e6, 0, block.timestamp)), ReferencePool.Closed.selector);
        rejects(ALICE, abi.encodeCall(pool.quoteBuy, (8, 1e6)), ReferencePool.Closed.selector);
        rejects(ALICE, abi.encodeCall(pool.quoteSell, (8, 1e6)), ReferencePool.Closed.selector);
        rejects(address(this), abi.encodeCall(pool.fund, ()), ReferencePool.AlreadyFunded.selector);
    }

    function testOverlappingWinnersAndLosersPayExactlyAndBurnPartialHoldings() public {
        pool.fund();
        buy(ALICE, 10, 20e6); // A wins in state 1
        buy(BOB, 14, 30e6); // A OR B wins
        buy(BOB, 8, 40e6); // A AND B loses
        vm.warp(pool.closesAt());
        uint256 cashBefore = token.balanceOf(address(pool));
        pool.resolve(1);
        assert(token.balanceOf(address(pool)) == cashBefore && pool.requiredCollateral() == 50e6);
        redeem(ALICE, 10, 7e6, 7e6);
        assert(pool.holdings(ALICE, 10) == 13e6 && pool.requiredCollateral() == 43e6);
        redeem(BOB, 8, 40e6, 0);
        redeem(BOB, 14, 30e6, 30e6);
        redeem(ALICE, 10, 13e6, 13e6);
        assert(pool.requiredCollateral() == 0 && token.balanceOf(address(pool)) == cashBefore - 50e6);
        rejects(ALICE, abi.encodeCall(pool.redeem, (10, 1)), ReferencePool.InsufficientHoldings.selector);
        rejects(BOB, abi.encodeCall(pool.redeem, (8, 1)), ReferencePool.InsufficientHoldings.selector);
    }

    function testRedemptionChecksCanonicalMaskQuantityAndExactOwner() public {
        pool.fund();
        buy(ALICE, 10, 20e6);
        vm.warp(pool.closesAt());
        pool.resolve(3);
        uint256[4] memory invalid = [uint256(0), 15, 16, type(uint256).max];
        for (uint256 i; i < invalid.length; i++) {
            rejects(ALICE, abi.encodeCall(pool.redeem, (invalid[i], 1e6)), LmsrQuote.InvalidMask.selector);
        }
        rejects(ALICE, abi.encodeCall(pool.redeem, (10, 0)), LmsrQuote.InvalidQuantity.selector);
        rejects(ALICE, abi.encodeCall(pool.redeem, (10, 20e6 + 1)), ReferencePool.InsufficientHoldings.selector);
        rejects(BOB, abi.encodeCall(pool.redeem, (10, 1e6)), ReferencePool.InsufficientHoldings.selector);
        rejects(ALICE, abi.encodeCall(pool.redeem, (8, 1e6)), ReferencePool.InsufficientHoldings.selector);
    }

    function testRedeemCanExceedPerTradeLimit() public {
        pool.fund();
        buy(ALICE, 8, 100e6);
        buy(ALICE, 8, 100e6);
        vm.warp(pool.closesAt());
        pool.resolve(3);
        redeem(ALICE, 8, 200e6, 200e6);
    }

    function testResolvedReserveIgnoresImpossibleStates() public {
        pool.fund();
        buy(ALICE, 8, 100e6); // loses, remains unburned
        buy(BOB, 1, 10e6); // wins
        vm.warp(pool.closesAt());
        pool.resolve(0);
        assert(pool.requiredCollateral() == 10e6);
        // Exact winning reserve must suffice even if an impossible state's ledger is larger.
        token.burn(address(pool), token.balanceOf(address(pool)) - 10e6);
        redeem(BOB, 1, 10e6, 10e6);
        assert(token.balanceOf(address(pool)) == 0 && pool.requiredCollateral() == 0);
        assert(pool.liabilities()[3] == 100e6);
        redeem(ALICE, 8, 100e6, 0);
    }

    function testFuzzAllFourStateMasksRedeemInVaryingOrder(uint256 seed) public {
        pool.fund();
        for (uint256 mask = 1; mask < 15; mask++) {
            address owner = mask & 1 == 0 ? ALICE : BOB;
            buy(owner, mask, uint128(2e6 + uint256(keccak256(abi.encode(seed, mask))) % 8e6));
        }
        uint8 outcome = uint8(seed % 4);
        uint128 winningTotal = pool.liabilities()[outcome];
        uint256 cashBefore = token.balanceOf(address(pool));
        vm.warp(pool.closesAt());
        pool.resolve(outcome);
        for (uint256 i; i < 14; i++) {
            uint256 mask = 1 + (i + seed % 14) % 14;
            address owner = mask & 1 == 0 ? ALICE : BOB;
            uint128 quantity = pool.holdings(owner, mask);
            bool wins = mask & (uint256(1) << outcome) != 0;
            redeem(owner, mask, quantity / 2, wins ? quantity / 2 : 0);
            redeem(owner, mask, quantity - quantity / 2, wins ? quantity - quantity / 2 : 0);
        }
        assert(pool.requiredCollateral() == 0);
        assert(token.balanceOf(address(pool)) == cashBefore - winningTotal);
    }

    function testFuzzPayoutAcrossStateCountsAndDecimals(uint8 eventSeed, uint8 decimalSeed, uint8 outcomeSeed) public {
        uint8 events_ = 1 + eventSeed % 3;
        uint8[3] memory precisions = [uint8(0), 6, 18];
        uint128 unit = uint128(10 ** uint256(precisions[decimalSeed % 3]));
        MockCollateral t = new MockCollateral(precisions[decimalSeed % 3]);
        ReferencePool p =
            new ReferencePool(address(t), events_, 100 * unit, uint64(block.timestamp + 1), address(this), RULES_HASH);
        t.mint(address(this), 1000 * unit);
        t.approve(address(p), type(uint256).max);
        p.fund();
        uint8 outcome = uint8(uint256(outcomeSeed) % (uint256(1) << events_));
        uint256 winner = uint256(1) << outcome;
        uint256 loser = ((uint256(1) << (uint256(1) << events_)) - 1) ^ winner;
        p.buy(winner, 20 * unit, 20 * unit, block.timestamp);
        p.buy(loser, 20 * unit, 20 * unit, block.timestamp);
        vm.warp(p.closesAt());
        p.resolve(outcome);
        assert(p.requiredCollateral() == 20 * unit);
        uint256 before_ = t.balanceOf(address(this));
        assert(p.redeem(loser, 20 * unit) == 0);
        assert(p.redeem(winner, 20 * unit) == 20 * unit);
        assert(t.balanceOf(address(this)) == before_ + 20 * unit);
        assert(p.holdings(address(this), winner) == 0 && p.holdings(address(this), loser) == 0);
        uint128[] memory remaining = p.liabilities();
        for (uint256 i; i < remaining.length; i++) {
            assert(remaining[i] == 0);
        }
        assert(p.requiredCollateral() == 0);
    }

    function redeem(address owner, uint256 mask, uint128 quantity, uint128 expected) private {
        uint256 poolBefore = token.balanceOf(address(pool));
        uint256 ownerBefore = token.balanceOf(owner);
        vm.expectEmit(true, true, false, true, address(pool));
        emit Redeemed(owner, mask, quantity, expected);
        vm.prank(owner);
        assert(pool.redeem(mask, quantity) == expected);
        assert(token.balanceOf(address(pool)) == poolBefore - expected);
        assert(token.balanceOf(owner) == ownerBefore + expected);
        checkAccounting();
    }
}
