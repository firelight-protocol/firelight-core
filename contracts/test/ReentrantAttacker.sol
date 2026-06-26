// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Malicious contract that attempts reentrancy on Rewarder.claim(bitmap, offset)
 *      when it receives reward tokens.
 */
interface IRewarder {
    function claim(uint256[] calldata claimsBitmap, uint256 offset) external returns (uint256);
}

contract ReentrantAttacker {
    IRewarder public target;
    bool public attacking;
    uint256[] private _bitmap;

    constructor(address target_) {
        target = IRewarder(target_);
        _bitmap.push(1);
    }

    function attack() external {
        attacking = true;
        target.claim(_bitmap, 0);
    }

    /// @dev Called when this contract receives ERC20 tokens via a hook (e.g. ERC777).
    ///      For testing, we trigger this via a mock token with transfer callbacks.
    function onTokenTransfer(address, uint256, bytes calldata) external returns (bool) {
        if (attacking) {
            attacking = false;
            target.claim(_bitmap, 0);
        }
        return true;
    }
}
