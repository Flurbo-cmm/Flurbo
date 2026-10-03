// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "./DeployPilot.s.sol";

/// @notice Uses the existing pilot mechanism with separate October artifact paths.
contract DeployOctoberDemo is DeployPilot {
    function preparedPath() internal pure override returns(string memory) { return "target/deployments/october-demo-prepared.json"; }
    function manifestPath() internal pure override returns(string memory) { return "target/deployments/october-demo-unverified.json"; }
}
