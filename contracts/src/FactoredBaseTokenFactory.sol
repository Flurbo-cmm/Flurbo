// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;
import {FactoredBaseToken} from "./FactoredBaseToken.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

/// @dev Stateless deployment helper. Receipt creation bytecode stays outside the pool runtime.
contract FactoredBaseTokenFactory {
    error InvalidEvent();

    function create(uint8 eventIndex, bool outcome, uint8 decimals) external returns (FactoredBaseToken) {
        if (eventIndex >= 32) revert InvalidEvent();
        string memory index = Strings.toString(eventIndex);
        return new FactoredBaseToken(
            msg.sender,
            uint32(1) << eventIndex,
            outcome ? 2 : 1,
            decimals,
            string.concat("Flurbo factored event ", index, outcome ? " YES" : " NO"),
            string.concat("FFB", index, outcome ? "Y" : "N")
        );
    }
}
