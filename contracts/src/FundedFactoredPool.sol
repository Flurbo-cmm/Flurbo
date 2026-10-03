// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredPool} from "./FactoredPool.sol";
import {FactoredQuote as Q} from "./FactoredQuote.sol";
import {FundedPricingEngine} from "./FundedPricingEngine.sol";

/// @notice Experimental funded learning integration for synthetic test assets; not approved for real-asset use.
/// @dev Updater supplies quantized bias tables, not a proof of learning. Settlement uses only actual positions.
contract FundedFactoredPool is FactoredPool {
    error UnauthorizedUpdater();
    error InvalidUpdateDomain();
    error StaleUpdate();
    error UpdateTooSoon();
    error MovementLimit();
    error FundingLimit();

    struct MarketConfig {
        address token;
        uint8 events;
        uint128 b;
        uint64 closeTime;
        uint8[] order;
        address resolver;
        bytes32 rulesHash;
    }

    struct UpdatePolicy {
        address updater;
        uint128 maxBiasMovement;
        uint128 epochFundingLimit;
        uint64 epochSeconds;
        uint64 minUpdateInterval;
    }

    struct Update {
        uint256 chainId;
        address pool;
        uint256 expectedRevision;
        uint256 deadline;
        uint128 maxFunding;
        Q.Factor[] bias;
    }

    FundedPricingEngine public immutable pricingEngine;
    address public immutable updater;
    uint128 public immutable maxBiasMovement;
    uint128 public immutable epochFundingLimit;
    uint64 public immutable epochSeconds;
    uint64 public immutable minUpdateInterval;
    uint256 public revision;
    uint256 public lastUpdateAt;
    uint256 public updateCount;
    uint256 public fundingEpoch;
    uint128 public epochFundingSpent;
    uint128 public pricingReserve;
    Q.Factor[] private storedBias;

    event BiasUpdated(uint256 indexed revision, bytes32 indexed proposalHash, uint128 fundingAdded, uint128 reserve);

    constructor(MarketConfig memory config, UpdatePolicy memory policy)
        FactoredPool(
            config.token, config.events, config.b, config.closeTime, config.order, config.resolver, config.rulesHash
        )
    {
        if (
            policy.updater == address(0) || policy.maxBiasMovement == 0 || policy.maxBiasMovement > config.b
                || policy.epochFundingLimit == 0 || policy.epochSeconds == 0 || policy.minUpdateInterval == 0
                || policy.minUpdateInterval > policy.epochSeconds
        ) revert InvalidConfiguration();
        updater = policy.updater;
        maxBiasMovement = policy.maxBiasMovement;
        epochFundingLimit = policy.epochFundingLimit;
        epochSeconds = policy.epochSeconds;
        minUpdateInterval = policy.minUpdateInterval;
        pricingEngine = new FundedPricingEngine();
        pricingReserve = requiredFunding;
    }

    function biasFactors() external view returns (Q.Factor[] memory) {
        return storedBias;
    }

    /// @notice Exact payout requirement, excluding the extra pricing reserve.
    /// @dev Maximum over outcomes before resolution; remaining winning payouts afterward.
    function actualRequiredCollateral() external view returns (uint128) {
        return super.requiredCollateral();
    }

    function requiredCollateral() public view override returns (uint128) {
        uint128 actual = super.requiredCollateral();
        if (resolved) return actual;
        return pricingReserve > actual ? pricingReserve : actual;
    }

    /// @notice Direct authenticated update; msg.sender funds the exact shortfall atomically.
    /// @dev No signed relay, withdrawals, model training, or changes to holder payouts.
    function updateBias(Update calldata proposal) external nonReentrant returns (uint128 added) {
        if (msg.sender != updater) revert UnauthorizedUpdater();
        requireOpen();
        requireCovered();
        if (proposal.chainId != block.chainid || proposal.pool != address(this)) revert InvalidUpdateDomain();
        if (proposal.expectedRevision != revision) revert StaleUpdate();
        if (block.timestamp > proposal.deadline) revert ExpiredDeadline();
        if (updateCount != 0 && block.timestamp < lastUpdateAt + minUpdateInterval) revert UpdateTooSoon();

        // Validate the full pricing graph before accepting any update, even one with no deposit.
        uint128 reserve = pricingEngine.reserve(market(), proposal.bias);
        if (pricingEngine.movement(storedBias, proposal.bias) > maxBiasMovement) revert MovementLimit();
        uint256 balance = collateral.balanceOf(address(this));
        if (reserve > balance) added = uint128(uint256(reserve) - balance);
        uint256 epoch = block.timestamp / epochSeconds;
        uint128 spent = epoch == fundingEpoch ? epochFundingSpent : 0;
        if (added > proposal.maxFunding || uint256(spent) + added > epochFundingLimit) revert FundingLimit();

        delete storedBias;
        for (uint256 i; i < proposal.bias.length; i++) {
            storedBias.push();
            storedBias[i].scope = proposal.bias[i].scope;
            storedBias[i].values = proposal.bias[i].values;
        }
        pricingReserve = reserve;
        revision++;
        updateCount++;
        lastUpdateAt = block.timestamp;
        fundingEpoch = epoch;
        epochFundingSpent = spent + added;
        if (added != 0) transferExact(msg.sender, added, true);
        requireCovered();
        emit BiasUpdated(revision, keccak256(abi.encode(proposal)), added, reserve);
    }

    function priceTrade(uint32 scope, uint256 mask, uint128 quantity, uint128 limit, bool isBuy)
        internal
        view
        override
        returns (Q.Quote memory quote, uint128 reserve)
    {
        (quote, reserve) = pricingEngine.quote(market(), storedBias, scope, mask, quantity, isBuy);
        if (isBuy && quote.collateral > limit) revert Q.MaxCostExceeded();
        if (!isBuy && quote.collateral < limit) revert Q.MinProceedsNotMet();
    }

    function afterTrade(uint128 reserve) internal override {
        pricingReserve = reserve;
        revision++;
    }
}
