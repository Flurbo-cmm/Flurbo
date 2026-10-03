// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "./DeployPilot.s.sol";
/// @notice Separate two-event test collection. Never overwrites Showcase artifacts.
contract DeployActivityTest is DeployPilot {
    function preparedPath() internal pure override returns(string memory) { return "target/deployments/activity-test-prepared.json"; }
    function manifestPath() internal pure override returns(string memory) { return "target/deployments/activity-test-unverified.json"; }
}
