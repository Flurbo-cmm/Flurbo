// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredQuote as Q} from "../src/FactoredQuote.sol";

/// @dev Deterministic quote benchmarks; model construction is outside the measured region.
contract FactoredGasTest {
    event log_named_uint(string name, uint256 value);
    event log_named_bytes32(string name, bytes32 value);

    function testChainQuoteGas() public {
        check(1, 31);
    }

    function testWidthTwoQuoteGas() public {
        check(2, 64);
    }

    function check(uint8 width, uint256 count) private {
        Q.Market memory m;
        m.events = 32;
        m.liquidity = 10e6;
        m.decimals = 6;
        m.order = new uint8[](32);
        for (uint8 i; i < 32; i++) {
            m.order[i] = i;
        }
        m.factors = new Q.Factor[](count);
        for (uint256 i; i < count; i++) {
            m.factors[i].scope = uint32((uint256(1) << (width + 1)) - 1) << uint32(i % (32 - width));
            m.factors[i].values = new uint128[](uint256(1) << (width + 1));
            for (uint256 j; j < m.factors[i].values.length; j++) {
                m.factors[i].values[j] = uint128((j ^ (j >> 1) ^ (j >> 2)) & 1) * 1e6;
            }
        }
        uint32 scope = width == 1 ? 3 : 7;
        uint256 mask = width == 1 ? 8 : 128;
        uint256 start = gasleft();
        Q.Quote memory result = Q.buy(m, scope, mask, 100000, 100000);
        uint256 used = start - gasleft();
        assert(result.maxLiabilityAfter == (width == 1 ? 31e6 : 64e6 + 100000));
        // Captured before the bucket-scan optimization: includes price, every table and exact maximum.
        bytes32 expected = width == 1
            ? bytes32(0x026d3677c985cf9a55cbbb9c74d74df1e5e58da814f08a4f93009f88ecf6ac20)
            : bytes32(0x4e09d014a12fa3c333b95c3064dbc20eeb1058d1e9bf7ce6d9b80372a43904dc);
        assert(keccak256(abi.encode(result)) == expected);
        // Small headroom over measured gas; revisit deliberately when changing compiler or evaluator.
        assert(used <= (width == 1 ? 7600000 : 18700000));
        emit log_named_uint("quote gas", used);
        emit log_named_uint("collateral atoms", result.collateral);
        emit log_named_bytes32("complete quote hash", keccak256(abi.encode(result)));
    }
}
