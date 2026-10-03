// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {LmsrCost} from "./LmsrCost.sol";
import {QuoteMath} from "./QuoteMath.sol";

/// @notice Fee-free quotes for the bounded, enumerated reference pool.
/// @dev Pure simulation only: no ownership, wallet balance, token transfer, or
/// settlement checks. Execution must recompute against authenticated pool state.
library LmsrQuote {
    error InvalidMask();
    error InvalidQuantity();
    error InsufficientLiability();
    error UnquotableTrade();
    error MaxCostExceeded();
    error MinProceedsNotMet();

    /// @dev All amounts are collateral atomic units, including liquidity b.
    struct Market {
        uint128[] liabilities;
        uint128 liquidity;
        uint8 decimals;
    }

    struct Quote {
        uint128 collateral;
        uint128[] liabilitiesAfter;
    }

    function buy(Market memory market, uint256 mask, uint128 quantity, uint128 maxCost)
        internal
        pure
        returns (Quote memory quote)
    {
        quote = simulate(market, mask, quantity, true);
        if (quote.collateral > maxCost) revert MaxCostExceeded();
    }

    function sell(Market memory market, uint256 mask, uint128 quantity, uint128 minProceeds)
        internal
        pure
        returns (Quote memory quote)
    {
        quote = simulate(market, mask, quantity, false);
        if (quote.collateral < minProceeds) revert MinProceedsNotMet();
    }

    function simulate(Market memory market, uint256 mask, uint128 quantity, bool isBuy)
        private
        pure
        returns (Quote memory quote)
    {
        uint256 n = market.liabilities.length;
        if (n != 2 && n != 4 && n != 8) revert LmsrCost.InvalidStateCount();
        uint256 full = (uint256(1) << n) - 1;
        if (mask == 0 || mask >= full) revert InvalidMask();
        if (quantity == 0 || quantity > market.liquidity) revert InvalidQuantity();
        uint256 factor = QuoteMath.scale(market.decimals);
        uint256 b = uint256(market.liquidity) * factor;
        uint256[] memory beforeWad = new uint256[](n);
        for (uint256 i; i < n; i++) {
            beforeWad[i] = uint256(market.liabilities[i]) * factor;
        }
        QuoteMath.CostBounds memory before_ = LmsrCost.bounds(beforeWad, b);

        uint256[] memory afterWad = new uint256[](n);
        quote.liabilitiesAfter = new uint128[](n);
        for (uint256 i; i < n; i++) {
            uint128 value = market.liabilities[i];
            if (mask & (uint256(1) << i) != 0) {
                if (isBuy) {
                    value += quantity; // checked; valid domain also bounds this below uint128.max
                } else {
                    if (value < quantity) revert InsufficientLiability();
                    value -= quantity;
                }
            }
            quote.liabilitiesAfter[i] = value;
            afterWad[i] = uint256(value) * factor;
        }
        QuoteMath.CostBounds memory after_ = LmsrCost.bounds(afterWad, b);
        quote.collateral = isBuy
            ? QuoteMath.buyFromBounds(before_, after_, market.decimals)
            : QuoteMath.sellFromBounds(before_, after_, market.decimals);
        // Do not quote a free burn or a purchase costing more than its maximum payout.
        if (quote.collateral == 0 || (isBuy && quote.collateral > quantity)) revert UnquotableTrade();
    }
}
