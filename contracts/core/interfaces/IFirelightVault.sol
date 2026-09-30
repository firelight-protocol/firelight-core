// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title IFirelightVault
 * @notice Full external interface of {FirelightVault}, an ERC4626-compatible vault with
 *         delayed withdrawals, role-based access control, blocklisting, pausing,
 *         and historical balance/supply/assets checkpoints.
 *
 * @dev FirelightVault intentionally deviates from ERC4626: `withdraw` and `redeem` create a
 *      pending withdrawal request rather than transferring assets immediately. The shares
 *      are burned on request, and assets become claimable in a later period via
 *      `claimWithdraw`. The standard ERC4626 `Withdraw` event is NOT emitted; instead the
 *      lifecycle is tracked by `WithdrawRequest` and `CompleteWithdraw` events.
 *
 * @custom:security-contact securityreport@firelight.finance
 */
interface IFirelightVault is IERC4626, IAccessControl {
    // -------------------------------------------------------------------------
    // Structs
    // -------------------------------------------------------------------------

    /**
     * @notice Configuration of a vault period.
     * @param epoch Starting timestamp of this configuration.
     * @param duration Period length in seconds. Must be a multiple of {SMALLEST_PERIOD_DURATION}.
     * @param startingPeriod Period number assigned to `epoch`.
     */
    struct PeriodConfiguration {
        uint48 epoch;
        uint48 duration;
        uint256 startingPeriod;
    }

    /**
     * @notice Initial parameters for vault deployment, ABI-encoded as the `bytes` argument
     *         of {initialize}.
     * @param defaultAdmin Receives `DEFAULT_ADMIN_ROLE`.
     * @param limitUpdater Receives `DEPOSIT_LIMIT_UPDATE_ROLE`.
     * @param blocklister Receives `BLOCKLIST_ROLE`.
     * @param pauser Receives `PAUSE_ROLE`.
     * @param periodConfigurationUpdater Receives `PERIOD_CONFIGURATION_UPDATE_ROLE`.
     * @param rescuer Receives `RESCUER_ROLE`.
     * @param depositLimit Initial maximum total assets allowed in the vault.
     * @param periodConfigurationDuration Initial period duration.
     */
    struct InitParams {
        address defaultAdmin;
        address limitUpdater;
        address blocklister;
        address pauser;
        address periodConfigurationUpdater;
        address rescuer;
        uint256 depositLimit;
        uint48 periodConfigurationDuration;
    }

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    /// @notice Emitted when the vault's deposit limit is updated.
    event DepositLimitUpdated(uint256 limit);

    /// @notice Emitted when a new period configuration is added.
    event PeriodConfigurationAdded(PeriodConfiguration periodConfiguration);

    /// @notice Emitted when a withdrawal request is created.
    event WithdrawRequest(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 period,
        uint256 assets,
        uint256 shares
    );

    /// @notice Emitted when a withdrawal is successfully claimed for a given period.
    event CompleteWithdraw(address indexed receiver, uint256 assets, uint256 period);

    /// @notice Emitted when a `RESCUER_ROLE` holder rescues shares from a blocklisted address.
    event SharesRescuedFromBlocklisted(address from, address to, uint256 rescuedShares);

    /// @notice Emitted when a `RESCUER_ROLE` holder rescues pending withdrawals from a blocklisted address.
    event WithdrawRescuedFromBlocklisted(address from, address to, uint256[] periods, uint256[] rescuedShares);

    /// @notice Emitted when an incident payout is processed, including when no assets can be paid.
    /// @param to The allowlisted payout receiver.
    /// @param requestedAmount The requested payout amount, in vault asset units.
    /// @param paidAmount The amount actually transferred, which may be less than requested or zero.
    /// @param captureTimestamp The incident capture timestamp that determines the covered period and payout window.
    event PayoutExecuted(address indexed to, uint256 requestedAmount, uint256 paidAmount, uint48 captureTimestamp);

    /// @notice Emitted when a period's active incident flag is set.
    /// @param period The period whose active incident flag was set.
    /// @param active Whether the period has an active incident.
    event ActiveIncidentUpdated(uint256 indexed period, bool active);

    /// @notice Emitted when an address is added to the blocklist.
    event AddedToBlocklist(address indexed account);

