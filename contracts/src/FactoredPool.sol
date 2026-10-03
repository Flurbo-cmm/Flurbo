// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredTrading} from "./FactoredTrading.sol";
import {FactoredPositions as P} from "./FactoredPositions.sol";
import {FactoredBaseToken} from "./FactoredBaseToken.sol";
import {FactoredBaseTokenFactory} from "./FactoredBaseTokenFactory.sol";

/// @notice Local-test factored pool with immutable trusted resolution. Not approved for real assets.
/// @dev One shared, uniform-prior cluster. Conditional securities and partner adapters remain separate.
contract FactoredPool is FactoredTrading {
    using P for P.Book;
    error UnauthorizedResolver();
    error NotClosed();
    error AlreadyResolved();
    error NotResolved();
    error InvalidOutcome();
    error MissingFactor();
    error InvalidBaseEvent();
    error BaseTokenNotCreated();

    address public immutable resolver;
    bytes32 public immutable settlementRulesHash;
    bool public resolved;
    uint32 public resolvedState;
    uint128 private remainingPayout;
    FactoredBaseTokenFactory public immutable baseTokenFactory;
    mapping(uint32 => mapping(uint8 => FactoredBaseToken)) public baseTokens;
    event BaseTokenCreated(
        uint8 indexed eventIndex, bool outcome, uint32 indexed scope, uint8 mask, address indexed token
    );
    event BaseWrapped(address indexed owner, uint32 indexed scope, uint8 indexed mask, uint128 quantity);
    event BaseUnwrapped(address indexed owner, uint32 indexed scope, uint8 indexed mask, uint128 quantity);
    event Resolved(uint32 indexed terminalState, bytes32 indexed rulesHash);
    event Redeemed(
        address indexed owner, uint32 indexed scope, uint256 indexed mask, uint128 quantity, uint128 collateralAmount
    );

    constructor(
        address token,
        uint8 events_,
        uint128 b,
        uint64 closeTime,
        uint8[] memory order_,
        address resolver_,
        bytes32 rulesHash
    ) FactoredTrading(token, events_, b, closeTime, order_) {
        if (resolver_ == address(0) || rulesHash == bytes32(0)) revert InvalidConfiguration();
        resolver = resolver_;
        settlementRulesHash = rulesHash;
        baseTokenFactory = new FactoredBaseTokenFactory();
    }

    function baseClaim(uint8 eventIndex, bool outcome) public view returns (uint32 scope, uint8 mask) {
        if (eventIndex >= eventCount) revert InvalidBaseEvent();
        return (uint32(1) << eventIndex, outcome ? 2 : 1);
    }

    /// @notice Permissionless and idempotent. Supply starts at zero; only existing claims can be wrapped.
    function createBaseToken(uint8 eventIndex, bool outcome) external nonReentrant returns (FactoredBaseToken token) {
        (uint32 scope, uint8 mask) = baseClaim(eventIndex, outcome);
        token = baseTokens[scope][mask];
        if (address(token) != address(0)) return token;
        token = baseTokenFactory.create(eventIndex, outcome, collateralDecimals);
        baseTokens[scope][mask] = token;
        emit BaseTokenCreated(eventIndex, outcome, scope, mask, address(token));
    }

    function wrapBase(uint8 eventIndex, bool outcome, uint128 quantity) external nonReentrant {
        (uint32 scope, uint8 mask) = baseClaim(eventIndex, outcome);
        FactoredBaseToken token = baseTokens[scope][mask];
        if (address(token) == address(0)) revert BaseTokenNotCreated();
        positions.debit(msg.sender, scope, mask, quantity);
        positions.credit(address(token), scope, mask, quantity);
        token.mint(msg.sender, quantity);
        emit BaseWrapped(msg.sender, scope, mask, quantity);
    }

    /// @notice Conversion remains available after close/resolution and during shortfall; it pays no collateral.
    function unwrapBase(uint8 eventIndex, bool outcome, uint128 quantity) external nonReentrant {
        (uint32 scope, uint8 mask) = baseClaim(eventIndex, outcome);
        FactoredBaseToken token = baseTokens[scope][mask];
        if (address(token) == address(0)) revert BaseTokenNotCreated();
        if (quantity == 0) revert P.InvalidQuantity();
        token.burn(msg.sender, quantity);
        positions.debit(address(token), scope, mask, quantity);
        positions.credit(msg.sender, scope, mask, quantity);
        emit BaseUnwrapped(msg.sender, scope, mask, quantity);
    }

    function requiredCollateral() public view virtual override returns (uint128) {
        return resolved ? remainingPayout : maximumLiability;
    }

    function resolve(uint32 terminalState) external nonReentrant {
        if (msg.sender != resolver) revert UnauthorizedResolver();
        if (!funded) revert NotFunded();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < closesAt) revert NotClosed();
        if (uint256(terminalState) >> eventCount != 0) revert InvalidOutcome();
        uint128 payout;
        for (uint256 i; i < storedFactors.length; i++) {
            payout += storedFactors[i].values[project(storedFactors[i].scope, terminalState)];
        }
        remainingPayout = payout;
        resolvedState = terminalState;
        resolved = true;
        emit Resolved(terminalState, settlementRulesHash);
    }

    function redeem(uint32 scope, uint256 mask, uint128 quantity) external nonReentrant returns (uint128 paid) {
        if (!resolved) revert NotResolved();
        requireCovered();
        positions.debit(msg.sender, scope, mask, quantity);
        burnLiability(scope, mask, quantity);
        if (mask & (uint256(1) << project(scope, resolvedState)) != 0) {
            paid = quantity;
            remainingPayout -= quantity;
            transferExact(msg.sender, paid, false);
        }
        requireCovered();
        emit Redeemed(msg.sender, scope, mask, quantity, paid);
    }

    function burnLiability(uint32 scope, uint256 mask, uint128 quantity) private {
        for (uint256 i; i < storedFactors.length; i++) {
            if (storedFactors[i].scope != scope) continue;
            for (uint256 j; j < storedFactors[i].values.length; j++) {
                if (mask & (uint256(1) << j) != 0) storedFactors[i].values[j] -= quantity;
            }
            return;
        }
        revert MissingFactor();
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
