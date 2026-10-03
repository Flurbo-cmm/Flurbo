// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FactoredTrading} from "./FactoredTrading.sol";
import {FactoredPositions as P} from "./FactoredPositions.sol";
import {FactoredBaseToken} from "./FactoredBaseToken.sol";
import {FactoredBaseTokenFactory} from "./FactoredBaseTokenFactory.sol";

/// @notice Separate Monad testnet pool with precommitted uniform-void settlement.
/// @dev Pricing remains factored. Settlement enumerates at most sixteen states for this bounded 2-4 event pilot.
contract PilotPool is FactoredTrading {
    using P for P.Book;
    error InvalidSettlement();
    error UnauthorizedResolver();
    error NotResolved();
    error InvalidBaseEvent();
    error BaseTokenNotCreated();

    address public immutable resolver;
    bytes32 public immutable settlementRulesHash;
    bool public resolved;
    uint32 public resolvedState;
    uint32 public voidMask;
    uint128 private remainingPayout;
    FactoredBaseTokenFactory public immutable baseTokenFactory;
    mapping(uint32 => mapping(uint8 => FactoredBaseToken)) public baseTokens;

    event Resolved(uint32 indexed yesMask, uint32 indexed voidMask, bytes32 indexed rulesHash);
    event Redeemed(address indexed owner, uint32 indexed scope, uint256 indexed mask, uint128 quantity, uint128 collateralAmount);
    event BaseTokenCreated(uint8 indexed eventIndex, bool outcome, uint32 indexed scope, uint8 mask, address indexed token);
    event BaseWrapped(address indexed owner, uint32 indexed scope, uint8 indexed mask, uint128 quantity);
    event BaseUnwrapped(address indexed owner, uint32 indexed scope, uint8 indexed mask, uint128 quantity);

    constructor(address token, uint8 events_, uint128 b, uint64 closeTime, uint8[] memory order_, address resolver_, bytes32 rulesHash)
        FactoredTrading(token, events_, b, closeTime, order_)
    {
        if (block.chainid != 10143 || events_ < 2 || events_ > 4 || resolver_.code.length == 0 || rulesHash == bytes32(0)) {
            revert InvalidConfiguration();
        }
        resolver = resolver_;
        settlementRulesHash = rulesHash;
        baseTokenFactory = new FactoredBaseTokenFactory();
    }

    function requiredCollateral() public view override returns (uint128) {
        return resolved ? remainingPayout : maximumLiability;
    }

    function resolve(uint32 yesMask, uint32 invalidMask) external nonReentrant {
        if (msg.sender != resolver) revert UnauthorizedResolver();
        if (!funded || resolved || block.timestamp < closesAt || (yesMask & invalidMask) != 0
            || (uint256(yesMask | invalidMask) >> eventCount) != 0) revert InvalidSettlement();
        uint256 total;
        uint256 count;
        uint32 known = uint32((uint256(1) << eventCount) - 1) ^ invalidMask;
        for (uint32 state; state < uint32(1) << eventCount; ++state) {
            if ((state & known) != yesMask) continue;
            count++;
            for (uint256 i; i < storedFactors.length; ++i) total += storedFactors[i].values[project(storedFactors[i].scope, state)];
        }
        // The mean cannot exceed the maximum pre-resolution liability. Round reserve UP.
        remainingPayout = uint128((total + count - 1) / count);
        resolvedState = yesMask;
        voidMask = invalidMask;
        resolved = true;
        emit Resolved(yesMask, invalidMask, settlementRulesHash);
    }

    function payoutFraction(uint32 scope, uint256 mask) public view returns (uint256 numerator, uint256 denominator) {
        if (!resolved) revert NotResolved();
        P.key(scope, mask);
        if (uint256(scope) >> eventCount != 0) revert P.InvalidClaim();
        uint32 known = uint32((uint256(1) << eventCount) - 1) ^ voidMask;
        for (uint32 state; state < uint32(1) << eventCount; ++state) {
            if ((state & known) != resolvedState) continue;
            denominator++;
            if ((mask & (uint256(1) << project(scope, state))) != 0) numerator++;
        }
    }

    function redeem(uint32 scope, uint256 mask, uint128 quantity) external nonReentrant returns (uint128 paid) {
        (uint256 numerator, uint256 denominator) = payoutFraction(scope, mask);
        requireCovered();
        positions.debit(msg.sender, scope, mask, quantity);
        for (uint256 i; i < storedFactors.length; ++i) {
            if (storedFactors[i].scope != scope) continue;
            for (uint256 j; j < storedFactors[i].values.length; ++j) {
                if ((mask & (uint256(1) << j)) != 0) storedFactors[i].values[j] -= quantity;
            }
            break;
        }
        // Round individual payouts DOWN. Split redemption cannot increase a payout.
        paid = uint128(uint256(quantity) * numerator / denominator);
        remainingPayout -= paid;
        if (paid != 0) transferExact(msg.sender, paid, false);
        requireCovered();
        emit Redeemed(msg.sender, scope, mask, quantity, paid);
    }

    function baseClaim(uint8 eventIndex, bool outcome) public view returns (uint32 scope, uint8 mask) {
        if (eventIndex >= eventCount) revert InvalidBaseEvent();
        return (uint32(1) << eventIndex, outcome ? 2 : 1);
    }

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

    function project(uint32 scope, uint32 state) private pure returns (uint256 local) {
        uint256 index;
        while (scope != 0) {
            uint32 bit = scope & (~scope + 1);
            if ((state & bit) != 0) local |= uint256(1) << index;
            index++;
            scope &= scope - 1;
        }
    }
}
