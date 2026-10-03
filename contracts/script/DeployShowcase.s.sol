// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "./DeployPilot.s.sol";
/// @notice Isolated real Ethereum activity showcase; original pools remain unchanged.
contract DeployShowcase is DeployPilot {
    function preparedPath() internal pure override returns(string memory) { return "target/deployments/showcase-v0-prepared.json"; }
    function manifestPath() internal pure override returns(string memory) { return "target/deployments/showcase-v0-unverified.json"; }
}
