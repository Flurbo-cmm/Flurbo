// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredQuote as Q} from "../src/FactoredQuote.sol";

/// @notice Regression properties of the shared LMSR distribution, not forecast calibration.
/// @dev exp(q[x]/b) / sum(exp(q/b)) defines p(x). Given A, conditional odds between
/// any two compatible states are exp((q[x]-q[y])/b). Testing these integer
/// differences exactly avoids a floating-point tolerance hiding an update error.
contract FactoredConditionalPropertiesTest {
    function testUnaryBuyAndSellPreserveIndependentConditionals() public pure {
        // Weights [1, exp(2), exp(1), exp(3)] factor into independent A and B.
        Q.Market memory m = market(false);
        uint256[] memory before_ = enumerate(m);
        assert(interaction(before_) == 0);
        uint256[] memory after_ = unaryRoundTrip(m, 25e6);
        assert(interaction(after_) == 0);
    }

    function testUnaryBuyAndSellPreservePositiveAssociation() public pure {
        // Weights [exp(2), 1, 1, exp(2)]: equal marginals with positive association.
        Q.Market memory m = market(true);
        uint256[] memory before_ = enumerate(m);
        assert(interaction(before_) > 0);
        uint256[] memory after_ = unaryRoundTrip(m, 25e6);
        assert(interaction(after_) == interaction(before_));
        // B's marginal need not be preserved. A's share of the population rises,
        // and P(B|A) > P(B|not A), so the law of total probability increases P(B).
        assert(conditionalLogOdds(after_, true) > conditionalLogOdds(after_, false));
    }

    function testUnaryBuyAndSellPreserveNegativeAssociation() public pure {
        Q.Market memory m = market(true);
        m.factors[0].values[0] = 0;
        m.factors[0].values[1] = 200e6;
        m.factors[0].values[2] = 200e6;
        m.factors[0].values[3] = 0;
        uint256[] memory before_ = enumerate(m);
        assert(interaction(before_) < 0);
        uint256[] memory after_ = unaryRoundTrip(m, 25e6);
        assert(interaction(after_) == interaction(before_));
    }

    function testAndBuyChangesConditionalAndSellRestoresIt() public pure {
        jointRoundTrip(8, 1, 0);
    }

    function testExactlyOneBuyChangesBothConditionalsAndSellRestoresThem() public pure {
        // XOR increases q(1,0) and q(0,1), so the two conditional odds move apart.
        jointRoundTrip(6, -1, 1);
    }

    function testFuzzUnaryTradePreservesWholeConditionalDistribution(uint256 seed, uint128 quantitySeed) public pure {
        Q.Market memory m;
        m.events = 3;
        m.liquidity = 100e6;
        m.decimals = 6;
        m.order = new uint8[](3);
        m.order[0] = 2;
        m.order[1] = 1;
        m.factors = new Q.Factor[](3);
        uint32[3] memory scopes = [uint32(1), 6, 5];
        for (uint256 i; i < scopes.length; i++) {
            m.factors[i].scope = scopes[i];
            m.factors[i].values = new uint128[](i == 0 ? 2 : 4);
            for (uint256 j; j < m.factors[i].values.length; j++) {
                m.factors[i].values[j] = uint128(uint256(keccak256(abi.encode(seed, i, j))) % 100e6);
            }
        }
        unaryRoundTrip(m, 1e6 + quantitySeed % 99e6);
    }

    function unaryRoundTrip(Q.Market memory m, uint128 quantity) private pure returns (uint256[] memory after_) {
        uint256[] memory before_ = enumerate(m);
        Q.Quote memory bought = Q.buy(m, 1, 2, quantity, quantity);
        m.factors = bought.factorsAfter;
        after_ = enumerate(m);
        // Whole conditional distribution of every other event given A or not A
        // is unchanged, even in a correlated three-event graph.
        for (uint256 x; x < before_.length; x++) {
            assert(after_[x] == before_[x] + ((x & 1) == 1 ? quantity : 0));
            for (uint256 y; y < before_.length; y++) {
                if ((x & 1) == (y & 1)) {
                    assert(int256(after_[x]) - int256(after_[y]) == int256(before_[x]) - int256(before_[y]));
                }
            }
        }
        // Do not assert a universal one-atom quote error. Existing independent
        // high-precision quote fixtures use the derived numerical enclosure.
        Q.Quote memory sold = Q.sell(m, 1, 2, quantity, 0);
        assert(sold.collateral <= bought.collateral);
        m.factors = sold.factorsAfter;
        equal(enumerate(m), before_);
    }

    function jointRoundTrip(uint256 mask, int256 expectedA, int256 expectedNotA) private pure {
        for (uint256 fixture; fixture < 2; fixture++) {
            Q.Market memory m = market(fixture == 1);
            uint256[] memory before_ = enumerate(m);
            uint128 quantity = 25e6;
            Q.Quote memory bought = Q.buy(m, 3, mask, quantity, quantity);
            m.factors = bought.factorsAfter;
            uint256[] memory after_ = enumerate(m);
            assert(
                conditionalLogOdds(after_, true) - conditionalLogOdds(before_, true)
                    == expectedA * int256(uint256(quantity))
            );
            assert(
                conditionalLogOdds(after_, false) - conditionalLogOdds(before_, false)
                    == expectedNotA * int256(uint256(quantity))
            );
            Q.Quote memory sold = Q.sell(m, 3, mask, quantity, 0);
            assert(sold.collateral <= bought.collateral);
            m.factors = sold.factorsAfter;
            equal(enumerate(m), before_);
        }
    }

    function market(bool correlated) private pure returns (Q.Market memory m) {
        m.events = 2;
        m.liquidity = 100e6;
        m.decimals = 6;
        m.order = new uint8[](2);
        m.order[1] = 1;
        m.factors = new Q.Factor[](1);
        m.factors[0].scope = 3;
        m.factors[0].values = new uint128[](4);
        if (correlated) {
            m.factors[0].values[0] = 200e6;
            m.factors[0].values[3] = 200e6;
        } else {
            m.factors[0].values[1] = 200e6;
            m.factors[0].values[2] = 100e6;
            m.factors[0].values[3] = 300e6;
        }
    }

    function enumerate(Q.Market memory m) private pure returns (uint256[] memory q) {
        // Independent test-only enumeration of the economic state, not a call
        // to the production graph projection or conditional analytics helpers.
        q = new uint256[](uint256(1) << m.events);
        for (uint256 state; state < q.length; state++) {
            for (uint256 i; i < m.factors.length; i++) {
                uint256 local;
                uint256 bit;
                for (uint256 event_; event_ < m.events; event_++) {
                    if ((m.factors[i].scope & (uint256(1) << event_)) != 0) {
                        local |= ((state >> event_) & 1) << bit++;
                    }
                }
                q[state] += m.factors[i].values[local];
            }
        }
    }

    function conditionalLogOdds(uint256[] memory q, bool a) private pure returns (int256) {
        // b * log(P(B|A)/P(not B|A)), or its not-A counterpart.
        return a ? int256(q[3]) - int256(q[1]) : int256(q[2]) - int256(q[0]);
    }

    function interaction(uint256[] memory q) private pure returns (int256) {
        // b times the log odds ratio; zero exactly characterizes independence
        // for these strictly positive two-event distributions.
        return int256(q[0]) + int256(q[3]) - int256(q[1]) - int256(q[2]);
    }

    function equal(uint256[] memory actual, uint256[] memory expected) private pure {
        assert(actual.length == expected.length);
        for (uint256 i; i < actual.length; i++) {
            assert(actual[i] == expected[i]);
        }
    }
}
