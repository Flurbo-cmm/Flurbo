// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Exact unit conversion and rounding of already-bounded cost estimates.
/// @dev Does not evaluate LMSR or prove supplied bounds. Keep this internal:
/// production callers must compute verified bounds from the actual pool state.
library QuoteMath {
    error UnsupportedDecimals();
    error AmountOverflow();
    error InvalidBounds();
    error UnresolvedDirection();

    struct CostBounds {
        uint256 lowerWad;
        uint256 upperWad;
    }

    /// @dev One whole collateral token is 1e18 internal units (WAD).
    function scale(uint8 decimals) internal pure returns (uint256) {
        if (decimals > 18) revert UnsupportedDecimals();
        return 10 ** (18 - decimals);
    }

    function toWad(uint128 atoms, uint8 decimals) internal pure returns (uint256) {
        // uint128.max * 1e18 fits uint256; no intermediate rounding.
        return uint256(atoms) * scale(decimals);
    }

    function fromWadDown(uint256 wad, uint8 decimals) internal pure returns (uint128) {
        return checkedAmount(wad / scale(decimals));
    }

    function fromWadUp(uint256 wad, uint8 decimals) internal pure returns (uint128) {
        uint256 factor = scale(decimals);
        uint256 atoms = wad / factor;
        // Avoid the potentially overflowing (wad + factor - 1) formulation.
        if (wad % factor != 0) atoms += 1;
        return checkedAmount(atoms);
    }

    /// @dev Charge ceil(upper(C_after) - lower(C_before)) in collateral atoms.
    function buyFromBounds(CostBounds memory before_, CostBounds memory after_, uint8 decimals)
        internal
        pure
        returns (uint128)
    {
        validate(before_);
        validate(after_);
        if (after_.upperWad < before_.lowerWad) revert UnresolvedDirection();
        return fromWadUp(after_.upperWad - before_.lowerWad, decimals);
    }

    /// @dev Pay floor(lower(C_before) - upper(C_after)) in collateral atoms.
    /// Reject overlapping bounds that cannot establish nonnegative proceeds.
    function sellFromBounds(CostBounds memory before_, CostBounds memory after_, uint8 decimals)
        internal
        pure
        returns (uint128)
    {
        validate(before_);
        validate(after_);
        if (before_.lowerWad < after_.upperWad) revert UnresolvedDirection();
        return fromWadDown(before_.lowerWad - after_.upperWad, decimals);
    }

    function validate(CostBounds memory bounds) private pure {
        if (bounds.lowerWad > bounds.upperWad) revert InvalidBounds();
    }

    function checkedAmount(uint256 atoms) private pure returns (uint128) {
        if (atoms > type(uint128).max) revert AmountOverflow();
        return uint128(atoms);
    }
}
