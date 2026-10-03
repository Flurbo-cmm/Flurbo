// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ReferencePool} from "./ReferencePool.sol";

/// @dev Wire-compatible with Chainlink CRE IReceiver; signature verification belongs to the forwarder.
interface ICreReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

/// @notice Local-tested CRE settlement boundary, not a deployed or verified oracle integration.
/// @dev No authentication bypass, authority rotation, corrections, or direct admin resolution.
contract CreSettlementReceiver is ICreReceiver, ReentrancyGuard {
    error InvalidConfiguration();
    error UnauthorizedConfigurator();
    error PoolAlreadyBound();
    error InvalidPool();
    error PoolNotBound();
    error UnauthorizedForwarder();
    error InvalidMetadata();
    error UnauthorizedWorkflow();
    error AlreadyFinalized();
    error InvalidReport();
    error WrongReportDomain();
    error InvalidObservation();

    // Exactly seven ABI words. observedAt is the final observation's timestamp,
    // not necessarily the timestamp of every underlying event in the evidence.
    struct SettlementReport {
        uint8 version;
        uint256 chainId;
        address pool;
        bytes32 rulesHash;
        uint64 observedAt;
        bytes32 observationsHash;
        uint8 terminalState;
    }

    address public immutable configurator;
    address public immutable forwarder;
    bytes32 public immutable workflowId;
    bytes10 public immutable workflowName;
    address public immutable workflowOwner;
    uint64 public immutable maxReportAge;
    ReferencePool public pool;
    bool public finalized;
    bytes32 public acceptedReportHash;

    event PoolBound(address indexed pool, bytes32 indexed rulesHash);
    event SettlementAccepted(
        address indexed pool,
        bytes32 indexed reportHash,
        bytes32 indexed observationsHash,
        uint64 observedAt,
        uint8 terminalState,
        bytes2 reportId
    );

    constructor(address forwarder_, bytes32 id, bytes10 name, address owner, uint64 maxAge) {
        if (forwarder_.code.length == 0 || id == bytes32(0) || name == bytes10(0) || owner == address(0) || maxAge == 0)
        {
            revert InvalidConfiguration();
        }
        configurator = msg.sender;
        forwarder = forwarder_;
        workflowId = id;
        workflowName = name;
        workflowOwner = owner;
        maxReportAge = maxAge;
    }

    /// @notice Deploy receiver, deploy pool with this resolver, then bind once before inviting funding.
    function bindPool(address target) external {
        if (msg.sender != configurator) revert UnauthorizedConfigurator();
        if (address(pool) != address(0)) revert PoolAlreadyBound();
        if (target.code.length == 0) revert InvalidPool();
        ReferencePool candidate = ReferencePool(target);
        if (candidate.resolver() != address(this)) revert InvalidPool();
        pool = candidate;
        emit PoolBound(target, candidate.settlementRulesHash());
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == type(ICreReceiver).interfaceId || id == type(IERC165).interfaceId;
    }

    function onReport(bytes calldata metadata, bytes calldata report) external nonReentrant {
        if (msg.sender != forwarder) revert UnauthorizedForwarder();
        // Production KeystoneForwarder sends 62 identity bytes plus the two-byte report ID.
        if (metadata.length != 64) revert InvalidMetadata();
        if (
            bytes32(metadata[0:32]) != workflowId || bytes10(metadata[32:42]) != workflowName
                || address(bytes20(metadata[42:62])) != workflowOwner
        ) revert UnauthorizedWorkflow();
        if (address(pool) == address(0)) revert PoolNotBound();
        if (finalized) revert AlreadyFinalized();
        if (report.length != 7 * 32) revert InvalidReport();
        SettlementReport memory result = abi.decode(report, (SettlementReport));
        if (result.version != 1) revert InvalidReport();
        if (
            result.chainId != block.chainid || result.pool != address(pool)
                || result.rulesHash != pool.settlementRulesHash()
        ) revert WrongReportDomain();
        if (
            result.observationsHash == bytes32(0) || result.observedAt < pool.closesAt()
                || result.observedAt > block.timestamp || block.timestamp - result.observedAt > maxReportAge
        ) revert InvalidObservation();

        // A reverted resolve also rolls back these effects, allowing a corrected/retried delivery.
        finalized = true;
        acceptedReportHash = keccak256(abi.encode(block.chainid, address(this), metadata, report));
        pool.resolve(result.terminalState);
        emit SettlementAccepted(
            address(pool),
            acceptedReportHash,
            result.observationsHash,
            result.observedAt,
            result.terminalState,
            bytes2(metadata[62:64])
        );
    }
}
