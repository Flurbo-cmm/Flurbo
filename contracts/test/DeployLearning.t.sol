// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {DeployLearning} from "../script/DeployLearning.s.sol";
import {FundedFactoredPool as Pool} from "../src/FundedFactoredPool.sol";
import {FactoredQuote as Q} from "../src/FactoredQuote.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";

interface LearningTestVm {
    function chainId(uint256) external;
    function etch(address, bytes calldata) external;
    function warp(uint256) external;
    function prank(address) external;
}

// Exercise the deployment body without writing manifests or mutating process-global env in parallel tests.
contract LearningDeploymentHarness is DeployLearning {
    function writeManifest(Pool) internal override {}

    function execute(address operator, uint256 close) external returns (Pool) {
        return deploy(operator, close);
    }
}

contract DeployLearningTest {
    LearningTestVm private constant vm = LearningTestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    LearningDeploymentHarness script;
    MockCollateral token;
    address operator;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1_800_000_000);
        script = new LearningDeploymentHarness();
        operator = script.OPERATOR();
        MockCollateral implementation = new MockCollateral(6);
        vm.etch(script.AUSD(), address(implementation).code);
        token = MockCollateral(script.AUSD());
        token.mint(operator, 65_451_775);
    }

    function testExactDeploymentFundingAndEightEventUpdateLifecycle() public {
        Pool pool = script.execute(operator, 1_800_604_800);
        assert(pool.eventCount() == 8 && pool.liquidity() == 10e6);
        assert(pool.resolver() == operator && pool.updater() == operator);
        assert(pool.maxBiasMovement() == 2e6 && pool.epochFundingLimit() == 10e6);
        assert(pool.epochSeconds() == 3600 && pool.minUpdateInterval() == 60);
        assert(pool.requiredFunding() == 55_451_775 && pool.pricingReserve() == 55_451_775);
        assert(token.balanceOf(address(pool)) == 55_451_775 && token.balanceOf(operator) == 10e6);
        assert(token.allowance(operator, address(pool)) == 0);
        assert(pool.revision() == 0 && pool.factors().length == 0 && pool.biasFactors().length == 0);

        address trader = address(0xA11CE);
        token.mint(trader, 2e6);
        vm.prank(trader);
        token.approve(address(pool), 2e6);
        vm.prank(trader);
        uint128 paid = pool.buy(3, 8, 1e6, 1e6, block.timestamp + 60);
        Q.Factor[] memory bias = new Q.Factor[](1);
        uint128[] memory values = new uint128[](4);
        values[3] = 1e6;
        bias[0] = Q.Factor(3, values);
        uint128 oldQuote = pool.quoteBuy(3, 8, 1e6);
        vm.prank(operator);
        token.approve(address(pool), 1e6);
        Pool.Update memory update = Pool.Update(10143, address(pool), 1, block.timestamp + 60, 1e6, bias);
        vm.prank(operator);
        uint128 added = pool.updateBias(update);
        assert(added > 0 && added <= 1e6 && pool.quoteBuy(3, 8, 1e6) > oldQuote);
        assert(pool.holdings(trader, 3, 8) == 1e6);
        vm.prank(trader);
        uint128 proceeds = pool.sell(3, 8, 1e6, 0, block.timestamp + 60);
        assert(proceeds > paid && pool.holdings(trader, 3, 8) == 0);
        assert(pool.revision() == 3 && pool.actualRequiredCollateral() == 0);
        assert(token.balanceOf(address(pool)) >= pool.requiredCollateral());
    }

    function testRejectMainnetBeforeDeployment() public {
        vm.chainId(143);
        (bool ok,) = address(script).call(abi.encodeCall(script.execute, (operator, 1_800_604_800)));
        assert(!ok);
    }

    function testRejectWrongOperator() public {
        (bool ok,) = address(script).call(abi.encodeCall(script.execute, (address(1), 1_800_604_800)));
        assert(!ok);
    }

    function testRejectInsufficientFundingAndUpdateReserve() public {
        token.burn(operator, 1);
        (bool ok,) = address(script).call(abi.encodeCall(script.execute, (operator, 1_800_604_800)));
        assert(!ok && token.balanceOf(operator) == 65_451_774);
    }

    function testRejectCloseOutsideReviewWindow() public {
        (bool ok,) = address(script).call(abi.encodeCall(script.execute, (operator, 1_800_000_010)));
        assert(!ok);
        (ok,) = address(script).call(abi.encodeCall(script.execute, (operator, 1_803_000_000)));
        assert(!ok);
    }
}
