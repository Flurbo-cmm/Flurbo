// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {FactoredPositions} from "./FactoredPositions.sol";
import {PilotPool} from "./PilotPool.sol";

/// @notice Separate testnet resolver: server-attested membership plus live holder-only challenges.
/// @dev No upgrades, operator override, panel rotation or unlimited retries. Bonds do not establish economic security.
contract AccountPilotResolver is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    error InvalidEligibility();
    address public immutable eligibilitySigner;
    mapping(uint256 => bool) public usedEligibility;
    struct Eligibility {
        bytes32 accountCommitment;
        address challenger;
        address holder;
        uint32 scope;
        uint256 mask;
        bool wrapped;
        uint256 nonce;
        uint64 deadline;
    }
    bytes32 public constant ELIGIBILITY_TYPEHASH = keccak256("Eligibility(bytes32 accountCommitment,address challenger,address holder,uint32 scope,uint256 mask,bool wrapped,uint256 nonce,uint64 deadline,uint8 eventIndex,uint8 alternative,bytes32 evidenceHash,bytes32 evidenceURIHash)");
    error InvalidConfig();
    error Unauthorized();
    error WrongPhase();
    error InvalidEvidence();
    error InvalidOutcome();
    error UnsupportedTransfer();

    enum Outcome { Unset, No, Yes, Void }
    enum Phase { Pending, Asserted, Disputed, Finalized }
    struct Config {
        address collateral;
        bytes32 draftHash;
        uint64 closesAt;
        bytes32[] eventHashes;
        uint64[] observationEnds;
        address[] reviewers;
        uint128 bond;
        uint32 assertionPeriod;
        uint32 challengePeriod;
        uint32 votingPeriod;
    }
    struct Case {
        Phase phase;
        Outcome proposal;
        Outcome counter;
        Outcome result;
        address asserter;
        address disputer;
        bytes32 evidenceHash;
        bytes32 counterEvidenceHash;
        uint64 challengeUntil;
        uint64 voteUntil;
        uint8[3] votes;
    }

    address public immutable creator;
    IERC20 public immutable collateral;
    bytes32 public immutable draftHash;
    bytes32 public immutable rulesHash;
    uint64 public immutable closesAt;
    uint128 public immutable bond;
    uint32 public immutable assertionPeriod;
    uint32 public immutable challengePeriod;
    uint32 public immutable votingPeriod;
    uint8 public immutable quorum;
    uint8 public immutable eventCount;
    address[] public reviewers;
    bytes32[] public eventHashes;
    uint64[] public observationEnds;
    mapping(address => bool) public isReviewer;
    mapping(uint8 => mapping(address => bool)) public voted;
    mapping(address => uint256) public credits;
    uint256 public lockedBonds;
    uint256 public totalCredits;
    Case[] private cases;
    PilotPool public pool;
    bool public delivered;

    event PoolBound(address indexed pool, bytes32 indexed rulesHash);
    event Asserted(uint8 indexed eventIndex, address indexed asserter, Outcome outcome, bytes32 evidenceHash, string evidenceURI, uint64 challengeUntil);
    event Disputed(uint8 indexed eventIndex, address indexed disputer, Outcome outcome, bytes32 evidenceHash, string evidenceURI, uint64 voteUntil);
    event Voted(uint8 indexed eventIndex, address indexed reviewer, Outcome outcome, bytes32 rationaleHash, string rationaleURI);
    event Finalized(uint8 indexed eventIndex, Outcome outcome, bool timedOut);
    event Delivered(address indexed pool, uint32 yesMask, uint32 voidMask);
    event BondWithdrawn(address indexed owner, uint256 amount);

    constructor(Config memory c, address authority) EIP712("Flurbo account challenges", "1") {
        if (authority == address(0) || authority == msg.sender) revert InvalidConfig();
        eligibilitySigner = authority;
        if (block.chainid != 10143 || c.collateral.code.length == 0 || c.draftHash == 0 || c.closesAt <= block.timestamp
            || c.eventHashes.length < 2 || c.eventHashes.length > 4 || c.eventHashes.length != c.observationEnds.length
            || (c.reviewers.length != 3 && c.reviewers.length != 5) || c.bond == 0
            || c.assertionPeriod < 1 hours || c.challengePeriod < 1 hours || c.votingPeriod < 1 hours
            || c.assertionPeriod > 30 days || c.challengePeriod > 7 days || c.votingPeriod > 7 days) revert InvalidConfig();
        for (uint256 i; i < c.eventHashes.length; ++i) {
            if (c.eventHashes[i] == 0 || c.observationEnds[i] <= c.closesAt
                || uint256(c.observationEnds[i]) + c.assertionPeriod + c.challengePeriod + c.votingPeriod > type(uint64).max) revert InvalidConfig();
            for (uint256 j; j < i; ++j) if (c.eventHashes[i] == c.eventHashes[j]) revert InvalidConfig();
            cases.push();
        }
        for (uint256 i; i < c.reviewers.length; ++i) {
            address reviewer = c.reviewers[i];
            if (reviewer == address(0) || reviewer == authority || isReviewer[reviewer]) revert InvalidConfig();
            isReviewer[reviewer] = true;
        }
        creator = msg.sender;
        collateral = IERC20(c.collateral);
        draftHash = c.draftHash;
        closesAt = c.closesAt;
        bond = c.bond;
        assertionPeriod = c.assertionPeriod;
        challengePeriod = c.challengePeriod;
        votingPeriod = c.votingPeriod;
        eventCount = uint8(c.eventHashes.length);
        quorum = uint8(c.reviewers.length / 2 + 1);
        reviewers = c.reviewers;
        eventHashes = c.eventHashes;
        observationEnds = c.observationEnds;
        // Address/chain binding prevents replay into another controller. Exact config is immutable.
        rulesHash = keccak256(abi.encode("flurbo.pilot.account-holders.v1", block.chainid, address(this), msg.sender, c, authority));
    }

    function bindPool(address target) external {
        if (msg.sender != creator) revert Unauthorized();
        if (address(pool) != address(0) || target.code.length == 0) revert InvalidConfig();
        PilotPool candidate = PilotPool(target);
        if (candidate.resolver() != address(this) || candidate.settlementRulesHash() != rulesHash
            || address(candidate.collateral()) != address(collateral) || candidate.eventCount() != eventCount
            || candidate.closesAt() != closesAt) revert InvalidConfig();
        pool = candidate;
        emit PoolBound(target, rulesHash);
    }

    function caseState(uint8 eventIndex) external view returns (Case memory) { return cases[eventIndex]; }
    function assertionDeadline(uint8 eventIndex) public view returns (uint64) { return observationEnds[eventIndex] + assertionPeriod; }

    function assertOutcome(uint8 eventIndex, Outcome outcome, bytes32 evidenceHash, string calldata evidenceURI) external nonReentrant {
        requireActive();
        checkEvidence(outcome, evidenceHash, evidenceURI);
        if (isReviewer[msg.sender]) revert Unauthorized();
        Case storage c = cases[eventIndex];
        if (c.phase != Phase.Pending || block.timestamp < observationEnds[eventIndex] || block.timestamp >= assertionDeadline(eventIndex)) revert WrongPhase();
        takeBond();
        c.phase = Phase.Asserted;
        c.proposal = outcome;
        c.asserter = msg.sender;
        c.evidenceHash = evidenceHash;
        c.challengeUntil = uint64(block.timestamp + challengePeriod);
        emit Asserted(eventIndex, msg.sender, outcome, evidenceHash, evidenceURI, c.challengeUntil);
    }

    function dispute(uint8 eventIndex, Outcome alternative, bytes32 evidenceHash, string calldata evidenceURI, Eligibility calldata eligibility, bytes calldata signature) external nonReentrant {
        requireActive();
        checkEvidence(alternative, evidenceHash, evidenceURI);
        Case storage c = cases[eventIndex];
        if (isReviewer[msg.sender] || msg.sender == c.asserter) revert Unauthorized();
        if (c.phase != Phase.Asserted || block.timestamp >= c.challengeUntil || alternative == c.proposal) revert WrongPhase();
        if (eligibility.challenger != msg.sender || eligibility.accountCommitment == bytes32(0)
            || eligibility.deadline <= block.timestamp || eligibility.deadline > block.timestamp + 120
            || eligibility.deadline > c.challengeUntil || usedEligibility[eligibility.nonce]
            || ECDSA.recover(eligibilityDigest(eventIndex, alternative, evidenceHash, evidenceURI, eligibility), signature) != eligibilitySigner
            || !hasQualifyingShares(eligibility.holder, eventIndex, eligibility.scope, eligibility.mask, eligibility.wrapped)) revert InvalidEligibility();
        usedEligibility[eligibility.nonce] = true;
        takeBond();
        c.phase = Phase.Disputed;
        c.counter = alternative;
        c.disputer = msg.sender;
        c.counterEvidenceHash = evidenceHash;
        c.voteUntil = uint64(block.timestamp + votingPeriod);
        emit Disputed(eventIndex, msg.sender, alternative, evidenceHash, evidenceURI, c.voteUntil);
    }

    function eligibilityDigest(uint8 eventIndex, Outcome alternative, bytes32 evidenceHash, string calldata evidenceURI, Eligibility calldata e) public view returns (bytes32) {
        // Eligibility contains only static fields, so its ABI encoding is the EIP-712 field sequence.
        return _hashTypedDataV4(keccak256(abi.encode(ELIGIBILITY_TYPEHASH, e,
            eventIndex, uint8(alternative), evidenceHash, keccak256(bytes(evidenceURI)))));
    }

    function hasQualifyingShares(address holder, uint8 eventIndex, uint32 scope, uint256 mask, bool wrapped) public view returns (bool) {
        if (address(pool) == address(0) || holder == address(0) || holder == address(pool) || holder == address(this)
            || eventIndex >= eventCount || uint256(scope) >> eventCount != 0 || (scope & (uint32(1) << eventIndex)) == 0) return false;
        FactoredPositions.key(scope, mask);
        uint256 width;
        uint256 localBit;
        for (uint8 i; i < eventCount; ++i) if ((scope & (uint32(1) << i)) != 0) {
            if (i == eventIndex) localBit = uint256(1) << width;
            width++;
        }
        bool dependent;
        for (uint256 state; state < (uint256(1) << width); ++state) {
            if (((mask >> state) & 1) != ((mask >> (state ^ localBit)) & 1)) { dependent = true; break; }
        }
        if (!dependent) return false;
        address yesToken = address(pool.baseTokens(uint32(1) << eventIndex, 2));
        address noToken = address(pool.baseTokens(uint32(1) << eventIndex, 1));
        if (holder == yesToken || holder == noToken) return false;
        if (wrapped) {
            if (scope != uint32(1) << eventIndex || (mask != 1 && mask != 2)) return false;
            address token = mask == 2 ? yesToken : noToken;
            return token != address(0) && IERC20(token).balanceOf(holder) > 0;
        }
        return pool.holdings(holder, scope, mask) > 0;
    }

    function vote(uint8 eventIndex, Outcome outcome, bytes32 rationaleHash, string calldata rationaleURI) external nonReentrant {
        checkEvidence(outcome, rationaleHash, rationaleURI);
        if (!isReviewer[msg.sender] || voted[eventIndex][msg.sender]) revert Unauthorized();
        Case storage c = cases[eventIndex];
        if (c.phase != Phase.Disputed || block.timestamp >= c.voteUntil) revert WrongPhase();
        voted[eventIndex][msg.sender] = true;
        uint8 count = ++c.votes[uint8(outcome) - 1];
        emit Voted(eventIndex, msg.sender, outcome, rationaleHash, rationaleURI);
        if (count == quorum) finish(eventIndex, outcome, false);
    }

    function finalize(uint8 eventIndex) external nonReentrant {
        requireActive();
        Case storage c = cases[eventIndex];
        if (c.phase == Phase.Pending && block.timestamp >= assertionDeadline(eventIndex)) finish(eventIndex, Outcome.Void, true);
        else if (c.phase == Phase.Asserted && block.timestamp >= c.challengeUntil) finish(eventIndex, c.proposal, false);
        else if (c.phase == Phase.Disputed && block.timestamp >= c.voteUntil) finish(eventIndex, Outcome.Void, true);
        else revert WrongPhase();
    }

    function deliver() external nonReentrant {
        requireActive();
        uint32 yesMask;
        uint32 invalidMask;
        for (uint8 i; i < eventCount; ++i) {
            if (cases[i].phase != Phase.Finalized) revert WrongPhase();
            if (cases[i].result == Outcome.Yes) yesMask |= uint32(1) << i;
            if (cases[i].result == Outcome.Void) invalidMask |= uint32(1) << i;
        }
        delivered = true;
        pool.resolve(yesMask, invalidMask);
        emit Delivered(address(pool), yesMask, invalidMask);
    }

    function withdrawBond() external nonReentrant {
        uint256 amount = credits[msg.sender];
        if (amount == 0) revert WrongPhase();
        credits[msg.sender] = 0;
        totalCredits -= amount;
        uint256 beforeSelf = collateral.balanceOf(address(this));
        uint256 beforeOwner = collateral.balanceOf(msg.sender);
        collateral.safeTransfer(msg.sender, amount);
        if (collateral.balanceOf(address(this)) + amount != beforeSelf || collateral.balanceOf(msg.sender) != beforeOwner + amount) revert UnsupportedTransfer();
        emit BondWithdrawn(msg.sender, amount);
    }

    function finish(uint8 eventIndex, Outcome outcome, bool timedOut) private {
        Case storage c = cases[eventIndex];
        uint256 amount = c.phase == Phase.Disputed ? uint256(bond) * 2 : c.phase == Phase.Asserted ? bond : 0;
        lockedBonds -= amount;
        if (amount != 0) {
            totalCredits += amount;
            if (c.phase == Phase.Asserted || (!timedOut && outcome == c.proposal)) credits[c.asserter] += amount;
            else if (!timedOut && outcome == c.counter) credits[c.disputer] += amount;
            else { credits[c.asserter] += bond; credits[c.disputer] += bond; }
        }
        c.phase = Phase.Finalized;
        c.result = outcome;
        emit Finalized(eventIndex, outcome, timedOut);
    }

    function takeBond() private {
        uint256 beforeSelf = collateral.balanceOf(address(this));
        uint256 beforeOwner = collateral.balanceOf(msg.sender);
        collateral.safeTransferFrom(msg.sender, address(this), bond);
        if (collateral.balanceOf(address(this)) != beforeSelf + bond || collateral.balanceOf(msg.sender) + bond != beforeOwner) revert UnsupportedTransfer();
        lockedBonds += bond;
    }

    function checkEvidence(Outcome outcome, bytes32 hash, string calldata uri) private pure {
        if (outcome == Outcome.Unset) revert InvalidOutcome();
        if (hash == 0 || bytes(uri).length < 8 || bytes(uri).length > 512) revert InvalidEvidence();
        bytes memory value = bytes(uri);
        if (bytes8(value) != bytes8("https://") && bytes7(value) != bytes7("ipfs://")) revert InvalidEvidence();
    }

    function requireActive() private view {
        if (address(pool) == address(0) || !pool.funded() || delivered) revert WrongPhase();
    }
}
