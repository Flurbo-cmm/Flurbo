// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredLogMath as M} from "./FactoredLogMath.sol";
import {QuoteMath} from "./QuoteMath.sol";

/// @notice Bounded-width evaluation of one global LMSR cost and exact maximum liability.
/// @dev Snapshot evaluator only. No quotes, ownership, transfers or settlement.
library FactoredCost {
    error InvalidEventCount();
    error InvalidLiquidity();
    error TooManyFactors();
    error InvalidScope();
    error InvalidValues();
    error InvalidOrder();
    error WidthExceeded();

    struct Factor {
        uint32 scope;
        // WAD liabilities; local bit i corresponds to the ith set bit of scope.
        uint256[] values;
    }

    struct Table {
        uint32 scope;
        bool active;
        M.LogBounds[] values;
    }

    struct ExactTable {
        uint32 scope;
        bool active;
        uint256[] values;
    }

    /// @dev Exact max_x sum_f q_f(x), in collateral WAD, within the same validated domain.
    /// b selects the domain only; no normalization, rounding, balances or ownership checks.
    function maxLiability(uint8 events, uint256 b, Factor[] memory factors, uint8[] memory order)
        internal
        pure
        returns (uint256 total)
    {
        validate(events, b, factors, order);
        return evaluateMax(events, factors, order);
    }

    function evaluateMax(uint8 events, Factor[] memory factors, uint8[] memory order)
        private
        pure
        returns (uint256 total)
    {
        ExactTable[] memory tables = new ExactTable[](factors.length + events);
        uint256 count = factors.length;
        for (uint256 i; i < count; i++) {
            // Input values are read only; active flags live in separate table structs.
            tables[i] = ExactTable(factors[i].scope, true, factors[i].values);
        }
        for (uint256 i; i < events; i++) {
            tables[count] = eliminateMax(tables, count, uint32(1) << order[i]);
            count++;
        }
        for (uint256 i; i < count; i++) {
            if (tables[i].active) total += tables[i].values[0];
        }
    }

    function bounds(uint8 events, uint256 b, Factor[] memory factors, uint8[] memory order)
        internal
        pure
        returns (QuoteMath.CostBounds memory)
    {
        validate(events, b, factors, order);
        return evaluateBounds(events, b, factors, order);
    }

    /// @dev Validate this snapshot once for both calculations. Unvalidated workers stay private.
    function boundsAndMax(uint8 events, uint256 b, Factor[] memory factors, uint8[] memory order)
        internal
        pure
        returns (QuoteMath.CostBounds memory cost, uint256 maximum)
    {
        validate(events, b, factors, order);
        return (evaluateBounds(events, b, factors, order), evaluateMax(events, factors, order));
    }

    function evaluateBounds(uint8 events, uint256 b, Factor[] memory factors, uint8[] memory order)
        private
        pure
        returns (QuoteMath.CostBounds memory)
    {
        Table[] memory tables = new Table[](factors.length + events);
        uint256 count = factors.length;
        for (uint256 i; i < count; i++) {
            M.LogBounds[] memory values = new M.LogBounds[](factors[i].values.length);
            for (uint256 j; j < values.length; j++) {
                values[j] = M.normalize(factors[i].values[j], b);
            }
            tables[i] = Table(factors[i].scope, true, values);
        }
        for (uint256 i; i < events; i++) {
            tables[count] = eliminate(tables, count, uint32(1) << order[i]);
            count++;
        }
        M.LogBounds memory total;
        for (uint256 i; i < count; i++) {
            if (tables[i].active) total = M.add(total, tables[i].values[0]);
        }
        return M.cost(total, b);
    }

    /// @dev Validate the whole graph before transcendental arithmetic. Returns induced width.
    function validate(uint8 events, uint256 b, Factor[] memory factors, uint8[] memory order)
        internal
        pure
        returns (uint256 width)
    {
        if (events == 0 || events > 32) revert InvalidEventCount();
        if (b < 1e12 || b > 1e27) revert InvalidLiquidity();
        if (factors.length > 64) revert TooManyFactors();
        if (order.length != events) revert InvalidOrder();
        uint256 seen;
        for (uint256 i; i < events; i++) {
            if (order[i] >= events || seen & (uint256(1) << order[i]) != 0) revert InvalidOrder();
            seen |= uint256(1) << order[i];
        }
        uint256[] memory scopes = new uint256[](factors.length + events);
        uint256 sumMaxima;
        for (uint256 i; i < factors.length; i++) {
            uint256 scope = factors[i].scope;
            uint256 size = popcount(scope);
            if (scope >> events != 0 || size > 3) revert InvalidScope();
            if (factors[i].values.length != uint256(1) << size) revert InvalidValues();
            uint256 maximum;
            for (uint256 j; j < factors[i].values.length; j++) {
                uint256 value = factors[i].values[j];
                if (value > 100 * b) revert InvalidValues();
                if (value > maximum) maximum = value;
            }
            sumMaxima += maximum;
            scopes[i] = scope;
        }
        if (sumMaxima > 100 * b) revert InvalidValues();
        uint256 count = factors.length;
        for (uint256 i; i < events; i++) {
            uint256 bit = uint256(1) << order[i];
            uint256 joined = bit;
            for (uint256 j; j < count; j++) {
                if (scopes[j] & bit != 0) {
                    joined |= scopes[j];
                    scopes[j] = 0; // Consumed scopes and constants add no future edges.
                }
            }
            uint256 currentWidth = popcount(joined) - 1;
            if (currentWidth > 2) revert WidthExceeded();
            if (currentWidth > width) width = currentWidth;
            scopes[count++] = joined & ~bit;
        }
    }

    function eliminate(Table[] memory tables, uint256 count, uint32 bit) private pure returns (Table memory) {
        uint32 joined = bit;
        uint256[] memory bucket = new uint256[](count);
        uint256 size;
        for (uint256 i; i < count; i++) {
            if (tables[i].active && tables[i].scope & bit != 0) {
                joined |= tables[i].scope;
                bucket[size++] = i;
                tables[i].active = false;
            }
        }
        uint32 remaining = joined & ~bit;
        M.LogBounds[] memory values = new M.LogBounds[](uint256(1) << popcount(remaining));
        for (uint256 local; local < values.length; local++) {
            uint32 state = expand(remaining, local);
            values[local] =
                M.logSumExp(bucketSum(tables, bucket, size, state), bucketSum(tables, bucket, size, state | bit));
        }
        return Table(remaining, true, values);
    }

    function bucketSum(Table[] memory tables, uint256[] memory bucket, uint256 size, uint32 state)
        private
        pure
        returns (M.LogBounds memory total)
    {
        // Indices retain original table order; only irrelevant scans are removed.
        for (uint256 i; i < size; i++) {
            Table memory table = tables[bucket[i]];
            total = M.add(total, table.values[project(table.scope, state)]);
        }
    }

    function eliminateMax(ExactTable[] memory tables, uint256 count, uint32 bit)
        private
        pure
        returns (ExactTable memory)
    {
        uint32 joined = bit;
        uint256[] memory bucket = new uint256[](count);
        uint256 size;
        for (uint256 i; i < count; i++) {
            if (tables[i].active && tables[i].scope & bit != 0) {
                joined |= tables[i].scope;
                bucket[size++] = i;
                tables[i].active = false;
            }
        }
        uint32 remaining = joined & ~bit;
        uint256[] memory values = new uint256[](uint256(1) << popcount(remaining));
        for (uint256 local; local < values.length; local++) {
            uint32 state = expand(remaining, local);
            uint256 no = exactBucketSum(tables, bucket, size, state);
            uint256 yes = exactBucketSum(tables, bucket, size, state | bit);
            values[local] = no > yes ? no : yes;
        }
        return ExactTable(remaining, true, values);
    }

    function exactBucketSum(ExactTable[] memory tables, uint256[] memory bucket, uint256 size, uint32 state)
        private
        pure
        returns (uint256 total)
    {
        for (uint256 i; i < size; i++) {
            ExactTable memory table = tables[bucket[i]];
            total += table.values[project(table.scope, state)];
        }
    }

    function popcount(uint256 scope) private pure returns (uint256 count) {
        while (scope != 0) {
            scope &= scope - 1;
            count++;
        }
    }

    function expand(uint32 scope, uint256 local) private pure returns (uint32 state) {
        uint256 index;
        while (scope != 0) {
            uint32 bit = scope & (~scope + 1);
            if (local & (uint256(1) << index++) != 0) state |= bit;
            scope &= scope - 1;
        }
    }

    function project(uint32 scope, uint32 state) private pure returns (uint256 local) {
        uint256 index;
        while (scope != 0) {
            uint32 bit = scope & (~scope + 1);
            if (state & bit != 0) local |= uint256(1) << index;
            index++;
            scope &= scope - 1;
        }
    }
}
