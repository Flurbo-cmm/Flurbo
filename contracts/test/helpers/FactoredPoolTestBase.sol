// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredPool} from "../../src/FactoredPool.sol";
import {FactoredQuote as Q} from "../../src/FactoredQuote.sol";
import {MockCollateral} from "./MockCollateral.sol";
import {FactoredVm} from "../FactoredFunding.t.sol";

abstract contract FactoredPoolTestBase {
    FactoredVm internal constant vm = FactoredVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    bytes32 internal constant RULES =
        keccak256("Synthetic factored cluster: event i is bit i; trusted final outcome after close; no cancellation.");
    MockCollateral internal token;
    FactoredPool internal pool;

    function setUp() public {
        token = new MockCollateral(6);
        uint8[] memory order = new uint8[](2);
        order[1] = 1;
        pool = new FactoredPool(address(token), 2, 100e6, uint64(block.timestamp + 1 days), order, address(this), RULES);
        prepare(address(this));
        prepare(ALICE);
        prepare(BOB);
    }

    function prepare(address owner) internal {
        token.mint(owner, 10000e6);
        vm.prank(owner);
        token.approve(address(pool), type(uint256).max);
    }

    function buy(address owner, uint32 scope, uint256 mask, uint128 qty) internal returns (uint128 paid) {
        uint128 limit = pool.quoteBuy(scope, mask, qty);
        vm.prank(owner);
        paid = pool.buy(scope, mask, qty, limit, block.timestamp);
        assert(paid == limit);
        checkAccounting();
    }

    function sell(address owner, uint32 scope, uint256 mask, uint128 qty) internal returns (uint128 paid) {
        uint128 limit = pool.quoteSell(scope, mask, qty);
        vm.prank(owner);
        paid = pool.sell(scope, mask, qty, limit, block.timestamp);
        assert(paid == limit);
        checkAccounting();
    }

    function redeem(address owner, uint32 scope, uint256 mask, uint128 qty) internal returns (uint128 paid) {
        vm.prank(owner);
        paid = pool.redeem(scope, mask, qty);
        checkAccounting();
    }

    function local(uint32 scope, uint256 state) internal pure returns (uint256 result) {
        uint256 bit;
        for (uint256 event_; event_ < 2; event_++) {
            if (scope & (uint256(1) << event_) != 0) result |= ((state >> event_) & 1) << bit++;
        }
    }

    function checkAccounting() internal view {
        Q.Factor[] memory factors = pool.factors();
        uint256 maximum;
        uint256 actual;
        for (uint256 state; state < 4; state++) {
            uint256 expected;
            for (uint32 scope = 1; scope <= 3; scope++) {
                uint256 full = scope == 3 ? 15 : 3;
                for (uint256 mask = 1; mask < full; mask++) {
                    if (mask & (uint256(1) << local(scope, state)) != 0) {
                        expected += pool.holdings(ALICE, scope, mask) + pool.holdings(BOB, scope, mask)
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

    function snapshot() internal view returns (bytes32 hash) {
        hash = keccak256(
            abi.encode(
                pool.funded(),
                pool.resolved(),
                pool.resolvedState(),
                pool.requiredCollateral(),
                pool.factors(),
                token.balanceOf(address(pool)),
                token.totalSupply()
            )
        );
        address[3] memory owners = [ALICE, BOB, address(this)];
        for (uint256 i; i < owners.length; i++) {
            hash = keccak256(abi.encode(hash, token.balanceOf(owners[i]), token.allowance(owners[i], address(pool))));
            for (uint32 scope = 1; scope <= 3; scope++) {
                for (uint256 mask = 1; mask < (scope == 3 ? 15 : 3); mask++) {
                    hash = keccak256(abi.encode(hash, pool.holdings(owners[i], scope, mask)));
                }
            }
        }
    }

    function rejects(address owner, bytes memory data, bytes4 expected) internal {
        bytes32 before_ = snapshot();
        vm.prank(owner);
        (bool ok, bytes memory result) = address(pool).call(data);
        assert(!ok && result.length >= 4 && bytes4(result) == expected);
        assert(snapshot() == before_);
    }
}
