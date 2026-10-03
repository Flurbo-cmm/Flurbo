// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {PilotResolver} from "../src/PilotResolver.sol";
import {PilotPool} from "../src/PilotPool.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {PilotDeployer} from "./DeployPilot.s.sol";

/// @notice Deploys several prepared pools in one run (one keystore prompt). FLURBO_DEPLOY_IDS lists the pool ids,
/// comma separated; pool <id> is read from target/deployments/<id>-prepared.json and its unverified manifest is
/// written to target/deployments/<id>-unverified.json. Every pool is checked before the first transaction: its
/// prepared file, deadlines, and the deployer's balance for the whole batch. A pool that already has an unverified
/// manifest is refused (move the file aside if that deployment never reached the chain), so a batch is never
/// deployed twice. Each pool is a separate contract pair; no existing pool or contract logic changes.
contract DeployPilotBatch is PilotDeployer {
    // ln 2 with 18 decimals, rounded up: funding for n questions at depth b is b * n * ln 2.
    uint256 private constant LN2 = 693147180559945310;

    function run() external {
        address creator = vm.envAddress("FLURBO_DEPLOYER");
        string[] memory ids = vm.envString("FLURBO_DEPLOY_IDS", ",");
        require(ids.length > 0 && ids.length <= 16, "list 1 to 16 pool ids");
        PilotResolver.Config[] memory configs = new PilotResolver.Config[](ids.length);
        uint256[] memory depths = new uint256[](ids.length);
        uint256 funding;
        for (uint256 i; i < ids.length; ++i) {
            for (uint256 j; j < i; ++j) require(keccak256(bytes(ids[i])) != keccak256(bytes(ids[j])), "duplicate pool id");
            require(!vm.exists(manifestPath(ids[i])), string.concat(ids[i], ": already deployed (unverified manifest exists)"));
            (configs[i], depths[i]) = readPrepared(preparedPath(ids[i]), creator);
            checkConfig(creator, configs[i], depths[i]);
            funding += (depths[i] * configs[i].eventHashes.length * LN2 + 1e18 - 1) / 1e18;
        }
        require(IERC20Metadata(AUSD).balanceOf(creator) >= funding, "fund creator with test AUSD for the whole batch");
        for (uint256 i; i < ids.length; ++i) {
            (PilotPool pool, PilotResolver resolver) = deploy(creator, configs[i], depths[i]);
            writeManifestTo(pool, resolver, ids[i], manifestPath(ids[i]));
        }
    }

    function preparedPath(string memory id) internal pure returns (string memory) { return string.concat("target/deployments/", id, "-prepared.json"); }
    function manifestPath(string memory id) internal pure returns (string memory) { return string.concat("target/deployments/", id, "-unverified.json"); }
}
