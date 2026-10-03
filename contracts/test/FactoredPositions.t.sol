// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredPositions as P} from "../src/FactoredPositions.sol";

contract PositionsHarness {
    using P for P.Book;
    P.Book private book;

    function credit(address owner, uint32 scope, uint256 mask, uint128 qty) external {
        book.credit(owner, scope, mask, qty);
    }

    function debit(address owner, uint32 scope, uint256 mask, uint128 qty) external {
        book.debit(owner, scope, mask, qty);
    }

    function balance(address owner, uint32 scope, uint256 mask) external view returns (uint128) {
        return book.balance(owner, scope, mask);
    }
}

contract FactoredPositionsTest {
    function testOwnershipScopeAndPartialDebitsAreExact() public {
        PositionsHarness book = new PositionsHarness();
        book.credit(address(1), 1, 2, 1e28 + 1);
        book.credit(address(1), 3, 10, 5);
        rejects(book, abi.encodeCall(book.debit, (address(2), 1, 2, 1)), P.InsufficientHoldings.selector);
        rejects(book, abi.encodeCall(book.debit, (address(1), 2, 2, 1)), P.InsufficientHoldings.selector);
        book.debit(address(1), 1, 2, 1e28);
        assert(book.balance(address(1), 1, 2) == 1 && book.balance(address(1), 3, 10) == 5);
        rejects(book, abi.encodeCall(book.debit, (address(1), 1, 2, 2)), P.InsufficientHoldings.selector);
        assert(book.balance(address(1), 1, 2) == 1);
    }

    function testInvalidAndOverflowingCreditsRollback() public {
        PositionsHarness book = new PositionsHarness();
        rejects(book, abi.encodeCall(book.credit, (address(1), 0, 1, 1)), P.InvalidClaim.selector);
        rejects(book, abi.encodeCall(book.credit, (address(1), 1, 3, 1)), P.InvalidClaim.selector);
        rejects(book, abi.encodeCall(book.credit, (address(1), 15, 1, 1)), P.InvalidClaim.selector);
        rejects(book, abi.encodeCall(book.credit, (address(1), 1, 2, 0)), P.InvalidQuantity.selector);
        book.credit(address(1), 1, 2, type(uint128).max);
        rejects(book, abi.encodeCall(book.credit, (address(1), 1, 2, 1)), bytes4(keccak256("Panic(uint256)")));
        assert(book.balance(address(1), 1, 2) == type(uint128).max);
    }

    function rejects(PositionsHarness book, bytes memory data, bytes4 expected) private {
        (bool ok, bytes memory result) = address(book).call(data);
        assert(!ok && result.length >= 4 && bytes4(result) == expected);
    }
}
