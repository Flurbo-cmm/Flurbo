// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredPoolTestBase} from "./helpers/FactoredPoolTestBase.sol";
import {FactoredPool} from "../src/FactoredPool.sol";
import {FactoredFunding} from "../src/FactoredFunding.sol";
import {FactoredTrading} from "../src/FactoredTrading.sol";
import {FactoredPositions as P} from "../src/FactoredPositions.sol";
import {FactoredQuote as Q} from "../src/FactoredQuote.sol";
import {FactoredCost as F} from "../src/FactoredCost.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FactoredPoolAdversarialTest is FactoredPoolTestBase {
    function testTransferFailuresRollbackBuysSalesAndRedemptions() public {
        pool.fund();
        buy(ALICE, 3, 8, 20e6);
        vm.prank(ALICE);
        token.approve(address(pool), 100e6);
        for (uint8 mode = 1; mode <= 5; mode++) {
            if (mode == 4) continue;
            token.setMode(mode);
            rejects(ALICE, abi.encodeCall(pool.buy, (3, 8, 10e6, 10e6, block.timestamp)), transferError(mode));
            rejects(ALICE, abi.encodeCall(pool.sell, (3, 8, 10e6, 0, block.timestamp)), transferError(mode));
        }
        token.setMode(0);
        vm.warp(pool.closesAt());
        pool.resolve(3);
        for (uint8 mode = 1; mode <= 5; mode++) {
            if (mode == 4) continue;
            token.setMode(mode);
            rejects(ALICE, abi.encodeCall(pool.redeem, (3, 8, 10e6)), transferError(mode));
        }
        token.setMode(0);
        assert(redeem(ALICE, 3, 8, 20e6) == 20e6);
    }

    function testCallbacksCannotReenterAnyMutation() public {
        token.setCallback(address(pool), abi.encodeCall(pool.fund, ()));
        pool.fund();
        checkCallback();
        token.setCallback(address(pool), abi.encodeCall(pool.sell, (3, 8, 1e6, 0, block.timestamp)));
        buy(ALICE, 3, 8, 20e6);
        checkCallback();
        token.setCallback(address(pool), abi.encodeCall(pool.buy, (3, 8, 1e6, 1e6, block.timestamp)));
        sell(ALICE, 3, 8, 5e6);
        checkCallback();
        token.setCallback(address(pool), abi.encodeCall(pool.resolve, (3)));
        buy(ALICE, 1, 2, 5e6);
        checkCallback();
        vm.warp(pool.closesAt());
        pool.resolve(3);
        token.setCallback(address(pool), abi.encodeCall(pool.redeem, (3, 8, 1e6)));
        redeem(ALICE, 3, 8, 15e6);
        checkCallback();
        assert(pool.holdings(address(token), 3, 8) == 0);
    }

    function testNoReturnCollateralAndLosingBurnWithoutTransfer() public {
        token.setMode(6);
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
        buy(BOB, 3, 8, 5e6);
        sell(ALICE, 1, 2, 5e6);
        vm.warp(pool.closesAt());
        pool.resolve(1);
        token.setMode(2); // Losing redemption must not attempt even a zero-value transfer.
        assert(redeem(BOB, 3, 8, 5e6) == 0);
        token.setMode(6);
        assert(redeem(ALICE, 1, 2, 5e6) == 5e6);
    }

    function testShortfallBlocksTradingAndFirstRedeemerUntilRestored() public {
        pool.fund();
        buy(ALICE, 1, 2, 20e6);
        buy(BOB, 3, 8, 10e6);
        token.burn(address(pool), token.balanceOf(address(pool)) - 30e6 + 1);
        rejects(ALICE, abi.encodeCall(pool.quoteBuy, (1, 2, 1e6)), FactoredFunding.UncoveredLiability.selector);
        rejects(ALICE, abi.encodeCall(pool.quoteSell, (1, 2, 1e6)), FactoredFunding.UncoveredLiability.selector);
        rejects(
            ALICE,
            abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp)),
            FactoredFunding.UncoveredLiability.selector
        );
        rejects(
            ALICE,
            abi.encodeCall(pool.sell, (1, 2, 1e6, 0, block.timestamp)),
            FactoredFunding.UncoveredLiability.selector
        );
        vm.warp(pool.closesAt());
        pool.resolve(3);
        rejects(ALICE, abi.encodeCall(pool.redeem, (1, 2, 1e6)), FactoredFunding.UncoveredLiability.selector);
        rejects(BOB, abi.encodeCall(pool.redeem, (3, 8, 1e6)), FactoredFunding.UncoveredLiability.selector);
        token.mint(address(pool), 1);
        redeem(ALICE, 1, 2, 20e6);
        redeem(BOB, 3, 8, 10e6);
        assert(token.balanceOf(address(pool)) == 0);
    }

    function testMissingApprovalBalancesAndSlippageRollback() public {
        pool.fund();
        buy(ALICE, 3, 8, 20e6);
        uint128 stale = pool.quoteSell(3, 8, 5e6);
        sell(ALICE, 3, 8, 5e6);
        rejects(ALICE, abi.encodeCall(pool.sell, (3, 8, 5e6, stale, block.timestamp)), Q.MinProceedsNotMet.selector);
        vm.prank(ALICE);
        token.approve(address(pool), 0);
        rejects(
            ALICE,
            abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp)),
            bytes4(keccak256("ERC20InsufficientAllowance(address,uint256,uint256)"))
        );
        vm.prank(ALICE);
        token.approve(address(pool), type(uint256).max);
        token.burn(ALICE, token.balanceOf(ALICE));
        rejects(
            ALICE,
            abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp)),
            bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)"))
        );
    }

    function testUnsupportedClaimCannotSpendFundsOrAlterHoldings() public {
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
        rejects(ALICE, abi.encodeCall(pool.buy, (4, 2, 1e6, 1e6, block.timestamp)), F.InvalidScope.selector);
        rejects(ALICE, abi.encodeCall(pool.buy, (1, 3, 1e6, 1e6, block.timestamp)), Q.InvalidMask.selector);
        rejects(ALICE, abi.encodeCall(pool.sell, (3, 10, 1e6, 0, block.timestamp)), P.InsufficientHoldings.selector);
        vm.warp(block.timestamp + 1);
        rejects(
            ALICE,
            abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp - 1)),
            FactoredTrading.ExpiredDeadline.selector
        );
    }

    function testFuzzMixedTradesMatchIndependentHoldings(uint256 seed) public {
        pool.fund();
        for (uint256 i; i < 6; i++) {
            uint256 choice = uint256(keccak256(abi.encode(seed, i)));
            address owner = choice & 1 == 0 ? ALICE : BOB;
            uint32 scope = uint32(1 + (choice >> 1) % 3);
            uint256 mask = 1 + (choice >> 3) % (scope == 3 ? 14 : 2);
            uint128 held = pool.holdings(owner, scope, mask);
            if (held != 0 && choice & 128 != 0) sell(owner, scope, mask, held);
            else buy(owner, scope, mask, 1e6 + uint128((choice >> 8) % 9e6));
        }
        // checkAccounting independently reconstructs every terminal liability from every owner's claims.
        checkAccounting();
    }

    function checkCallback() private view {
        assert(
            !token.callbackSucceeded() && token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
    }

    function transferError(uint8 mode) private pure returns (bytes4) {
        if (mode == 1) return SafeERC20.SafeERC20FailedOperation.selector;
        if (mode == 2) return bytes4(keccak256("Error(string)"));
        return FactoredFunding.UnsupportedTransfer.selector;
    }
}