    /// @notice Emitted when an address is removed from the blocklist.
    event RemovedFromBlocklist(address indexed account);

    /// @notice Emitted when an address is added to the payout allowlist.
    event AddedToPayoutAllowlist(address indexed account);

    /// @notice Emitted when an address is removed from the payout allowlist.
    event RemovedFromPayoutAllowlist(address indexed account);

    /// @notice Emitted when a total-assets checkpoint is recorded outside deposit/withdraw flows.
    event TotalAssetsCheckpointed(uint256 totalAssets);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    /// @notice An account involved in the operation is blocklisted.
    error BlocklistedAddress();

    /// @notice The account is not blocklisted.
    error NotBlocklistedAddress();

    /// @notice A deposit or mint would increase total assets above the deposit limit.
    error DepositLimitExceeded();

    /// @notice The deposit limit is zero.
    error InvalidDepositLimit();

    /// @notice The period configuration epoch is too early or not aligned with a period boundary.
    error InvalidPeriodConfigurationEpoch();

    /// @notice The period duration is outside the allowed range or not a multiple of SMALLEST_PERIOD_DURATION.
    error InvalidPeriodConfigurationDuration();

    /// @notice The account has insufficient shares for the withdrawal or no shares to rescue.
    error InsufficientShares();

    /// @notice The underlying asset address is zero.
    error InvalidAssetAddress();

    /// @notice The default admin address is zero.
    error InvalidAdminAddress();

    /// @notice An account address required by the operation is zero.
    error InvalidAddress();

    /// @notice The requested amount is zero or converts to zero shares or assets.
    error InvalidAmount();

    /// @notice No period configuration applies to the query, or the withdrawal period has not ended.
    error InvalidPeriod();

    /// @notice A future period configuration is already scheduled.
    error CurrentPeriodConfigurationNotLast();

    /// @notice The array of withdrawal periods to rescue is empty.
    error InvalidArrayLength();

    /// @notice A withdrawal for the account and period has already been claimed.
    /// @param period The period whose withdrawal has already been claimed.
    error AlreadyClaimedPeriod(uint256 period);

    /// @notice The account has no withdrawal shares or claimable assets for the period.
    /// @param period The period with no withdrawal shares or claimable assets.
    error NoWithdrawalAmount(uint256 period);

    /// @notice The payout receiver is not on the payout allowlist.
    error AccountNotAllowlisted();

    /// @notice The capture period is neither the current period nor the previous period.
    error InvalidCapturePeriod();

    /// @notice An active incident in the current or previous period blocks deposits and mints.
    error CurrentPeriodHasActiveIncident();

    // -------------------------------------------------------------------------
    // Role identifiers and protocol constants (auto-generated public getters)
    // -------------------------------------------------------------------------

    function DEPOSIT_LIMIT_UPDATE_ROLE() external view returns (bytes32);

    function RESCUER_ROLE() external view returns (bytes32);

    function BLOCKLIST_ROLE() external view returns (bytes32);

    function PAUSE_ROLE() external view returns (bytes32);

    function PAYOUT_ALLOWLIST_ROLE() external view returns (bytes32);

    function PAYOUT_ROLE() external view returns (bytes32);

    function INCIDENT_ROLE() external view returns (bytes32);

    function CHECKPOINT_ROLE() external view returns (bytes32);

    function PERIOD_CONFIGURATION_UPDATE_ROLE() external view returns (bytes32);

    function SMALLEST_PERIOD_DURATION() external view returns (uint48);

    function MAX_PERIOD_DURATION() external view returns (uint48);

    // -------------------------------------------------------------------------
    // Storage getters (auto-generated from public state variables)
    // -------------------------------------------------------------------------

    function depositLimit() external view returns (uint256);

    function contractVersion() external view returns (uint256);

    function pendingWithdrawAssets() external view returns (uint256);

    function periodConfigurations(
        uint256 index
    ) external view returns (uint48 epoch, uint48 duration, uint256 startingPeriod);

    function withdrawShares(uint256 period) external view returns (uint256);

    function withdrawAssets(uint256 period) external view returns (uint256);

    function withdrawSharesOf(uint256 period, address account) external view returns (uint256);

    function isWithdrawClaimed(uint256 period, address account) external view returns (bool);

    function isBlocklisted(address account) external view returns (bool);

