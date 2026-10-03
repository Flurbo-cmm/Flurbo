// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredLogMath as M} from "../src/FactoredLogMath.sol";

contract FactoredLogHarness {
    function reduce(M.LogBounds memory a, M.LogBounds memory b) external pure returns (M.LogBounds memory) {
        return M.logSumExp(a, b);
    }

    function add(M.LogBounds memory a, M.LogBounds memory b) external pure returns (M.LogBounds memory) {
        return M.add(a, b);
    }

    function normalize(uint256 q, uint256 b) external pure returns (M.LogBounds memory) {
        return M.normalize(q, b);
    }
}

contract FactoredLogMathTest {
    FactoredLogHarness private harness = new FactoredLogHarness();

    function testFuzzSymmetryTranslationAndWidth(uint128 seedA, uint128 seedB) public pure {
        uint256 a = uint256(seedA) % 120e18;
        uint256 b = uint256(seedB) % 120e18;
        M.LogBounds memory original = M.logSumExp(M.LogBounds(a, a), M.LogBounds(b, b));
        M.LogBounds memory swapped = M.logSumExp(M.LogBounds(b, b), M.LogBounds(a, a));
        M.LogBounds memory shifted = M.logSumExp(M.LogBounds(a + 1e18, a + 1e18), M.LogBounds(b + 1e18, b + 1e18));
        assert(original.lower == swapped.lower && original.upper == swapped.upper);
        assert(shifted.lower == original.lower + 1e18 && shifted.upper == original.upper + 1e18);
        assert(original.upper - original.lower <= 2562);
        assert(original.lower >= a && original.lower >= b);
    }

    function testFuzzNormalizationEnclosesExactRatio(uint128 liquiditySeed, uint128 quantitySeed) public pure {
        uint256 b = 1e12 + uint256(liquiditySeed) % (1e27 - 1e12 + 1);
        uint256 q = uint256(quantitySeed) % (100 * b + 1);
        M.LogBounds memory result = M.normalize(q, b);
        assert(result.lower * b <= q * 1e18 && result.upper * b >= q * 1e18);
        assert(result.upper - result.lower <= 1);
    }

    function testIntervalEndpointsAndAddition() public pure {
        M.LogBounds memory a = M.LogBounds(1e18, 2e18);
        M.LogBounds memory b = M.LogBounds(3e18, 5e18);
        M.LogBounds memory sum = M.add(a, b);
        assert(sum.lower == 4e18 && sum.upper == 7e18);
        M.LogBounds memory result = M.logSumExp(a, b);
        M.LogBounds memory lower = M.logSumExp(M.LogBounds(a.lower, a.lower), M.LogBounds(b.lower, b.lower));
        M.LogBounds memory upper = M.logSumExp(M.LogBounds(a.upper, a.upper), M.LogBounds(b.upper, b.upper));
        assert(result.lower == lower.lower && result.upper == upper.upper);
    }

    function testRejectsInvalidAndUnenclosableDomains() public {
        M.LogBounds memory zero = M.LogBounds(0, 0);
        rejects(abi.encodeCall(harness.reduce, (M.LogBounds(1, 0), zero)), M.InvalidBounds.selector);
        rejects(abi.encodeCall(harness.reduce, (zero, M.LogBounds(0, 128e18 + 1))), M.LogOutOfRange.selector);
        rejects(abi.encodeCall(harness.add, (M.LogBounds(128e18, 128e18), M.LogBounds(1, 1))), M.LogOutOfRange.selector);
        rejects(abi.encodeCall(harness.reduce, (M.LogBounds(128e18, 128e18), zero)), M.LogOutOfRange.selector);
        rejects(abi.encodeCall(harness.normalize, (0, 1e12 - 1)), M.InvalidLiquidity.selector);
        rejects(abi.encodeCall(harness.normalize, (0, 1e27 + 1)), M.InvalidLiquidity.selector);
        rejects(abi.encodeCall(harness.normalize, (100e18 + 1, 1e18)), M.LiabilityOutOfRange.selector);
    }

    function rejects(bytes memory callData, bytes4 expected) private {
        (bool ok, bytes memory data) = address(harness).call(callData);
        assert(!ok && data.length == 4 && bytes4(data) == expected);
    }
}
