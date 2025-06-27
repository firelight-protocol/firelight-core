/* SPDX-License-Identifier: UNLICENSED */
pragma solidity 0.8.28;

import {Checkpoints} from "./lib/Checkpoints.sol";

/**
 * @title FirelightVaultStorage
 * @notice Storage of FirelightVault
 * @custom:security-contact securityreport@firelight.finance
 */
abstract contract FirelightVaultStorage {
    bytes32 public constant DEPOSIT_LIMIT_UPDATE_ROLE = keccak256("DEPOSIT_LIMIT_UPDATE_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant BLACKLIST_ROLE = keccak256("BLACKLIST_ROLE");
    bytes32 public constant PAUSE_ROLE = keccak256("PAUSE_ROLE");

    /// @notice The maximum total amount of assets that can be deposited into the vault.
    uint256 public depositLimit;

    /// @notice The current version of the contract.
    uint256 public contractVersion;

    /// @notice The total amount of assets pending withdrawal across all periods.
    uint256 public pendingWithdrawAssets;

    /// @notice The timestamp when the first period started.
    uint48 public periodInit;

    /// @notice The duration of each period in seconds.
    uint48 public periodDuration;

    /// @notice Total shares allocated for withdrawals in a given period.
    mapping(uint256 period => uint256 shares) public withdrawShares;

    /// @notice Total assets allocated for withdrawals in a given period.
    mapping(uint256 period => uint256 assets) public withdrawAssets;

    /// @notice Total shares allocated for withdrawals in a given period and a givven account.
    mapping(uint256 period => mapping(address account => uint256 assets)) public withdrawSharesOf;

    /// @notice Indicates whether an account has claimed their withdrawal for a given period.
    mapping(uint256 period => mapping(address account => bool value)) public isWithdrawClaimed;

    /// @notice Indicates whether an account is blacklisted.
    mapping(address account => bool) public isBlacklisted;

    /// @notice Checkpoints for assets and shares
    mapping(address account => Checkpoints.Trace256 shares) internal _traceBalanceOf;
    Checkpoints.Trace256 internal _traceTotalSupply;
    Checkpoints.Trace256 internal _traceTotalAssets;

    uint256[50] private __gap;
}
