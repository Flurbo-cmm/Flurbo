// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ReferencePool} from "../src/ReferencePool.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolTestBase} from "./helpers/PoolTestBase.sol";

contract ReferencePoolRedemptionAdversarialTest is PoolTestBase {
    function testRejectedPayoutsPreserveHoldingsLiabilitiesAndBalances() public {
        prepareResolution();
        for (uint8 mode = 1; mode <= 5; mode++) {
            if (mode == 4) continue;
            token.setMode(mode);
            bytes4 error = mode == 1
                ? SafeERC20.SafeERC20FailedOperation.selector
                : mode == 2 ? bytes4(keccak256("Error(string)")) : ReferencePool.UnsupportedTransfer.selector;
            rejects(ALICE, abi.encodeCall(pool.redeem, (8, 10e6)), error);
        }
        token.setMode(0);
        vm.prank(ALICE);
        assert(pool.redeem(8, 10e6) == 10e6);
        checkAccounting();
    }

    function testLosingBurnSkipsTokenTransfer() public {
        prepareResolution();
        token.setMode(2); // every token transfer would revert
        uint256 balance = token.balanceOf(address(pool));
        vm.prank(ALICE);
        assert(pool.redeem(1, 5e6) == 0);
        assert(token.balanceOf(address(pool)) == balance && pool.holdings(ALICE, 1) == 0);
        checkAccounting();
    }

    function testNoReturnPayoutWorks() public {
        prepareResolution();
        token.setMode(6);
        uint256 before_ = token.balanceOf(ALICE);
        vm.prank(ALICE);
        assert(pool.redeem(8, 10e6) == 10e6);
        assert(token.balanceOf(ALICE) == before_ + 10e6);
        checkAccounting();
    }

    function testPayoutCallbacksCannotReenterAnyMutation() public {
        prepareResolution();
        bytes[5] memory attempts = [
            abi.encodeCall(pool.redeem, (8, 1)),
            abi.encodeCall(pool.resolve, (0)),
            abi.encodeCall(pool.buy, (8, 1e6, 1e6, block.timestamp)),
            abi.encodeCall(pool.sell, (8, 1e6, 0, block.timestamp)),
            abi.encodeCall(pool.fund, ())
        ];
        for (uint256 i; i < attempts.length; i++) {
            token.setCallback(address(pool), attempts[i]);
            vm.prank(ALICE);
            assert(pool.redeem(8, 1e6) == 1e6);
            assert(!token.callbackSucceeded());
            assert(token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
            checkAccounting();
        }
        assert(pool.resolvedState() == 3 && pool.holdings(ALICE, 8) == 5e6);
    }

    function testShortfallBlocksFirstMoverWithoutBlockingResolution() public {
        pool.fund();
        buy(ALICE, 8, 10e6);
        buy(BOB, 10, 20e6);
        token.burn(address(pool), token.balanceOf(address(pool)) - 30e6 + 1);
        vm.warp(pool.closesAt());
        pool.resolve(3); // outcome finalization is independent of token solvency
        assert(pool.requiredCollateral() == 30e6);
        rejects(ALICE, abi.encodeCall(pool.redeem, (8, 1)), ReferencePool.UncoveredLiability.selector);
        rejects(BOB, abi.encodeCall(pool.redeem, (10, 1)), ReferencePool.UncoveredLiability.selector);
        token.transfer(address(pool), 1); // explicit donation restores full coverage
        vm.prank(ALICE);
        assert(pool.redeem(8, 10e6) == 10e6);
        assert(token.balanceOf(address(pool)) == 20e6 && pool.requiredCollateral() == 20e6);
        vm.prank(BOB);
        assert(pool.redeem(10, 20e6) == 20e6);
        assert(token.balanceOf(address(pool)) == 0);
        checkAccounting();
    }

    function prepareResolution() private {
        pool.fund();
        buy(ALICE, 8, 10e6);
        buy(ALICE, 1, 5e6);
        buy(BOB, 10, 20e6);
        vm.warp(pool.closesAt());
        pool.resolve(3);
    }
}
