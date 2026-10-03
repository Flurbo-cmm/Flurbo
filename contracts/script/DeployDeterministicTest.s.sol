// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "./DeployPilot.s.sol";
/// @notice Fresh source-rule-bound test deployment; no change to pool or resolver logic.
contract DeployDeterministicTest is DeployPilot {
    function preparedPath() internal pure override returns (string memory) { return "target/deployments/deterministic-test-prepared.json"; }
    function manifestPath() internal pure override returns (string memory) { return "target/deployments/deterministic-test-unverified.json"; }
}
