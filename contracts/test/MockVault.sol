// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

/**
 * @dev Minimal mock of IFirelightVault for Rewarder tests.
 *      Stores per-address balance snapshots and total supply snapshots
 *      that can be set directly from tests.
 */
contract MockVault {
    address public asset;

    mapping(uint48 => uint256) private _totalSupplyAt;
    mapping(address => mapping(uint48 => uint256)) private _balanceOfAt;
    mapping(uint48 => uint256) private _periodAtTimestamp;

    constructor(address asset_) {
        asset = asset_;
    }

    function setTotalSupplyAt(uint48 timestamp, uint256 supply) external {
        _totalSupplyAt[timestamp] = supply;
    }

    function setBalanceOfAt(address account, uint48 timestamp, uint256 balance) external {
        _balanceOfAt[account][timestamp] = balance;
    }

    function totalSupplyAt(uint48 timestamp) external view returns (uint256) {
        return _totalSupplyAt[timestamp];
    }

    function balanceOfAt(address account, uint48 timestamp) external view returns (uint256) {
        return _balanceOfAt[account][timestamp];
    }

    function setPeriodAtTimestamp(uint48 timestamp, uint256 period) external {
        _periodAtTimestamp[timestamp] = period;
    }

    function periodAtTimestamp(uint48 timestamp) external view returns (uint256) {
        return _periodAtTimestamp[timestamp];
    }
}
