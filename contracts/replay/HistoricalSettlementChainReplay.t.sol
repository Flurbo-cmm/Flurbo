// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccountPilotResolver as R} from "../src/AccountPilotResolver.sol";
import {PilotPool} from "../src/PilotPool.sol";
import {MockCollateral} from "../test/helpers/MockCollateral.sol";

interface HistoricalVm {
    function readFile(string calldata) external view returns (string memory);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonBool(string calldata, string calldata) external pure returns (bool);
    function toString(uint256) external pure returns (string memory);
    function chainId(uint256) external;
    function warp(uint256) external;
    function prank(address) external;
}

/// @dev Opt-in, local EVM only. Generated inputs come from archived official sources,
/// parsed and evaluated by replay-settlement-chain.mjs immediately before this suite.
contract HistoricalSettlementChainReplayTest {
    HistoricalVm constant vm = HistoricalVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant HOLDER = address(0x111);
    address constant REPORTER = address(0x222);
    event log_named_uint(string key, uint256 val);
    string input;
    R resolver;
    PilotPool pool;
    MockCollateral cash;

    function setUp() public {
        (bool forked,) = address(vm).call(abi.encodeWithSignature("activeFork()"));
        require(!forked, "Replay forbids forks and remote chain state");
        vm.chainId(10143); // Constructor domain, not a connection to Monad testnet.
        input = vm.readFile("target/settlement-replay/evm-input.json");
        require(vm.parseJsonBool(input, ".localOnly"));
        require(vm.parseJsonBool(input, ".retrospective"));
        require(!vm.parseJsonBool(input, ".liveSubmissionEligible"));
        require(vm.parseJsonBytes32(input, ".sourceReplayHash") != bytes32(0));
    }

    function number(string memory prefix, string memory key) internal view returns (uint256) {
        return vm.parseJsonUint(input, string.concat(prefix, key));
    }
    function bytesValue(string memory prefix, string memory key) internal view returns (bytes32) {
        return vm.parseJsonBytes32(input, string.concat(prefix, key));
    }
    function deployScenario(string memory prefix) internal {
        uint64 closesAt = uint64(number(prefix, ".closesAt"));
        vm.warp(closesAt - 3600);
        cash = new MockCollateral(6);
        R.Config memory c;
        c.collateral = address(cash);
        c.draftHash = bytesValue(prefix, ".draftHash");
        c.closesAt = closesAt;
        c.eventHashes = new bytes32[](2);
        c.observationEnds = new uint64[](2);
        for (uint256 i; i < 2; ++i) {
            string memory path = string.concat(".events[", vm.toString(i), "]");
            c.eventHashes[i] = bytesValue(prefix, string.concat(path, ".ruleHash"));
            c.observationEnds[i] = uint64(number(prefix, string.concat(path, ".observationEnd")));
        }
        c.reviewers = new address[](3);
        c.reviewers[0] = address(100); c.reviewers[1] = address(101); c.reviewers[2] = address(102);
        c.bond = 1e6;
        c.assertionPeriod = uint32(number(prefix, ".assertionPeriod"));
        c.challengePeriod = uint32(number(prefix, ".challengePeriod"));
        c.votingPeriod = uint32(number(prefix, ".votingPeriod"));
        resolver = new R(c, address(0x333));
        uint8[] memory order = new uint8[](2); order[1] = 1;
        pool = new PilotPool(address(cash), 2, 10e6, closesAt, order, address(resolver), resolver.rulesHash());
        resolver.bindPool(address(pool));
        assert(resolver.draftHash() == c.draftHash);
        assert(pool.settlementRulesHash() == resolver.rulesHash());
        assert(resolver.eventHashes(0) == c.eventHashes[0] && resolver.eventHashes(1) == c.eventHashes[1]);
        cash.mint(address(this), pool.requiredFunding());
        cash.approve(address(pool), pool.requiredFunding()); pool.fund();
        cash.mint(HOLDER, 100e6);
        vm.prank(HOLDER); cash.approve(address(pool), type(uint256).max);
        uint128 units = uint128(number(prefix, ".units"));
        uint256 beforeTrade = cash.balanceOf(HOLDER);
        vm.prank(HOLDER); pool.buy(3, 8, units, 100e6, closesAt - 1);
        emit log_named_uint("purchaseCostAtoms", beforeTrade - cash.balanceOf(HOLDER));
        cash.mint(REPORTER, 100e6);
        vm.prank(REPORTER); cash.approve(address(resolver), type(uint256).max);
    }
    function executeActions(string memory prefix, uint256 actionCount) internal {
        for (uint256 i; i < actionCount; ++i) {
            string memory path = string.concat(".actions[", vm.toString(i), "]");
            uint256 at = number(prefix, string.concat(path, ".at"));
            require(at >= block.timestamp, "Actions must be chronological");
            vm.warp(at);
            uint8 eventIndex = uint8(number(prefix, string.concat(path, ".eventIndex")));
            R.Outcome outcome = R.Outcome(number(prefix, string.concat(path, ".outcome")));
            uint256 kind = number(prefix, string.concat(path, ".kind"));
            if (kind == 1) {
                require(outcome == R.Outcome.Yes || outcome == R.Outcome.No);
                bytes32 evidenceHash = bytesValue(prefix, string.concat(path, ".evidenceHash"));
                require(evidenceHash != bytes32(0));
                vm.prank(REPORTER);
                resolver.assertOutcome(eventIndex, outcome, evidenceHash, "https://example.invalid/retrospective-local-replay");
                assert(resolver.caseState(eventIndex).evidenceHash == evidenceHash);
                assert(resolver.caseState(eventIndex).proposal == outcome);
            } else {
                require(kind == 2);
                if (outcome == R.Outcome.Void) {
                    assert(resolver.caseState(eventIndex).phase == R.Phase.Pending);
                    assert(resolver.caseState(eventIndex).evidenceHash == bytes32(0));
                }
                resolver.finalize(eventIndex);
                assert(resolver.caseState(eventIndex).phase == R.Phase.Finalized);
                assert(resolver.caseState(eventIndex).result == outcome);
            }
        }
    }
    function runScenario(string memory prefix, uint256 actionCount, uint128 expectedPayout, uint32 expectedVoidMask) internal {
        deployScenario(prefix);
        executeActions(prefix, actionCount);
        assert(!pool.resolved());
        uint256 beforeDelivery = cash.balanceOf(HOLDER);
        resolver.deliver();
        assert(pool.resolved() && pool.voidMask() == expectedVoidMask);
        assert(cash.balanceOf(HOLDER) == beforeDelivery); // Delivery does not push payouts.
        uint128 units = uint128(number(prefix, ".units"));
        vm.prank(HOLDER); uint128 paid = pool.redeem(3, 8, units);
        assert(paid == expectedPayout && paid == number(prefix, ".expectedPayout"));
        uint256 delta = cash.balanceOf(HOLDER) - beforeDelivery;
        assert(delta == paid);
        assert(cash.balanceOf(address(pool)) >= pool.requiredCollateral());
        emit log_named_uint("redeemedAtoms", paid);
        emit log_named_uint("holderBalanceIncreaseAtoms", delta);
        emit log_named_uint("voidMask", pool.voidMask());
        emit log_named_uint("redemptionTimestamp", block.timestamp);
    }

    function testHistoricalShortPolicySourceToVoidAndYesRedemption() public { runScenario(".short", 3, 500000, 1); }
    function testHistoricalLongPolicySourceToYesAndYesRedemption() public { runScenario(".long", 4, 1000000, 0); }
}
