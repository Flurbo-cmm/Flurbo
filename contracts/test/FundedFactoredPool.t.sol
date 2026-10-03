// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FundedFactoredPool as Pool} from "../src/FundedFactoredPool.sol";
import {FundedPricingEngine} from "../src/FundedPricingEngine.sol";
import {FactoredQuote as Q} from "../src/FactoredQuote.sol";
import {FactoredCost as F} from "../src/FactoredCost.sol";
import {FactoredFunding} from "../src/FactoredFunding.sol";
import {FactoredTrading} from "../src/FactoredTrading.sol";
import {FactoredPositions as P} from "../src/FactoredPositions.sol";
import {FactoredBaseToken} from "../src/FactoredBaseToken.sol";
import {MockCollateral} from "./helpers/MockCollateral.sol";
import {FactoredVm} from "./FactoredFunding.t.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract FundedFactoredPoolTest {
    FactoredVm constant vm = FactoredVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address constant ALICE = address(0xA11CE);
    MockCollateral token;
    Pool pool;

    function setUp() public {
        token = new MockCollateral(6);
        pool = deploy(2, 100e6);
    }

    function deploy(uint8 events_, uint128 budget) private returns (Pool p) {
        uint8[] memory order = new uint8[](events_);
        for (uint8 i; i < events_; i++) {
            order[i] = i;
        }
        p = new Pool(
            Pool.MarketConfig(
                address(token),
                events_,
                100e6,
                uint64(block.timestamp + 2 days),
                order,
                address(this),
                keccak256("synthetic funded repricing")
            ),
            Pool.UpdatePolicy(address(this), 20e6, budget, 3600, 60)
        );
        token.mint(address(this), 10000e6);
        token.approve(address(p), type(uint256).max);
        token.mint(ALICE, 1000e6);
        vm.prank(ALICE);
        token.approve(address(p), type(uint256).max);
        p.fund();
    }

    function bias(uint128 high, bool yes) private pure returns (Q.Factor[] memory result) {
        result = new Q.Factor[](1);
        uint128[] memory values = new uint128[](2);
        values[yes ? 1 : 0] = high;
        result[0] = Q.Factor(1, values);
    }

    function proposal(Q.Factor[] memory factors) private view returns (Pool.Update memory) {
        return Pool.Update(block.chainid, address(pool), pool.revision(), block.timestamp + 100, 100e6, factors);
    }

    function stateHash() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                pool.factors(),
                pool.biasFactors(),
                pool.revision(),
                pool.updateCount(),
                pool.pricingReserve(),
                pool.lastUpdateAt(),
                pool.fundingEpoch(),
                pool.epochFundingSpent(),
                token.balanceOf(address(pool)),
                token.balanceOf(address(this)),
                token.allowance(address(this), address(pool)),
                pool.holdings(ALICE, 1, 2)
            )
        );
    }

    function reject(address sender, bytes memory data, bytes4 expected) private {
        bytes32 before_ = stateHash();
        vm.prank(sender);
        (bool ok, bytes memory error) = address(pool).call(data);
        assert(!ok && error.length >= 4 && bytes4(error) == expected);
        assert(stateHash() == before_);
    }

    function testFundedUpdateChangesPricePreservesHoldingsAndPaysRoundTrip() public {
        vm.prank(ALICE);
        uint128 buyCost = pool.buy(1, 2, 1e6, 1e6, block.timestamp);
        uint128 oldQuote = pool.quoteBuy(1, 2, 1e6);
        bytes32 actual = keccak256(abi.encode(pool.factors()));
        uint256 beforeCash = token.balanceOf(address(pool));
        uint128 added = pool.updateBias(proposal(bias(10e6, true)));
        assert(added > 0 && token.balanceOf(address(pool)) == beforeCash + added);
        assert(pool.quoteBuy(1, 2, 1e6) > oldQuote);
        assert(keccak256(abi.encode(pool.factors())) == actual);
        assert(pool.holdings(ALICE, 1, 2) == 1e6 && pool.actualRequiredCollateral() == 1e6);
        vm.prank(ALICE);
        uint128 proceeds = pool.sell(1, 2, 1e6, 0, block.timestamp);
        assert(proceeds > buyCost && added > proceeds - buyCost);
        assert(pool.actualRequiredCollateral() == 0 && pool.revision() == 3);
        assert(token.balanceOf(address(pool)) >= pool.pricingReserve());
    }

    function testAuthorizationDomainReplayExpiryAndCooldown() public {
        Pool.Update memory p = proposal(bias(10e6, true));
        reject(ALICE, abi.encodeCall(pool.updateBias, (p)), Pool.UnauthorizedUpdater.selector);
        p.chainId++;
        reject(address(this), abi.encodeCall(pool.updateBias, (p)), Pool.InvalidUpdateDomain.selector);
        p.chainId = block.chainid;
        p.pool = ALICE;
        reject(address(this), abi.encodeCall(pool.updateBias, (p)), Pool.InvalidUpdateDomain.selector);
        p.pool = address(pool);
        p.deadline = block.timestamp - 1;
        reject(address(this), abi.encodeCall(pool.updateBias, (p)), FactoredTrading.ExpiredDeadline.selector);
        p.deadline = block.timestamp + 100;
        pool.updateBias(p);
        reject(address(this), abi.encodeCall(pool.updateBias, (p)), Pool.StaleUpdate.selector);
        p.expectedRevision = pool.revision();
        reject(address(this), abi.encodeCall(pool.updateBias, (p)), Pool.UpdateTooSoon.selector);
        vm.warp(block.timestamp + 60);
        vm.prank(ALICE);
        pool.buy(1, 2, 1e6, 1e6, block.timestamp);
        reject(address(this), abi.encodeCall(pool.updateBias, (p)), Pool.StaleUpdate.selector);
        vm.warp(pool.closesAt());
        reject(
            address(this), abi.encodeCall(pool.updateBias, (proposal(bias(0, true)))), FactoredFunding.Closed.selector
        );
    }

    function testFundingAndEpochBudgetAreAtomicAndSurplusCannotBeWithdrawn() public {
        pool = deploy(2, 6e6);
        Pool.Update memory p = proposal(bias(10e6, true));
        p.maxFunding = 0;
        reject(address(this), abi.encodeCall(pool.updateBias, (p)), Pool.FundingLimit.selector);
        p.maxFunding = 6e6;
        uint128 paid = pool.updateBias(p);
        assert(paid > 5e6 && paid < 6e6);
        vm.warp(block.timestamp + 60);
        reject(address(this), abi.encodeCall(pool.updateBias, (proposal(bias(20e6, true)))), Pool.FundingLimit.selector);
        vm.warp((block.timestamp / 3600 + 1) * 3600);
        uint128 paid2 = pool.updateBias(proposal(bias(20e6, true)));
        assert(pool.epochFundingSpent() == paid2 && paid2 < 6e6);
        uint256 cash = token.balanceOf(address(pool));
        vm.warp(block.timestamp + 60);
        token.setMode(2); // Empty/cheaper update must not transfer even zero tokens.
        assert(pool.updateBias(proposal(new Q.Factor[](0))) == 0);
        assert(token.balanceOf(address(pool)) == cash && cash > pool.pricingReserve());
    }

    function testMovementAndCombinedGraphWidthRejectOnUpdatesAndTrades() public {
        reject(
            address(this), abi.encodeCall(pool.updateBias, (proposal(bias(21e6, true)))), Pool.MovementLimit.selector
        );
        pool = deploy(4, 100e6);
        Q.Factor[] memory factors = new Q.Factor[](2);
        uint128[] memory values = new uint128[](4);
        values[3] = 1e6;
        factors[0] = Q.Factor(3, values);
        factors[1] = Q.Factor(5, values);
        pool.updateBias(proposal(factors));
        // Bias edges 0-1 and 0-2 plus a real trade on 0-3 exceed width 2 in fixed order.
        reject(ALICE, abi.encodeCall(pool.buy, (9, 8, 1e6, 1e6, block.timestamp)), F.WidthExceeded.selector);
        vm.warp(block.timestamp + 60);
        Q.Factor[] memory dense = new Q.Factor[](3);
        dense[0] = factors[0];
        dense[1] = factors[1];
        dense[2] = Q.Factor(9, values);
        reject(address(this), abi.encodeCall(pool.updateBias, (proposal(dense))), F.WidthExceeded.selector);
        Q.Factor[] memory malformed = bias(1e6, true);
        malformed[0].values[0] = 1;
        reject(
            address(this),
            abi.encodeCall(pool.updateBias, (proposal(malformed))),
            FundedPricingEngine.NonCanonicalBias.selector
        );
    }

    function testFundingTransferFailuresRollbackEveryUpdateField() public {
        Pool.Update memory p = proposal(bias(10e6, true));
        for (uint8 mode = 1; mode <= 5; mode++) {
            if (mode == 4) continue;
            token.setMode(mode);
            bytes4 error = mode == 1
                ? SafeERC20.SafeERC20FailedOperation.selector
                : mode == 2 ? bytes4(keccak256("Error(string)")) : FactoredFunding.UnsupportedTransfer.selector;
            reject(address(this), abi.encodeCall(pool.updateBias, (p)), error);
        }
        token.setMode(0);
        token.approve(address(pool), 0);
        reject(
            address(this),
            abi.encodeCall(pool.updateBias, (p)),
            bytes4(keccak256("ERC20InsufficientAllowance(address,uint256,uint256)"))
        );
        token.approve(address(pool), type(uint256).max);
        token.setMode(6);
        assert(pool.updateBias(p) > 0);
    }

    function testFundingCallbackCannotReenterAndShortfallBlocksTrades() public {
        token.setCallback(address(pool), abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp)));
        pool.updateBias(proposal(bias(10e6, true)));
        assert(
            !token.callbackSucceeded() && token.callbackError() == ReentrancyGuard.ReentrancyGuardReentrantCall.selector
        );
        token.setMode(0);
        token.burn(address(pool), token.balanceOf(address(pool)) - pool.pricingReserve() + 1);
        reject(
            ALICE,
            abi.encodeCall(pool.buy, (1, 2, 1e6, 1e6, block.timestamp)),
            FactoredFunding.UncoveredLiability.selector
        );
        token.mint(address(pool), 1);
        reject(ALICE, abi.encodeCall(pool.sell, (1, 2, 1e6, 0, block.timestamp)), P.InsufficientHoldings.selector);
    }

    function testReceiptsAndWinningLosingSettlementIgnoreBias() public {
        vm.prank(ALICE);
        pool.buy(1, 2, 2e6, 2e6, block.timestamp);
        vm.prank(ALICE);
        pool.buy(2, 2, 1e6, 1e6, block.timestamp);
        FactoredBaseToken receipt = pool.createBaseToken(0, true);
        vm.prank(ALICE);
        pool.wrapBase(0, true, 1e6);
        pool.updateBias(proposal(bias(10e6, false)));
        assert(receipt.totalSupply() == 1e6 && pool.holdings(address(receipt), 1, 2) == 1e6);
        vm.warp(pool.closesAt());
        pool.resolve(1); // A true; B false.
        assert(pool.requiredCollateral() == 2e6);
        vm.prank(ALICE);
        pool.unwrapBase(0, true, 1e6);
        vm.prank(ALICE);
        assert(pool.redeem(1, 2, 2e6) == 2e6);
        vm.prank(ALICE);
        assert(pool.redeem(2, 2, 1e6) == 0);
        assert(pool.requiredCollateral() == 0 && receipt.totalSupply() == 0);
    }

    function testFuzzTradesAndUpdatesCoverIndependentTerminalLedger(uint256 seed) public {
        for (uint256 i; i < 5; i++) {
            uint256 choice = uint256(keccak256(abi.encode(seed, i)));
            uint32 scope = uint32(1 + choice % 3);
            uint256 mask = 1 + (choice >> 8) % (scope == 3 ? 14 : 2);
            vm.prank(ALICE);
            pool.buy(scope, mask, 1e6, 1e6, block.timestamp);
            vm.warp(block.timestamp + 60);
            pool.updateBias(proposal(bias(8e6, choice & 1 == 0)));
            uint256 maxPayout;
            for (uint256 state; state < 4; state++) {
                uint256 payout;
                for (uint32 s = 1; s <= 3; s++) {
                    uint256 local = s == 3 ? state : s == 1 ? state & 1 : state >> 1;
                    for (uint256 m = 1; m < (s == 3 ? 15 : 3); m++) {
                        if (m & (uint256(1) << local) != 0) payout += pool.holdings(ALICE, s, m);
                    }
                }
                if (payout > maxPayout) maxPayout = payout;
                assert(token.balanceOf(address(pool)) >= payout);
            }
            assert(pool.actualRequiredCollateral() == maxPayout);
            assert(token.balanceOf(address(pool)) >= pool.pricingReserve());
            vm.prank(ALICE);
            pool.sell(scope, mask, 1e6, 0, block.timestamp);
            assert(pool.actualRequiredCollateral() == 0);
        }
    }

    function testRuntimeAndConstructorStayWithinDeploymentLimits() public view {
        assert(address(pool).code.length <= 24576);
        assert(address(pool.pricingEngine()).code.length <= 24576);
        // Worst supported elimination order length, including ABI constructor arguments.
        Pool.MarketConfig memory config = Pool.MarketConfig(
            address(token),
            32,
            100e6,
            uint64(block.timestamp + 1 days),
            new uint8[](32),
            address(this),
            bytes32(uint256(1))
        );
        Pool.UpdatePolicy memory policy = Pool.UpdatePolicy(address(this), 20e6, 100e6, 3600, 60);
        assert(type(Pool).creationCode.length + abi.encode(config, policy).length <= 49152);
    }
}

