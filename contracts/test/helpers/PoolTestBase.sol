// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ReferencePool} from "../../src/ReferencePool.sol";
import {MockCollateral} from "./MockCollateral.sol";

interface PoolVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function expectEmit(bool topic1, bool topic2, bool topic3, bool data, address emitter) external;
}

abstract contract PoolTestBase {
    PoolVm internal constant vm = PoolVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant RULES_HASH = keccak256(
        "Flurbo reference rules v1: event i is bit i; outcomes are test inputs supplied by the fixed resolver after close; binary only; final once; no cancellation."
    );
    MockCollateral internal token;
    ReferencePool internal pool;

    function setUp() public {
        token = new MockCollateral(6);
        pool = new ReferencePool(address(token), 2, 100e6, uint64(block.timestamp + 1 days), address(this), RULES_HASH);
        prepare(address(this));
        prepare(ALICE);
        prepare(BOB);
    }

    function prepare(address trader) internal {
        token.mint(trader, 10_000e6);
        vm.prank(trader);
        token.approve(address(pool), type(uint256).max);
    }

    function buy(address trader, uint256 mask, uint128 quantity) internal returns (uint128 cost) {
        cost = pool.quoteBuy(mask, quantity);
        vm.prank(trader);
        assert(pool.buy(mask, quantity, cost, block.timestamp) == cost);
        checkAccounting();
    }

    function sell(address trader, uint256 mask, uint128 quantity) internal returns (uint128 proceeds) {
        proceeds = pool.quoteSell(mask, quantity);
        vm.prank(trader);
        assert(pool.sell(mask, quantity, proceeds, block.timestamp) == proceeds);
        checkAccounting();
    }

    // Independent reconstruction from each trader's holdings, including overlapping masks.
    function checkAccounting() internal view {
        uint128[] memory q = pool.liabilities();
        uint256 maximum;
        for (uint256 state; state < q.length; state++) {
            uint256 expected;
            for (uint256 mask = 1; mask < (uint256(1) << q.length) - 1; mask++) {
                if (mask & (uint256(1) << state) != 0) {
                    expected += pool.holdings(ALICE, mask) + pool.holdings(BOB, mask)
                    + pool.holdings(address(this), mask);
                }
            }
            assert(q[state] == expected);
            if (expected > maximum) maximum = expected;
        }
        uint256 required = pool.resolved() ? q[pool.resolvedState()] : maximum;
        assert(pool.requiredCollateral() == required);
        assert(token.balanceOf(address(pool)) >= required);
    }

    function snapshot() internal view returns (bytes32 hash) {
        hash = keccak256(
            abi.encode(
                pool.funded(),
                pool.resolved(),
                pool.resolvedState(),
                pool.liabilities(),
                token.balanceOf(address(pool)),
                token.totalSupply()
            )
        );
        address[3] memory traders = [ALICE, BOB, address(this)];
        for (uint256 i; i < traders.length; i++) {
            hash = keccak256(abi.encode(hash, token.balanceOf(traders[i]), token.allowance(traders[i], address(pool))));
            for (uint256 mask = 1; mask < 15; mask++) {
                hash = keccak256(abi.encode(hash, pool.holdings(traders[i], mask)));
            }
        }
    }

    function rejects(address trader, bytes memory data, bytes4 expected) internal {
        bytes32 before_ = snapshot();
        vm.prank(trader);
        (bool ok, bytes memory result) = address(pool).call(data);
        assert(!ok && result.length >= 4 && bytes4(result) == expected);
        assert(snapshot() == before_);
    }
}
