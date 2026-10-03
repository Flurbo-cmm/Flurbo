// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ReferencePool} from "../src/ReferencePool.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {PoolTestBase} from "./helpers/PoolTestBase.sol";

contract ReferencePoolAdversarialTest is PoolTestBase {
    function testMissingAllowanceAndWalletBalanceRollBack() public {
        pool.fund();
        vm.prank(ALICE);
        token.approve(address(pool), 0);
        rejects(
            ALICE,
            abi.encodeCall(pool.buy, (8, 10e6, 10e6, block.timestamp)),
            bytes4(keccak256("ERC20InsufficientAllowance(address,uint256,uint256)"))
        );
        vm.prank(ALICE);
        token.approve(address(pool), type(uint256).max);
        token.burn(ALICE, token.balanceOf(ALICE));
        rejects(
            ALICE,
            abi.encodeCall(pool.buy, (8, 10e6, 10e6, block.timestamp)),
            bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)"))
        );
    }

    function testRejectedFundingRollsBackActivation() public {
        for (uint8 mode = 1; mode <= 5; mode++) {
            if (mode == 4) continue;
            token.setMode(mode);
            rejects(address(this), abi.encodeCall(pool.fund, ()), transferError(mode));
            assert(!pool.funded());
        }
        token.setMode(0);
        pool.fund();
    }

    function testRejectedBuysAndSalesRollBackAllAccounting() public {
        pool.fund();
        buy(ALICE, 8, 20e6);
        // A finite allowance makes accidental allowance consumption observable.
        vm.prank(ALICE);
        token.approve(address(pool), 100e6);
        for (uint8 mode = 1; mode <= 5; mode++) {
            if (mode == 4) continue;
            token.setMode(mode);
            rejects(ALICE, abi.encodeCall(pool.buy, (8, 10e6, 10e6, block.timestamp)), transferError(mode));
            rejects(ALICE, abi.encodeCall(pool.sell, (8, 10e6, 0, block.timestamp)), transferError(mode));
        }
    }

    function testNoReturnTokenWithExactTransfersWorks() public {
        token.setMode(6);
        pool.fund();
        buy(ALICE, 8, 10e6);
        sell(ALICE, 8, 10e6);
    }

    function testCallbacksCannotReenterFundingOrTrading() public {
        token.setCallback(address(pool), abi.encodeCall(pool.fund, ()));
        pool.fund();
        checkCallback();
        token.setCallback(address(pool), abi.encodeCall(pool.sell, (8, 1e6, 0, block.timestamp)));
        buy(ALICE, 8, 20e6);
        checkCallback();
        token.setCallback(address(pool), abi.encodeCall(pool.buy, (8, 1e6, 1e6, block.timestamp)));
        sell(ALICE, 8, 10e6);
        checkCallback();
        assert(pool.holdings(address(token), 8) == 0 && pool.holdings(ALICE, 8) == 10e6);
    }

    function testExternalBalanceLossBlocksQuotesAndTrades() public {
        pool.fund();
        buy(ALICE, 8, 20e6);
        token.burn(address(pool), token.balanceOf(address(pool)) - pool.requiredCollateral() + 1);
        rejects(ALICE, abi.encodeCall(pool.quoteBuy, (8, 10e6)), ReferencePool.UncoveredLiability.selector);
        rejects(ALICE, abi.encodeCall(pool.quoteSell, (8, 10e6)), ReferencePool.UncoveredLiability.selector);
        rejects(
            ALICE, abi.encodeCall(pool.buy, (8, 10e6, 10e6, block.timestamp)), ReferencePool.UncoveredLiability.selector
        );
        rejects(
            ALICE, abi.encodeCall(pool.sell, (8, 10e6, 0, block.timestamp)), ReferencePool.UncoveredLiability.selector
        );
    }

    function checkCallback() private view {
        assert(!token.callbackSucceeded());
        assert(token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
    }

    function transferError(uint8 mode) private pure returns (bytes4) {
        if (mode == 1) return SafeERC20.SafeERC20FailedOperation.selector;
        if (mode == 2) return bytes4(keccak256("Error(string)"));
        return ReferencePool.UnsupportedTransfer.selector;
    }
}
