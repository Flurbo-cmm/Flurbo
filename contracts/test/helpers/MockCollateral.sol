// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Test-only mint/burn and adversarial behaviors. Not a deployable collateral integration.
contract MockCollateral is ERC20 {
    uint8 private immutable precision;
    uint8 public mode; // 0 normal, 1 false, 2 revert, 3 receiver tax, 4 callback, 5 sender fee, 6 no return
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes4 public callbackError;

    constructor(uint8 decimals_) ERC20("Test Collateral", "TEST") {
        precision = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return precision;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function setMode(uint8 value) external {
        mode = value;
    }

    function setCallback(address target, bytes calldata data) external {
        mode = 4;
        callbackTarget = target;
        callbackData = data;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        require(mode != 2, "mock transfer failure");
        bool ok = super.transfer(to, amount);
        afterTransfer(msg.sender, to, amount);
        if (mode == 6) assembly { return(0, 0) }
        return ok;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (mode == 1) return false;
        require(mode != 2, "mock transfer failure");
        bool ok = super.transferFrom(from, to, amount);
        afterTransfer(from, to, amount);
        if (mode == 6) assembly { return(0, 0) }
        return ok;
    }

    function afterTransfer(address from, address to, uint256 amount) private {
        if (amount != 0 && mode == 3) _burn(to, 1);
        if (amount != 0 && mode == 5) _burn(from, 1);
        if (mode == 4) {
            bytes memory result;
            (callbackSucceeded, result) = callbackTarget.call(callbackData);
            callbackError = result.length >= 4 ? bytes4(result) : bytes4(0);
        }
    }
}
