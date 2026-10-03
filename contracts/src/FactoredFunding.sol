// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {FactoredCost as F} from "./FactoredCost.sol";
import {QuoteMath} from "./QuoteMath.sol";

/// @dev Abstract funding/transfer boundary for the local-test factored pool. No LP withdrawal entitlement.
abstract contract FactoredFunding is ReentrancyGuard {
    using SafeERC20 for IERC20;
    error InvalidConfiguration();
    error AlreadyFunded();
    error NotFunded();
    error Closed();
    error UnsupportedTransfer();
    error UncoveredLiability();

    IERC20 public immutable collateral;
    uint8 public immutable collateralDecimals;
    uint8 public immutable eventCount;
    uint128 public immutable liquidity;
    uint128 public immutable requiredFunding;
    uint64 public immutable closesAt;
    uint8[] internal order;
    uint128 internal maximumLiability;
    bool public funded;
    event Funded(address indexed sponsor, uint128 amount);

    constructor(address token, uint8 events_, uint128 b, uint64 closeTime, uint8[] memory order_) {
        if (token.code.length == 0 || closeTime <= block.timestamp) revert InvalidConfiguration();
        collateral = IERC20(token);
        collateralDecimals = IERC20Metadata(token).decimals();
        eventCount = events_;
        liquidity = b;
        closesAt = closeTime;
        order = order_;
        QuoteMath.CostBounds memory initial =
            F.bounds(events_, QuoteMath.toWad(b, collateralDecimals), new F.Factor[](0), order_);
        requiredFunding = QuoteMath.fromWadUp(initial.upperWad, collateralDecimals);
    }

    function eliminationOrder() external view returns (uint8[] memory) {
        return order;
    }

    function requiredCollateral() public view virtual returns (uint128) {
        return maximumLiability;
    }

    function fund() external nonReentrant {
        if (funded) revert AlreadyFunded();
        if (block.timestamp >= closesAt) revert Closed();
        funded = true;
        transferExact(msg.sender, requiredFunding, true);
        requireCovered();
        emit Funded(msg.sender, requiredFunding);
    }

    function requireOpen() internal view {
        if (!funded) revert NotFunded();
        if (block.timestamp >= closesAt) revert Closed();
    }

    function requireCovered() internal view {
        if (collateral.balanceOf(address(this)) < requiredCollateral()) revert UncoveredLiability();
    }

    function transferExact(address trader, uint128 amount, bool incoming) internal {
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
