// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PilotResolver as R} from "../src/PilotResolver.sol";
import {PilotPool} from "../src/PilotPool.sol";
import {FactoredBaseToken} from "../src/FactoredBaseToken.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";

interface PilotVm {
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
}

contract PilotLifecycleTest {
    PilotVm constant vm = PilotVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ALICE = address(0xA11CE);
    address constant BOB = address(0xB0B);
    address constant CAROL = address(0xCA401);
    bytes32 constant EVIDENCE = keccak256("test evidence bytes");
    string constant URI = "https://example.org/evidence.json";
    MockCollateral token;
    R resolver;
    PilotPool pool;

    function config(uint8 count, uint8 reviewers) internal view returns (R.Config memory c) {
        c.collateral = address(token);
        c.draftHash = keccak256("explicitly synthetic test fixture");
        c.closesAt = 2000;
        c.eventHashes = new bytes32[](count);
        c.observationEnds = new uint64[](count);
        for (uint8 i; i < count; ++i) { c.eventHashes[i] = bytes32(uint256(i) + 1); c.observationEnds[i] = 3000; }
        c.reviewers = new address[](reviewers);
        for (uint8 i; i < reviewers; ++i) c.reviewers[i] = address(uint160(100 + i));
        c.bond = 1e6;
        c.assertionPeriod = 3600;
        c.challengePeriod = 3600;
        c.votingPeriod = 3600;
    }

    function setUp() public {
        vm.chainId(10143);
        vm.warp(1000);
        token = new MockCollateral(6);
        deploy(3, 3);
    }

    function testConsumerBooleanClaimsRedeemWithUniformVoid() public {
        // A Yes, B No, C VOID: OR pays 1; exactly one and at least two pay 1/2.
        buy(7, 254, 2e6);
        buy(7, 22, 2e6);
        buy(7, 232, 2e6);
        vm.warp(3000);
        propose(0, R.Outcome.Yes);
        propose(1, R.Outcome.No);
        vm.warp(6601);
        for (uint8 i; i < 3; ++i) resolver.finalize(i);
        resolver.deliver();
        assert(pool.resolvedState() == 1 && pool.voidMask() == 4);
        vm.prank(ALICE); assert(pool.redeem(7, 254, 2e6) == 2e6);
        vm.prank(ALICE); assert(pool.redeem(7, 22, 2e6) == 1e6);
        vm.prank(ALICE); assert(pool.redeem(7, 232, 2e6) == 1e6);
        assert(pool.requiredCollateral() == 0);
    }

    function testFourEventsTradeAndSettleWithOneVoid() public {
        deploy(4, 3);
        buy(8, 2, 2e6);
        buy(12, 8, 2e6);
        vm.prank(ALICE); pool.sell(8, 2, 1e6, 0, 1999);
        vm.warp(3000);
        propose(0, R.Outcome.Yes);
        propose(1, R.Outcome.No);
        propose(3, R.Outcome.Yes);
        vm.warp(6601);
        for (uint8 i; i < 4; ++i) resolver.finalize(i);
        resolver.deliver();
        assert(pool.resolvedState() == 9 && pool.voidMask() == 4);
        assert(pool.requiredCollateral() == 2e6);
        vm.prank(ALICE); assert(pool.redeem(8, 2, 1e6) == 1e6);
        vm.prank(ALICE); assert(pool.redeem(12, 8, 2e6) == 1e6);
        assert(pool.requiredCollateral() == 0);
    }

    function deploy(uint8 count, uint8 reviewers) internal {
        resolver = new R(config(count, reviewers));
        uint8[] memory order = new uint8[](count);
        for (uint8 i; i < count; ++i) order[i] = i;
        pool = new PilotPool(address(token), count, 10e6, 2000, order, address(resolver), resolver.rulesHash());
        resolver.bindPool(address(pool));
        token.mint(address(this), pool.requiredFunding());
        token.approve(address(pool), pool.requiredFunding());
        pool.fund();
        for (uint256 i; i < 3; ++i) {
            address owner = i == 0 ? ALICE : i == 1 ? BOB : CAROL;
            token.mint(owner, 100e6);
            vm.prank(owner); token.approve(address(pool), type(uint256).max);
            vm.prank(owner); token.approve(address(resolver), type(uint256).max);
        }
    }

    function buy(uint32 scope, uint256 mask, uint128 quantity) internal {
        vm.prank(ALICE); pool.buy(scope, mask, quantity, 100e6, 1999);
    }

    function propose(uint8 i, R.Outcome outcome) internal {
        vm.prank(ALICE); resolver.assertOutcome(i, outcome, EVIDENCE, URI);
    }

    function challenge(uint8 i, R.Outcome outcome) internal {
        vm.prank(BOB); resolver.dispute(i, outcome, EVIDENCE, URI);
    }

    function vote(uint8 i, uint8 reviewer, R.Outcome outcome) internal {
        vm.prank(address(uint160(100 + reviewer))); resolver.vote(i, outcome, EVIDENCE, URI);
    }

    function finishAll(R.Outcome a, R.Outcome b, R.Outcome c) internal {
        vm.warp(3000);
        propose(0, a); propose(1, b); propose(2, c);
        vm.warp(6600);
        for (uint8 i; i < 3; ++i) resolver.finalize(i);
        resolver.deliver();
    }

    function rejects(address target, address sender, bytes memory data) internal {
        vm.prank(sender);
        (bool ok,) = target.call(data);
        assert(!ok);
    }

    function accounting() internal view {
        assert(token.balanceOf(address(resolver)) == resolver.lockedBonds() + resolver.totalCredits());
        assert(token.balanceOf(address(pool)) >= pool.requiredCollateral());
    }

    function testBuySellNormalResolutionAndOneTimeRedemption() public {
        buy(3, 8, 2e6);
        vm.prank(ALICE); pool.sell(3, 8, 1e6, 0, 1999);
        finishAll(R.Outcome.Yes, R.Outcome.Yes, R.Outcome.No);
        assert(pool.resolvedState() == 3 && pool.voidMask() == 0 && pool.requiredCollateral() == 1e6);
        vm.prank(ALICE); assert(pool.redeem(3, 8, 1e6) == 1e6);
        rejects(address(pool), ALICE, abi.encodeCall(pool.redeem, (3, 8, 1)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.deliver, ()));
        assert(resolver.credits(ALICE) == 3e6);
        vm.prank(ALICE); resolver.withdrawBond();
        accounting();
    }

    function testDisputeMajorityRewardsCorrectCounterparty() public {
        vm.warp(3000); propose(0, R.Outcome.Yes); challenge(0, R.Outcome.No);
        vote(0, 0, R.Outcome.No);
        assert(resolver.caseState(0).phase == R.Phase.Disputed);
        vote(0, 1, R.Outcome.No);
        assert(resolver.caseState(0).result == R.Outcome.No);
        assert(resolver.credits(BOB) == 2e6 && resolver.credits(ALICE) == 0);
        rejects(address(resolver), address(102), abi.encodeCall(resolver.vote, (0, R.Outcome.Yes, EVIDENCE, URI)));
        vm.prank(BOB); resolver.withdrawBond();
        accounting();
    }

    function testProposalWinsAndThirdOutcomeRefundsBothBonds() public {
        vm.warp(3000);
        propose(0, R.Outcome.Yes); challenge(0, R.Outcome.No);
        vote(0, 0, R.Outcome.Yes); vote(0, 1, R.Outcome.Yes);
        assert(resolver.credits(ALICE) == 2e6);
        propose(1, R.Outcome.Yes); challenge(1, R.Outcome.No);
        vote(1, 0, R.Outcome.Void); vote(1, 1, R.Outcome.Void);
        assert(resolver.credits(ALICE) == 3e6 && resolver.credits(BOB) == 1e6);
        accounting();
    }

    function testFiveReviewersRequireThreeMatchingVotes() public {
        deploy(3, 5);
        vm.warp(3000); propose(0, R.Outcome.Yes); challenge(0, R.Outcome.No);
        vote(0, 0, R.Outcome.No); vote(0, 1, R.Outcome.No);
        assert(resolver.caseState(0).phase == R.Phase.Disputed);
        vote(0, 2, R.Outcome.Yes); vote(0, 3, R.Outcome.No);
        assert(resolver.caseState(0).result == R.Outcome.No);
        accounting();
    }

    function testSplitVoteAndNonresponseHaveBoundedVoidExit() public {
        buy(7, 128, 8e6);
        vm.warp(3000); propose(0, R.Outcome.Void); challenge(0, R.Outcome.Yes);
        vote(0, 0, R.Outcome.Yes); vote(0, 1, R.Outcome.No); vote(0, 2, R.Outcome.Void);
        vm.warp(6600);
        resolver.finalize(0); resolver.finalize(1); resolver.finalize(2); resolver.deliver();
        assert(pool.voidMask() == 7 && resolver.credits(ALICE) == 1e6 && resolver.credits(BOB) == 1e6);
        vm.prank(ALICE); assert(pool.redeem(7, 128, 8e6) == 1e6);
        accounting();
    }

    function testNoAssertionTimeoutTwoEventPool() public {
        deploy(2, 3);
        vm.warp(6600); resolver.finalize(0); resolver.finalize(1); resolver.deliver();
        assert(pool.voidMask() == 3 && pool.requiredCollateral() == 0);
        accounting();
    }

    function testExactDeadlineBoundaries() public {
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, EVIDENCE, URI)));
        vm.warp(3000); propose(0, R.Outcome.Yes);
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.finalize, (0)));
        vm.warp(6599); challenge(0, R.Outcome.No);
        vm.warp(6600);
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.assertOutcome, (1, R.Outcome.Yes, EVIDENCE, URI)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.finalize, (0)));
        vm.warp(10199);
        rejects(address(resolver), address(100), abi.encodeCall(resolver.vote, (0, R.Outcome.Yes, EVIDENCE, URI)));
        resolver.finalize(0);
        assert(resolver.caseState(0).result == R.Outcome.Void);
    }

    function testUnchallengedCannotBeDisputedAtDeadline() public {
        vm.warp(3000); propose(0, R.Outcome.Yes);
        vm.warp(6600);
        rejects(address(resolver), BOB, abi.encodeCall(resolver.dispute, (0, R.Outcome.No, EVIDENCE, URI)));
        resolver.finalize(0);
        assert(resolver.caseState(0).result == R.Outcome.Yes);
    }

    function testUnauthorizedActionsReplayAndEvidenceChecks() public {
        vm.warp(3000);
        rejects(address(pool), ALICE, abi.encodeCall(pool.resolve, (0, 0)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.bindPool, (address(pool))));
        rejects(address(resolver), address(100), abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, EVIDENCE, URI)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Unset, EVIDENCE, URI)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, bytes32(0), URI)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, EVIDENCE, "javascript:alert(1)")));
        propose(0, R.Outcome.Yes);
        rejects(address(resolver), BOB, abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, EVIDENCE, URI)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.dispute, (0, R.Outcome.No, EVIDENCE, URI)));
        rejects(address(resolver), address(100), abi.encodeCall(resolver.dispute, (0, R.Outcome.No, EVIDENCE, URI)));
        rejects(address(resolver), BOB, abi.encodeCall(resolver.dispute, (0, R.Outcome.Yes, EVIDENCE, URI)));
        challenge(0, R.Outcome.No);
        rejects(address(resolver), CAROL, abi.encodeCall(resolver.vote, (0, R.Outcome.Yes, EVIDENCE, URI)));
        vote(0, 0, R.Outcome.No);
        rejects(address(resolver), address(100), abi.encodeCall(resolver.vote, (0, R.Outcome.Yes, EVIDENCE, URI)));
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.deliver, ()));
        accounting();
    }

    function testBondTransferFailuresRollbackAndWithdrawCanRetry() public {
        vm.warp(3000);
        for (uint8 mode = 1; mode <= 5; ++mode) {
            if (mode == 4) continue;
            token.setMode(mode);
            rejects(address(resolver), ALICE, abi.encodeCall(resolver.assertOutcome, (0, R.Outcome.Yes, EVIDENCE, URI)));
            assert(resolver.caseState(0).phase == R.Phase.Pending && resolver.lockedBonds() == 0);
        }
        token.setMode(0); propose(0, R.Outcome.Yes);
        vm.warp(6600); resolver.finalize(0);
        token.setMode(3);
        rejects(address(resolver), ALICE, abi.encodeCall(resolver.withdrawBond, ()));
        assert(resolver.credits(ALICE) == 1e6 && resolver.totalCredits() == 1e6);
        token.setMode(0); vm.prank(ALICE); resolver.withdrawBond();
        accounting();
    }

    function testReentrantBondCallbackCannotFinalizeOrTakeAnotherBond() public {
        vm.warp(3000);
        token.setCallback(address(resolver), abi.encodeCall(resolver.assertOutcome, (1, R.Outcome.Yes, EVIDENCE, URI)));
        propose(0, R.Outcome.Yes);
        assert(!token.callbackSucceeded());
        assert(resolver.caseState(1).phase == R.Phase.Pending);
        accounting();
    }

    function testWrappedClaimTransfersAndRedeemsAfterPartialVoid() public {
        buy(1, 2, 2e6);
        FactoredBaseToken receipt = pool.createBaseToken(0, true);
        vm.prank(ALICE); pool.wrapBase(0, true, 2e6);
        vm.prank(ALICE); receipt.transfer(BOB, 2e6);
        finishAll(R.Outcome.Void, R.Outcome.Yes, R.Outcome.No);
        assert(pool.holdings(address(receipt), 1, 2) == receipt.totalSupply());
        vm.prank(BOB); pool.unwrapBase(0, true, 2e6);
        vm.prank(BOB); assert(pool.redeem(1, 2, 2e6) == 1e6);
        assert(receipt.totalSupply() == 0);
        accounting();
    }

    function testFuzzTruthTableUniformVoidAndSplitPayout(uint8 truthMask, uint8 ternary, uint32 atoms) public {
        uint256 mask = uint256(truthMask) % 254 + 1;
        uint128 quantity = uint128(atoms % 10_000_000) + 2;
        buy(7, mask, quantity);
        R.Outcome a = R.Outcome(ternary % 3 + 1);
        R.Outcome b = R.Outcome((ternary / 3) % 3 + 1);
        R.Outcome c = R.Outcome((ternary / 9) % 3 + 1);
        finishAll(a, b, c);
        // Independent enumeration of the eight states, using per-event outcomes.
        uint256 winners; uint256 states;
        for (uint256 s; s < 8; ++s) {
            if ((a == R.Outcome.Yes && s % 2 != 1) || (a == R.Outcome.No && s % 2 != 0)) continue;
            if ((b == R.Outcome.Yes && (s / 2) % 2 != 1) || (b == R.Outcome.No && (s / 2) % 2 != 0)) continue;
            if ((c == R.Outcome.Yes && s / 4 != 1) || (c == R.Outcome.No && s / 4 != 0)) continue;
            states++;
            if ((mask / (2 ** s)) % 2 == 1) winners++;
        }
        (uint256 n, uint256 d) = pool.payoutFraction(7, mask);
        assert(n == winners && d == states);
        uint256 reserve = pool.requiredCollateral();
        assert(reserve == (uint256(quantity) * winners + states - 1) / states);
        vm.prank(ALICE); uint128 first = pool.redeem(7, mask, quantity / 2);
        vm.prank(ALICE); uint128 second = pool.redeem(7, mask, quantity - quantity / 2);
        assert(uint256(first) + second <= uint256(quantity) * winners / states);
        assert(pool.requiredCollateral() == reserve - first - second);
        assert(pool.holdings(ALICE, 7, mask) == 0);
        accounting();
    }

    function testPayoutsForMixedScopesAndNoOversell() public {
        buy(1, 2, 1e6); buy(2, 1, 1e6); buy(3, 8, 2e6); buy(3, 14, 2e6); buy(3, 6, 2e6);
        rejects(address(pool), ALICE, abi.encodeCall(pool.sell, (1, 2, 2e6, 0, 1999)));
        finishAll(R.Outcome.Yes, R.Outcome.Void, R.Outcome.No);
        assert(pool.requiredCollateral() == 5_500_000);
        vm.prank(ALICE); assert(pool.redeem(1, 2, 1e6) == 1e6);
        vm.prank(ALICE); assert(pool.redeem(2, 1, 1e6) == 500_000);
        vm.prank(ALICE); assert(pool.redeem(3, 8, 2e6) == 1e6);
        vm.prank(ALICE); assert(pool.redeem(3, 14, 2e6) == 2e6);
        vm.prank(ALICE); assert(pool.redeem(3, 6, 2e6) == 1e6);
        assert(pool.requiredCollateral() == 0);
        accounting();
    }

    function testRedemptionFailsClosedOnDeficitAndTransferFailure() public {
        buy(3, 8, 1e6);
        finishAll(R.Outcome.Yes, R.Outcome.Yes, R.Outcome.Yes);
        token.setMode(3);
        rejects(address(pool), ALICE, abi.encodeCall(pool.redeem, (3, 8, 1e6)));
        assert(pool.holdings(ALICE, 3, 8) == 1e6 && pool.requiredCollateral() == 1e6);
        token.setMode(0);
        token.burn(address(pool), token.balanceOf(address(pool)) - 999_999);
        rejects(address(pool), ALICE, abi.encodeCall(pool.redeem, (3, 8, 1e6)));
        token.mint(address(pool), 1);
        vm.prank(ALICE); pool.redeem(3, 8, 1e6);
        accounting();
    }

    function badConfig(R.Config memory c) internal {
        bool ok;
        try new R(c) returns (R) { ok = true; } catch {}
        assert(!ok);
    }

    function testConfigAndBindingRejectUnsupportedOrAmbiguousRules() public {
        R.Config memory c = config(3, 3);
        vm.chainId(143); badConfig(c); vm.chainId(10143);
        c.reviewers[1] = c.reviewers[0]; badConfig(c);
        c = config(3, 3); c.reviewers[0] = address(0); badConfig(c);
        c = config(3, 3); c.eventHashes[1] = c.eventHashes[0]; badConfig(c);
        c = config(3, 3); c.observationEnds[0] = c.closesAt; badConfig(c);
        c = config(3, 3); c.challengePeriod = 1; badConfig(c);
        c = config(3, 3); c.bond = 0; badConfig(c);
        c = config(3, 3); c.draftHash = 0; badConfig(c);
        badConfig(config(5, 3)); badConfig(config(2, 4));
        R second = new R(config(3, 3));
        rejects(address(second), address(this), abi.encodeCall(second.bindPool, (address(pool))));
        rejects(address(resolver), address(this), abi.encodeCall(resolver.bindPool, (address(pool))));
        assert(second.rulesHash() != resolver.rulesHash());
    }
}
