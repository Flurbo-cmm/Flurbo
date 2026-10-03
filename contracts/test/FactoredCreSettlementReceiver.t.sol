// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredCreSettlementReceiver} from "../src/FactoredCreSettlementReceiver.sol";
import {FactoredPool} from "../src/FactoredPool.sol";
import {FactoredQuote as Q} from "../src/FactoredQuote.sol";
import {FactoredFunding} from "../src/FactoredFunding.sol";
import {FundedFactoredPool} from "../src/FundedFactoredPool.sol";
import {ICreReceiver} from "../src/CreSettlementReceiver.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

interface FactoredCreVm {
    function prank(address sender) external;
    function warp(uint256 timestamp) external;
    function chainId(uint256 id) external;
}

/// @dev Deliberately unauthenticated test transport, NOT a signature verifier or deployable forwarder.
contract FactoredLocalCreForwarder {
    function deliver(ICreReceiver receiver, bytes memory metadata, bytes memory report) external {
        receiver.onReport(metadata, report);
    }
}

contract FactoredCreSettlementReceiverTest {
    FactoredCreVm private constant vm = FactoredCreVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 private constant WORKFLOW = bytes32(uint256(0x1234));
    bytes10 private constant NAME = "001122aabb";
    address private constant AUTHOR = address(0xA11CE);
    bytes32 private constant RULES = keccak256("CRE receiver test rules only");
    FactoredLocalCreForwarder private forwarder;
    FactoredCreSettlementReceiver private receiver;
    MockCollateral private token;
    FactoredPool private pool;

    function setUp() public {
        vm.warp(1000);
        forwarder = new FactoredLocalCreForwarder();
        receiver = makeReceiver();
        token = new MockCollateral(6);
        uint8[] memory order = new uint8[](2);
        order[1] = 1;
        pool = new FactoredPool(
            address(token), 2, 100e6, uint64(block.timestamp + 1 days), order, address(receiver), RULES
        );
        receiver.bindPool(address(pool));
        token.mint(address(this), 1000e6);
        token.approve(address(pool), type(uint256).max);
    }

    function testSupportsReceiverAndErc165() public view {
        assert(receiver.supportsInterface(type(ICreReceiver).interfaceId));
        assert(receiver.supportsInterface(bytes4(keccak256("onReport(bytes,bytes)"))));
        assert(receiver.supportsInterface(type(IERC165).interfaceId));
        assert(!receiver.supportsInterface(0xffffffff));
    }

    function testConfigurationCannotDisableAuthenticationOrFreshness() public {
        badConfig(address(0), WORKFLOW, NAME, AUTHOR, 1);
        badConfig(AUTHOR, WORKFLOW, NAME, AUTHOR, 1);
        badConfig(address(forwarder), bytes32(0), NAME, AUTHOR, 1);
        badConfig(address(forwarder), WORKFLOW, bytes10(0), AUTHOR, 1);
        badConfig(address(forwarder), WORKFLOW, NAME, address(0), 1);
        badConfig(address(forwarder), WORKFLOW, NAME, AUTHOR, 0);
    }

    function testOnlyDeployerCanBindAndBindingIsPermanent() public {
        FactoredCreSettlementReceiver other = makeReceiver();
        vm.prank(AUTHOR);
        (bool ok, bytes memory reason) = address(other).call(abi.encodeCall(other.bindPool, (address(pool))));
        assert(!ok && bytes4(reason) == FactoredCreSettlementReceiver.UnauthorizedConfigurator.selector);
        (ok, reason) = address(other).call(abi.encodeCall(other.bindPool, (address(0))));
        assert(!ok && bytes4(reason) == FactoredCreSettlementReceiver.InvalidPool.selector);
        (ok, reason) = address(other).call(abi.encodeCall(other.bindPool, (address(pool))));
        assert(!ok && bytes4(reason) == FactoredCreSettlementReceiver.InvalidPool.selector);
        (ok, reason) = address(receiver).call(abi.encodeCall(receiver.bindPool, (address(pool))));
        assert(!ok && bytes4(reason) == FactoredCreSettlementReceiver.PoolAlreadyBound.selector);
        assert(address(other.pool()) == address(0) && address(receiver.pool()) == address(pool));
    }

    function testUnboundReceiverRejectsDelivery() public {
        FactoredCreSettlementReceiver other = makeReceiver();
        (bool ok, bytes memory reason) =
            address(forwarder).call(abi.encodeCall(forwarder.deliver, (other, metadata(), abi.encode(validReport()))));
        assert(!ok && bytes4(reason) == FactoredCreSettlementReceiver.PoolNotBound.selector);
        assert(!other.finalized() && other.acceptedReportHash() == bytes32(0));
    }

    function testDirectCallerCannotForgeAuthenticMetadata() public {
        reject(
            address(this),
            metadata(),
            abi.encode(validReport()),
            FactoredCreSettlementReceiver.UnauthorizedForwarder.selector
        );
        reject(
            AUTHOR, metadata(), abi.encode(validReport()), FactoredCreSettlementReceiver.UnauthorizedForwarder.selector
        );
    }

    function testProductionMetadataLayoutHasExactly64Bytes() public {
        // Independent literal: 32-byte ID, 10 ASCII hex name bytes, 20-byte owner, report ID 0x0007.
        bytes memory fixture =
            hex"00000000000000000000000000000000000000000000000000000000000012343030313132326161626200000000000000000000000000000000000a11ce0007";
        assert(keccak256(fixture) == keccak256(metadata()));
        reject(
            address(forwarder),
            new bytes(0),
            abi.encode(validReport()),
            FactoredCreSettlementReceiver.InvalidMetadata.selector
        );
        reject(
            address(forwarder),
            abi.encodePacked(WORKFLOW, NAME, AUTHOR),
            abi.encode(validReport()),
            FactoredCreSettlementReceiver.InvalidMetadata.selector
        );
        reject(
            address(forwarder),
            bytes.concat(fixture, hex"00"),
            abi.encode(validReport()),
            FactoredCreSettlementReceiver.InvalidMetadata.selector
        );
        pool.fund();
        vm.warp(pool.closesAt());
        forwarder.deliver(receiver, fixture, abi.encode(validReport()));
        assert(pool.resolved());
    }

    function testAllWorkflowIdentityFieldsAreEnforced() public {
        bytes memory data = abi.encode(validReport());
        reject(
            address(forwarder),
            abi.encodePacked(bytes32(uint256(7)), NAME, AUTHOR, bytes2(0)),
            data,
            FactoredCreSettlementReceiver.UnauthorizedWorkflow.selector
        );
        reject(
            address(forwarder),
            abi.encodePacked(WORKFLOW, bytes10("different"), AUTHOR, bytes2(0)),
            data,
            FactoredCreSettlementReceiver.UnauthorizedWorkflow.selector
        );
        reject(
            address(forwarder),
            abi.encodePacked(WORKFLOW, NAME, address(this), bytes2(0)),
            data,
            FactoredCreSettlementReceiver.UnauthorizedWorkflow.selector
        );
    }

    function testChainPoolAndRulesAreBound() public {
        FactoredCreSettlementReceiver.SettlementReport memory result = validReport();
        result.chainId++;
        rejectReport(result, FactoredCreSettlementReceiver.WrongReportDomain.selector);
        result = validReport();
        result.pool = address(token);
        rejectReport(result, FactoredCreSettlementReceiver.WrongReportDomain.selector);
        result = validReport();
        result.rulesHash = keccak256("different rules");
        rejectReport(result, FactoredCreSettlementReceiver.WrongReportDomain.selector);
        result = validReport();
        vm.chainId(block.chainid + 1);
        rejectReport(result, FactoredCreSettlementReceiver.WrongReportDomain.selector);
    }

    function testReportVersionLengthAndCanonicalAbiAreEnforced() public {
        FactoredCreSettlementReceiver.SettlementReport memory result = validReport();
        result.version = 1;
        rejectReport(result, FactoredCreSettlementReceiver.InvalidReport.selector);
        reject(address(forwarder), metadata(), new bytes(223), FactoredCreSettlementReceiver.InvalidReport.selector);
        reject(
            address(forwarder),
            metadata(),
            bytes.concat(abi.encode(validReport()), hex"00"),
            FactoredCreSettlementReceiver.InvalidReport.selector
        );
        bytes memory data = abi.encode(validReport());
        data[0] = 0x01; // Nonzero high byte of ABI uint8: decoder must reject, not truncate.
        bytes32 before_ = snapshot();
        vm.prank(address(forwarder));
        (bool ok,) = address(receiver).call(abi.encodeCall(receiver.onReport, (metadata(), data)));
        assert(!ok && snapshot() == before_);
    }

    function testObservationsMustBeAfterCloseNotFutureFreshAndCommitted() public {
        rejectReport(validReport(), FactoredCreSettlementReceiver.InvalidObservation.selector); // close is still in future
        vm.warp(pool.closesAt());
        FactoredCreSettlementReceiver.SettlementReport memory result = validReport();
        result.observedAt--;
        rejectReport(result, FactoredCreSettlementReceiver.InvalidObservation.selector);
        result = validReport();
        result.observedAt++;
        rejectReport(result, FactoredCreSettlementReceiver.InvalidObservation.selector);
        result = validReport();
        result.observationsHash = bytes32(0);
        rejectReport(result, FactoredCreSettlementReceiver.InvalidObservation.selector);
        result = validReport();
        vm.warp(block.timestamp + 3601);
        rejectReport(result, FactoredCreSettlementReceiver.InvalidObservation.selector);
    }

    function testPoolRevertRollsBackReceiverThenCorrectedReportWorks() public {
        pool.fund();
        vm.warp(pool.closesAt());
        FactoredCreSettlementReceiver.SettlementReport memory result = validReport();
        result.terminalState = 4;
        rejectReport(result, FactoredPool.InvalidOutcome.selector);
        forwarder.deliver(receiver, metadata(), abi.encode(validReport()));
        assert(receiver.finalized() && pool.resolved());
    }

    function testUnfundedPoolCannotResolve() public {
        vm.warp(pool.closesAt());
        rejectReport(validReport(), FactoredFunding.NotFunded.selector);
    }

    function testSettlementRedeemsOverlappingClaimsAndPreventsAnySecondReport() public {
        pool.fund();
        pool.buy(1, 2, 10e6, 10e6, block.timestamp); // A
        pool.buy(3, 8, 10e6, 10e6, block.timestamp); // A AND B
        vm.warp(pool.closesAt());
        bytes memory data = abi.encode(validReport()); // state 3: both win
        uint256 cash = token.balanceOf(address(pool));
        forwarder.deliver(receiver, metadata(), data);
        assert(
            receiver.acceptedReportHash() == keccak256(abi.encode(block.chainid, address(receiver), metadata(), data))
        );
        assert(pool.resolvedState() == 3 && token.balanceOf(address(pool)) == cash);
        reject(address(forwarder), metadata(), data, FactoredCreSettlementReceiver.AlreadyFinalized.selector);
        FactoredCreSettlementReceiver.SettlementReport memory changed = validReport();
        changed.terminalState = 0;
        reject(
            address(forwarder),
            abi.encodePacked(WORKFLOW, NAME, AUTHOR, bytes2(uint16(8))),
            abi.encode(changed),
            FactoredCreSettlementReceiver.AlreadyFinalized.selector
        );
        assert(pool.redeem(1, 2, 10e6) == 10e6);
        assert(pool.redeem(3, 8, 10e6) == 10e6);
        assert(pool.requiredCollateral() == 0);
    }

    function testFuzzEveryValidStateAndReportId(uint8 stateSeed, bytes2 reportId) public {
        pool.fund();
        vm.warp(pool.closesAt() + 3600); // Inclusive maximum age is accepted.
        FactoredCreSettlementReceiver.SettlementReport memory result = validReport();
        result.terminalState = stateSeed % 4;
        forwarder.deliver(receiver, abi.encodePacked(WORKFLOW, NAME, AUTHOR, reportId), abi.encode(result));
        assert(receiver.finalized() && pool.resolved() && pool.resolvedState() == result.terminalState);
    }

    function testFullWidthOutcomeSettlesFundedPoolWithoutChangingBias() public {
        FactoredCreSettlementReceiver target = makeReceiver();
        uint8[] memory order = new uint8[](32);
        for (uint8 i; i < 32; i++) {
            order[i] = i;
        }
        FundedFactoredPool wide = new FundedFactoredPool(
            FundedFactoredPool.MarketConfig(
                address(token), 32, 10e6, uint64(block.timestamp + 1 days), order, address(target), RULES
            ),
            FundedFactoredPool.UpdatePolicy(address(this), 5e6, 20e6, 3600, 1)
        );
        target.bindPool(address(wide));
        token.approve(address(wide), type(uint256).max);
        wide.fund();
        Q.Factor[] memory learnedBias = new Q.Factor[](1);
        uint128[] memory values = new uint128[](2);
        values[1] = 100000;
        learnedBias[0] = Q.Factor(1, values);
        wide.updateBias(
            FundedFactoredPool.Update(block.chainid, address(wide), 0, block.timestamp + 100, 1e6, learnedBias)
        );
        wide.buy(uint32(1) << 31, 2, 1e6, 1e6, block.timestamp);
        bytes32 bias = keccak256(abi.encode(wide.biasFactors()));
        vm.warp(wide.closesAt());
        FactoredCreSettlementReceiver.SettlementReport memory result = FactoredCreSettlementReceiver.SettlementReport(
            2, block.chainid, address(wide), RULES, wide.closesAt(), keccak256("32 event evidence"), type(uint32).max
        );
        forwarder.deliver(target, metadata(), abi.encode(result));
        assert(wide.resolvedState() == type(uint32).max);
        assert(wide.actualRequiredCollateral() == 1e6 && wide.requiredCollateral() == 1e6);
        assert(keccak256(abi.encode(wide.biasFactors())) == bias);
        assert(wide.redeem(uint32(1) << 31, 2, 1e6) == 1e6);
        assert(wide.requiredCollateral() == 0);
    }

    function makeReceiver() private returns (FactoredCreSettlementReceiver) {
        return new FactoredCreSettlementReceiver(address(forwarder), WORKFLOW, NAME, AUTHOR, 3600);
    }

    function metadata() private pure returns (bytes memory) {
        return abi.encodePacked(WORKFLOW, NAME, AUTHOR, bytes2(uint16(7)));
    }

    function validReport() private view returns (FactoredCreSettlementReceiver.SettlementReport memory) {
        return FactoredCreSettlementReceiver.SettlementReport(
            2, block.chainid, address(pool), RULES, pool.closesAt(), keccak256("test observations"), 3
        );
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
                token.balanceOf(address(this))
            )
        );
    }

    function rejectReport(FactoredCreSettlementReceiver.SettlementReport memory result, bytes4 error) private {
        reject(address(forwarder), metadata(), abi.encode(result), error);
    }

    function reject(address caller, bytes memory meta, bytes memory data, bytes4 error) private {
        bytes32 before_ = snapshot();
        vm.prank(caller);
        (bool ok, bytes memory reason) = address(receiver).call(abi.encodeCall(receiver.onReport, (meta, data)));
        assert(!ok && reason.length >= 4 && bytes4(reason) == error);
        assert(snapshot() == before_);
    }

    function badConfig(address sender, bytes32 id, bytes10 name, address owner, uint64 age) private {
        try new FactoredCreSettlementReceiver(sender, id, name, owner, age) {
            assert(false);
        } catch (bytes memory reason) {
            assert(bytes4(reason) == FactoredCreSettlementReceiver.InvalidConfiguration.selector);
        }
    }
}
