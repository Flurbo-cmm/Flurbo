// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {ud} from "@prb/math/src/UD60x18.sol";
import {QuoteMath} from "./QuoteMath.sol";

/// @notice Bounded enumerated LMSR cost for the small-state validation engine.
/// @dev All inputs and outputs use WAD, not collateral atoms. No trading endpoint.
/// Error derivation is checked by the contract tests; see docs/PROJECT_REFERENCE.md for deployed limits.
library LmsrCost {
    error InvalidStateCount();
    error InvalidLiquidity();
    error LiabilityOutOfRange();
    error WeightOutOfRange();

    uint256 internal constant WAD = 1e18;
    uint256 internal constant WEIGHT_ERROR = 512;
    uint256 internal constant LOG_ERROR = 256;

    /// @dev Supports 2/4/8 states, 1e-6 <= b <= 1e9 tokens, 0 <= q[i] <= 100*b.
    /// Rejects outside this domain; never approximates an unsupported state space.
    function bounds(uint256[] memory q, uint256 b) internal pure returns (QuoteMath.CostBounds memory) {
        uint256 n = q.length;
        if (n != 2 && n != 4 && n != 8) revert InvalidStateCount();
        if (b < 1e12 || b > 1e27) revert InvalidLiquidity();
        uint256 maximum;
        for (uint256 i; i < n; i++) {
            if (q[i] > 100 * b) revert LiabilityOutOfRange();
            if (q[i] > maximum) maximum = q[i];
        }
        uint256 sum;
        for (uint256 i; i < n; i++) {
            uint256 distance = (maximum - q[i]) * WAD / b;
            // Reciprocal of positive exp avoids signed exp underflow conventions.
            uint256 weight = 1e36 / ud(distance).exp().unwrap();
            if (weight > WAD) revert WeightOutOfRange();
            sum += weight;
        }
        // A maximum-liability state contributes exactly WAD; ln input is [1,8].
        if (sum < WAD) revert WeightOutOfRange();
        uint256 estimate = maximum + b * ud(sum).ln().unwrap() / WAD;
        uint256 errorNumerator = b * (n * WEIGHT_ERROR + LOG_ERROR);
        uint256 error = errorNumerator / WAD + (errorNumerator % WAD == 0 ? 0 : 1) + 1;
        // C(q) >= max(q) independently, so this tightens the lower endpoint safely.
        uint256 lower = estimate > error ? estimate - error : 0;
        if (lower < maximum) lower = maximum;
        return QuoteMath.CostBounds(lower, estimate + error);
    }
}
