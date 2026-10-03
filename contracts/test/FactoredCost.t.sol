// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredCost as F} from "../src/FactoredCost.sol";
import {LmsrCost} from "../src/LmsrCost.sol";
import {QuoteMath} from "../src/QuoteMath.sol";

contract FactoredCostHarness {
    function boundsAndMax(uint8 events, uint256 b, F.Factor[] memory factors, uint8[] memory order)
        external
        pure
        returns (QuoteMath.CostBounds memory, uint256)
    {
        return F.boundsAndMax(events, b, factors, order);
    }

    function maxLiability(uint8 events, uint256 b, F.Factor[] memory factors, uint8[] memory order)
        external
        pure
        returns (uint256)
    {
        return F.maxLiability(events, b, factors, order);
    }

    function bounds(uint8 events, uint256 b, F.Factor[] memory factors, uint8[] memory order)
        external
        pure
        returns (QuoteMath.CostBounds memory)
    {
        return F.bounds(events, b, factors, order);
    }
}

contract FactoredCostTest {
    FactoredCostHarness private harness = new FactoredCostHarness();

    function testFuzzEnumerationTranslationAndInputPreservation(uint256 seed, uint128 liquiditySeed) public pure {
        uint256 b = 1e12 + uint256(liquiditySeed) % (1e27 - 1e12 + 1);
        F.Factor[] memory factors = new F.Factor[](4);
        uint32[4] memory scopes = [uint32(1), 6, 5, 0];
        for (uint256 i; i < 4; i++) {
            factors[i] = factor(scopes[i], i == 0 ? 2 : (i == 3 ? 1 : 4));
            for (uint256 j; j < factors[i].values.length; j++) {
                factors[i].values[j] = uint256(keccak256(abi.encode(seed, i, j))) % (b + 1);
            }
        }
        uint8[] memory order = permutation(hex"020001");
        bytes32 before_ = keccak256(abi.encode(factors, order));
        QuoteMath.CostBounds memory result = F.bounds(3, b, factors, order);
        uint256 maximum = F.maxLiability(3, b, factors, order);
        (QuoteMath.CostBounds memory combined, uint256 combinedMaximum) = F.boundsAndMax(3, b, factors, order);
        assert(
            combined.lowerWad == result.lowerWad && combined.upperWad == result.upperWad && combinedMaximum == maximum
        );
        assert(keccak256(abi.encode(factors, order)) == before_);
        // Full enumeration is test-only and uses an independent indexing loop.
        uint256[] memory q = new uint256[](8);
        for (uint256 state; state < 8; state++) {
            for (uint256 i; i < factors.length; i++) {
                uint256 local;
                uint256 bit;
                for (uint256 event_; event_ < 3; event_++) {
                    if (factors[i].scope & (uint256(1) << event_) != 0) {
                        local |= ((state >> event_) & 1) << bit++;
                    }
                }
                q[state] += factors[i].values[local];
            }
        }
        QuoteMath.CostBounds memory enumerated = LmsrCost.bounds(q, b);
        assert(result.lowerWad <= enumerated.upperWad && enumerated.lowerWad <= result.upperWad);
        uint256 enumeratedMaximum;
        for (uint256 i; i < q.length; i++) {
            if (q[i] > enumeratedMaximum) enumeratedMaximum = q[i];
        }
        assert(maximum == enumeratedMaximum && maximum <= result.upperWad);
        factors[3].values[0] += b;
        QuoteMath.CostBounds memory shifted = F.bounds(3, b, factors, order);
        assert(shifted.lowerWad == result.lowerWad + b && shifted.upperWad == result.upperWad + b);
        assert(F.maxLiability(3, b, factors, order) == maximum + b);
    }

    function testRejectsInvalidDomainsBeforeEvaluation() public {
        F.Factor[] memory empty = new F.Factor[](0);
        uint8[] memory order = permutation(hex"0001");
        rejects(0, 1e18, empty, order, F.InvalidEventCount.selector);
        rejects(33, 1e18, empty, order, F.InvalidEventCount.selector);
        rejects(2, 1e12 - 1, empty, order, F.InvalidLiquidity.selector);
        rejects(2, 1e27 + 1, empty, order, F.InvalidLiquidity.selector);
        rejects(2, 1e18, empty, permutation(hex"00"), F.InvalidOrder.selector);
        rejects(2, 1e18, empty, permutation(hex"0000"), F.InvalidOrder.selector);
        rejects(2, 1e18, empty, permutation(hex"0002"), F.InvalidOrder.selector);
        rejects(2, 1e18, new F.Factor[](65), order, F.TooManyFactors.selector);
        F.Factor[] memory factors = new F.Factor[](1);
        factors[0] = factor(4, 2);
        rejects(2, 1e18, factors, order, F.InvalidScope.selector);
        factors[0] = factor(15, 16);
        rejects(4, 1e18, factors, permutation(hex"00010203"), F.InvalidScope.selector);
        factors[0] = factor(1, 1);
        rejects(2, 1e18, factors, order, F.InvalidValues.selector);
        factors[0] = factor(1, 2);
        factors[0].values[0] = type(uint256).max;
        rejects(2, 1e18, factors, order, F.InvalidValues.selector);
        factors = new F.Factor[](2);
        factors[0] = factor(1, 2);
        factors[1] = factor(1, 2);
        factors[0].values[0] = 60e18;
        factors[1].values[1] = 60e18;
        rejects(2, 1e18, factors, order, F.InvalidValues.selector);
        // Exactly at the conservative sum-of-maxima boundary is accepted.
        factors[1].values[1] = 40e18;
        F.bounds(2, 1e18, factors, order);
    }

    function testRejectsFillInAndKeepsDeclaredZeroScopes() public {
        F.Factor[] memory star = new F.Factor[](3);
        star[0] = factor(3, 4);
        star[1] = factor(5, 4);
        star[2] = factor(9, 4);
        rejects(4, 1e18, star, permutation(hex"00010203"), F.WidthExceeded.selector);
        uint8[] memory leavesFirst = permutation(hex"01020300");
        assert(F.validate(4, 1e18, star, leavesFirst) == 1);
        F.Factor[] memory clique = new F.Factor[](4);
        for (uint256 i; i < 3; i++) {
            clique[i] = star[i];
        }
        clique[3] = factor(14, 8);
        rejects(4, 1e18, clique, leavesFirst, F.WidthExceeded.selector);
    }

    function testIncompatibleMaximaUseOneSharedOutcome() public pure {
        F.Factor[] memory factors = new F.Factor[](4);
        uint32[3] memory scopes = [uint32(5), 12, 9];
        for (uint256 i; i < 3; i++) {
            factors[i] = factor(scopes[i], 4);
            factors[i].values[1] = 10e18 + 1;
            factors[i].values[2] = 10e18 + 1;
        }
        factors[3] = factor(0, 1);
        factors[3].values[0] = 7e18;
        // Three pairwise inequalities around a triangle cannot all hold at once.
        // Event 1 is disconnected; noncontiguous scopes still map bits canonically.
        assert(F.maxLiability(4, 10e18, factors, permutation(hex"03010200")) == 27e18 + 2);
        assert(F.maxLiability(4, 10e18, factors, permutation(hex"00020301")) == 27e18 + 2);
    }

    function testDuplicateScopesAndLargeValuesRemainExact() public pure {
        F.Factor[] memory factors = new F.Factor[](2);
        factors[0] = factor(1, 2);
        factors[1] = factor(1, 2);
        factors[0].values[0] = 1e28 + 1;
        factors[1].values[1] = 1e28;
        assert(F.maxLiability(1, 1e27, factors, permutation(hex"00")) == 1e28 + 1);
        factors[1].values[0] = 1;
        assert(F.maxLiability(1, 1e27, factors, permutation(hex"00")) == 1e28 + 2);
    }

    function testEmptyModelAndSixtyFourConstantsAcrossThirtyTwoEvents() public pure {
        uint8[] memory order = new uint8[](32);
        for (uint8 i; i < 32; i++) {
            order[i] = 31 - i;
        }
        assert(F.maxLiability(32, 1e27, new F.Factor[](0), order) == 0);
        F.Factor[] memory factors = new F.Factor[](64);
        for (uint256 i; i < 64; i++) {
            factors[i] = factor(0, 1);
            factors[i].values[0] = 1e27 + i;
        }
        assert(F.maxLiability(32, 1e27, factors, order) == 64e27 + 2016);
    }

    function rejects(uint8 events, uint256 b, F.Factor[] memory factors, uint8[] memory order, bytes4 expected)
        private
    {
        (bool ok, bytes memory data) =
            address(harness).call(abi.encodeCall(harness.bounds, (events, b, factors, order)));
        assert(!ok && data.length == 4 && bytes4(data) == expected);
        (ok, data) = address(harness).call(abi.encodeCall(harness.maxLiability, (events, b, factors, order)));
        assert(!ok && data.length == 4 && bytes4(data) == expected);
        (ok, data) = address(harness).call(abi.encodeCall(harness.boundsAndMax, (events, b, factors, order)));
        assert(!ok && data.length == 4 && bytes4(data) == expected);
    }

    function permutation(bytes memory raw) private pure returns (uint8[] memory order) {
        order = new uint8[](raw.length);
        for (uint256 i; i < raw.length; i++) {
            order[i] = uint8(raw[i]);
        }
    }

    function factor(uint32 scope, uint256 length) private pure returns (F.Factor memory) {
        return F.Factor(scope, new uint256[](length));
    }
}
