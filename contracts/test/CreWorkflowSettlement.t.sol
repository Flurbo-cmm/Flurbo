// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {CreSettlementReceiver} from "../src/CreSettlementReceiver.sol";
import {ReferencePool} from "../src/ReferencePool.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
import {CreWorkflowFixtures as Fixture} from "./helpers/CreWorkflowFixtures.sol";
import {LocalCreForwarder} from "./CreSettlementReceiver.t.sol";

interface WorkflowVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function setNonce(address account, uint64 nonce) external;
}

/// @dev Cross-language payload test. LocalCreForwarder does NOT verify DON signatures.
contract CreWorkflowSettlementTest {
    WorkflowVm private constant vm = WorkflowVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BOB = address(0xB0B);
    LocalCreForwarder private forwarder;
    CreSettlementReceiver private receiver;
    MockCollateral private token;
    ReferencePool private pool;

    function setUp() public {
        vm.chainId(Fixture.CHAIN_ID);
        vm.warp(Fixture.CLOSES_AT - 100);
        forwarder = new LocalCreForwarder();
        receiver = new CreSettlementReceiver(address(forwarder), bytes32(uint256(1)), "001122aabb", BOB, 3600);
        token = new MockCollateral(6);
        // CREATE address depends on creator/nonce, so the rules can commit to it before deployment.
        vm.setNonce(Fixture.DEPLOYER, 1);
        vm.prank(Fixture.DEPLOYER);
        pool = new ReferencePool(address(token), 2, 100e6, Fixture.CLOSES_AT, address(receiver), Fixture.RULES);
        assert(address(pool) == Fixture.POOL);
        receiver.bindPool(address(pool));
        token.mint(address(this), 1000e6);
        token.approve(address(pool), type(uint256).max);
        pool.fund();
        pool.buy(10, 10e6, 10e6, block.timestamp); // A
        pool.buy(8, 4e6, 4e6, block.timestamp); // A AND B
        token.mint(BOB, 100e6);
        vm.prank(BOB);
        token.approve(address(pool), type(uint256).max);
        vm.prank(BOB);
        pool.buy(12, 7e6, 7e6, block.timestamp); // B
        vm.warp(Fixture.OBSERVED_AT);
    }

    function testGeneratedNeitherOutcome() public {
        settleAndRedeem(0);
    }

    function testGeneratedAOnlyOutcome() public {
        settleAndRedeem(1);
    }

    function testGeneratedBOnlyOutcome() public {
        settleAndRedeem(2);
    }

    function testGeneratedBothOutcome() public {
        settleAndRedeem(3);
    }

    function testUnsignedPayloadCannotBypassForwarder() public {
        bytes32 before_ = snapshot();
        (bool ok, bytes memory reason) =
            address(receiver).call(abi.encodeCall(receiver.onReport, (metadata(), Fixture.report(1))));
        assert(!ok && bytes4(reason) == CreSettlementReceiver.UnauthorizedForwarder.selector);
        assert(snapshot() == before_);
        settleAndRedeem(1);
    }

    function testGeneratedPayloadRejectsWrongChainWithoutChangingState() public {
        vm.chainId(Fixture.CHAIN_ID + 1);
        reject(Fixture.report(1), CreSettlementReceiver.WrongReportDomain.selector);
        vm.chainId(Fixture.CHAIN_ID);
        settleAndRedeem(1);
    }

    function testGeneratedPayloadExpiresAtReceiver() public {
        vm.warp(Fixture.OBSERVED_AT + 3601);
        reject(Fixture.report(3), CreSettlementReceiver.InvalidObservation.selector);
    }

    function settleAndRedeem(uint8 state) private {
        bytes memory report = Fixture.report(state); // Deliver unchanged bytes emitted by TypeScript.
        uint256 cash = token.balanceOf(address(pool));
        uint256 aliceCash = token.balanceOf(address(this));
        uint256 bobCash = token.balanceOf(BOB);
        forwarder.deliver(receiver, metadata(), report);
        assert(receiver.finalized() && pool.resolved() && pool.resolvedState() == state);
        assert(
            receiver.acceptedReportHash() == keccak256(abi.encode(block.chainid, address(receiver), metadata(), report))
        );
        assert(token.balanceOf(address(pool)) == cash);
        uint128 aPayout = state & 1 != 0 ? 10e6 : 0;
        uint128 bPayout = state & 2 != 0 ? 7e6 : 0;
        uint128 jointPayout = state == 3 ? 4e6 : 0;
        assert(pool.requiredCollateral() == aPayout + bPayout + jointPayout);
        assert(pool.redeem(10, 3e6) == (aPayout == 0 ? 0 : 3e6));
        assert(pool.holdings(address(this), 10) == 7e6);
        assert(pool.requiredCollateral() == (aPayout == 0 ? 0 : 7e6) + bPayout + jointPayout);
        assert(pool.redeem(10, 7e6) == (aPayout == 0 ? 0 : 7e6));
        assert(pool.redeem(8, 4e6) == jointPayout);
        vm.prank(BOB);
        uint128 bobPaid = pool.redeem(12, 7e6);
        assert(bobPaid == bPayout);
        assert(token.balanceOf(address(this)) == aliceCash + aPayout + jointPayout);
        assert(token.balanceOf(BOB) == bobCash + bPayout);
        assert(token.balanceOf(address(pool)) == cash - aPayout - jointPayout - bPayout);
        assert(pool.holdings(address(this), 10) == 0 && pool.holdings(address(this), 8) == 0);
        assert(pool.holdings(BOB, 12) == 0 && pool.requiredCollateral() == 0);
        uint128[] memory liabilities = pool.liabilities();
        for (uint256 i; i < liabilities.length; ++i) {
            assert(liabilities[i] == 0);
        }
        reject(report, CreSettlementReceiver.AlreadyFinalized.selector);
        reject(Fixture.report((state + 1) % 4), CreSettlementReceiver.AlreadyFinalized.selector);
    }

    function metadata() private pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes10("001122aabb"), BOB, bytes2(uint16(7)));
    }

    function reject(bytes memory report, bytes4 expected) private {
        bytes32 before_ = snapshot();
        (bool ok, bytes memory reason) =
            address(forwarder).call(abi.encodeCall(forwarder.deliver, (receiver, metadata(), report)));
        assert(!ok && bytes4(reason) == expected && snapshot() == before_);
    }

    function snapshot() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                receiver.finalized(),
                receiver.acceptedReportHash(),
                pool.resolved(),
                pool.resolvedState(),
                pool.liabilities(),
                token.balanceOf(address(pool)),
                token.balanceOf(address(this)),
                token.balanceOf(BOB)
            )
        );
    }
}
