// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredPoolTestBase} from "./helpers/FactoredPoolTestBase.sol";
import {FactoredPool} from "../src/FactoredPool.sol";
import {FactoredFunding} from "../src/FactoredFunding.sol";
import {FactoredPositions as P} from "../src/FactoredPositions.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";

contract FactoredPoolSettlementTest is FactoredPoolTestBase {
    function testCollateralPrecisionsPreserveAtomicPayouts() public {
        uint8[3] memory decimals = [uint8(0), 6, 18];
        for (uint256 i; i < decimals.length; i++) {
            MockCollateral asset = new MockCollateral(decimals[i]);
            uint128 unit = uint128(10 ** uint256(decimals[i]));
            uint8[] memory order = new uint8[](3);
            order[0] = 2;
            order[1] = 0;
            order[2] = 1;
            FactoredPool p = new FactoredPool(
                address(asset), 3, 100 * unit, uint64(block.timestamp + 100), order, address(this), RULES
            );
            asset.mint(address(this), 10000 * unit);
            asset.approve(address(p), type(uint256).max);
            p.fund();
            p.buy(1, 2, 10 * unit, 10 * unit, block.timestamp);
            assert(p.requiredCollateral() == 10 * unit);
            p.sell(1, 2, 5 * unit, 1, block.timestamp);
            vm.warp(p.closesAt());
            p.resolve(1);
            assert(p.redeem(1, 2, 5 * unit) == 5 * unit && p.requiredCollateral() == 0);
        }
    }

    function testRejectsMissingResolverAndRules() public {
        uint8[] memory order = new uint8[](2);
        order[1] = 1;
        try new FactoredPool(address(token), 2, 100e6, uint64(block.timestamp + 100), order, address(0), RULES) {
            revert("accepted missing resolver");
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FactoredFunding.InvalidConfiguration.selector);
        }
        try new FactoredPool(
            address(token), 2, 100e6, uint64(block.timestamp + 100), order, address(this), bytes32(0)
        ) {
            revert("accepted missing rules");
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FactoredFunding.InvalidConfiguration.selector);
        }
    }

    function testWinningLosingAndPartialRedemption() public {
        pool.fund();
        buy(ALICE, 1, 2, 20e6);
        buy(BOB, 3, 8, 10e6);
        buy(ALICE, 3, 14, 30e6);
        sell(ALICE, 1, 2, 5e6);
        assert(pool.requiredCollateral() == 55e6);
        vm.warp(pool.closesAt()); // A true, B false
        pool.resolve(1);
        assert(pool.requiredCollateral() == 45e6 && pool.settlementRulesHash() == RULES);
        assert(redeem(ALICE, 1, 2, 5e6) == 5e6);
        assert(redeem(BOB, 3, 8, 10e6) == 0);
        assert(redeem(ALICE, 3, 14, 30e6) == 30e6);
        assert(redeem(ALICE, 1, 2, 10e6) == 10e6);
        assert(pool.requiredCollateral() == 0);
        rejects(ALICE, abi.encodeCall(pool.redeem, (1, 2, 1)), P.InsufficientHoldings.selector);
    }

    function testResolutionAuthorityLifecycleAndInvalidRedemptions() public {
        rejects(address(this), abi.encodeCall(pool.resolve, (0)), FactoredFunding.NotFunded.selector);
        pool.fund();
        buy(ALICE, 1, 2, 10e6);
        rejects(ALICE, abi.encodeCall(pool.redeem, (1, 2, 1e6)), FactoredPool.NotResolved.selector);
        rejects(ALICE, abi.encodeCall(pool.resolve, (1)), FactoredPool.UnauthorizedResolver.selector);
        rejects(address(this), abi.encodeCall(pool.resolve, (1)), FactoredPool.NotClosed.selector);
        vm.warp(pool.closesAt());
        rejects(address(this), abi.encodeCall(pool.resolve, (4)), FactoredPool.InvalidOutcome.selector);
        pool.resolve(1);
        rejects(address(this), abi.encodeCall(pool.resolve, (0)), FactoredPool.AlreadyResolved.selector);
        rejects(ALICE, abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp)), FactoredFunding.Closed.selector);
        rejects(BOB, abi.encodeCall(pool.redeem, (1, 2, 1e6)), P.InsufficientHoldings.selector);
        rejects(ALICE, abi.encodeCall(pool.redeem, (1, 2, 0)), P.InvalidQuantity.selector);
        rejects(ALICE, abi.encodeCall(pool.redeem, (1, 3, 1)), P.InvalidClaim.selector);
    }

    function testRedemptionMayExceedPerTradeSize() public {
        pool.fund();
        buy(ALICE, 1, 2, 100e6);
        buy(ALICE, 1, 2, 100e6);
        vm.warp(pool.closesAt());
        pool.resolve(1);
        assert(redeem(ALICE, 1, 2, 200e6) == 200e6);
        assert(pool.requiredCollateral() == 0);
    }

    function testFuzzAllLocalMasksSettleExactly(uint8 outcomeSeed, uint8 maskSeed) public {
        uint32 outcome = outcomeSeed % 4;
        uint256 mask = 1 + uint256(maskSeed) % 14;
        pool.fund();
        buy(ALICE, 3, mask, 10e6);
        buy(BOB, 1, 2, 5e6);
        vm.warp(pool.closesAt());
        pool.resolve(outcome);
        uint128 expected = mask & (uint256(1) << outcome) != 0 ? 10e6 : 0;
        assert(redeem(ALICE, 3, mask, 10e6) == expected);
        assert(redeem(BOB, 1, 2, 5e6) == (outcome & 1 != 0 ? 5e6 : 0));
        assert(pool.requiredCollateral() == 0);
    }

    function testThirtyTwoEventHighBitLifecycle() public {
        uint8[] memory order = new uint8[](32);
        for (uint8 i; i < 32; i++) {
            order[i] = i;
        }
        FactoredPool large =
            new FactoredPool(address(token), 32, 100e6, uint64(block.timestamp + 100), order, address(this), RULES);
        token.approve(address(large), type(uint256).max);
        large.fund();
        large.buy(0x80008001, 128, 10e6, 10e6, block.timestamp);
        assert(large.requiredCollateral() == 10e6);
        vm.warp(large.closesAt());
        large.resolve(0x80008001);
        assert(large.redeem(0x80008001, 128, 10e6) == 10e6);
        assert(large.requiredCollateral() == 0);
    }
}
