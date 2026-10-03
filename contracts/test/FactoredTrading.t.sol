// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredTrading} from "../src/FactoredTrading.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
import {FactoredVm} from "./FactoredFunding.t.sol";

contract TradingHarness is FactoredTrading {
    constructor(address token, uint64 close) FactoredTrading(token, 2, 100e6, close, permutation()) {}

    function permutation() private pure returns (uint8[] memory p) {
        p = new uint8[](2);
        p[1] = 1;
    }
}

contract FactoredTradingTest {
    FactoredVm constant vm = FactoredVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testOverlappingTradesEnforceOwnershipAndReprice() public {
        MockCollateral token = new MockCollateral(6);
        TradingHarness pool = new TradingHarness(address(token), uint64(block.timestamp + 100));
        token.mint(address(this), 1000e6);
        token.approve(address(pool), type(uint256).max);
        pool.fund();
        uint128 stale = pool.quoteBuy(3, 8, 10e6);
        pool.buy(1, 2, 20e6, 20e6, block.timestamp);
        assert(pool.quoteBuy(3, 8, 10e6) > stale);
        (bool ok,) = address(pool).call(abi.encodeCall(pool.buy, (3, 8, 10e6, stale, block.timestamp)));
        assert(!ok && pool.holdings(address(this), 3, 8) == 0);
        pool.buy(3, 8, 10e6, 10e6, block.timestamp);
        assert(pool.requiredCollateral() == 30e6);
        vm.prank(address(2));
        (ok,) = address(pool).call(abi.encodeCall(pool.sell, (1, 2, 1e6, 0, block.timestamp)));
        assert(!ok);
        pool.sell(1, 2, 5e6, 0, block.timestamp);
        assert(pool.holdings(address(this), 1, 2) == 15e6 && pool.requiredCollateral() == 25e6);
        assert(token.balanceOf(address(pool)) >= pool.requiredCollateral());
        vm.warp(block.timestamp + 1);
        (ok,) = address(pool).call(abi.encodeCall(pool.sell, (1, 2, 1e6, 0, block.timestamp - 1)));
        assert(!ok && pool.holdings(address(this), 1, 2) == 15e6);
        vm.warp(pool.closesAt());
        (ok,) = address(pool).call(abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp)));
        assert(!ok);
    }
}
