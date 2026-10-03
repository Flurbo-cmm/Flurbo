// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredCreSettlementReceiver} from "../src/FactoredCreSettlementReceiver.sol";
import {FactoredQuote as Q} from "../src/FactoredQuote.sol";
import {FactoredPool} from "../src/FactoredPool.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
import {FactoredCreWorkflowFixtures as Fixture} from "./helpers/FactoredCreWorkflowFixtures.sol";
import {FactoredLocalCreForwarder} from "./FactoredCreSettlementReceiver.t.sol";

interface FactoredWorkflowVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
    function setNonce(address account, uint64 nonce) external;
}

/// @dev Cross-language payload test. FactoredLocalCreForwarder does NOT verify DON signatures.
contract FactoredCreWorkflowSettlementTest {
    FactoredWorkflowVm private constant vm =
        FactoredWorkflowVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant BOB = address(0xB0B);
    FactoredLocalCreForwarder private forwarder;
    FactoredCreSettlementReceiver private receiver;
    MockCollateral private token;
    FactoredPool private pool;

    function order() private pure returns (uint8[] memory result) {
        result = new uint8[](2);
        result[1] = 1;
    }

    function setUp() public {
        vm.chainId(Fixture.CHAIN_ID);
        vm.warp(Fixture.CLOSES_AT - 100);
        forwarder = new FactoredLocalCreForwarder();
        receiver = new FactoredCreSettlementReceiver(address(forwarder), bytes32(uint256(1)), "001122aabb", BOB, 3600);
        token = new MockCollateral(6);
        // CREATE address depends on creator/nonce, so the rules can commit to it before deployment.
        vm.setNonce(Fixture.DEPLOYER, 1);
        vm.prank(Fixture.DEPLOYER);
        pool = new FactoredPool(address(token), 2, 100e6, Fixture.CLOSES_AT, order(), address(receiver), Fixture.RULES);
        assert(address(pool) == Fixture.POOL);
        receiver.bindPool(address(pool));
        token.mint(address(this), 1000e6);
        token.approve(address(pool), type(uint256).max);
        pool.fund();
        pool.buy(1, 2, 10e6, 10e6, block.timestamp); // A
        pool.buy(3, 8, 4e6, 4e6, block.timestamp); // A AND B
        token.mint(BOB, 100e6);
        vm.prank(BOB);
        token.approve(address(pool), type(uint256).max);
        vm.prank(BOB);
        pool.buy(2, 2, 7e6, 7e6, block.timestamp); // B
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
        assert(!ok && bytes4(reason) == FactoredCreSettlementReceiver.UnauthorizedForwarder.selector);
        assert(snapshot() == before_);
        settleAndRedeem(1);
    }

    function testGeneratedPayloadRejectsWrongChainWithoutChangingState() public {
        vm.chainId(Fixture.CHAIN_ID + 1);
        reject(Fixture.report(1), FactoredCreSettlementReceiver.WrongReportDomain.selector);
        vm.chainId(Fixture.CHAIN_ID);
        settleAndRedeem(1);
    }

    function testGeneratedPayloadExpiresAtReceiver() public {
        vm.warp(Fixture.OBSERVED_AT + 3601);
        reject(Fixture.report(3), FactoredCreSettlementReceiver.InvalidObservation.selector);
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
        assert(pool.redeem(1, 2, 3e6) == (aPayout == 0 ? 0 : 3e6));
        assert(pool.holdings(address(this), 1, 2) == 7e6);
        assert(pool.requiredCollateral() == (aPayout == 0 ? 0 : 7e6) + bPayout + jointPayout);
        assert(pool.redeem(1, 2, 7e6) == (aPayout == 0 ? 0 : 7e6));
        assert(pool.redeem(3, 8, 4e6) == jointPayout);
        vm.prank(BOB);
        uint128 bobPaid = pool.redeem(2, 2, 7e6);
        assert(bobPaid == bPayout);
        assert(token.balanceOf(address(this)) == aliceCash + aPayout + jointPayout);
        assert(token.balanceOf(BOB) == bobCash + bPayout);
        assert(token.balanceOf(address(pool)) == cash - aPayout - jointPayout - bPayout);
        assert(pool.holdings(address(this), 1, 2) == 0 && pool.holdings(address(this), 3, 8) == 0);
        assert(pool.holdings(BOB, 2, 2) == 0 && pool.requiredCollateral() == 0);
        Q.Factor[] memory liabilities = pool.factors();
        for (uint256 i; i < liabilities.length; ++i) {
            for (uint256 j; j < liabilities[i].values.length; j++) {
                assert(liabilities[i].values[j] == 0);
            }
        }
        reject(report, FactoredCreSettlementReceiver.AlreadyFinalized.selector);
        reject(Fixture.report((state + 1) % 4), FactoredCreSettlementReceiver.AlreadyFinalized.selector);
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
                pool.factors(),
                token.balanceOf(address(pool)),
                token.balanceOf(address(this)),
                token.balanceOf(BOB)
            )
        );
    }
}
