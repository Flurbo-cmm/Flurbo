// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @dev Local-chain stand-in for Multicall3's aggregate3, installed at the canonical address on an anvil
/// chain so the web service's batched reads work in local agent tests. Never deployed to a public network.
contract LocalMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory data) = calls[i].target.staticcall(calls[i].callData);
            require(ok || calls[i].allowFailure, "Multicall3: call failed");
            results[i] = Result(ok, data);
        }
    }
}
