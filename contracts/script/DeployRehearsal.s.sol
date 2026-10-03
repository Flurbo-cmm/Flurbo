// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "./DeployPilot.s.sol";

/// @notice Separate scripted testnet deployment. Never reads or replaces real-event artifacts.
contract DeployRehearsal is DeployPilot {
    function preparedPath() internal pure override returns(string memory) { return "target/deployments/rehearsal-prepared.json"; }
    function manifestPath() internal pure override returns(string memory) { return "target/deployments/rehearsal-unverified.json"; }
}