    // -------------------------------------------------------------------------
    // Initialization
    // -------------------------------------------------------------------------

    /**
     * @notice Initializes the FirelightVault contract.
     * @param asset_ The underlying ERC20 token.
     * @param name_ The name of the vault share token.
     * @param symbol_ The symbol of the vault share token.
     * @param initParams_ ABI-encoded {InitParams}.
     */
    function initialize(IERC20 asset_, string memory name_, string memory symbol_, bytes memory initParams_) external;

    // -------------------------------------------------------------------------
    // Period queries
    // -------------------------------------------------------------------------

    function periodConfigurationAtTimestamp(uint48 timestamp) external view returns (PeriodConfiguration memory);

    function periodConfigurationAtNumber(uint256 periodNumber) external view returns (PeriodConfiguration memory);

    function periodAtTimestamp(uint48 timestamp) external view returns (uint256);

    function currentPeriodConfiguration() external view returns (PeriodConfiguration memory);

    function currentPeriod() external view returns (uint256);

    function currentPeriodStart() external view returns (uint48);

    function currentPeriodEnd() external view returns (uint48);

    function nextPeriodEnd() external view returns (uint48);

    function periodConfigurationsLength() external view returns (uint256);

    // -------------------------------------------------------------------------
    // Historical (checkpointed) queries
    // -------------------------------------------------------------------------

    function balanceOfAt(address account, uint48 timestamp) external view returns (uint256);

    function totalSupplyAt(uint48 timestamp) external view returns (uint256);

    function totalAssetsAt(uint48 timestamp) external view returns (uint256);

    function withdrawalsOf(uint256 period, address account) external view returns (uint256);

    function isPeriodInPayoutWindow(uint256 period) external view returns (bool);

    // -------------------------------------------------------------------------
    // Withdrawal lifecycle
    // -------------------------------------------------------------------------

    /**
     * @notice Claims a pending withdrawal for `period`.
     * @dev Reverts if `period` has not yet ended, has already been claimed, or has no balance.
     */
    function claimWithdraw(uint256 period) external returns (uint256 assets);

    // -------------------------------------------------------------------------
    // Pausing (PausableUpgradeable)
    // -------------------------------------------------------------------------

    function paused() external view returns (bool);

    function pause() external;

    function unpause() external;

    function hasActiveIncident(uint256 period) external view returns (bool);

    function setActiveIncident(uint256 period, bool active) external;

    // -------------------------------------------------------------------------
    // Admin / configuration
    // -------------------------------------------------------------------------

    function updateDepositLimit(uint256 newLimit) external;

    function addPeriodConfiguration(uint48 epoch, uint48 duration) external;

    /**
     * @notice Records a checkpoint of the current total assets. Requires `CHECKPOINT_ROLE`.
     * @dev Called by the reward distributor after forwarding assets so historical
     * `totalAssetsAt` lookups include them.
     */
    function checkpointTotalAssets() external;

    // -------------------------------------------------------------------------
    // Blocklist
    // -------------------------------------------------------------------------

    function addToBlocklist(address account) external;

    function removeFromBlocklist(address account) external;

    // -------------------------------------------------------------------------
    // Payout allowlist
    // -------------------------------------------------------------------------

    /// @notice Adds an address to the payout allowlist. Requires PAYOUT_ALLOWLIST_ROLE.
    /// @param account The address to add. Cannot be the zero address.
    function addToPayoutAllowlist(address account) external;

    /// @notice Removes an address from the payout allowlist. Requires PAYOUT_ALLOWLIST_ROLE.
    /// @param account The address to remove.
    function removeFromPayoutAllowlist(address account) external;

    /// @notice Returns whether an address is on the payout allowlist.
    /// @param account The address to query.
    /// @return True if the address is allowlisted to receive payouts.
    function isPayoutAllowlisted(address account) external view returns (bool);

    // -------------------------------------------------------------------------
    // Rescue
    // -------------------------------------------------------------------------

    function rescueSharesFromBlocklisted(address from, address to) external;

    function rescueWithdrawFromBlocklisted(address from, address to, uint256[] calldata periods) external;

    // -------------------------------------------------------------------------
    // Payout
    // -------------------------------------------------------------------------

    function payout(address to, uint256 amount, uint48 captureTimestamp) external returns (uint256 paidAmount);
}
