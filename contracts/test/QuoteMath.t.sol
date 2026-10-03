// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {QuoteMath} from "../src/QuoteMath.sol";

// External surface exists only in tests, so revert cases can be inspected.
contract QuoteMathHarness {
    function up(uint256 wad, uint8 decimals) external pure returns (uint128) {
        return QuoteMath.fromWadUp(wad, decimals);
    }

    function down(uint256 wad, uint8 decimals) external pure returns (uint128) {
        return QuoteMath.fromWadDown(wad, decimals);
    }

    function buy(QuoteMath.CostBounds memory a, QuoteMath.CostBounds memory b) external pure returns (uint128) {
        return QuoteMath.buyFromBounds(a, b, 6);
    }

    function sell(QuoteMath.CostBounds memory a, QuoteMath.CostBounds memory b) external pure returns (uint128) {
        return QuoteMath.sellFromBounds(a, b, 6);
    }
}

contract QuoteMathTest {
    QuoteMathHarness private harness = new QuoteMathHarness();

    function testFuzzAtomicRoundTrip(uint128 atoms, uint8 decimalSeed) public pure {
        uint8 decimals = decimalSeed % 19;
        uint256 wad = QuoteMath.toWad(atoms, decimals);
        assert(QuoteMath.fromWadDown(wad, decimals) == atoms);
        assert(QuoteMath.fromWadUp(wad, decimals) == atoms);
    }

    function testFuzzRoundingEnclosesValue(uint128 atomSeed, uint64 remainder, uint8 decimalSeed) public pure {
        uint8 decimals = decimalSeed % 19;
        uint256 factor = QuoteMath.scale(decimals);
        uint128 atoms = atomSeed == type(uint128).max ? atomSeed - 1 : atomSeed;
        uint256 wad = QuoteMath.toWad(atoms, decimals) + remainder % factor;
        uint128 lower = QuoteMath.fromWadDown(wad, decimals);
        uint128 upper = QuoteMath.fromWadUp(wad, decimals);
        assert(QuoteMath.toWad(lower, decimals) <= wad);
        assert(QuoteMath.toWad(upper, decimals) >= wad);
        assert(upper - lower <= 1);
    }

    function testRoundingBoundaries() public pure {
        for (uint8 decimals = 0; decimals <= 18; decimals++) {
            assert(QuoteMath.fromWadUp(0, decimals) == 0);
            assert(QuoteMath.fromWadUp(1, decimals) == 1);
            uint256 maximum = QuoteMath.toWad(type(uint128).max, decimals);
            assert(QuoteMath.fromWadUp(maximum, decimals) == type(uint128).max);
        }
        assert(QuoteMath.fromWadDown(1, 6) == 0);
        assert(QuoteMath.fromWadUp(1e12, 6) == 1);
        assert(QuoteMath.fromWadUp(1e12 + 1, 6) == 2);
    }

    function testFuzzCostIntervalsProtectPool(uint128 initial, uint64 delta, uint32 error, uint8 decimalSeed)
        public
        pure
    {
        uint8 decimals = decimalSeed % 19;
        uint256 exactBefore = uint256(initial) + error;
        uint256 exactAfter = exactBefore + delta;
        QuoteMath.CostBounds memory before_ = QuoteMath.CostBounds(exactBefore - error, exactBefore + error);
        QuoteMath.CostBounds memory after_ = QuoteMath.CostBounds(exactAfter - error, exactAfter + error);
        uint256 chargedWad = QuoteMath.toWad(QuoteMath.buyFromBounds(before_, after_, decimals), decimals);
        assert(chargedWad >= delta);
        uint256 allowance = 2 * uint256(error) + QuoteMath.scale(decimals);
        assert(chargedWad - delta < allowance);
        if (uint256(delta) >= 2 * uint256(error)) {
            uint256 paidWad = QuoteMath.toWad(QuoteMath.sellFromBounds(after_, before_, decimals), decimals);
            assert(paidWad <= delta);
            assert(delta - paidWad < allowance);
        }
    }

    function testRejectsDecimalsAndOverflow() public {
        checkRevert(abi.encodeCall(harness.up, (1, 19)), QuoteMath.UnsupportedDecimals.selector);
        checkRevert(abi.encodeCall(harness.down, (1, 255)), QuoteMath.UnsupportedDecimals.selector);
        checkRevert(abi.encodeCall(harness.up, (type(uint256).max, 0)), QuoteMath.AmountOverflow.selector);
        uint256 maxWad = QuoteMath.toWad(type(uint128).max, 6);
        assert(harness.down(maxWad + 1, 6) == type(uint128).max);
        checkRevert(abi.encodeCall(harness.up, (maxWad + 1, 6)), QuoteMath.AmountOverflow.selector);
        checkRevert(abi.encodeCall(harness.down, (maxWad + 1e12, 6)), QuoteMath.AmountOverflow.selector);
    }

    function testRejectsMalformedAndUnresolvedBounds() public {
        QuoteMath.CostBounds memory invalid = QuoteMath.CostBounds(2, 1);
        QuoteMath.CostBounds memory low = QuoteMath.CostBounds(1, 2);
        QuoteMath.CostBounds memory high = QuoteMath.CostBounds(3, 4);
        checkRevert(abi.encodeCall(harness.buy, (invalid, high)), QuoteMath.InvalidBounds.selector);
        checkRevert(abi.encodeCall(harness.sell, (high, invalid)), QuoteMath.InvalidBounds.selector);
        checkRevert(abi.encodeCall(harness.buy, (high, low)), QuoteMath.UnresolvedDirection.selector);
        checkRevert(abi.encodeCall(harness.sell, (low, high)), QuoteMath.UnresolvedDirection.selector);
        checkRevert(abi.encodeCall(harness.sell, (low, low)), QuoteMath.UnresolvedDirection.selector);
    }

    function checkRevert(bytes memory callData, bytes4 expected) private {
        (bool success, bytes memory data) = address(harness).call(callData);
        assert(!success && data.length == 4 && bytes4(data) == expected);
    }
}
