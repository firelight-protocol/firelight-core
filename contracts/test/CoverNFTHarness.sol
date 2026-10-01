// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {CoverNFT} from "../core/CoverNFT.sol";

/**
 * @dev Exposes CoverNFT internal hooks that are unreachable through the external ABI,
 *      so tests can exercise the required multiple-inheritance overrides.
 */
contract CoverNFTHarness is CoverNFT {
    function exposedIncreaseBalance(address account, uint128 value) external {
        _increaseBalance(account, value);
    }
}
