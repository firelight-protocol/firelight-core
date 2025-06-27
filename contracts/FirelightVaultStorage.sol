/* SPDX-License-Identifier: UNLICENSED */
pragma solidity 0.8.28;

import {Checkpoints} from "./lib/Checkpoints.sol";

/**
 * @title FirelightVaultStorage
 * @notice Storage layout for FirelightVault.
 * @custom:security-contact securityreport@firelight.finance
 */
abstract contract FirelightVaultStorage {
    /// @notice Role for updating deposit limits.
    bytes32 public constant DEPOSIT_LIMIT_UPDATE_ROLE = keccak256("DEPOSIT_LIMIT_UPDATE_ROLE");

    /// @notice Role for rescuing funds.    
    bytes32 public constant RESCUER_ROLE = keccak256("RESCUER_ROLE");

    /// @notice Role for managing the blacklist.
    bytes32 public constant BLACKLIST_ROLE = keccak256("BLACKLIST_ROLE");

    /// @notice Role for pausing and unpausing contract operations.
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");

    /// @notice Role for updating the period configurations.
    bytes32 public constant PERIOD_CONFIGURATION_UPDATE_ROLE = keccak256("PERIOD_CONFIGURATION_UPDATE_ROLE");

    /// @notice Minimum period duration in seconds.
    uint48 public constant SMALLEST_PERIOD_DURATION = 1 days;

    /// @notice The maximum total amount of assets that can be deposited into the vault.
    uint256 public depositLimit;

    /// @notice The current version of the contract.
    uint256 public contractVersion;

    /// @notice The total amount of assets pending withdrawal across all periods.
    uint256 public pendingWithdrawAssets;

    struct PeriodConfiguration {
        uint48 epoch;
        uint48 duration;
        uint startingPeriod;
    }

    /// @notice Array of period configurations consisting of an starting timestamp (epoch), starting period number (startingPeriod) and period duration (duration).
    PeriodConfiguration[] public periodConfigurations;

    /// @notice Total shares allocated for withdrawals in a given period.
    mapping(uint256 period => uint256 shares) public withdrawShares;

    /// @notice Total assets allocated for withdrawals in a given period.
    mapping(uint256 period => uint256 assets) public withdrawAssets;

    /// @notice Total shares allocated for withdrawals in a given period and a given account.
    mapping(uint256 period => mapping(address account => uint256 shares)) public withdrawSharesOf;

    /// @notice Indicates whether an account has claimed their withdrawal for a given period.
    mapping(uint256 period => mapping(address account => bool value)) public isWithdrawClaimed;

    /// @notice Indicates whether an account is blacklisted.
    mapping(address account => bool) public isBlacklisted;

    /// @notice Checkpoints for assets and shares.
    mapping(address account => Checkpoints.Trace256 shares) internal _traceBalanceOf;
    Checkpoints.Trace256 internal _traceTotalSupply;
    Checkpoints.Trace256 internal _traceTotalAssets;

    uint256[50] private __gap;
}
