// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredPoolTestBase, FactoredPool, MockCollateral, Q} from "./helpers/FactoredPoolTestBase.sol";
import {FactoredBaseToken} from "../src/FactoredBaseToken.sol";
import {FactoredFunding} from "../src/FactoredFunding.sol";
import {FactoredPositions as P} from "../src/FactoredPositions.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FactoredBaseTokenTest is FactoredPoolTestBase {
    function testIdentityPrecisionAndHighBitLifecycle() public {
        for (uint8 fixture; fixture < 3; fixture++) {
            uint8 count = fixture == 0 ? 1 : fixture == 1 ? 3 : 32;
            uint8 decimals = fixture == 0 ? 0 : fixture == 1 ? 6 : 18;
            uint128 unit = uint128(10 ** decimals);
            MockCollateral collateral = new MockCollateral(decimals);
            uint8[] memory order = new uint8[](count);
            for (uint8 i; i < count; i++) {
                order[i] = i;
            }
            FactoredPool other = new FactoredPool(
                address(collateral), count, 100 * unit, uint64(block.timestamp + 100), order, address(this), RULES
            );
            // First and final events exercise singleton clusters and the uint32 high bit.
            for (uint8 which; which < 2; which++) {
                uint8 index = which == 0 ? 0 : count - 1;
                FactoredBaseToken yes = other.createBaseToken(index, true);
                FactoredBaseToken no = other.createBaseToken(index, false);
                assert(yes.scope() == uint32(1) << index && no.scope() == yes.scope());
                assert(yes.mask() == 2 && no.mask() == 1);
                assert(yes.pool() == address(other) && no.pool() == address(other));
                assert(yes.decimals() == decimals && no.decimals() == decimals);
                assert(yes.totalSupply() == 0 && no.totalSupply() == 0 && !other.funded());
                assert(address(other.baseTokens(yes.scope(), 2)) == address(yes));
                assert(address(other.baseTokens(no.scope(), 1)) == address(no));
                vm.prank(BOB);
                assert(address(other.createBaseToken(index, true)) == address(yes));
            }
            collateral.mint(address(this), 10000 * unit);
            collateral.approve(address(other), type(uint256).max);
            other.fund();
            uint8 last = count - 1;
            uint32 scope = uint32(1) << last;
            FactoredBaseToken receipt = other.baseTokens(scope, 2);
            other.buy(scope, 2, 10 * unit, 10 * unit, block.timestamp);
            other.wrapBase(last, true, 10 * unit);
            assert(receipt.totalSupply() == other.holdings(address(receipt), scope, 2));
            receipt.transfer(BOB, 10 * unit);
            vm.warp(other.closesAt());
            other.resolve(scope);
            vm.prank(BOB);
            other.unwrapBase(last, true, 10 * unit);
            vm.prank(BOB);
            assert(other.redeem(scope, 2, 10 * unit) == 10 * unit);
            assert(collateral.balanceOf(BOB) == 10 * unit && other.requiredCollateral() == 0);
            assert(receipt.totalSupply() == 0 && other.holdings(address(receipt), scope, 2) == 0);
        }
    }

    function testConversionsPreserveQuotesCashAndLiabilities() public {
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
        buy(BOB, 3, 8, 4e6);
        FactoredBaseToken receipt = pool.createBaseToken(0, true);
        uint128 baseQuote = pool.quoteBuy(1, 2, 1e6);
        uint128 jointQuote = pool.quoteBuy(3, 8, 1e6);
        uint128 required = pool.requiredCollateral();
        uint256 cash = token.balanceOf(address(pool));
        bytes32 factors = keccak256(abi.encode(pool.factors()));
        vm.prank(ALICE);
        pool.wrapBase(0, true, 6e6);
        assert(pool.holdings(ALICE, 1, 2) == 4e6 && receipt.balanceOf(ALICE) == 6e6);
        vm.prank(ALICE);
        receipt.approve(address(this), 2e6);
        receipt.transferFrom(ALICE, BOB, 2e6);
        assert(receipt.allowance(ALICE, address(this)) == 0 && receipt.balanceOf(BOB) == 2e6);
        vm.prank(BOB);
        pool.unwrapBase(0, true, 1e6);
        assert(pool.holdings(BOB, 1, 2) == 1e6 && receipt.balanceOf(BOB) == 1e6);
        assert(pool.quoteBuy(1, 2, 1e6) == baseQuote && pool.quoteBuy(3, 8, 1e6) == jointQuote);
        assert(pool.requiredCollateral() == required && token.balanceOf(address(pool)) == cash);
        assert(keccak256(abi.encode(pool.factors())) == factors);
        checkBacking();
        vm.prank(BOB);
        pool.sell(1, 2, 1e6, 0, block.timestamp);
        checkBacking();
    }

    function testFuzzTransferUnwrapAndFinalPayout(uint8 seed, bool outcome, uint128 size) public {
        uint8 index = (seed / 4) % 2;
        uint32 state = seed % 4;
        uint128 quantity = 1000 + size % 50e6;
        pool.fund();
        FactoredBaseToken receipt = pool.createBaseToken(index, outcome);
        uint32 scope = receipt.scope();
        uint8 mask = receipt.mask();
        buy(ALICE, scope, mask, quantity);
        vm.prank(ALICE);
        pool.wrapBase(index, outcome, quantity);
        checkBacking();
        uint128 bobUnits = quantity / 2;
        vm.prank(ALICE);
        receipt.transfer(BOB, bobUnits);
        checkBacking();
        vm.warp(pool.closesAt());
        vm.prank(BOB);
        pool.unwrapBase(index, outcome, bobUnits);
        checkBacking();
        pool.resolve(state);
        uint256 aliceBefore = token.balanceOf(ALICE);
        uint256 bobBefore = token.balanceOf(BOB);
        bool wins = ((state & scope) != 0) == outcome;
        vm.prank(ALICE);
        pool.unwrapBase(index, outcome, quantity - bobUnits);
        vm.prank(ALICE);
        assert(pool.redeem(scope, mask, quantity - bobUnits) == (wins ? quantity - bobUnits : 0));
        vm.prank(BOB);
        assert(pool.redeem(scope, mask, bobUnits) == (wins ? bobUnits : 0));
        assert(token.balanceOf(ALICE) - aliceBefore == (wins ? quantity - bobUnits : 0));
        assert(token.balanceOf(BOB) - bobBefore == (wins ? bobUnits : 0));
        assert(receipt.totalSupply() == 0 && pool.requiredCollateral() == 0);
        checkBacking();
    }

    function testInvalidConversionsRollBack() public {
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
        pool.createBaseToken(0, true);
        rejectConversion(ALICE, abi.encodeCall(pool.wrapBase, (0, true, 11e6)), P.InsufficientHoldings.selector);
        rejectConversion(ALICE, abi.encodeCall(pool.wrapBase, (0, true, 0)), P.InvalidQuantity.selector);
        rejectConversion(ALICE, abi.encodeCall(pool.wrapBase, (0, false, 1)), FactoredPool.BaseTokenNotCreated.selector);
        rejectConversion(
            ALICE, abi.encodeCall(pool.unwrapBase, (1, true, 1)), FactoredPool.BaseTokenNotCreated.selector
        );
        uint8[3] memory invalid = [uint8(2), 32, 255];
        for (uint256 i; i < invalid.length; i++) {
            rejectConversion(
                ALICE, abi.encodeCall(pool.createBaseToken, (invalid[i], true)), FactoredPool.InvalidBaseEvent.selector
            );
            rejectConversion(
                ALICE, abi.encodeCall(pool.wrapBase, (invalid[i], true, 1)), FactoredPool.InvalidBaseEvent.selector
            );
            rejectConversion(
                ALICE, abi.encodeCall(pool.unwrapBase, (invalid[i], true, 1)), FactoredPool.InvalidBaseEvent.selector
            );
        }
        vm.prank(ALICE);
        pool.wrapBase(0, true, 10e6);
        rejectConversion(ALICE, abi.encodeCall(pool.unwrapBase, (0, true, 0)), P.InvalidQuantity.selector);
        bytes4 insufficient = bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)"));
        rejectConversion(BOB, abi.encodeCall(pool.unwrapBase, (0, true, 1)), insufficient);
        rejectConversion(ALICE, abi.encodeCall(pool.unwrapBase, (0, true, 10e6 + 1)), insufficient);
        checkBacking();
    }

    function testFactoryCannotGrantAuthorityOverCanonicalReceipts() public {
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
        FactoredBaseToken receipt = pool.createBaseToken(0, true);
        vm.prank(ALICE);
        pool.wrapBase(0, true, 10e6);
        bytes32 before_ = backingSnapshot();
        address[3] memory callers = [ALICE, address(this), address(pool.baseTokenFactory())];
        for (uint256 i; i < callers.length; i++) {
            vm.prank(callers[i]);
            (bool ok, bytes memory reason) = address(receipt).call(abi.encodeCall(receipt.mint, (BOB, 1)));
            assert(!ok && bytes4(reason) == FactoredBaseToken.OnlyPool.selector);
            vm.prank(callers[i]);
            (ok, reason) = address(receipt).call(abi.encodeCall(receipt.burn, (ALICE, 1)));
            assert(!ok && bytes4(reason) == FactoredBaseToken.OnlyPool.selector);
        }
        FactoredBaseToken lookalike = pool.baseTokenFactory().create(0, true, 6);
        assert(lookalike.pool() == address(this));
        lookalike.mint(BOB, 100e6);
        assert(address(pool.baseTokens(1, 2)) == address(receipt));
        rejectConversion(
            BOB,
            abi.encodeCall(pool.unwrapBase, (0, true, 1)),
            bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)"))
        );
        assert(backingSnapshot() == before_);
        checkBacking();
    }

    function testEscrowCannotBeSoldOrRedeemedTwice() public {
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
        pool.createBaseToken(0, true);
        vm.prank(ALICE);
        pool.wrapBase(0, true, 10e6);
        rejectConversion(
            ALICE, abi.encodeCall(pool.sell, (1, 2, 1e6, 0, block.timestamp)), P.InsufficientHoldings.selector
        );
        vm.warp(pool.closesAt());
        pool.resolve(1);
        rejectConversion(ALICE, abi.encodeCall(pool.redeem, (1, 2, 1e6)), P.InsufficientHoldings.selector);
        vm.prank(ALICE);
        pool.unwrapBase(0, true, 10e6);
        vm.prank(ALICE);
        assert(pool.redeem(1, 2, 10e6) == 10e6);
        rejectConversion(ALICE, abi.encodeCall(pool.redeem, (1, 2, 1)), P.InsufficientHoldings.selector);
        checkBacking();
    }

    function testUnwrapDuringShortfallCannotBypassCoverage() public {
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
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
        rejectConversion(ALICE, abi.encodeCall(pool.redeem, (1, 2, 10e6)), FactoredFunding.UncoveredLiability.selector);
        token.mint(address(pool), 1);
        vm.prank(ALICE);
        assert(pool.redeem(1, 2, 10e6) == 10e6);
        checkBacking();
    }

    function testCollateralCallbacksCannotReenterConversions() public {
        pool.fund();
        bytes[3] memory calls = [
            abi.encodeCall(pool.createBaseToken, (0, true)),
            abi.encodeCall(pool.wrapBase, (0, true, 1)),
            abi.encodeCall(pool.unwrapBase, (0, true, 1))
        ];
        for (uint256 i; i < calls.length; i++) {
            token.setCallback(address(pool), calls[i]);
            buy(ALICE, 1, 2, 1e6);
            assert(!token.callbackSucceeded());
            assert(token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        }
    }

    // Independent small-state oracle counts every internal holder, including escrow exactly once.
    function checkBacking() private view {
        Q.Factor[] memory factors = pool.factors();
        uint256 maximum;
        uint256 actual;
        for (uint256 state; state < 4; state++) {
            uint256 expected;
            for (uint32 scope = 1; scope <= 3; scope++) {
                for (uint256 mask = 1; mask < (scope == 3 ? 15 : 3); mask++) {
                    FactoredBaseToken receipt = pool.baseTokens(scope, uint8(mask));
                    uint256 escrow;
                    if (address(receipt) != address(0)) {
                        escrow = pool.holdings(address(receipt), scope, mask);
                        assert(receipt.totalSupply() == escrow);
                        assert(receipt.balanceOf(ALICE) + receipt.balanceOf(BOB) == escrow);
                    }
                    if (mask & (uint256(1) << local(scope, state)) != 0) {
                        expected += escrow + pool.holdings(ALICE, scope, mask) + pool.holdings(BOB, scope, mask)
                            + pool.holdings(address(this), scope, mask);
                    }
                }
            }
            uint256 observed;
            for (uint256 i; i < factors.length; i++) {
                observed += factors[i].values[local(factors[i].scope, state)];
            }
            assert(observed == expected);
            if (expected > maximum) maximum = expected;
            if (state == pool.resolvedState()) actual = expected;
        }
        assert(pool.requiredCollateral() == (pool.resolved() ? actual : maximum));
        assert(token.balanceOf(address(pool)) >= pool.requiredCollateral());
    }

    function rejectConversion(address caller, bytes memory data, bytes4 expected) private {
        bytes32 before_ = backingSnapshot();
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(pool).call(data);
        assert(!ok && reason.length >= 4 && bytes4(reason) == expected && backingSnapshot() == before_);
    }

    function backingSnapshot() private view returns (bytes32 hash) {
        hash = snapshot();
        for (uint32 scope = 1; scope <= 2; scope++) {
            for (uint8 mask = 1; mask <= 2; mask++) {
                FactoredBaseToken receipt = pool.baseTokens(scope, mask);
                hash = keccak256(abi.encode(hash, receipt));
                if (address(receipt) != address(0)) {
                    hash = keccak256(
                        abi.encode(
                            hash,
                            receipt.totalSupply(),
                            receipt.balanceOf(ALICE),
                            receipt.balanceOf(BOB),
                            pool.holdings(address(receipt), scope, mask)
                        )
                    );
                }
            }
        }
    }
}
