// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredFunding} from "../src/FactoredFunding.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";

interface FactoredVm {
    function prank(address) external;
    function warp(uint256) external;
}

contract FundingHarness is FactoredFunding {
    constructor(address token, uint64 close) FactoredFunding(token, 2, 100e6, close, permutation()) {}

    function permutation() private pure returns (uint8[] memory p) {
        p = new uint8[](2);
        p[1] = 1;
    }

    function checkCoverage(uint128 required) external {
        maximumLiability = required;
        requireCovered();
    }
}

contract FactoredFundingTest {
    FactoredVm constant vm = FactoredVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testFixedFundingAndExternalShortfall() public {
        MockCollateral token = new MockCollateral(6);
        FundingHarness pool = new FundingHarness(address(token), uint64(block.timestamp + 100));
        token.mint(address(this), 1000e6);
        token.approve(address(pool), type(uint256).max);
        token.transfer(address(pool), 1);
        assert(!pool.funded() && pool.requiredFunding() == 138629437);
        pool.fund();
        assert(token.balanceOf(address(pool)) == pool.requiredFunding() + 1);
        (bool ok,) = address(pool).call(abi.encodeCall(pool.fund, ()));
        assert(!ok);
        pool.checkCoverage(100e6);
        token.burn(address(pool), token.balanceOf(address(pool)) - 100e6 + 1);
        (ok,) = address(pool).call(abi.encodeCall(pool.checkCoverage, (100e6)));
        assert(!ok);
    }

    function testTransferFailuresAndCloseCannotActivatePool() public {
        MockCollateral token = new MockCollateral(6);
        FundingHarness pool = new FundingHarness(address(token), uint64(block.timestamp + 100));
        token.mint(address(this), 1000e6);
        token.approve(address(pool), 1000e6);
        for (uint8 mode = 1; mode <= 5; mode++) {
            if (mode == 4) continue;
            token.setMode(mode);
            (bool ok,) = address(pool).call(abi.encodeCall(pool.fund, ()));
            assert(!ok && !pool.funded() && token.balanceOf(address(pool)) == 0);
            assert(token.allowance(address(this), address(pool)) == 1000e6);
        }
        token.setMode(0);
        vm.warp(pool.closesAt());
        (bool closedOk,) = address(pool).call(abi.encodeCall(pool.fund, ()));
        assert(!closedOk && !pool.funded());
    }
}
