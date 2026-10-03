// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {FundedFactoredPool as Pool} from "../src/FundedFactoredPool.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface LearningDeployVm {
    function envAddress(string calldata) external returns (address);
    function envUint(string calldata) external returns (uint256);
    function startBroadcast(address) external;
    function stopBroadcast() external;
    function serializeAddress(string calldata, string calldata, address) external returns (string memory);
    function serializeUint(string calldata, string calldata, uint256) external returns (string memory);
    function serializeString(string calldata, string calldata, string calldata) external returns (string memory);
    function serializeBytes32(string calldata, string calldata, bytes32) external returns (string memory);
    function writeJson(string calldata, string calldata) external;
}

/// @notice Separate synthetic test-asset deployment. Default execution is a dry run.
/// @dev Does not replace the existing pool, seed Kuru or submit any pricing update.
contract DeployLearning {
    LearningDeployVm private constant vm = LearningDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant OPERATOR = 0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391;
    address public constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    uint128 public constant INITIAL_FUNDING = 55_451_775;
    string public constant RULES =
        "Flurbo synthetic learning v1: eight binary test fixtures; event i is bit i; immutable deployer resolves once after close; no cancellation; no real-world outcome source; authorized funded bias updates change prices, not payouts.";

    function run() external returns (Pool pool) {
        return deploy(vm.envAddress("FLURBO_DEPLOYER"), vm.envUint("FLURBO_LEARNING_CLOSES_AT"));
    }

    function deploy(address operator, uint256 close) internal returns (Pool pool) {
        require(block.chainid == 10143, "Monad testnet only");
        require(operator == OPERATOR, "unexpected deployer");
        require(close > block.timestamp + 1 hours && close < block.timestamp + 30 days, "invalid close");
        IERC20Metadata cash = IERC20Metadata(AUSD);
        require(cash.decimals() == 6, "unexpected collateral precision");
        // Ten AUSD stays in the operator wallet for separately reviewed updates.
        require(cash.balanceOf(OPERATOR) >= INITIAL_FUNDING + 10e6, "needs 65.451775 test AUSD");
        uint8[] memory order = new uint8[](8);
        for (uint8 i; i < 8; i++) {
            order[i] = i;
        }
        vm.startBroadcast(OPERATOR);
        pool = new Pool(
            Pool.MarketConfig(AUSD, 8, 10e6, uint64(close), order, OPERATOR, keccak256(bytes(RULES))),
            Pool.UpdatePolicy(OPERATOR, 2e6, 10e6, 1 hours, 60)
        );
        require(pool.requiredFunding() == INITIAL_FUNDING, "unexpected funding requirement");
        require(cash.approve(address(pool), INITIAL_FUNDING), "approval failed");
        pool.fund();
        require(cash.approve(address(pool), 0), "approval reset failed");
        vm.stopBroadcast();
        writeManifest(pool);
    }

    function writeManifest(Pool pool) internal virtual {
        string memory key = "learning";
        vm.serializeString(key, "status", "unverified_learning_deployment");
        vm.serializeString(key, "deployment_kind", "synthetic_funded_learning_v1");
        vm.serializeString(key, "rules", RULES);
        vm.serializeUint(key, "chain_id", 10143);
        vm.serializeUint(key, "event_count", 8);
        vm.serializeUint(key, "liquidity_atoms", 10e6);
        vm.serializeUint(key, "closes_at", pool.closesAt());
        vm.serializeUint(key, "initial_funding_atoms", pool.requiredFunding());
        vm.serializeUint(key, "max_bias_movement_atoms", pool.maxBiasMovement());
        vm.serializeUint(key, "epoch_funding_limit_atoms", pool.epochFundingLimit());
        vm.serializeUint(key, "epoch_seconds", pool.epochSeconds());
        vm.serializeUint(key, "min_update_interval_seconds", pool.minUpdateInterval());
        vm.serializeBytes32(key, "rules_hash", pool.settlementRulesHash());
        vm.serializeAddress(key, "operator", OPERATOR);
        vm.serializeAddress(key, "resolver", pool.resolver());
        vm.serializeAddress(key, "updater", pool.updater());
        vm.serializeAddress(key, "pool", address(pool));
        vm.serializeAddress(key, "pricing_engine", address(pool.pricingEngine()));
        vm.serializeAddress(key, "base_token_factory", address(pool.baseTokenFactory()));
        string memory output = vm.serializeAddress(key, "cash", AUSD);
        // Dry runs also write this file. Only RPC verification can establish a public deployment.
        vm.writeJson(output, "target/deployments/learning-unverified.json");
    }
}
