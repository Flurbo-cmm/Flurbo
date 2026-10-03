// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "../script/DeployPilot.s.sol";
import {PilotResolver as R} from "../src/PilotResolver.sol";
import {PilotPool} from "../src/PilotPool.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";

interface PilotScriptVm { function chainId(uint256) external; function warp(uint256) external; function etch(address, bytes calldata) external; }
contract PilotDeploymentHarness is DeployPilot {
    function execute(address owner, R.Config memory c) external returns (PilotPool, R) { return deploy(owner,c,10e6); }
    function executeWith(address owner, R.Config memory c, uint256 liquidity) external returns (PilotPool, R) { return deploy(owner,c,liquidity); }
    function writeManifest(PilotPool, R) internal override {}
}
contract DeployPilotTest {
    PilotScriptVm constant vm = PilotScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PilotDeploymentHarness script;
    MockCollateral cash;
    address constant OWNER = address(0xA11CE);
    function setUp() public {
        vm.chainId(10143); vm.warp(1000);
        script = new PilotDeploymentHarness();
        MockCollateral implementation = new MockCollateral(6);
        vm.etch(script.AUSD(), address(implementation).code);
        cash=MockCollateral(script.AUSD()); cash.mint(OWNER,100e6);
    }
    function config() internal view returns(R.Config memory c) {
        c.collateral=address(cash); c.draftHash=keccak256("fixture"); c.closesAt=10000;
        c.eventHashes=new bytes32[](2); c.eventHashes[0]=bytes32(uint256(1)); c.eventHashes[1]=bytes32(uint256(2));
        c.observationEnds=new uint64[](2); c.observationEnds[0]=20000; c.observationEnds[1]=30000;
        c.reviewers=new address[](3); c.reviewers[0]=address(100); c.reviewers[1]=address(101); c.reviewers[2]=address(102);
        c.bond=1e6; c.assertionPeriod=86400; c.challengePeriod=86400; c.votingPeriod=86400;
    }
    function testBoundFundedCanonicalReceipts() public {
        (PilotPool pool,R resolver)=script.execute(OWNER,config());
        assert(address(resolver.pool())==address(pool) && resolver.creator()==OWNER);
        assert(pool.resolver()==address(resolver) && pool.settlementRulesHash()==resolver.rulesHash());
        assert(pool.funded() && pool.liquidity()==10e6 && pool.requiredFunding()==13_862_944);
        assert(cash.balanceOf(address(pool))==pool.requiredFunding() && cash.allowance(OWNER,address(pool))==0);
        assert(address(pool.baseTokens(1,2))!=address(0) && address(pool.baseTokens(2,2))!=address(0));
    }
    function testDeeperPoolFromPreparedLiquidity() public {
        cash.mint(OWNER,400e6);
        (PilotPool pool,)=script.executeWith(OWNER,config(),250e6);
        // Funding is ceil(2 * 250 * ln 2) test AUSD, rounded up by the pool; allow one atom per event.
        assert(pool.funded() && pool.liquidity()==250e6);
        assert(pool.requiredFunding()>=346_573_591 && pool.requiredFunding()<=346_573_593);
        assert(cash.balanceOf(address(pool))==pool.requiredFunding() && cash.allowance(OWNER,address(pool))==0);
    }
    function testRejectLiquidityOutOfRange() public {
        try script.executeWith(OWNER,config(),5e6) { assert(false); } catch Error(string memory reason) { assert(keccak256(bytes(reason))==keccak256("prepared liquidity out of range")); }
    }
    function testRejectWrongNetworkAndStaleWindow() public {
        vm.chainId(143); (bool ok,)=address(script).call(abi.encodeCall(script.execute,(OWNER,config()))); assert(!ok);
        vm.chainId(10143); vm.warp(9999); (ok,)=address(script).call(abi.encodeCall(script.execute,(OWNER,config()))); assert(!ok);
    }
}
