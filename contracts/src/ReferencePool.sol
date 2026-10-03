// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {LmsrCost} from "./LmsrCost.sol";
import {LmsrQuote} from "./LmsrQuote.sol";
import {QuoteMath} from "./QuoteMath.sol";
import {BaseEventToken} from "./BaseEventToken.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @notice Local-test reference pool with trusted resolution; do not fund with real assets.
/// @dev One immutable, enumerated cluster. Base claims can be wrapped into canonical ERC-20 receipts.
contract ReferencePool is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error InvalidConfiguration();
    error NotFunded();
    error AlreadyFunded();
    error Closed();
    error ExpiredDeadline();
    error InsufficientHoldings();
    error UnsupportedTransfer();
    error UncoveredLiability();
    error UnauthorizedResolver();
    error NotClosed();
    error AlreadyResolved();
    error NotResolved();
    error InvalidOutcome();
    error InvalidBaseEvent();
    error BaseTokenNotCreated();

    IERC20 public immutable collateral;
    uint8 public immutable collateralDecimals;
    uint128 public immutable liquidity;
    uint128 public immutable requiredFunding;
    uint64 public immutable closesAt;
    address public immutable resolver;
    bytes32 public immutable settlementRulesHash;
    bool public funded;
    bool public resolved;
    uint8 public resolvedState;
    uint128[] private stateLiabilities;
    mapping(address => mapping(uint256 => uint128)) public holdings;
    mapping(uint256 => BaseEventToken) public baseTokens;

    event Funded(address indexed sponsor, uint128 amount);
    event Traded(address indexed trader, uint256 indexed mask, bool isBuy, uint128 quantity, uint128 collateralAmount);
    event Resolved(uint8 indexed terminalState, bytes32 indexed rulesHash);
    event Redeemed(address indexed holder, uint256 indexed mask, uint128 quantity, uint128 collateralAmount);
    event BaseTokenCreated(uint8 indexed eventIndex, bool outcome, uint256 indexed mask, address indexed token);
    event BaseWrapped(address indexed owner, uint256 indexed mask, uint128 quantity);
    event BaseUnwrapped(address indexed owner, uint256 indexed mask, uint128 quantity);

    constructor(address token, uint8 events_, uint128 b, uint64 closeTime, address resolver_, bytes32 rulesHash) {
        if (
            token.code.length == 0 || events_ == 0 || events_ > 3 || closeTime <= block.timestamp
                || resolver_ == address(0) || rulesHash == bytes32(0)
        ) {
            revert InvalidConfiguration();
        }
        collateral = IERC20(token);
        collateralDecimals = IERC20Metadata(token).decimals();
        liquidity = b;
        closesAt = closeTime;
        resolver = resolver_;
        settlementRulesHash = rulesHash;
        uint256 n = uint256(1) << events_;
        stateLiabilities = new uint128[](n);
        QuoteMath.CostBounds memory initial = LmsrCost.bounds(new uint256[](n), QuoteMath.toWad(b, collateralDecimals));
        requiredFunding = QuoteMath.fromWadUp(initial.upperWad, collateralDecimals);
    }

    /// @notice One-time fixed subsidy. No LP receipt or withdrawal entitlement is created.
    function fund() external nonReentrant {
        if (funded) revert AlreadyFunded();
        if (block.timestamp >= closesAt) revert Closed();
        funded = true;
        transferExact(msg.sender, requiredFunding, true);
        requireCovered();
        emit Funded(msg.sender, requiredFunding);
    }

    function liabilities() external view returns (uint128[] memory) {
        return stateLiabilities;
    }

    /// @notice Permissionless, idempotent creation of this pool's canonical YES/NO receipt.
    function createBaseToken(uint8 eventIndex, bool outcome) external nonReentrant returns (BaseEventToken token) {
        uint256 mask = baseMask(eventIndex, outcome);
        token = baseTokens[mask];
        if (address(token) != address(0)) return token;
        string memory index = Strings.toString(eventIndex);
        token = new BaseEventToken(
            mask,
            collateralDecimals,
            string.concat("Flurbo event ", index, outcome ? " YES" : " NO"),
            string.concat("FLB", index, outcome ? "Y" : "N")
        );
        baseTokens[mask] = token;
        emit BaseTokenCreated(eventIndex, outcome, mask, address(token));
    }

    /// @notice Move owned base claims into escrow and mint equal transferable receipt units.
    /// @dev Conversion moves no collateral and changes no terminal liability or quote.
    function wrapBase(uint8 eventIndex, bool outcome, uint128 quantity) external nonReentrant {
        uint256 mask = baseMask(eventIndex, outcome);
        BaseEventToken token = baseTokens[mask];
        if (address(token) == address(0)) revert BaseTokenNotCreated();
        if (quantity == 0) revert LmsrQuote.InvalidQuantity();
        if (holdings[msg.sender][mask] < quantity) revert InsufficientHoldings();
        holdings[msg.sender][mask] -= quantity;
        holdings[address(token)][mask] += quantity;
        token.mint(msg.sender, quantity);
        emit BaseWrapped(msg.sender, mask, quantity);
    }

    /// @notice Burn caller-owned receipts and restore equal internal claims for selling/redemption.
    /// @dev Available after close/resolution too; conversion cannot withdraw collateral.
    function unwrapBase(uint8 eventIndex, bool outcome, uint128 quantity) external nonReentrant {
        uint256 mask = baseMask(eventIndex, outcome);
        BaseEventToken token = baseTokens[mask];
        if (address(token) == address(0)) revert BaseTokenNotCreated();
        if (quantity == 0) revert LmsrQuote.InvalidQuantity();
        token.burn(msg.sender, quantity);
        holdings[address(token)][mask] -= quantity;
        holdings[msg.sender][mask] += quantity;
        emit BaseUnwrapped(msg.sender, mask, quantity);
    }

    function baseMask(uint8 eventIndex, bool outcome) public view returns (uint256 mask) {
        uint256 bit = uint256(1) << eventIndex;
        uint256 n = stateLiabilities.length;
        if (bit >= n) revert InvalidBaseEvent();
        for (uint256 state; state < n; ++state) {
            if (((state & bit) != 0) == outcome) mask |= uint256(1) << state;
        }
    }

    function requiredCollateral() public view returns (uint128 required) {
        if (resolved) return stateLiabilities[resolvedState];
        for (uint256 i; i < stateLiabilities.length; i++) {
            if (stateLiabilities[i] > required) required = stateLiabilities[i];
        }
    }

    /// @notice Snapshot quote only; execution recomputes it. Fees and gas are excluded.
    function quoteBuy(uint256 mask, uint128 quantity) external view returns (uint128) {
        requireOpen();
        requireCovered();
        return LmsrQuote.buy(market(), mask, quantity, type(uint128).max).collateral;
    }

    /// @notice Price preview; caller ownership is checked by sell, not by this view.
    function quoteSell(uint256 mask, uint128 quantity) external view returns (uint128) {
        requireOpen();
        requireCovered();
        return LmsrQuote.sell(market(), mask, quantity, 0).collateral;
    }

    function buy(uint256 mask, uint128 quantity, uint128 maxCost, uint256 deadline)
        external
        nonReentrant
        returns (uint128 paid)
    {
        requireTrading(deadline);
        LmsrQuote.Quote memory quote = LmsrQuote.buy(market(), mask, quantity, maxCost);
        holdings[msg.sender][mask] += quantity;
        stateLiabilities = quote.liabilitiesAfter;
        paid = quote.collateral;
        transferExact(msg.sender, paid, true);
        requireCovered();
        emit Traded(msg.sender, mask, true, quantity, paid);
    }

    function sell(uint256 mask, uint128 quantity, uint128 minProceeds, uint256 deadline)
        external
        nonReentrant
        returns (uint128 received)
    {
        requireTrading(deadline);
        if (holdings[msg.sender][mask] < quantity) revert InsufficientHoldings();
        LmsrQuote.Quote memory quote = LmsrQuote.sell(market(), mask, quantity, minProceeds);
        holdings[msg.sender][mask] -= quantity;
        stateLiabilities = quote.liabilitiesAfter;
        received = quote.collateral;
        transferExact(msg.sender, received, false);
        requireCovered();
        emit Traded(msg.sender, mask, false, quantity, received);
    }

    /// @notice Finalize all base-event bits at once; the resolver is trusted to follow the committed rules.
    /// @dev Recording the outcome does not move funds or hide a collateral shortfall.
    function resolve(uint8 terminalState) external nonReentrant {
        if (msg.sender != resolver) revert UnauthorizedResolver();
        if (!funded) revert NotFunded();
        if (resolved) revert AlreadyResolved();
        if (block.timestamp < closesAt) revert NotClosed();
        if (terminalState >= stateLiabilities.length) revert InvalidOutcome();
        resolvedState = terminalState;
        resolved = true;
        emit Resolved(terminalState, settlementRulesHash);
    }

    /// @notice Burn owned units for their final payout. Losing units burn without a token transfer.
    /// @dev Quantity may exceed the trading size limit, but cannot exceed this caller's holdings.
    function redeem(uint256 mask, uint128 quantity) external nonReentrant returns (uint128 paid) {
        if (!resolved) revert NotResolved();
        uint256 n = stateLiabilities.length;
        if (mask == 0 || mask >= (uint256(1) << n) - 1) revert LmsrQuote.InvalidMask();
        if (quantity == 0) revert LmsrQuote.InvalidQuantity();
        if (holdings[msg.sender][mask] < quantity) revert InsufficientHoldings();
        requireCovered();
        holdings[msg.sender][mask] -= quantity;
        for (uint256 i; i < n; i++) {
            if (mask & (uint256(1) << i) != 0) stateLiabilities[i] -= quantity;
        }
        if (mask & (uint256(1) << resolvedState) != 0) {
            paid = quantity;
            transferExact(msg.sender, paid, false);
        }
        requireCovered();
        emit Redeemed(msg.sender, mask, quantity, paid);
    }

    function market() private view returns (LmsrQuote.Market memory) {
        return LmsrQuote.Market(stateLiabilities, liquidity, collateralDecimals);
    }

    function requireOpen() private view {
        if (!funded) revert NotFunded();
        if (resolved || block.timestamp >= closesAt) revert Closed();
    }

    function requireTrading(uint256 deadline) private view {
        requireOpen();
        if (block.timestamp > deadline) revert ExpiredDeadline();
        requireCovered();
    }

    function requireCovered() private view {
        if (collateral.balanceOf(address(this)) < requiredCollateral()) revert UncoveredLiability();
    }

    // Check both sides: receiver tax and extra sender fees both violate the signed amount.
    function transferExact(address trader, uint128 amount, bool incoming) private {
        uint256 poolBefore = collateral.balanceOf(address(this));
        uint256 traderBefore = collateral.balanceOf(trader);
        if (incoming) collateral.safeTransferFrom(trader, address(this), amount);
        else collateral.safeTransfer(trader, amount);
        uint256 poolAfter = collateral.balanceOf(address(this));
        uint256 traderAfter = collateral.balanceOf(trader);
        if (incoming) {
            if (
                poolAfter < poolBefore || poolAfter - poolBefore != amount || traderAfter > traderBefore
                    || traderBefore - traderAfter != amount
            ) revert UnsupportedTransfer();
        } else {
            if (
                poolAfter > poolBefore || poolBefore - poolAfter != amount || traderAfter < traderBefore
                    || traderAfter - traderBefore != amount
            ) revert UnsupportedTransfer();
        }
    }
}
