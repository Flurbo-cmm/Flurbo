// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {AccountPilotResolver as PilotResolver} from "../src/AccountPilotResolver.sol";
import {PilotPool} from "../src/PilotPool.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface AccountPilotDeployVm {
    function envAddress(string calldata) external returns (address);
    function readFile(string calldata) external view returns (string memory);
    function parseJsonBytes(string calldata, string calldata) external pure returns (bytes memory);
    function parseJsonAddress(string calldata, string calldata) external pure returns (address);
    function parseJsonBytes32(string calldata, string calldata) external pure returns (bytes32);
    function parseJsonUint(string calldata, string calldata) external pure returns (uint256);
    function startBroadcast(address) external;
    function stopBroadcast() external;
    function serializeAddress(string calldata, string calldata, address) external returns (string memory);
    function serializeBytes32(string calldata, string calldata, bytes32) external returns (string memory);
    function serializeString(string calldata, string calldata, string calldata) external returns (string memory);
    function writeJson(string calldata, string calldata) external;
}

/// @notice Explicit deployment of a separate 2-4 event testnet pilot. Never changes the existing pools.
contract DeployAccountPilot {
    address private authority;
    AccountPilotDeployVm private constant vm = AccountPilotDeployVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;

    function run() external returns (PilotPool pool, PilotResolver resolver) {
        string memory prepared = vm.readFile(preparedPath());
        address creator = vm.envAddress("FLURBO_DEPLOYER");
        authority = vm.parseJsonAddress(prepared, ".publication.challengePolicy.authority");
        require(creator == vm.parseJsonAddress(prepared, ".creator"), "prepared creator mismatch");
        bytes memory encoded = vm.parseJsonBytes(prepared, ".resolverConfig");
        require(keccak256(encoded) == vm.parseJsonBytes32(prepared, ".configHash"), "configuration hash mismatch");
        PilotResolver.Config memory c = abi.decode(encoded, (PilotResolver.Config));
        uint256 liquidity = vm.parseJsonUint(prepared, ".liquidityAtoms");
        (pool, resolver) = deploy(creator, c, liquidity);
        writeManifest(pool, resolver);
    }

    function preparedPath() internal pure virtual returns (string memory) { return "target/deployments/account-pilot-prepared.json"; }
    function manifestPath() internal pure virtual returns (string memory) { return "target/deployments/account-pilot-unverified.json"; }

    function deploy(address creator, PilotResolver.Config memory c, uint256 liquidity) internal returns (PilotPool pool, PilotResolver resolver) {
        require(block.chainid == 10143 && creator != address(0), "Monad testnet creator required");
        require(c.collateral == AUSD && c.closesAt > block.timestamp + 1 hours && c.closesAt <= block.timestamp + 30 days, "invalid pilot configuration");
        for (uint256 i; i < c.observationEnds.length; ++i) require(c.observationEnds[i] <= block.timestamp + 90 days, "observation too late");
        IERC20Metadata cash = IERC20Metadata(AUSD);
        require(cash.decimals() == 6, "collateral precision mismatch");
        uint8[] memory order = new uint8[](c.eventHashes.length);
        for (uint8 i; i < order.length; ++i) order[i] = i;
        vm.startBroadcast(creator);
        resolver = new PilotResolver(c, authority);
        require(liquidity >= 10e6 && liquidity <= 1e12, "prepared liquidity out of range");
        pool = new PilotPool(AUSD, uint8(c.eventHashes.length), uint128(liquidity), c.closesAt, order, address(resolver), resolver.rulesHash());
        resolver.bindPool(address(pool));
        require(cash.balanceOf(creator) >= pool.requiredFunding(), "fund creator with test AUSD");
        require(cash.approve(address(pool), pool.requiredFunding()), "funding approval failed");
        pool.fund();
        require(cash.approve(address(pool), 0), "reset approval failed");
        // Canonical YES receipts are created for future verified Kuru pairs.
        for (uint8 i; i < c.eventHashes.length; ++i) pool.createBaseToken(i, true);
        vm.stopBroadcast();
    }

    function writeManifest(PilotPool pool, PilotResolver resolver) internal virtual {
        string memory key = "pilot";
        vm.serializeString(key, "status", "unverified_pilot_deployment");
        vm.serializeAddress(key, "pool", address(pool));
        vm.serializeAddress(key, "resolver", address(resolver));
        vm.serializeAddress(key, "creator", resolver.creator());
        vm.serializeBytes32(key, "draftHash", resolver.draftHash());
        string memory output = vm.serializeBytes32(key, "rulesHash", resolver.rulesHash());
        vm.writeJson(output, manifestPath());
    }
}
