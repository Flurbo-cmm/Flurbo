// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Disposable rehearsal asset. Never identify this as Agora-issued AUSD.
contract TestAsset is ERC20 {
    constructor() ERC20("Flurbo lab token", "LAB") { require(block.chainid == 31337); }
    function decimals() public pure override returns (uint8) { return 6; }
    function mint(address to, uint256 value) external { _mint(to, value); }
}
