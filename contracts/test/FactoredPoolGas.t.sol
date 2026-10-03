// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredPool} from "../src/FactoredPool.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
import {FactoredQuote as Q} from "../src/FactoredQuote.sol";

contract FactoredPoolGasTest {
    event log_named_uint(string name, uint256 value);
    MockCollateral private token;
    FactoredPool private pool;

    function setUp() public {
        token = new MockCollateral(6);
        uint8[] memory order = new uint8[](8);
        for (uint8 i; i < 8; i++) {
            order[i] = i;
        }
        pool = new FactoredPool(
            address(token),
            8,
            100e6,
            uint64(block.timestamp + 100),
            order,
            address(this),
            keccak256("synthetic gas fixture")
        );
        token.mint(address(this), 10000e6);
        token.approve(address(pool), type(uint256).max);
        pool.fund();
        for (uint32 scope = 3; scope <= 192; scope <<= 2) {
            pool.buy(scope, 8, 10e6, 10e6, block.timestamp);
        }
    }

    function testExistingFirstFactorBuyGas() public {
        uint256 start = gasleft();
        uint128 paid = pool.buy(3, 8, 1e6, 1e6, block.timestamp);
        uint256 used = start - gasleft();
        assert(pool.holdings(address(this), 3, 8) == 11e6 && pool.requiredCollateral() == 41e6);
        assert(paid == 270200 && used <= 1040000);
        emit log_named_uint("buy execution gas", used);
        emit log_named_uint("buy collateral atoms", paid);
    }

    function testExistingMiddleFactorSellGas() public {
        uint256 start = gasleft();
        uint128 paid = pool.sell(48, 8, 1e6, 1, block.timestamp);
        uint256 used = start - gasleft();
        assert(pool.holdings(address(this), 48, 8) == 9e6 && pool.requiredCollateral() == 39e6);
        assert(paid == 268232 && used <= 1040000);
        emit log_named_uint("sell execution gas", used);
        emit log_named_uint("sell collateral atoms", paid);
    }

    function testStableStorageMatchesQuotedFactorsAndLaterPrices() public {
        Q.Market memory m = Q.Market(8, 100e6, 6, pool.factors(), pool.eliminationOrder());
        Q.Quote memory expected = Q.buy(m, 3, 8, 1e6, 1e6);
        pool.buy(3, 8, 1e6, expected.collateral, block.timestamp);
        Q.Factor[] memory stored = pool.factors();
        assert(stored.length == 4 && expected.factorsAfter.length == 4);
        for (uint256 i; i < stored.length; i++) {
            assert(stored[i].scope == m.factors[i].scope);
            if (i != 0) assert(keccak256(abi.encode(stored[i])) == keccak256(abi.encode(m.factors[i])));
            uint256 matches;
            for (uint256 j; j < expected.factorsAfter.length; j++) {
                if (stored[i].scope == expected.factorsAfter[j].scope) {
                    assert(keccak256(abi.encode(stored[i])) == keccak256(abi.encode(expected.factorsAfter[j])));
                    matches++;
                }
            }
            assert(matches == 1);
        }
        // The pure quote moves its changed table to the end; the pool's insertion order is economically equivalent.
        m.factors = expected.factorsAfter;
        Q.Quote memory subsequent = Q.buy(m, 48, 8, 1e6, 1e6);
        assert(pool.quoteBuy(48, 8, 1e6) == subsequent.collateral);
        pool.buy(48, 8, 1e6, subsequent.collateral, block.timestamp);
        assert(pool.requiredCollateral() == subsequent.maxLiabilityAfter);
        pool.sell(3, 8, 11e6, 1, block.timestamp);
        stored = pool.factors();
        assert(stored.length == 4 && stored[0].scope == 3 && stored[0].values[3] == 0);
        pool.buy(1, 2, 1e6, 1e6, block.timestamp);
        stored = pool.factors();
        assert(stored.length == 5 && stored[0].scope == 3 && stored[4].scope == 1);
    }
}
