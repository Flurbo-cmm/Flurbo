// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredFunding} from "./FactoredFunding.sol";
import {FactoredPositions as P} from "./FactoredPositions.sol";
import {FactoredQuote as Q} from "./FactoredQuote.sol";

/// @dev Abstract trading layer: only the final pool with settlement is deployable outside tests.
abstract contract FactoredTrading is FactoredFunding {
    using P for P.Book;
    error ExpiredDeadline();
    P.Book internal positions;
    Q.Factor[] internal storedFactors;
    event Traded(
        address indexed trader,
        uint32 indexed scope,
        uint256 indexed mask,
        bool isBuy,
        uint128 quantity,
        uint128 collateralAmount
    );

    constructor(address token, uint8 events_, uint128 b, uint64 closeTime, uint8[] memory order_)
        FactoredFunding(token, events_, b, closeTime, order_)
    {}

    function holdings(address owner, uint32 scope, uint256 mask) external view returns (uint128) {
        return positions.balance(owner, scope, mask);
    }

    function factors() external view returns (Q.Factor[] memory) {
        return storedFactors;
    }

    function quoteBuy(uint32 scope, uint256 mask, uint128 quantity) external view returns (uint128) {
        requireOpen();
        requireCovered();
        (Q.Quote memory quote,) = priceTrade(scope, mask, quantity, type(uint128).max, true);
        return quote.collateral;
    }

    function quoteSell(uint32 scope, uint256 mask, uint128 quantity) external view returns (uint128) {
        requireOpen();
        requireCovered();
        (Q.Quote memory quote,) = priceTrade(scope, mask, quantity, 0, false);
        return quote.collateral;
    }

    function buy(uint32 scope, uint256 mask, uint128 quantity, uint128 maxCost, uint256 deadline)
        external
        nonReentrant
        returns (uint128 paid)
    {
        requireTrading(deadline);
        (Q.Quote memory quote, uint128 reserve) = priceTrade(scope, mask, quantity, maxCost, true);
        positions.credit(msg.sender, scope, mask, quantity);
        applyQuote(quote, scope);
        afterTrade(reserve);
        paid = quote.collateral;
        transferExact(msg.sender, paid, true);
        requireCovered();
        emit Traded(msg.sender, scope, mask, true, quantity, paid);
    }

    function sell(uint32 scope, uint256 mask, uint128 quantity, uint128 minProceeds, uint256 deadline)
        external
        nonReentrant
        returns (uint128 received)
    {
        requireTrading(deadline);
        positions.debit(msg.sender, scope, mask, quantity);
        (Q.Quote memory quote, uint128 reserve) = priceTrade(scope, mask, quantity, minProceeds, false);
        applyQuote(quote, scope);
        afterTrade(reserve);
        received = quote.collateral;
        transferExact(msg.sender, received, false);
        requireCovered();
        emit Traded(msg.sender, scope, mask, false, quantity, received);
    }

    function market() internal view returns (Q.Market memory) {
        return Q.Market(eventCount, liquidity, collateralDecimals, storedFactors, order);
    }

    function priceTrade(uint32 scope, uint256 mask, uint128 quantity, uint128 limit, bool isBuy)
        internal
        view
        virtual
        returns (Q.Quote memory quote, uint128 reserve)
    {
        quote = isBuy ? Q.buy(market(), scope, mask, quantity, limit) : Q.sell(market(), scope, mask, quantity, limit);
        reserve = 0; // The existing uniform pool checks its exact payout liability.
    }

    function afterTrade(uint128) internal virtual {}

    function requireTrading(uint256 deadline) private view {
        requireOpen();
        if (block.timestamp > deadline) revert ExpiredDeadline();
        requireCovered();
    }

    function applyQuote(Q.Quote memory quote, uint32 scope) private {
        // Quotes append the sole changed scope. Pool state starts empty and keeps one table per scope.
        Q.Factor memory changed = quote.factorsAfter[quote.factorsAfter.length - 1];
        assert(changed.scope == scope);
        uint256 index = storedFactors.length;
        for (uint256 i; i < storedFactors.length; i++) {
            if (storedFactors[i].scope == scope) {
                index = i;
                break;
            }
        }
        if (index == storedFactors.length) {
            storedFactors.push();
            storedFactors[index].scope = scope;
            storedFactors[index].values = changed.values;
        } else {
            assert(storedFactors[index].values.length == changed.values.length);
            for (uint256 j; j < changed.values.length; j++) {
                if (storedFactors[index].values[j] != changed.values[j]) {
                    storedFactors[index].values[j] = changed.values[j];
                }
            }
        }
        assert(storedFactors.length == quote.factorsAfter.length);
        maximumLiability = quote.maxLiabilityAfter;
    }
}
