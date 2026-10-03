// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PoolTestBase, ReferencePool, MockCollateral} from "./helpers/PoolTestBase.sol";
import {BaseEventToken} from "../src/BaseEventToken.sol";
import {LmsrQuote} from "../src/LmsrQuote.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract BaseEventTokenTest is PoolTestBase {
    function testCanonicalMasksAndDecimalsAcrossAllSupportedClusters() public {
        for (uint8 count = 1; count <= 3; ++count) {
            uint8 decimals = count == 1 ? 0 : count == 2 ? 6 : 18;
            MockCollateral collateral = new MockCollateral(decimals);
            ReferencePool other = new ReferencePool(
                address(collateral),
                count,
                uint128(100 * 10 ** decimals),
                uint64(block.timestamp + 1 days),
                address(this),
                RULES_HASH
            );
            for (uint8 eventIndex; eventIndex < count; ++eventIndex) {
                BaseEventToken yes = other.createBaseToken(eventIndex, true);
                BaseEventToken no = other.createBaseToken(eventIndex, false);
                uint256 all = (uint256(1) << (uint256(1) << count)) - 1;
                assert(yes.mask() & no.mask() == 0 && yes.mask() | no.mask() == all);
                for (uint256 state; state < uint256(1) << count; ++state) {
                    assert(((yes.mask() >> state) & 1) == ((state >> eventIndex) & 1));
                }
                assert(yes.pool() == address(other) && no.pool() == address(other));
                assert(yes.decimals() == decimals && no.decimals() == decimals);
                assert(yes.totalSupply() == 0 && no.totalSupply() == 0);
                assert(address(other.baseTokens(yes.mask())) == address(yes));
                vm.prank(BOB);
                assert(address(other.createBaseToken(eventIndex, true)) == address(yes));
            }
        }
    }

    function testWrappingAndTransfersPreserveCashLiabilitiesAndQuotes() public {
        pool.fund();
        buy(ALICE, 10, 10e6);
        buy(BOB, 8, 4e6);
        BaseEventToken receipt = pool.createBaseToken(0, true);
        uint128 baseQuote = pool.quoteBuy(10, 1e6);
        uint128 jointQuote = pool.quoteBuy(8, 1e6);
        uint256 cash = token.balanceOf(address(pool));
        bytes32 liabilities = keccak256(abi.encode(pool.liabilities()));
        vm.prank(ALICE);
        pool.wrapBase(0, true, 6e6);
        assert(pool.holdings(ALICE, 10) == 4e6 && receipt.balanceOf(ALICE) == 6e6);
        vm.prank(ALICE);
        receipt.approve(address(this), 2e6);
        receipt.transferFrom(ALICE, BOB, 2e6);
        assert(receipt.allowance(ALICE, address(this)) == 0 && receipt.balanceOf(BOB) == 2e6);
        vm.prank(BOB);
        pool.unwrapBase(0, true, 1e6);
        assert(pool.holdings(BOB, 10) == 1e6 && receipt.balanceOf(BOB) == 1e6);
        assert(pool.quoteBuy(10, 1e6) == baseQuote && pool.quoteBuy(8, 1e6) == jointQuote);
        assert(token.balanceOf(address(pool)) == cash && keccak256(abi.encode(pool.liabilities())) == liabilities);
        checkBacking();
        // Selling restored claims uses the original pool cost function and decreases the same ledger.
        vm.prank(BOB);
        pool.sell(10, 1e6, 0, block.timestamp);
        checkBacking();
    }

    function testFuzzTransferUnwrapAndFinalPayout(uint8 seed, bool outcome, uint128 size) public {
        uint8 eventIndex = (seed / 4) % 2;
        uint8 state = seed % 4;
        uint128 quantity = 1000 + size % 50e6;
        pool.fund();
        BaseEventToken receipt = pool.createBaseToken(eventIndex, outcome);
        uint256 mask = receipt.mask();
        buy(ALICE, mask, quantity);
        vm.prank(ALICE);
        pool.wrapBase(eventIndex, outcome, quantity);
        checkBacking();
        uint128 bobUnits = quantity / 2;
        vm.prank(ALICE);
        receipt.transfer(BOB, bobUnits);
        checkBacking();
        vm.warp(pool.closesAt());
        // Unwrap remains possible during the gap between close and resolution.
        vm.prank(BOB);
        pool.unwrapBase(eventIndex, outcome, bobUnits);
        checkBacking();
        pool.resolve(state);
        uint256 aliceBefore = token.balanceOf(ALICE);
        uint256 bobBefore = token.balanceOf(BOB);
        bool wins = ((state & (uint8(1) << eventIndex)) != 0) == outcome;
        vm.prank(ALICE);
        pool.unwrapBase(eventIndex, outcome, quantity - bobUnits);
        vm.prank(ALICE);
        assert(pool.redeem(mask, quantity - bobUnits) == (wins ? quantity - bobUnits : 0));
        vm.prank(BOB);
        assert(pool.redeem(mask, bobUnits) == (wins ? bobUnits : 0));
        assert(token.balanceOf(ALICE) - aliceBefore == (wins ? quantity - bobUnits : 0));
        assert(token.balanceOf(BOB) - bobBefore == (wins ? bobUnits : 0));
        assert(receipt.totalSupply() == 0 && pool.requiredCollateral() == 0);
        checkBacking();
    }

    function testInvalidConversionsAndUnauthorizedMintBurnRollBack() public {
        pool.fund();
        buy(ALICE, 10, 10e6);
        BaseEventToken receipt = pool.createBaseToken(0, true);
        rejectConversion(
            ALICE, abi.encodeCall(pool.wrapBase, (0, true, 11e6)), ReferencePool.InsufficientHoldings.selector
        );
        rejectConversion(ALICE, abi.encodeCall(pool.wrapBase, (0, true, 0)), LmsrQuote.InvalidQuantity.selector);
        rejectConversion(
            ALICE, abi.encodeCall(pool.wrapBase, (0, false, 1)), ReferencePool.BaseTokenNotCreated.selector
        );
        rejectConversion(
            ALICE, abi.encodeCall(pool.unwrapBase, (1, true, 1)), ReferencePool.BaseTokenNotCreated.selector
        );
        rejectConversion(
            ALICE, abi.encodeCall(pool.createBaseToken, (2, true)), ReferencePool.InvalidBaseEvent.selector
        );
        rejectConversion(ALICE, abi.encodeCall(pool.wrapBase, (255, true, 1)), ReferencePool.InvalidBaseEvent.selector);
        vm.prank(ALICE);
        pool.wrapBase(0, true, 10e6);
        rejectConversion(ALICE, abi.encodeCall(pool.unwrapBase, (0, true, 0)), LmsrQuote.InvalidQuantity.selector);
        rejectConversion(
            BOB,
            abi.encodeCall(pool.unwrapBase, (0, true, 1)),
            bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)"))
        );
        (bool ok, bytes memory reason) = address(receipt).call(abi.encodeCall(receipt.mint, (BOB, 1)));
        assert(!ok && bytes4(reason) == BaseEventToken.OnlyPool.selector);
        (ok, reason) = address(receipt).call(abi.encodeCall(receipt.burn, (ALICE, 1)));
        assert(!ok && bytes4(reason) == BaseEventToken.OnlyPool.selector);
        assert(receipt.balanceOf(ALICE) == 10e6 && receipt.balanceOf(BOB) == 0);
        checkBacking();
    }

    function testEscrowedClaimsCannotBeSoldOrRedeemedTwice() public {
        pool.fund();
        buy(ALICE, 10, 10e6);
        pool.createBaseToken(0, true);
        vm.prank(ALICE);
        pool.wrapBase(0, true, 10e6);
        rejectConversion(
            ALICE, abi.encodeCall(pool.sell, (10, 1e6, 0, block.timestamp)), ReferencePool.InsufficientHoldings.selector
        );
        vm.warp(pool.closesAt());
        pool.resolve(1);
        rejectConversion(ALICE, abi.encodeCall(pool.redeem, (10, 1e6)), ReferencePool.InsufficientHoldings.selector);
        vm.prank(ALICE);
        pool.unwrapBase(0, true, 10e6);
        vm.prank(ALICE);
        assert(pool.redeem(10, 10e6) == 10e6);
        rejectConversion(ALICE, abi.encodeCall(pool.redeem, (10, 1)), ReferencePool.InsufficientHoldings.selector);
        checkBacking();
    }

    function testUnwrappingDuringShortfallCannotBypassPayoutCoverage() public {
        pool.fund();
        buy(ALICE, 10, 10e6);
        pool.createBaseToken(0, true);
        vm.prank(ALICE);
        pool.wrapBase(0, true, 10e6);
        token.burn(address(pool), token.balanceOf(address(pool)) - pool.requiredCollateral() + 1);
        vm.warp(pool.closesAt());
        pool.resolve(1);
        uint256 cash = token.balanceOf(address(pool));
        vm.prank(ALICE);
        pool.unwrapBase(0, true, 10e6);
        assert(token.balanceOf(address(pool)) == cash);
        rejectConversion(ALICE, abi.encodeCall(pool.redeem, (10, 10e6)), ReferencePool.UncoveredLiability.selector);
        token.mint(address(pool), 1);
        vm.prank(ALICE);
        assert(pool.redeem(10, 10e6) == 10e6);
        checkBacking();
    }

    function testCollateralCallbacksCannotReenterTokenization() public {
        pool.fund();
        bytes[3] memory calls = [
            abi.encodeCall(pool.createBaseToken, (0, true)),
            abi.encodeCall(pool.wrapBase, (0, true, 1)),
            abi.encodeCall(pool.unwrapBase, (0, true, 1))
        ];
        for (uint256 i; i < calls.length; ++i) {
            token.setCallback(address(pool), calls[i]);
            buy(ALICE, 10, 1e6);
            assert(!token.callbackSucceeded());
            assert(token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        }
    }

    function checkBacking() private view {
        uint128[] memory liabilities = pool.liabilities();
        for (uint256 state; state < liabilities.length; ++state) {
            uint256 expected;
            for (uint256 mask = 1; mask < 15; ++mask) {
                BaseEventToken receipt = pool.baseTokens(mask);
                uint256 escrow = address(receipt) == address(0) ? 0 : pool.holdings(address(receipt), mask);
                if (address(receipt) != address(0)) {
                    assert(receipt.totalSupply() == escrow);
                    assert(receipt.balanceOf(ALICE) + receipt.balanceOf(BOB) == escrow);
                }
                if (mask & (uint256(1) << state) != 0) {
                    expected += escrow + pool.holdings(ALICE, mask) + pool.holdings(BOB, mask);
                }
            }
            assert(liabilities[state] == expected);
        }
        assert(token.balanceOf(address(pool)) >= pool.requiredCollateral());
    }

    function rejectConversion(address caller, bytes memory data, bytes4 expected) private {
        bytes32 before_ = backingSnapshot();
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(pool).call(data);
        assert(!ok && bytes4(reason) == expected && backingSnapshot() == before_);
    }

    function backingSnapshot() private view returns (bytes32 hash) {
        hash = snapshot();
        for (uint256 mask = 1; mask < 15; ++mask) {
            BaseEventToken receipt = pool.baseTokens(mask);
            hash = keccak256(abi.encode(hash, receipt));
            if (address(receipt) != address(0)) {
                hash = keccak256(
                    abi.encode(
                        hash,
                        receipt.totalSupply(),
                        receipt.balanceOf(ALICE),
                        receipt.balanceOf(BOB),
                        pool.holdings(address(receipt), mask)
                    )
                );
            }
        }
    }
}
