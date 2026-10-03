// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "./DeployPilot.s.sol";
/// @notice pre-test-v1: the deterministic deployment with its own artifact files; no change to pool or resolver logic.
contract DeployPreTest is DeployPilot {
    function preparedPath() internal pure override returns (string memory) { return "target/deployments/pre-test-v1-prepared.json"; }
    function manifestPath() internal pure override returns (string memory) { return "target/deployments/pre-test-v1-unverified.json"; }
}
