// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Finite operator-funded demo tokens. No minting or access to market funds.
/// @dev Address limits are not person limits; anyone can create more addresses.
contract TestAusdFaucet is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public constant TOKEN = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    uint256 public constant CLAIM_AMOUNT = 50e6;
    uint256 public constant COOLDOWN = 1 days;
    address public immutable owner;
    mapping(address => uint256) public nextClaimAt;
    event Claimed(address indexed recipient, uint256 amount);
    event Withdrawn(uint256 amount);
    error WrongRecipient();
    error TooSoon();
    error InsufficientFunds();
    error OwnerOnly();

    constructor(address operator) {
        require(block.chainid == 10143, "Monad testnet only");
        require(operator != address(0), "Owner required");
        owner = operator;
    }

    function requestFunds(address recipient) external nonReentrant {
        if (recipient != msg.sender) revert WrongRecipient();
        if (block.timestamp < nextClaimAt[recipient]) revert TooSoon();
        if (IERC20(TOKEN).balanceOf(address(this)) < CLAIM_AMOUNT) revert InsufficientFunds();
        nextClaimAt[recipient] = block.timestamp + COOLDOWN;
        IERC20(TOKEN).safeTransfer(recipient, CLAIM_AMOUNT);
        emit Claimed(recipient, CLAIM_AMOUNT);
    }

    function withdraw(uint256 amount) external nonReentrant {
        if (msg.sender != owner) revert OwnerOnly();
        IERC20(TOKEN).safeTransfer(owner, amount);
        emit Withdrawn(amount);
    }
}
