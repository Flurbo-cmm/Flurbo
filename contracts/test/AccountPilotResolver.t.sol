// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {AccountPilotResolver as R} from "../src/AccountPilotResolver.sol";
import {PilotPool} from "../src/PilotPool.sol";
import {FactoredBaseToken} from "../src/FactoredBaseToken.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
interface HolderVm {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function etch(address,bytes calldata) external;
    function addr(uint256) external returns (address);
    function sign(uint256,bytes32) external returns (uint8,bytes32,bytes32);
}
contract AccountPilotResolverTest {
    HolderVm constant vm=HolderVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 constant KEY=0x12345;
    address constant HOLDER=address(0x111);
    address constant CHALLENGER=address(0x222);
    address constant REPORTER=address(0x333);
    bytes32 constant HASH=keccak256("fixture evidence");
    string constant URI="https://example.org/evidence";
    MockCollateral cash;
    R resolver;
    PilotPool pool;
    function setUp() public {
        vm.chainId(10143);vm.warp(1000);cash=new MockCollateral(6);
        R.Config memory c;c.collateral=address(cash);c.draftHash=HASH;c.closesAt=2000;
        c.eventHashes=new bytes32[](3);c.observationEnds=new uint64[](3);c.reviewers=new address[](3);
        for(uint8 i;i<3;i++){c.eventHashes[i]=bytes32(uint256(i)+1);c.observationEnds[i]=3000;c.reviewers[i]=address(uint160(100+i));}
        c.bond=1e6;c.assertionPeriod=3600;c.challengePeriod=3600;c.votingPeriod=3600;
        resolver=new R(c,vm.addr(KEY));uint8[] memory order=new uint8[](3);order[1]=1;order[2]=2;
        pool=new PilotPool(address(cash),3,10e6,2000,order,address(resolver),resolver.rulesHash());resolver.bindPool(address(pool));
        cash.mint(address(this),pool.requiredFunding());cash.approve(address(pool),pool.requiredFunding());pool.fund();
        for(uint8 i;i<3;i++){address a=i==0?HOLDER:i==1?CHALLENGER:REPORTER;cash.mint(a,100e6);vm.prank(a);cash.approve(address(pool),type(uint256).max);vm.prank(a);cash.approve(address(resolver),type(uint256).max);}
    }
    function buy(uint32 scope,uint256 mask) internal {vm.prank(HOLDER);pool.buy(scope,mask,1e6,100e6,1999);}
    function propose() internal {vm.warp(3000);vm.prank(REPORTER);resolver.assertOutcome(0,R.Outcome.Yes,HASH,URI);}
    function permit(uint32 scope,uint256 mask,bool wrapped) internal view returns(R.Eligibility memory){return R.Eligibility(HASH,CHALLENGER,HOLDER,scope,mask,wrapped,1,uint64(block.timestamp+90));}
    function signature(R.Eligibility memory e) internal returns(bytes memory){(uint8 v,bytes32 r,bytes32 s)=vm.sign(KEY,resolver.eligibilityDigest(0,R.Outcome.No,HASH,URI,e));return abi.encodePacked(r,s,v);}
    function callChallenge(R.Eligibility memory e,bytes memory sig,bool expected) internal {vm.prank(CHALLENGER);(bool ok,)=address(resolver).call(abi.encodeCall(resolver.dispute,(0,R.Outcome.No,HASH,URI,e,sig)));assert(ok==expected);}
    function testDifferentLinkedWalletCanChallengeAndRedeemNormally() public {
        buy(3,8);propose();R.Eligibility memory e=permit(3,8,false);callChallenge(e,signature(e),true);assert(resolver.usedEligibility(1));
        assert(resolver.caseState(0).disputer==CHALLENGER);assert(resolver.lockedBonds()==2e6);
        vm.prank(address(100));resolver.vote(0,R.Outcome.No,HASH,URI);vm.prank(address(101));resolver.vote(0,R.Outcome.No,HASH,URI);
        assert(resolver.credits(CHALLENGER)==2e6);vm.prank(CHALLENGER);resolver.withdrawBond();
        vm.warp(6600);resolver.finalize(1);resolver.finalize(2);resolver.deliver();
        vm.prank(HOLDER);assert(pool.redeem(3,8,1e6)==0);assert(cash.balanceOf(address(pool))>=pool.requiredCollateral());
        callChallenge(e,signature(e),false);
    }
    function testZeroSharesAndOldSelectorRejected() public {propose();R.Eligibility memory e=permit(1,2,false);callChallenge(e,signature(e),false);vm.prank(CHALLENGER);(bool ok,)=address(resolver).call(abi.encodeWithSignature("dispute(uint8,uint8,bytes32,string)",0,1,HASH,URI));assert(!ok);assert(!resolver.usedEligibility(1));}
    function testUnrelatedAndPaddedScopeRejected() public {buy(2,2);buy(3,12);propose();R.Eligibility memory e=permit(2,2,false);callChallenge(e,signature(e),false);e=permit(3,12,false);callChallenge(e,signature(e),false);}
    function testSoldSharesRejected() public {buy(1,2);vm.prank(HOLDER);pool.sell(1,2,1e6,0,1999);propose();R.Eligibility memory e=permit(1,2,false);callChallenge(e,signature(e),false);}
    function testWrongSignerTamperingAndDeadlineRejected() public {
        buy(1,1);propose();R.Eligibility memory e=permit(1,1,false);bytes memory sig=signature(e);
        e.holder=CHALLENGER;callChallenge(e,sig,false);e.holder=HOLDER;
        e.nonce=2;callChallenge(e,sig,false);e.nonce=1;
        vm.warp(e.deadline);callChallenge(e,sig,false);
        e.deadline=uint64(block.timestamp+121);callChallenge(e,signature(e),false);
    }
    function testTransferredWrappedSharesRecheckedAtExecution() public {
        buy(1,2);FactoredBaseToken token=pool.createBaseToken(0,true);vm.prank(HOLDER);pool.wrapBase(0,true,1e6);propose();
        R.Eligibility memory e=permit(1,2,true);bytes memory sig=signature(e);
        assert(resolver.hasQualifyingShares(HOLDER,0,1,2,true));
        assert(!resolver.hasQualifyingShares(address(token),0,1,2,false));
        vm.prank(HOLDER);token.transfer(CHALLENGER,1e6);callChallenge(e,sig,false);
        e.holder=CHALLENGER;callChallenge(e,signature(e),true);
    }
    function testOtherChainSignatureRejected() public {buy(1,2);propose();R.Eligibility memory e=permit(1,2,false);bytes memory sig=signature(e);vm.chainId(10144);callChallenge(e,sig,false);}
    function testAnyPositiveAtomicStakeQualifies() public {vm.prank(HOLDER);pool.buy(1,1,1,100e6,1999);propose();R.Eligibility memory e=permit(1,1,false);callChallenge(e,signature(e),true);}
    function testBooleanOrQualifies() public {buy(3,14);propose();R.Eligibility memory e=permit(3,14,false);callChallenge(e,signature(e),true);}
    function testDigestMatchesIndependentViemVector() public {
        address target=0x3333333333333333333333333333333333333333;
        vm.etch(target,address(resolver).code);
        R.Eligibility memory e=R.Eligibility(HASH,CHALLENGER,HOLDER,3,8,false,1,3090);
        assert(R(target).eligibilityDigest(0,R.Outcome.No,HASH,URI,e)==0x3069bbf8d8eca14979fccda2cce30184d8822e8a5529e7aa8e8afdd4be2fbeb4);
        assert(resolver.eligibilityDigest(0,R.Outcome.No,HASH,URI,e)!=R(target).eligibilityDigest(0,R.Outcome.No,HASH,URI,e));
    }
    function testWrongAuthorityCallerAndEvidenceRejected() public {
        buy(1,2);propose();R.Eligibility memory e=permit(1,2,false);bytes memory sig=signature(e);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(KEY+1,resolver.eligibilityDigest(0,R.Outcome.No,HASH,URI,e));
        callChallenge(e,abi.encodePacked(r,s,v),false);
        vm.prank(HOLDER);(bool ok,)=address(resolver).call(abi.encodeCall(resolver.dispute,(0,R.Outcome.No,HASH,URI,e,sig)));assert(!ok);
        vm.prank(CHALLENGER);(ok,)=address(resolver).call(abi.encodeCall(resolver.dispute,(0,R.Outcome.Void,HASH,URI,e,sig)));assert(!ok);
        vm.prank(CHALLENGER);(ok,)=address(resolver).call(abi.encodeCall(resolver.dispute,(0,R.Outcome.No,HASH,"https://example.org/changed",e,sig)));assert(!ok);
        assert(!resolver.usedEligibility(e.nonce));callChallenge(e,sig,true);
    }
    function testUsedNonceCannotAuthorizeAnotherEvent() public {
        buy(3,8);propose();vm.prank(REPORTER);resolver.assertOutcome(1,R.Outcome.Yes,HASH,URI);
        R.Eligibility memory e=permit(3,8,false);callChallenge(e,signature(e),true);
        (uint8 v,bytes32 r,bytes32 s)=vm.sign(KEY,resolver.eligibilityDigest(1,R.Outcome.No,HASH,URI,e));
        vm.prank(CHALLENGER);(bool ok,)=address(resolver).call(abi.encodeCall(resolver.dispute,(1,R.Outcome.No,HASH,URI,e,abi.encodePacked(r,s,v))));
        assert(!ok);assert(resolver.caseState(1).phase==R.Phase.Asserted);
    }
}
