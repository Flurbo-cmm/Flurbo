// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {LmsrCost} from "../src/LmsrCost.sol";
import {QuoteMath} from "../src/QuoteMath.sol";

contract LmsrCostHarness {
    function bounds(uint256[] memory q, uint256 b) external pure returns (QuoteMath.CostBounds memory) {
        return LmsrCost.bounds(q, b);
    }
}

contract LmsrCostTest {
    LmsrCostHarness private harness = new LmsrCostHarness();

    function testFuzzTranslationAndCoverage(uint64 seed, uint8 countSeed, uint128 liquiditySeed) public pure {
        uint256 n = 2 ** (1 + countSeed % 3);
        uint256 b = 1e12 + uint256(liquiditySeed) % (1e27 - 1e12 + 1);
        uint256[] memory q = new uint256[](n);
        uint256 maximum;
        for (uint256 i; i < n; i++) {
            q[i] = uint256(keccak256(abi.encode(seed, i))) % (99 * b + 1);
            if (q[i] > maximum) maximum = q[i];
        }
        QuoteMath.CostBounds memory original = LmsrCost.bounds(q, b);
        assert(original.lowerWad >= maximum && original.upperWad >= original.lowerWad);
        for (uint256 i; i < n; i++) {
            q[i] += b;
        }
        QuoteMath.CostBounds memory shifted = LmsrCost.bounds(q, b);
        assert(shifted.lowerWad == original.lowerWad + b);
        assert(shifted.upperWad == original.upperWad + b);
    }

    function testRejectsUnsupportedDomain() public {
        uint256[] memory q = new uint256[](3);
        rejects(q, 1e18, LmsrCost.InvalidStateCount.selector);
        q = new uint256[](2);
        rejects(q, 1e12 - 1, LmsrCost.InvalidLiquidity.selector);
        rejects(q, 1e27 + 1, LmsrCost.InvalidLiquidity.selector);
        q[1] = 100e18 + 1;
        rejects(q, 1e18, LmsrCost.LiabilityOutOfRange.selector);
    }

    function rejects(uint256[] memory q, uint256 b, bytes4 expected) private {
        (bool ok, bytes memory data) = address(harness).call(abi.encodeCall(harness.bounds, (q, b)));
        assert(!ok && data.length == 4 && bytes4(data) == expected);
    }
}
