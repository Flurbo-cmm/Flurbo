// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {LmsrCost} from "./LmsrCost.sol";
import {QuoteMath} from "./QuoteMath.sol";

/// @notice Interval arithmetic for nonnegative factored log potentials.
/// @dev Dimensionless WAD logs, not collateral. No graph validation or trade endpoint.
/// Factored pricing scope and limits: docs/PROJECT_REFERENCE.md.
library FactoredLogMath {
    error InvalidBounds();
    error LogOutOfRange();
    error InvalidLiquidity();
    error LiabilityOutOfRange();

    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_LOG = 128e18;

    struct LogBounds {
        uint256 lower;
        uint256 upper;
    }

    /// @dev Enclose q/b, with whole-token WAD inputs and 0 <= q <= 100*b.
    function normalize(uint256 q, uint256 b) internal pure returns (LogBounds memory) {
        validateLiquidity(b);
        if (q > 100 * b) revert LiabilityOutOfRange();
        uint256 numerator = q * WAD;
        return LogBounds(numerator / b, ceilDiv(numerator, b));
    }

    /// @dev Product of positive potentials becomes exact endpoint addition in log space.
    function add(LogBounds memory a, LogBounds memory b) internal pure returns (LogBounds memory result) {
        validate(a);
        validate(b);
        result = LogBounds(a.lower + b.lower, a.upper + b.upper);
        validate(result);
    }

    /// @dev Eliminate one binary variable using monotonicity of ln(exp(a)+exp(b)).
    function logSumExp(LogBounds memory a, LogBounds memory b) internal pure returns (LogBounds memory result) {
        validate(a);
        validate(b);
        result = LogBounds(pair(a.lower, b.lower).lower, pair(a.upper, b.upper).upper);
        validate(result);
    }

    /// @dev Convert a caller-supplied log-partition enclosure into collateral WAD.
    /// Does not certify that the inputs came from a valid market graph.
    function cost(LogBounds memory logPartition, uint256 b) internal pure returns (QuoteMath.CostBounds memory) {
        validate(logPartition);
        validateLiquidity(b);
        return QuoteMath.CostBounds(b * logPartition.lower / WAD, ceilDiv(b * logPartition.upper, WAD));
    }

    function pair(uint256 a, uint256 b) private pure returns (LogBounds memory) {
        uint256 minimum = a < b ? a : b;
        uint256 maximum = a > b ? a : b;
        uint256 gap = maximum - minimum;
        // ln(1+exp(-d)) < exp(-d) < 1/WAD for d > 100.
        // This also handles interval endpoints just beyond the existing PRB proof's domain.
        if (gap > 100e18) return LogBounds(maximum, maximum + 1);
        uint256[] memory q = new uint256[](2);
        q[1] = gap;
        QuoteMath.CostBounds memory normalized = LmsrCost.bounds(q, WAD);
        return LogBounds(minimum + normalized.lowerWad, minimum + normalized.upperWad);
    }

    function validate(LogBounds memory value) private pure {
        if (value.lower > value.upper) revert InvalidBounds();
        if (value.upper > MAX_LOG) revert LogOutOfRange();
    }

    function validateLiquidity(uint256 b) private pure {
        if (b < 1e12 || b > 1e27) revert InvalidLiquidity();
    }

    function ceilDiv(uint256 numerator, uint256 denominator) private pure returns (uint256) {
        return numerator / denominator + (numerator % denominator == 0 ? 0 : 1);
    }
}
