// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {TestAusdFaucet} from "../src/TestAusdFaucet.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface TestFaucetVm {
    function envAddress(string calldata) external returns (address);
    function startBroadcast(address) external;
    function stopBroadcast() external;
}

contract DeployTestFaucet {
    TestFaucetVm private constant vm = TestFaucetVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant OPERATOR = 0xF1feA08EbBa92eD342Acc5639dB312C3694Bc391;
    address public constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    uint256 public constant INITIAL_FUNDING = 1000e6;

    function run() external returns (TestAusdFaucet faucet) {
        require(block.chainid == 10143, "Monad testnet only");
        require(vm.envAddress("FLURBO_DEPLOYER") == OPERATOR, "Unexpected deployer");
        IERC20Metadata token = IERC20Metadata(AUSD);
        require(token.decimals() == 6 && token.balanceOf(OPERATOR) >= INITIAL_FUNDING, "Needs 1000 test AUSD");
        vm.startBroadcast(OPERATOR);
        faucet = new TestAusdFaucet(OPERATOR);
        require(token.transfer(address(faucet), INITIAL_FUNDING), "Funding failed");
        vm.stopBroadcast();
        require(token.balanceOf(address(faucet)) == INITIAL_FUNDING, "Verify faucet funding");
    }
}
