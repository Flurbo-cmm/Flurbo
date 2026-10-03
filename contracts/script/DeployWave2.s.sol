// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {DeployPilot} from "./DeployPilot.s.sol";

contract DeployWave2F3 is DeployPilot {
    function preparedPath() internal pure override returns (string memory) { return "target/deployments/wave2-f3-prepared.json"; }
    function manifestPath() internal pure override returns (string memory) { return "target/deployments/wave2-f3-unverified.json"; }
}

contract DeployWave2F2 is DeployPilot {
    function preparedPath() internal pure override returns (string memory) { return "target/deployments/wave2-f2-prepared.json"; }
    function manifestPath() internal pure override returns (string memory) { return "target/deployments/wave2-f2-unverified.json"; }
}
