/* SPDX-License-Identifier: UNLICENSED */

pragma solidity 0.8.28;

import {FirelightVault} from  "../FirelightVault.sol";
import {Checkpoints} from "../lib/Checkpoints.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract FirelightVaultUpgradeTest is FirelightVault {
    using Checkpoints for Checkpoints.Trace256;
    using SafeERC20 for IERC20;

    function updateVersion(uint256 version) public {
        contractVersion = version;
    }
}