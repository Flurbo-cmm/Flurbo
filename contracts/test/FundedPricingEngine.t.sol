// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FundedPricingEngine} from "../src/FundedPricingEngine.sol";
import {FactoredQuote as Q} from "../src/FactoredQuote.sol";
import {FactoredCost as F} from "../src/FactoredCost.sol";

contract FundedPricingEngineTest {
    FundedPricingEngine engine = new FundedPricingEngine();

    function market() private pure returns (Q.Market memory m) {
        m.events = 2;
        m.liquidity = 100e6;
        m.decimals = 6;
        m.order = new uint8[](2);
        m.order[1] = 1;
        m.factors = new Q.Factor[](0);
    }

    function factor(uint32 scope, uint128 amount) private pure returns (Q.Factor memory f) {
        f.scope = scope;
        f.values = new uint128[](scope == 3 ? 4 : 2);
        f.values[f.values.length - 1] = amount;
    }

    function testQuotesAndReserveEncloseIndependentDecimalEnumeration() public view {
        Q.Market memory m = market();
        m.factors = new Q.Factor[](2);
        m.factors[0] = factor(1, 2e6);
        m.factors[1] = factor(3, 3e6);
        Q.Factor[] memory bias = new Q.Factor[](2);
        bias[0] = factor(1, 10e6);
        bias[1] = factor(3, 4e6);
        // Python Decimal, precision 80: C(v)=100*ln(sum(exp(v/100))).
        // q+a = [0,12,0,19]; buy/sell change only the final state by +/-1.
        // R=146.712440089767572026..., buy=.279844892404476238...,
        // sell=.277834022278633370... . Conservative rounding in 6-decimal atoms.
        assert(engine.reserve(m, bias) == 146712441);
        (Q.Quote memory buy, uint128 buyReserve) = engine.quote(m, bias, 3, 8, 1e6, true);
        (Q.Quote memory sell, uint128 sellReserve) = engine.quote(m, bias, 3, 8, 1e6, false);
        assert(buy.collateral == 279845 && sell.collateral == 277834);
        assert(buy.maxLiabilityAfter == 6e6 && sell.maxLiabilityAfter == 4e6);
        assert(buyReserve <= engine.reserve(m, bias) + buy.collateral);
        assert(sellReserve + sell.collateral <= engine.reserve(m, bias));
    }

    function testGlobalMinimumBiasIsExactEvenWhenLocalMinimaConflict() public view {
        Q.Market memory m = market();
        Q.Factor[] memory bias = new Q.Factor[](2);
        bias[0] = factor(1, 10e6); // A YES
        bias[1] = factor(3, 0);
        bias[1].values[0] = 10e6; // A NO
        bias[1].values[2] = 10e6;
        // Each local minimum is zero, but the sum equals 10 in every state.
        assert(engine.reserve(m, bias) == engine.reserve(m, new Q.Factor[](0)));
        (Q.Quote memory a,) = engine.quote(m, bias, 3, 8, 1e6, true);
        Q.Quote memory b = Q.buy(m, 3, 8, 1e6, 1e6);
        assert(a.collateral == b.collateral);
    }

    function testMovementBoundsJointBiasChangeAndCanonicalInputs() public {
        Q.Factor[] memory oldBias = new Q.Factor[](1);
        oldBias[0] = factor(1, 10e6);
        Q.Factor[] memory next = new Q.Factor[](2);
        next[0] = factor(1, 0);
        next[0].values[0] = 10e6;
        next[1] = factor(3, 5e6);
        assert(engine.movement(oldBias, next) == 25e6);
        // Exhaustively verify the advertised upper bound over every pair of states.
        int256[4] memory delta = [int256(10e6), int256(-10e6), int256(10e6), int256(-5e6)];
        for (uint256 i; i < 4; i++) {
            for (uint256 j; j < 4; j++) {
                assert(delta[i] - delta[j] <= int256(engine.movement(oldBias, next)));
            }
        }
        next[1].scope = 1;
        (bool ok, bytes memory err) = address(engine).call(abi.encodeCall(engine.movement, (oldBias, next)));
        assert(!ok && bytes4(err) == FundedPricingEngine.NonCanonicalBias.selector);
    }

    function testCombinedFactorCountAndMalformedShapesReject() public {
        Q.Market memory m = market();
        m.factors = new Q.Factor[](64);
        for (uint256 i; i < 64; i++) {
            m.factors[i] = factor(1, 0);
        }
        Q.Factor[] memory bias = new Q.Factor[](1);
        bias[0] = factor(1, 1);
        (bool ok, bytes memory err) = address(engine).call(abi.encodeCall(engine.reserve, (m, bias)));
        assert(!ok && bytes4(err) == F.TooManyFactors.selector);
        m = market();
        bias[0].scope = 3; // two-event scope needs four entries, not two
        (ok, err) = address(engine).call(abi.encodeCall(engine.reserve, (m, bias)));
        assert(!ok && bytes4(err) == F.InvalidValues.selector);
    }

    function testFuzzConservativeTradeReserveAcrossAmounts(uint64 raw) public view {
        Q.Market memory m = market();
        m.factors = new Q.Factor[](1);
        m.factors[0] = factor(3, 100e6);
        Q.Factor[] memory bias = new Q.Factor[](1);
        bias[0] = factor(1, uint128(raw % 100e6));
        uint128 qty = 1000 + uint128(raw % 99999000);
        uint128 before_ = engine.reserve(m, bias);
        (Q.Quote memory buy, uint128 buyReserve) = engine.quote(m, bias, 3, 8, qty, true);
        (Q.Quote memory sell, uint128 sellReserve) = engine.quote(m, bias, 3, 8, qty, false);
        assert(uint256(before_) + buy.collateral >= buyReserve);
        assert(uint256(sellReserve) + sell.collateral <= before_);
        assert(buyReserve >= buy.maxLiabilityAfter && sellReserve >= sell.maxLiabilityAfter);
    }
}
