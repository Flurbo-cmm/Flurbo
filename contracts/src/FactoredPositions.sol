// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Exact, owner-specific balances for local Boolean claims in a single pool.
/// @dev Internal accounting only. The calling pool must authorize credits and validate event membership.
library FactoredPositions {
    error InvalidClaim();
    error InvalidQuantity();
    error InsufficientHoldings();

    struct Book {
        mapping(address => mapping(bytes32 => uint128)) balances;
    }

    function key(uint32 scope, uint256 mask) internal pure returns (bytes32) {
        uint256 size;
        for (uint32 s = scope; s != 0; s &= s - 1) {
            size++;
        }
        if (size == 0 || size > 3 || mask == 0 || mask >= (uint256(1) << (uint256(1) << size)) - 1) {
            revert InvalidClaim();
        }
        return keccak256(abi.encode(scope, mask));
    }

    function balance(Book storage self, address owner, uint32 scope, uint256 mask) internal view returns (uint128) {
        return self.balances[owner][key(scope, mask)];
    }

    function credit(Book storage self, address owner, uint32 scope, uint256 mask, uint128 quantity) internal {
        if (quantity == 0) revert InvalidQuantity();
        self.balances[owner][key(scope, mask)] += quantity;
    }

    function debit(Book storage self, address owner, uint32 scope, uint256 mask, uint128 quantity) internal {
        if (quantity == 0) revert InvalidQuantity();
        bytes32 id = key(scope, mask);
        if (self.balances[owner][id] < quantity) revert InsufficientHoldings();
        self.balances[owner][id] -= quantity;
    }
}
