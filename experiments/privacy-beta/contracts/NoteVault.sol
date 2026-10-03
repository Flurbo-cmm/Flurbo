// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ISemaphore} from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Experimental fixed-lot ownership vault. NOT confidential trading.
/// @dev One asset per vault. No admin withdrawals, upgrades or fee deductions.
contract NoteVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    ISemaphore public immutable semaphore;
    IERC20 public immutable asset;
    uint256 public immutable lot;
    uint256 public immutable groupId;
    uint256 public immutable scope;
    uint256 public outstanding;
    mapping(uint256 => bool) public commitments;
    mapping(uint256 => bool) public spent;

    error InvalidNote();
    error InvalidSpend();
    error InexactTransfer();
    event Deposited(uint256 indexed commitment);
    event Withdrawn(uint256 indexed nullifier, address indexed recipient);

    constructor(ISemaphore semaphore_, IERC20 asset_, uint256 lot_) {
        // Deliberately exclude real-value networks from this unaudited beta.
        require(block.chainid == 10143 || block.chainid == 31337, "Test networks only");
        require(address(semaphore_).code.length > 0 && address(asset_).code.length > 0 && lot_ > 0);
        semaphore = semaphore_;
        asset = asset_;
        lot = lot_;
        groupId = semaphore_.createGroup(address(this));
        scope = uint256(keccak256(abi.encode("flurbo.note-vault.v1", block.chainid, address(this), address(asset_), lot_)));
    }

    function deposit(uint256 commitment) external nonReentrant {
        if (commitment == 0 || commitments[commitment]) revert InvalidNote();
        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), lot);
        if (asset.balanceOf(address(this)) != beforeBalance + lot) revert InexactTransfer();
        commitments[commitment] = true;
        outstanding++;
        semaphore.addMember(groupId, commitment);
        emit Deposited(commitment);
    }

    function withdrawalMessage(address recipient, uint256 deadline) public view returns (uint256) {
        return uint256(keccak256(abi.encode("withdraw", scope, recipient, deadline)));
    }

    /// @dev Anyone may relay the proof, but cannot redirect its payout. A direct
    /// call from the depositor wallet reveals that link; use a separate relayer.
    function withdraw(address recipient, uint256 deadline, ISemaphore.SemaphoreProof calldata proof) external nonReentrant {
        if (recipient == address(0) || recipient == address(this) || block.timestamp > deadline
            || proof.scope != scope || proof.message != withdrawalMessage(recipient, deadline)
            || spent[proof.nullifier] || outstanding == 0) revert InvalidSpend();
        // Use view verification plus OUR nullifier registry. Semaphore's public
        // validateProof can otherwise be front-run to consume a user's nullifier.
        if (!semaphore.verifyProof(groupId, proof)) revert InvalidSpend();
        spent[proof.nullifier] = true;
        outstanding--;
        uint256 beforeBalance = asset.balanceOf(address(this));
        uint256 beforeRecipient = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, lot);
        if (asset.balanceOf(address(this)) != beforeBalance - lot
            || asset.balanceOf(recipient) != beforeRecipient + lot) revert InexactTransfer();
        require(asset.balanceOf(address(this)) >= outstanding * lot, "Backing mismatch");
        emit Withdrawn(proof.nullifier, recipient);
    }
}
