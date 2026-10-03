// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredQuote as Q} from "./FactoredQuote.sol";
import {FactoredCost as F} from "./FactoredCost.sol";
import {QuoteMath as M} from "./QuoteMath.sol";

/// @notice Stateless integer reference engine. No balances, permissions or transfers.
/// @dev Shared payouts q and pricing bias a remain distinct. All factors use token atoms.
contract FundedPricingEngine {
    error NonCanonicalBias();

    function quote(Q.Market memory market, Q.Factor[] memory bias, uint32 scope, uint256 mask, uint128 qty, bool isBuy)
        external
        pure
        returns (Q.Quote memory result, uint128 reserveAfter)
    {
        M.CostBounds memory before_ = cost(market, bias);
        result.factorsAfter = Q.updatedFactors(market, scope, mask, qty, isBuy);
        market.factors = result.factorsAfter;
        M.CostBounds memory after_ = cost(market, bias);
        result.collateral = isBuy
            ? M.buyFromBounds(before_, after_, market.decimals)
            : M.sellFromBounds(before_, after_, market.decimals);
        if (result.collateral == 0 || (isBuy && result.collateral > qty)) revert Q.UnquotableTrade();
        result.maxLiabilityAfter = maximum(market);
        reserveAfter = reserveFromCost(market, bias, after_);
    }

    function maximum(Q.Market memory market) private pure returns (uint128) {
        return M.fromWadUp(
            F.maxLiability(
                market.events,
                M.toWad(market.liquidity, market.decimals),
                Q.toWad(market.factors, M.scale(market.decimals)),
                market.order
            ),
            market.decimals
        );
    }

    function reserve(Q.Market memory market, Q.Factor[] memory bias) external pure returns (uint128) {
        return reserveFromCost(market, bias, cost(market, bias));
    }

    function cost(Q.Market memory market, Q.Factor[] memory bias) private pure returns (M.CostBounds memory) {
        canonical(bias);
        if (market.factors.length + bias.length > 64) revert F.TooManyFactors();
        Q.Factor[] memory joined = new Q.Factor[](market.factors.length + bias.length);
        for (uint256 i; i < market.factors.length; i++) {
            joined[i] = market.factors[i];
        }
        for (uint256 i; i < bias.length; i++) {
            joined[market.factors.length + i] = bias[i];
        }
        return F.bounds(
            market.events,
            M.toWad(market.liquidity, market.decimals),
            Q.toWad(joined, M.scale(market.decimals)),
            market.order
        );
    }

    function reserveFromCost(Q.Market memory market, Q.Factor[] memory bias, M.CostBounds memory bounds)
        private
        pure
        returns (uint128)
    {
        // min(sum a_f) = sum(max a_f) - max(sum(max a_f - a_f)).
        // Exact max-sum inference avoids enumerating terminal outcomes.
        F.Factor[] memory reflected = Q.toWad(bias, M.scale(market.decimals));
        uint256 sumMax;
        for (uint256 i; i < reflected.length; i++) {
            uint256 high;
            for (uint256 j; j < reflected[i].values.length; j++) {
                if (reflected[i].values[j] > high) high = reflected[i].values[j];
            }
            sumMax += high;
            for (uint256 j; j < reflected[i].values.length; j++) {
                reflected[i].values[j] = high - reflected[i].values[j];
            }
        }
        uint256 minimum =
            sumMax - F.maxLiability(market.events, M.toWad(market.liquidity, market.decimals), reflected, market.order);
        return M.fromWadUp(bounds.upperWad - minimum, market.decimals);
    }

    /// @notice Conservative upper bound on range_x(a_new(x)-a_old(x)), in atoms.
    /// @dev Canonical factor scopes align tables. Sum of local ranges bounds global range.
    function movement(Q.Factor[] memory oldBias, Q.Factor[] memory newBias) external pure returns (uint256 span) {
        canonical(oldBias);
        canonical(newBias);
        uint256 i;
        uint256 j;
        while (i < oldBias.length || j < newBias.length) {
            bool takeOld = i < oldBias.length && (j == newBias.length || oldBias[i].scope <= newBias[j].scope);
            bool takeNew = j < newBias.length && (i == oldBias.length || newBias[j].scope <= oldBias[i].scope);
            uint256 count = takeOld ? oldBias[i].values.length : newBias[j].values.length;
            if (takeOld && takeNew && count != newBias[j].values.length) revert NonCanonicalBias();
            int256 low = type(int256).max;
            int256 high = type(int256).min;
            for (uint256 k; k < count; k++) {
                int256 delta = (takeNew ? int256(uint256(newBias[j].values[k])) : int256(0))
                    - (takeOld ? int256(uint256(oldBias[i].values[k])) : int256(0));
                if (delta < low) low = delta;
                if (delta > high) high = delta;
            }
            span += uint256(high - low);
            if (takeOld) i++;
            if (takeNew) j++;
        }
    }

    function canonical(Q.Factor[] memory bias) private pure {
        if (bias.length > 64) revert F.TooManyFactors();
        for (uint256 i; i < bias.length; i++) {
            if (
                bias[i].scope == 0 || (i != 0 && bias[i - 1].scope >= bias[i].scope) || bias[i].values.length == 0
                    || bias[i].values.length > 8
            ) revert NonCanonicalBias();
            uint128 low = type(uint128).max;
            for (uint256 j; j < bias[i].values.length; j++) {
                if (bias[i].values[j] < low) low = bias[i].values[j];
            }
            if (low != 0) revert NonCanonicalBias();
        }
    }
}
