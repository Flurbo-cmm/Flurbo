// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice ERC-20 receipt for a factored pool's escrowed base-event claim.
/// @dev Canonical identity is pool.baseTokens(scope, mask), never the display name or factory alone.
contract FactoredBaseToken is ERC20 {
    error OnlyPool();
    error InvalidIdentity();
    address public immutable pool;
    uint32 public immutable scope;
    uint8 public immutable mask;
    uint8 private immutable precision;

    constructor(address pool_, uint32 scope_, uint8 mask_, uint8 decimals_, string memory name_, string memory symbol_)
        ERC20(name_, symbol_)
    {
        if (
            pool_ == address(0) || scope_ == 0 || (scope_ & (scope_ - 1)) != 0 || (mask_ != 1 && mask_ != 2)
                || decimals_ > 18
        ) {
            revert InvalidIdentity();
        }
        pool = pool_;
        scope = scope_;
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
