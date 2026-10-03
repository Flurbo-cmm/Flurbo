// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Transferable receipt for an equal quantity of escrowed base-event claims.
/// @dev Canonical identity is the issuing pool's baseTokens(mask) registry, not the name/symbol.
contract BaseEventToken is ERC20 {
    error OnlyPool();

    address public immutable pool;
    uint256 public immutable mask;
    uint8 private immutable precision;

    constructor(uint256 mask_, uint8 decimals_, string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        pool = msg.sender;
        mask = mask_;
        precision = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return precision;
    }

    function mint(address owner, uint128 quantity) external {
        if (msg.sender != pool) revert OnlyPool();
        _mint(owner, quantity);
    }

    function burn(address owner, uint128 quantity) external {
        if (msg.sender != pool) revert OnlyPool();
        _burn(owner, quantity);
    }
}
