// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredCost as F} from "./FactoredCost.sol";
import {QuoteMath} from "./QuoteMath.sol";

/// @notice Fee-free, conservative local Boolean quotes against a factored snapshot.
/// @dev All public struct amounts are collateral atoms. No ownership, funding or transfers.
library FactoredQuote {
    error InvalidMask();
    error InvalidQuantity();
    error InsufficientLiability();
    error UnquotableTrade();
    error MaxCostExceeded();
    error MinProceedsNotMet();

    struct Factor {
        uint32 scope;
        uint128[] values;
    }

    struct Market {
        uint8 events;
        uint128 liquidity;
        uint8 decimals;
        Factor[] factors;
        uint8[] order;
    }

    struct Quote {
        uint128 collateral;
        Factor[] factorsAfter;
        uint128 maxLiabilityAfter;
    }

    function buy(Market memory market, uint32 scope, uint256 mask, uint128 quantity, uint128 maxCost)
        internal
        pure
        returns (Quote memory quote)
    {
        quote = simulate(market, scope, mask, quantity, true);
        if (quote.collateral > maxCost) revert MaxCostExceeded();
    }

    function sell(Market memory market, uint32 scope, uint256 mask, uint128 quantity, uint128 minProceeds)
        internal
        pure
        returns (Quote memory quote)
    {
        quote = simulate(market, scope, mask, quantity, false);
        if (quote.collateral < minProceeds) revert MinProceedsNotMet();
    }

    function simulate(Market memory market, uint32 scope, uint256 mask, uint128 quantity, bool isBuy)
        private
        pure
        returns (Quote memory quote)
    {
        if (quantity == 0 || quantity > market.liquidity) revert InvalidQuantity();
        uint256 scale = QuoteMath.scale(market.decimals);
        uint256 b = uint256(market.liquidity) * scale;
        F.Factor[] memory beforeWad = toWad(market.factors, scale);
        QuoteMath.CostBounds memory before_ = F.bounds(market.events, b, beforeWad, market.order);
        quote.factorsAfter = updatedFactors(market, scope, mask, quantity, isBuy);
        price(market, before_, quote, isBuy);
        if (quote.collateral == 0 || (isBuy && quote.collateral > quantity)) revert UnquotableTrade();
    }

    /// @dev Liability update only. Caller must validate the input and resulting factor graphs.
    function updatedFactors(Market memory market, uint32 scope, uint256 mask, uint128 quantity, bool isBuy)
        internal
        pure
        returns (Factor[] memory)
    {
        if (quantity == 0 || quantity > market.liquidity) revert InvalidQuantity();
        uint256 size;
        for (uint32 s = scope; s != 0; s &= s - 1) {
            size++;
        }
        if (scope == 0 || uint256(scope) >> market.events != 0 || size > 3) revert F.InvalidScope();
        uint256 states = uint256(1) << size;
        uint256 full = (uint256(1) << states) - 1;
        if (mask == 0 || mask >= full) revert InvalidMask();

        return update(market.factors, scope, mask, quantity, states, isBuy);
    }

    function price(Market memory market, QuoteMath.CostBounds memory before_, Quote memory quote, bool isBuy)
        private
        pure
    {
        uint256 scale = QuoteMath.scale(market.decimals);
        uint256 b = uint256(market.liquidity) * scale;
        F.Factor[] memory afterWad = toWad(quote.factorsAfter, scale);
        (QuoteMath.CostBounds memory after_, uint256 maximum) = F.boundsAndMax(market.events, b, afterWad, market.order);
        quote.collateral = isBuy
            ? QuoteMath.buyFromBounds(before_, after_, market.decimals)
            : QuoteMath.sellFromBounds(before_, after_, market.decimals);
        // Atom-aligned input sums/maxima remain atom-aligned; this conversion is exact.
        quote.maxLiabilityAfter = QuoteMath.fromWadUp(maximum, market.decimals);
    }

    function update(Factor[] memory factors, uint32 scope, uint256 mask, uint128 quantity, uint256 states, bool isBuy)
        private
        pure
        returns (Factor[] memory after_)
    {
        uint256 matches;
        for (uint256 i; i < factors.length; i++) {
            if (factors[i].scope == scope) matches++;
        }
        uint256 count = factors.length + 1 - matches;
        if (count > 64) revert F.TooManyFactors();
        after_ = new Factor[](count);
        uint128[] memory values = new uint128[](states);
        uint256 cursor;
        for (uint256 i; i < factors.length; i++) {
            if (factors[i].scope == scope) {
                for (uint256 j; j < states; j++) {
                    values[j] += factors[i].values[j];
                }
            } else {
                uint128[] memory copy = new uint128[](factors[i].values.length);
                for (uint256 j; j < copy.length; j++) {
                    copy[j] = factors[i].values[j];
                }
                after_[cursor++] = Factor(factors[i].scope, copy);
            }
        }
        for (uint256 j; j < states; j++) {
            if (mask & (uint256(1) << j) != 0) {
                if (isBuy) {
                    values[j] += quantity;
                } else {
                    if (values[j] < quantity) revert InsufficientLiability();
                    values[j] -= quantity;
                }
            }
        }
        after_[cursor] = Factor(scope, values);
    }

    function toWad(Factor[] memory factors, uint256 scale) internal pure returns (F.Factor[] memory result) {
        if (factors.length > 64) revert F.TooManyFactors();
        result = new F.Factor[](factors.length);
        for (uint256 i; i < factors.length; i++) {
            if (factors[i].values.length > 8) revert F.InvalidValues();
            uint256[] memory values = new uint256[](factors[i].values.length);
            for (uint256 j; j < values.length; j++) {
                values[j] = uint256(factors[i].values[j]) * scale;
            }
            result[i] = F.Factor(factors[i].scope, values);
        }
    }
}
