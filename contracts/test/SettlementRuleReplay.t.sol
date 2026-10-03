// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccountPilotResolver as R} from "../src/AccountPilotResolver.sol";
import {PilotPool} from "../src/PilotPool.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";

interface ReplayVm {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
    function addr(uint256) external returns (address);
    function sign(uint256, bytes32) external returns (uint8, bytes32, bytes32);
}

/// @notice Resolver acceptance tests for the adapter outcome/timeout interface.
/// @dev The accompanying JavaScript replay verifies source parsing. This suite verifies
/// the existing contracts, not arbitrary sources, GitHub scheduling or live deployment.
contract SettlementRuleReplayTest {
    ReplayVm constant vm = ReplayVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant HOLDER = address(0x111);
    address constant REPORTER = address(0x222);
    uint256 constant AUTHORITY_KEY = 0x5245504c4159;
    bytes32 constant EVIDENCE = keccak256("local replay evidence packet");
    string constant URI = "https://example.org/local-replay";
    R resolver;
    PilotPool pool;
    MockCollateral cash;

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1000);
        cash = new MockCollateral(6);
        R.Config memory c;
        c.collateral = address(cash);
        c.draftHash = keccak256("local fixture rules; not a live market");
        c.closesAt = 2000;
        c.eventHashes = new bytes32[](2);
        c.eventHashes[0] = keccak256("source A threshold rule");
        c.eventHashes[1] = keccak256("source B threshold rule");
        c.observationEnds = new uint64[](2);
        c.observationEnds[0] = 3000;
        c.observationEnds[1] = 4000;
        c.reviewers = new address[](3);
        c.reviewers[0] = address(100);
        c.reviewers[1] = address(101);
        c.reviewers[2] = address(102);
        c.bond = 1e6;
        c.assertionPeriod = 3600;
        c.challengePeriod = 3600;
        c.votingPeriod = 3600;
        resolver = new R(c, vm.addr(AUTHORITY_KEY));
        uint8[] memory order = new uint8[](2);
        order[1] = 1;
        pool = new PilotPool(address(cash), 2, 10e6, c.closesAt, order, address(resolver), resolver.rulesHash());
        resolver.bindPool(address(pool));
        cash.mint(address(this), pool.requiredFunding());
        cash.approve(address(pool), pool.requiredFunding());
        pool.fund();
        cash.mint(HOLDER, 100e6);
        vm.prank(HOLDER); cash.approve(address(pool), type(uint256).max);
        vm.prank(HOLDER); pool.buy(3, 8, 1e6, 100e6, 1999);
        vm.prank(HOLDER); cash.approve(address(resolver), type(uint256).max);
        cash.mint(REPORTER, 100e6);
        vm.prank(REPORTER); cash.approve(address(resolver), type(uint256).max);
    }

    function assertEvent(uint8 eventIndex, R.Outcome outcome) internal {
        vm.prank(REPORTER);
        resolver.assertOutcome(eventIndex, outcome, EVIDENCE, URI);
    }
    function deliverAndRedeem(uint128 expected) internal {
        resolver.deliver();
        uint256 beforeBalance = cash.balanceOf(HOLDER);
        vm.prank(HOLDER);
        uint128 paid = pool.redeem(3, 8, 1e6);
        assert(paid == expected);
        assert(cash.balanceOf(HOLDER) - beforeBalance == expected);
        assert(cash.balanceOf(address(pool)) >= pool.requiredCollateral());
    }
    function testTwoValidYesResultsPayAndOnlyAfterEveryFinalizationAndDelivery() public {
        vm.warp(3000); assertEvent(0, R.Outcome.Yes);
        vm.warp(4000); assertEvent(1, R.Outcome.Yes);
        vm.warp(7600);
        assert(!pool.resolved()); // Time does not execute settlement.
        resolver.finalize(0);
        (bool premature,) = address(resolver).call(abi.encodeCall(resolver.deliver, ()));
        assert(!premature);
        resolver.finalize(1);
        assert(!pool.resolved()); // Finalizing cases still does not deliver or pay holders.
        deliverAndRedeem(1e6);
    }
    function testEvidenceBackedNoIsNotVoid() public {
        vm.warp(4000); assertEvent(0, R.Outcome.No); assertEvent(1, R.Outcome.Yes);
        vm.warp(7600); resolver.finalize(0); resolver.finalize(1);
        deliverAndRedeem(0);
        assert(pool.voidMask() == 0);
    }
    function testMissingFirstReleaseAndKnownYesPayHalfForAnd() public {
        vm.warp(4000); assertEvent(1, R.Outcome.Yes);
        vm.warp(7600); resolver.finalize(0); resolver.finalize(1);
        deliverAndRedeem(500000);
        assert(pool.voidMask() == 1);
    }
    function testBothMissingBecomeVoidWithQuarterAndPayoutNotPurchaseRefund() public {
        vm.warp(7600); resolver.finalize(0); resolver.finalize(1);
        deliverAndRedeem(250000);
        assert(pool.voidMask() == 3);
    }
    function testAssertionAtExpiredDeadlineCannotRestoreSourceResult() public {
        vm.warp(6600);
        vm.prank(REPORTER);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, EVIDENCE, URI)));
        assert(!ok);
        resolver.finalize(0);
        assert(resolver.caseState(0).result == R.Outcome.Void);
    }
    function testCorrectionWindowCannotBeBypassedForEarlierNormalResult() public {
        vm.warp(3999);
        vm.prank(REPORTER);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.assertOutcome, (1, R.Outcome.Yes, EVIDENCE, URI)));
        assert(!ok);
        vm.warp(4000); assertEvent(1, R.Outcome.Yes);
    }
    function challengeFirst() internal {
        R.Eligibility memory e = R.Eligibility(EVIDENCE, HOLDER, HOLDER, 3, 8, false, 1, uint64(block.timestamp + 90));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(AUTHORITY_KEY, resolver.eligibilityDigest(0, R.Outcome.No, EVIDENCE, URI, e));
        vm.prank(HOLDER);
        resolver.dispute(0, R.Outcome.No, EVIDENCE, URI, e, abi.encodePacked(r, s, v));
    }
    function testDisputeUsesReviewersAndThenRejectsPostFinalizationObjection() public {
        vm.warp(4000); assertEvent(0, R.Outcome.Yes); assertEvent(1, R.Outcome.Yes);
        challengeFirst();
        vm.prank(address(100)); resolver.vote(0, R.Outcome.No, EVIDENCE, URI);
        vm.prank(address(101)); resolver.vote(0, R.Outcome.No, EVIDENCE, URI);
        assert(resolver.caseState(0).result == R.Outcome.No);
        vm.warp(7600); resolver.finalize(1); deliverAndRedeem(0);
        vm.prank(REPORTER);
        (bool ok,) = address(resolver).call(abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, EVIDENCE, URI)));
        assert(!ok);
    }
    function testUnresolvedDisputeTimesOutToVoid() public {
        vm.warp(4000); assertEvent(0, R.Outcome.Yes); assertEvent(1, R.Outcome.Yes);
        challengeFirst();
        vm.warp(7600); resolver.finalize(0); resolver.finalize(1);
        assert(resolver.caseState(0).result == R.Outcome.Void);
        deliverAndRedeem(500000);
    }
}
