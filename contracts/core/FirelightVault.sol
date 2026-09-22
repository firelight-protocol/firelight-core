// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Time} from "@openzeppelin/contracts/utils/types/Time.sol";

import {FirelightVaultStorage} from "./FirelightVaultStorage.sol";
import {Checkpoints} from "./lib/Checkpoints.sol";

/**
 * @title FirelightVault
 * @notice Upgradeable ERC4626-compatible vault with delayed withdrawals.
 *
 * @dev FirelightVault is an ERC4626 vault that intentionally deviates from the standard.
 * It overrides `withdraw` and `redeem` to implement delayed withdrawals.
 * Instead of transferring assets immediately, these functions create a withdrawal request,
 * which must be completed later via `claimWithdraw` after a set delay.
 *
 * The standard `Withdraw` event is not emitted. Instead, `WithdrawRequest` and `CompleteWithdraw`
 * are used to track the withdrawal process.
 *
 * Off-chain and on-chain tools must account for this custom flow and event structure.
 *
 * @custom:security-contact securityreport@firelight.finance
 */
contract FirelightVault is
    FirelightVaultStorage,
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable
{
    using Checkpoints for Checkpoints.Trace256;
    using SafeERC20 for IERC20;
    using Math for uint256;

    /**
     * @notice Initial parameters needed for the vault's deployment.
     * @param defaultAdmin Vault's admin that grants and revokes roles.
     * @param limitUpdater Address assigned the DEPOSIT_LIMIT_UPDATE_ROLE at initialization.
     * @param blocklister Address assigned the BLOCKLIST_ROLE at initialization.
     * @param pauser Address assigned the PAUSE_ROLE at initialization.
     * @param periodConfigurationUpdater Address assigned the PERIOD_CONFIGURATION_UPDATE_ROLE at initialization.
     * @param rescuer Address assigned the RESCUER_ROLE at initialization.
     * @param depositLimit Initial total deposit limit.
     * @param periodConfigurationDuration Initial period duration of the vault.
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

    /**
     * @notice Emitted when the vault's deposit limit is updated.
     * @param limit The new maximum amount of assets allowed in the vault.
     */
    event DepositLimitUpdated(uint256 limit);

    /**
     * @notice Emitted when a new periodConfiguration is added.
     * @param periodConfiguration The details of the newly added periodConfiguration.
     */
    event PeriodConfigurationAdded(PeriodConfiguration periodConfiguration);

    /**
     * @notice Emitted when a withdrawal request is created by a user.
     * @param sender The caller who initiated the withdrawal request.
     * @param receiver The address that will receive the assets in the next period.
     * @param owner The address whose shares are being redeemed, using allowance.
     * @param period The period when the withdrawal will be available.
     * @param assets The amount of assets to be withdrawn.
     * @param shares The number of shares burned for the withdrawal.
     */
    event WithdrawRequest(
        address indexed sender,
        address indexed receiver,
        address indexed owner,
        uint256 period,
        uint256 assets,
        uint256 shares
    );

    /**
     * @notice Emitted when a user successfully claims a withdrawal for a given period.
     * @param receiver The address that received the withdrawn assets.
     * @param assets The amount of assets withdrawn.
     * @param period The period for which the withdrawal was claimed.
     */
    event CompleteWithdraw(address indexed receiver, uint256 assets, uint256 period);

    /**
     * @notice Emitted when a user with RESCUER_ROLE successfully rescues shares from a blocklisted address.
     * @param from The blocklisted address.
     * @param to The beneficiary of the rescued shares.
     * @param rescuedShares The amount of shares rescued.
     */
    event SharesRescuedFromBlocklisted(address from, address to, uint256 rescuedShares);

    /**
     * @notice Emitted when a user with RESCUER_ROLE successfully rescues a pending withdrawal from blocklisted address.
     * @param from The blocklisted address.
     * @param to The beneficiary of the rescued withdrawals.
     * @param periods The array of periods rescued.
     * @param rescuedShares The array of pending shares from withdrawals rescued for each period.
     */
    event WithdrawRescuedFromBlocklisted(address from, address to, uint256[] periods, uint256[] rescuedShares);

    //TODO:add natspec
    event PayoutExecuted(address indexed to, uint256 requestedAmount, uint256 paidAmount, uint48 captureTimestamp);
    event ActiveIncidentUpdated(uint256 indexed period, bool active);

    /**
     * @notice Emitted when an address is added to the blocklist.
     * @param account The blocklisted address.
     */
    event AddedToBlocklist(address indexed account);

    /**
     * @notice Emitted when an address is removed from the blocklist.
     * @param account The address removed from the blocklist.
     */
    event RemovedFromBlocklist(address indexed account);

    /**
     * @notice Emitted when an address is added to the payout allowlist.
     * @param account The allowlisted address.
     */
    event AddedToPayoutAllowlist(address indexed account);

    /**
     * @notice Emitted when an address is removed from the payout allowlist.
     * @param account The address removed from the payout allowlist.
     */
    event RemovedFromPayoutAllowlist(address indexed account);

    /**
     * @notice Emitted when a total-assets checkpoint is recorded outside deposit/withdraw flows.
     * @param totalAssets The total assets recorded, excluding assets pending withdrawal.
     */
    event TotalAssetsCheckpointed(uint256 totalAssets);

    error BlocklistedAddress();
    error NotBlocklistedAddress();
    error DepositLimitExceeded();
    error InvalidDepositLimit();
    error InvalidPeriodConfigurationEpoch();
    error InvalidPeriodConfigurationDuration();
    error InsufficientShares();
    error InvalidAssetAddress();
    error InvalidAdminAddress();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidPeriod();
    error CurrentPeriodConfigurationNotLast();
    error InvalidArrayLength();
    error AlreadyClaimedPeriod(uint256 period);
    error NoWithdrawalAmount(uint256 period);
    error AccountNotAllowlisted();
    error InvalidCapturePeriod();
    error CurrentPeriodHasActiveIncident();

    modifier notBlocklisted(address account) {
        _requireNotBlocklisted(account);
        _;
    }

    function _requireNotBlocklisted(address account) private view {
        if (isBlocklisted[account]) {
            revert BlocklistedAddress();
        }
    }

    modifier onlyBlocklisted(address account) {
        if (!isBlocklisted[account]) {
            revert NotBlocklistedAddress();
        }
        _;
    }

    /**
     * @notice Prevents unauthorized direct deployment via the constructor.
     */
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the FirelightVault contract with given parameters
     * @param _asset The underlying collateral ERC20 token.
     * @param _name The name of the vault token.
     * @param _symbol The symbol of the vault token.
     * @param _initParams Initial parameters.
     */
    function initialize(
        IERC20 _asset,
        string memory _name,
        string memory _symbol,
        bytes memory _initParams
    ) public initializer {
        InitParams memory initParams = abi.decode(_initParams, (InitParams));
        __ERC20_init(_name, _symbol);
        __ERC4626_init(_asset);
        __Pausable_init();
        __ReentrancyGuard_init();
        __AccessControl_init();

        if (address(_asset) == address(0)) {
            revert InvalidAssetAddress();
        }

        _updateDepositLimit(initParams.depositLimit);

        if (initParams.periodConfigurationDuration == 0) {
            revert InvalidPeriodConfigurationDuration();
        }

        if (initParams.defaultAdmin == address(0)) {
            revert InvalidAdminAddress();
        }

        _addPeriodConfiguration(Time.timestamp(), initParams.periodConfigurationDuration);
        contractVersion = 2;

        _grantRole(DEFAULT_ADMIN_ROLE, initParams.defaultAdmin);

        if (initParams.limitUpdater != address(0)) {
            _grantRole(DEPOSIT_LIMIT_UPDATE_ROLE, initParams.limitUpdater);
        }

        if (initParams.blocklister != address(0)) {
            _grantRole(BLOCKLIST_ROLE, initParams.blocklister);
        }

        if (initParams.pauser != address(0)) {
            _grantRole(PAUSE_ROLE, initParams.pauser);
        }

        if (initParams.periodConfigurationUpdater != address(0)) {
            _grantRole(PERIOD_CONFIGURATION_UPDATE_ROLE, initParams.periodConfigurationUpdater);
        }

        if (initParams.rescuer != address(0)) {
            _grantRole(RESCUER_ROLE, initParams.rescuer);
        }
    }

    /**
     * @notice Intended to be called atomically during upgrade via `upgradeToAndCall`.
     */
    function initializeV2() external reinitializer(2) {
        contractVersion = 2;
    }

    /**
     * @notice Returns the period configuration corresponding to a given timestamp.
     * @dev Return value may be unreliable if timestamp given is far away in the future
     * @dev given that new period configurations can be added after nextPeriodEnd().
     * @param timestamp The timestamp to find the period configuration for.
     * @return The period configuration corresponding to the given timestamp.
     */
    function periodConfigurationAtTimestamp(uint48 timestamp) public view returns (PeriodConfiguration memory) {
        uint256 length = periodConfigurations.length;
        if (length == 0) revert InvalidPeriod();

        PeriodConfiguration memory periodConfiguration;
        for (uint256 i = 0; i < length; i++) {
            if (timestamp < periodConfigurations[i].epoch)
                break;
            periodConfiguration = periodConfigurations[i];
        }
        if (periodConfiguration.epoch == 0) revert InvalidPeriod();
        return periodConfiguration;
    }

    /**
     * @notice Returns the period configuration corresponding to a given period number.
     * @dev Return value may be unreliable if period number given is far away in the future
     * @dev given that new period configurations can be added after nextPeriodEnd().
     * @param periodNumber The period number to find the period configuration for.
     * @return The period configuration corresponding to the given period number.
     */
    function periodConfigurationAtNumber(uint256 periodNumber) public view returns (PeriodConfiguration memory) {
        uint256 length = periodConfigurations.length;
        if (length == 0) revert InvalidPeriod();

        PeriodConfiguration memory periodConfiguration;
        for (uint256 i = 0; i < length; i++) {
            if (periodNumber < periodConfigurations[i].startingPeriod)
                break;
            periodConfiguration = periodConfigurations[i];
        }
        if (periodConfiguration.epoch == 0) revert InvalidPeriod();
        return periodConfiguration;
    }

    /**
     * @notice Returns the period number for the timestamp given.
     * @dev Return value may be unreliable if period number given is far away in the future
     * @dev given that new period configurations can be added after nextPeriodEnd().
     * @return The period number corresponding to the given timestamp.
     */
    function periodAtTimestamp(uint48 timestamp) public view returns (uint256) {
        PeriodConfiguration memory periodConfiguration = periodConfigurationAtTimestamp(timestamp);
        // solhint-disable-next-line max-line-length
        return periodConfiguration.startingPeriod + _timestampSinceEpoch(timestamp, periodConfiguration.epoch) / periodConfiguration.duration;
    }

    /**
     * @notice Returns the period configuration for the current period.
     * @return The period configuration corresponding to the current period.
     */
    function currentPeriodConfiguration() public view returns (PeriodConfiguration memory) {
        return periodConfigurationAtTimestamp(Time.timestamp());
    }

    /**
     * @notice Returns the current active period.
     * @return The current period number since contract deployment.
     */
    function currentPeriod() public view returns (uint256) {
        return periodAtTimestamp(Time.timestamp());
    }

    /**
     * @notice Returns the start timestamp of the current period.
     * @return Timestamp of the current period start.
     */
    function currentPeriodStart() external view returns (uint48) {
        PeriodConfiguration memory currentPC = currentPeriodConfiguration();
        return currentPC.epoch + (_nowSinceEpoch(currentPC.epoch) / currentPC.duration) * currentPC.duration;
    }

    /**
     * @notice Returns the end timestamp of the current period.
     * @return Timestamp of the current period end.
     */
    function currentPeriodEnd() public view returns (uint48) {
        PeriodConfiguration memory currentPC = currentPeriodConfiguration();
        return currentPC.epoch + (_nowSinceEpoch(currentPC.epoch) / currentPC.duration + 1) * currentPC.duration;
    }

    /**
     * @notice Returns the end timestamp of the period following the current period.
     * @return Timestamp of the next period end.
     */
    function nextPeriodEnd() public view returns (uint48) {
        uint48 currentEnd = currentPeriodEnd();
        return currentEnd + periodConfigurationAtTimestamp(currentEnd).duration;
    }

    /**
     * @notice Returns the maximum amount of the underlying asset that can be deposited into the Vault for the receiver,
     * through a deposit call.
     * @param receiver The address of the deposit receiver.
     * @return amount Maximum amount of assets that can be deposited.
     */
    function maxDeposit(address receiver) public view override returns (uint256 amount) {
        uint256 assets = totalAssets();
        if (isBlocklisted[receiver] || paused() || _hasActiveIncident() || assets > depositLimit) {
            return 0;
        } else {
            return depositLimit - assets;
        }
    }

    /**
     * @notice Returns the maximum amount of the Vault shares that can be minted for the receiver, through a mint call.
     * @param receiver The address of the mint receiver.
     * @return amount Maximum amount of shares that can be minted.
     */
    function maxMint(address receiver) public view override returns (uint256 amount) {
        uint256 shares = totalSupply();
        uint256 sharesLimit = convertToShares(depositLimit);
        if (isBlocklisted[receiver] || paused() || _hasActiveIncident() || shares > sharesLimit) {
            return 0;
        } else {
            return sharesLimit - shares;
        }
    }

    /**
     * @notice Returns the maximum amount of the underlying asset that can be withdrawn from the owner balance in the
     * Vault, through a withdraw call.
     * @param owner The owner of the assets.
     * @return amount Maximum amount of assets that can be withdrawn.
     */
    function maxWithdraw(address owner) public view override returns (uint256 amount) {
        if (isBlocklisted[owner] || paused()) {
            return 0;
        } else {
            return _convertToAssets(balanceOf(owner), Math.Rounding.Floor);
        }
    }

    /**
     * @notice Returns the maximum amount of Vault shares that can be redeemed from the owner balance in the Vault,
     * through a redeem call.
     * @param owner The owner of the shares.
     * @param amount Maximum amount of shares that can be redeemed.
     */
    function maxRedeem(address owner) public view override returns (uint256 amount) {
        if (isBlocklisted[owner] || paused()) {
            return 0;
        } else {
            return balanceOf(owner);
        }
    }

    /**
     * @notice Returns the total assets in the vault excluding those marked for withdrawal.
     * @return The total assets held by the vault.
     */
    function totalAssets() public view override returns (uint256) {
        return super.totalAssets() - pendingWithdrawAssets;
    }

    /**
     * @notice Returns the effective total shares for `account` at a specific `timestamp`.
     * @param account The address whose share balance is being queried.
     * @param timestamp The point in time for which the balance is being checked.
     * @return The shares owned by `account` at the specified time.
     */
    function balanceOfAt(address account, uint48 timestamp) external view returns (uint256) {
        return _traceBalanceOf[account].upperLookupRecent(timestamp);
    }

    /**
     * @notice Returns the total supply of shares at a specific `timestamp`.
     * @param timestamp The point in time for which the total supply is being checked.
     * @return The total shares in existence at the specified time.
     */
    function totalSupplyAt(uint48 timestamp) external view returns (uint256) {
        return _traceTotalSupply.upperLookupRecent(timestamp);
    }

    /**
     * @notice Returns the total underlying assets held by the vault at a specific `timestamp`, excluding any assets
     * marked for withdrawal.
     * @param timestamp The point in time for which the total assets are being checked.
     * @return The total underlying assets held by the vault at the specified time.
     */
    function totalAssetsAt(uint48 timestamp) public view returns (uint256) {
        return _traceTotalAssets.upperLookupRecent(timestamp);
    }

    /**
     * @notice Returns the amount that was made withdrawable for the given period and account, whether claimed or not.
     * @param period Period number to check.
     * @param account Account address.
     * @return Amount of assets claimable for that period.
     */
    function withdrawalsOf(uint256 period, address account) external view returns (uint256) {
        return
            _convertToAssetsTotals(
                withdrawSharesOf[period][account],
                withdrawShares[period],
                withdrawAssets[period],
                Math.Rounding.Floor
            );
    }

    /**
     * @notice Returns whether a period is inside the payout window.
     * @param period Vault period to check.
     * @return True if the period can still be used for payout.
     */
    function isPeriodInPayoutWindow(uint256 period) external view returns (bool) {
        return _isPeriodInPayoutWindow(period, currentPeriod());
    }

    /**
     * @notice Returns the length of the periodConfigurations array.
     * @return Length of the periodConfigurations array.
     */
    function periodConfigurationsLength() public view returns (uint256) {
        return periodConfigurations.length;
    }

    /**
     * @notice Pauses the contract. Requires PAUSE_ROLE.
     */
    function pause() external onlyRole(PAUSE_ROLE) {
        _pause();
    }

    /**
     * @notice Unpauses the contract. Requires PAUSE_ROLE.
     */
    function unpause() external onlyRole(PAUSE_ROLE) {
        _unpause();
    }

    /**
     * @notice Sets whether deposits are blocked for a period due to an active incident.
     */
    function setActiveIncident(uint256 period, bool active) external onlyRole(INCIDENT_ROLE) {
        hasActiveIncident[period] = active;
        emit ActiveIncidentUpdated(period, active);
    }

    /**
     * @notice Records a checkpoint of the current total assets. Requires CHECKPOINT_ROLE.
     * @dev Assets forwarded directly to the vault (e.g. reward distribution) do not trigger
     * the deposit/withdraw checkpoints, so historical `totalAssetsAt` lookups would miss them
     * until the next flow. The reward distributor calls this atomically after forwarding so
     * period-start snapshots include the forwarded assets. Restricted to a role because
     * checkpoint growth on a low-fee chain would otherwise be spammable.
     */
    function checkpointTotalAssets() external onlyRole(CHECKPOINT_ROLE) {
        uint256 assets = totalAssets();
        _traceTotalAssets.push(Time.timestamp(), assets);
        emit TotalAssetsCheckpointed(assets);
    }

    /**
     * @notice Updates the maximum deposit limit for the vault. Requires DEPOSIT_LIMIT_UPDATE_ROLE.
     * @param newLimit The new deposit limit.
     */
    function updateDepositLimit(uint256 newLimit) external onlyRole(DEPOSIT_LIMIT_UPDATE_ROLE) {
        _updateDepositLimit(newLimit);
    }

    /**
     * @notice Adds a period configuration. Requires PERIOD_CONFIGURATION_UPDATE_ROLE.
     * @param epoch The epoch timestamp.
     * @param duration The period duration.
     */
    function addPeriodConfiguration(uint48 epoch, uint48 duration) external onlyRole(PERIOD_CONFIGURATION_UPDATE_ROLE) {
        _addPeriodConfiguration(epoch, duration);
    }

    /**
     * @notice Adds an address to the blocklist. Requires BLOCKLIST_ROLE.
     * @param account Address to blocklist. Cannot be zero address nor blocklisted.
     */
    function addToBlocklist(address account) external onlyRole(BLOCKLIST_ROLE) notBlocklisted(account) {
        if (account == address(0)) revert InvalidAddress();
        isBlocklisted[account] = true;
        emit AddedToBlocklist(account);
    }

    /**
     * @notice Removes an address from the blocklist. Requires BLOCKLIST_ROLE.
     * @param account Address to remove from blocklist. Must be blocklisted.
     */
    function removeFromBlocklist(address account) external onlyRole(BLOCKLIST_ROLE) onlyBlocklisted(account) {
        isBlocklisted[account] = false;
        emit RemovedFromBlocklist(account);
    }

    /**
     * @notice Adds an address to the payout allowlist. Requires PAYOUT_ALLOWLIST_ROLE.
     * @param account Address to add. Cannot be zero address.
     */
    function addToPayoutAllowlist(address account) external onlyRole(PAYOUT_ALLOWLIST_ROLE) {
        if (account == address(0)) revert InvalidAddress();
        isPayoutAllowlisted[account] = true;
        emit AddedToPayoutAllowlist(account);
    }

    /**
     * @notice Removes an address from the payout allowlist. Requires PAYOUT_ALLOWLIST_ROLE.
     * @param account Address to remove.
     */
    function removeFromPayoutAllowlist(address account) external onlyRole(PAYOUT_ALLOWLIST_ROLE) {
        isPayoutAllowlisted[account] = false;
        emit RemovedFromPayoutAllowlist(account);
    }

    /**
     * @notice Transfers shares to an address, with blocklist and pause checks.
     * @param to Recipient address.
     * @param shares Number of shares to transfer.
     * @return Boolean indicating transfer success.
     */
    function transfer(
        address to,
        uint256 shares
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused
        notBlocklisted(_msgSender())
        notBlocklisted(to)
        returns (bool)
    {
        super.transfer(to, shares);

        uint48 ts = Time.timestamp();
        address sender = _msgSender();
        _traceBalanceOf[sender].push(ts, balanceOf(sender));
        _traceBalanceOf[to].push(ts, balanceOf(to));

        return true;
    }

    /**
     * @notice Transfers shares from one account to another using allowance, with blocklist and pause checks.
     * @param from Address sending the shares.
     * @param to Address receiving the shares.
     * @param shares Number of shares to transfer.
     * @return Boolean indicating transfer success.
     */
    function transferFrom(
        address from,
        address to,
        uint256 shares
    )
        public
        override(ERC20Upgradeable, IERC20)
        whenNotPaused
        notBlocklisted(_msgSender())
        notBlocklisted(from)
        notBlocklisted(to)
        returns (bool)
    {
        super.transferFrom(from, to, shares);

        uint48 ts = Time.timestamp();
        _traceBalanceOf[from].push(ts, balanceOf(from));
        _traceBalanceOf[to].push(ts, balanceOf(to));

        return true;
    }

    /**
     * @notice Deposits assets into the vault and receive shares, with blocklist and pause checks.
     * @param assets Amount of assets to deposit.
     * @param receiver Address receiving the shares.
     * @return Amount of shares received.
     */
    function deposit(
        uint256 assets,
        address receiver
    )
        public
        override
        whenNotPaused
        notBlocklisted(_msgSender())
        notBlocklisted(receiver)
        nonReentrant
        returns (uint256)
    {
        if (assets == 0) revert InvalidAmount();

        if (_hasActiveIncident()) revert CurrentPeriodHasActiveIncident();

        (uint256 shares, uint256 _totalSupply, uint256 _totalAssets) = _previewTotals(
            assets,
            true,
            Math.Rounding.Floor
        );
        // A dust deposit can floor to zero shares once the share price exceeds 1;
        // reject it instead of pulling assets in exchange for nothing.
        if (shares == 0) revert InvalidAmount();

        _depositFunds(_msgSender(), receiver, assets, shares, _totalSupply, _totalAssets);

        return shares;
    }

    /**
     * @notice Mints shares by depositing the required amount of assets into the vault, with blocklist and pause checks.
     * @param shares Amount of shares to mint.
     * @param receiver Address receiving the shares.
     * @return Amount of assets deposited.
     */
    function mint(
        uint256 shares,
        address receiver
    )
        public
        override
        whenNotPaused
        notBlocklisted(_msgSender())
        notBlocklisted(receiver)
        nonReentrant
        returns (uint256)
    {
        if (shares == 0) revert InvalidAmount();

        if (_hasActiveIncident()) revert CurrentPeriodHasActiveIncident();

        (uint256 assets, uint256 _totalSupply, uint256 _totalAssets) = _previewTotals(
            shares,
            false,
            Math.Rounding.Ceil
        );

        _depositFunds(_msgSender(), receiver, assets, shares, _totalSupply, _totalAssets);

        return assets;
    }

    /**
     * @notice Redeems shares from the vault and receives underlying assets, with blocklist and pause checks.
     * Creates a withdrawal request, which will be available in the next period. Shares are burned.
     * @param shares Amount of shares to redeem.
     * @param receiver Address to receive the assets in the next period.
     * @param owner Address whose shares are being redeemed.
     * @return Amount of assets that will be received in the next period.
     */
    function redeem(
        uint256 shares,
        address receiver,
        address owner
    )
        public
        override
        whenNotPaused
        notBlocklisted(_msgSender())
        notBlocklisted(owner)
        notBlocklisted(receiver)
        nonReentrant
        returns (uint256)
    {
        if (shares == 0) revert InvalidAmount();

        (uint256 assets, uint256 _totalSupply, uint256 _totalAssets) = _previewTotals(
            shares,
            false,
            Math.Rounding.Floor
        );

        uint256 ownerBalance = _requestWithdraw(assets, shares, receiver, owner);

        _logTrace(owner, ownerBalance, _totalSupply - shares, _totalAssets - assets, true);

        return assets;
    }

    /**
     * @notice Initiates a withdrawal request from the vault, with blocklist and pause checks.
     * The request becomes claimable starting from the period after the next full period.
     * The calculated shares are burned.
     * @param assets The amount of assets to withdraw.
     * @param receiver The address to receive the assets in the next period.
     * @param owner The address whose shares are being withdrawn.
     * @return The amount of shares that were burned.
     */
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    )
        public
        override
        whenNotPaused
        notBlocklisted(_msgSender())
        notBlocklisted(owner)
        notBlocklisted(receiver)
        nonReentrant
        returns (uint256)
    {
        if (assets == 0) revert InvalidAmount();

        (uint256 shares, uint256 _totalSupply, uint256 _totalAssets) = _previewTotals(assets, true, Math.Rounding.Ceil);

        uint256 ownerBalance = _requestWithdraw(assets, shares, receiver, owner);

        _logTrace(owner, ownerBalance, _totalSupply - shares, _totalAssets - assets, true);

        return shares;
    }

    /**
     * @notice Claims a pending withdrawal for a given period.
     * Transfers the corresponding assets to the caller if not already claimed.
     * Can only be called after the specified period has ended.
     * Reverts if the withdrawal has already been claimed or if no withdrawal amount is available for the period.
     * @param period The period number for which to claim the withdrawal.
     * @return assets The amount of assets transferred to the caller.
     */
    function claimWithdraw(
        uint256 period
    ) external whenNotPaused notBlocklisted(_msgSender()) nonReentrant returns (uint256 assets) {
        if (period >= currentPeriod()) revert InvalidPeriod();

        address sender = _msgSender();
        if (isWithdrawClaimed[period][sender]) revert AlreadyClaimedPeriod(period);

        assets = _convertToAssetsTotals(
            withdrawSharesOf[period][sender],
            withdrawShares[period],
            withdrawAssets[period],
            Math.Rounding.Floor
        );

        if (assets == 0) revert NoWithdrawalAmount(period);

        pendingWithdrawAssets -= assets;
        isWithdrawClaimed[period][sender] = true;

        IERC20(asset()).safeTransfer(sender, assets);

        emit CompleteWithdraw(sender, assets, period);
    }

    /**
     * @notice Rescues shares from a blocklisted address. Requires RESCUER_ROLE.
     * @param from The blocklisted address.
     * @param to The address to transfer the shares. Must not be blocklisted.
     */
    function rescueSharesFromBlocklisted(
        address from,
        address to
    )
        external
        onlyRole(RESCUER_ROLE)
        onlyBlocklisted(from)
        notBlocklisted(to)
    {
        uint256 rescuedShares = balanceOf(from);
        if( rescuedShares == 0) revert InsufficientShares();

        _transfer(from, to, rescuedShares);

        uint48 ts = Time.timestamp();
        _traceBalanceOf[from].push(ts, 0);
        _traceBalanceOf[to].push(ts, balanceOf(to));

        emit SharesRescuedFromBlocklisted(from, to, rescuedShares);
    }

    /**
    * @notice Rescues pending withdrawals from a blocklisted address. Requires RESCUER_ROLE.
    * @param from The blocklisted address.
    * @param to The address to transfer the shares to. Must not be blocklisted.
    * @param periods An array of periods to rescue.
    */
    function rescueWithdrawFromBlocklisted(
        address from,
        address to,
        uint256[] calldata periods
    )
        external
        onlyRole(RESCUER_ROLE)
        onlyBlocklisted(from)
        notBlocklisted(to)
    {
        if (to == address(0)) revert InvalidAddress();

        uint256 len = periods.length;
        if(len == 0 ) revert InvalidArrayLength();

        uint256[] memory rescuedShares = new uint256[](len);
        for (uint256 i = 0; i < len; i++) {
            uint256 _withdrawOf = withdrawSharesOf[periods[i]][from];

            if (isWithdrawClaimed[periods[i]][from]) revert AlreadyClaimedPeriod(periods[i]);
            if (isWithdrawClaimed[periods[i]][to]) revert AlreadyClaimedPeriod(periods[i]);
            if (_withdrawOf == 0) revert NoWithdrawalAmount(periods[i]);

            withdrawSharesOf[periods[i]][to] += _withdrawOf;
            withdrawSharesOf[periods[i]][from] = 0;

            rescuedShares[i] = _withdrawOf;
        }

        emit WithdrawRescuedFromBlocklisted(from, to, periods, rescuedShares);
    }

    /**
     * @notice Pays an incident claim to an allowlisted receiver from the assets exposed to the incident's
     * capture period. Callable only by PAYOUT_ROLE.
     * @dev Allowed only during the capture period or the one after it. The amount is capped by the active assets
     * at the capture-period start (an exposure cap, not a segregated bucket) and by currently payable assets, and
     * is drawn proportionally from active assets and still-exposed withdrawals. `paidAmount` may be zero.
     *
     * The vault applies only these per-call limits; ensuring aggregate payouts stay within underwritten exposure
     * is the responsibility of the curator and assessor roles.
     * @param to Allowlisted payout receiver.
     * @param amount Requested payout amount, in vault asset units.
     * @param captureTimestamp Incident capture timestamp; sets the covered period and payout window.
     * @return paidAmount Amount actually transferred; may be less than `amount`, including zero.
     */
    function payout(
        address to,
        uint256 amount,
        uint48 captureTimestamp
    ) external onlyRole(PAYOUT_ROLE) nonReentrant returns (uint256 paidAmount) {
        if (!isPayoutAllowlisted[to]) revert AccountNotAllowlisted();
        if (amount == 0) revert InvalidAmount();

        (uint256 capturePeriod, uint48 capturePeriodStart) = _periodAndStartAt(captureTimestamp);
        uint256 _currentPeriod = currentPeriod();

        // Payout can execute during the incident period or the following period.
        // After that, withdrawals for the incident period can become claimable.
        if (!_isPeriodInPayoutWindow(capturePeriod, _currentPeriod)) {
            revert InvalidCapturePeriod();
        }

        // Cap by the active assets committed at the start of the covered period.
        // This is an exposure cap, not a segregated asset bucket.
        // Use capturePeriodStart - 1 so the inclusive lookup selects timestamps < capturePeriodStart.
        // This excludes deposits and withdrawals at the period start from the payout snapshot.
        // capturePeriodStart is always > 0 (deploy epoch), so the subtraction cannot underflow.
        uint256 assetsAtCapturePeriod = totalAssetsAt(capturePeriodStart - 1);
        uint256 currentActiveAssets = totalAssets();

        // Withdrawals requested during the capture period are assigned to capturePeriod + 1
        // and remain payable while payout is allowed.
        uint256 capturePeriodWithdrawals = withdrawAssets[capturePeriod + 1];

        // If payout happens in the following period, withdrawals requested before payout
        // during that following period are assigned to capturePeriod + 2 and should also
        // remain payable; otherwise exposed assets could escape by withdrawing first.
        uint256 nextPeriodWithdrawals;
        if (_currentPeriod == capturePeriod + 1) {
            nextPeriodWithdrawals = withdrawAssets[capturePeriod + 2];
        }

        uint256 activePayableAmount = currentActiveAssets + capturePeriodWithdrawals + nextPeriodWithdrawals;
        paidAmount = Math.min(amount, Math.min(assetsAtCapturePeriod, activePayableAmount));

        // The incident must be processed with the available amount, even if paidAmount is zero.
        if (paidAmount > 0) {
            uint256 paidFromActive;
            uint256 paidFromNextWithdrawals;
            uint256 paidFromCaptureWithdrawals;

            if (_currentPeriod == capturePeriod) {
                uint256 payableAmount = currentActiveAssets + capturePeriodWithdrawals;
                paidFromActive = paidAmount.mulDiv(currentActiveAssets, payableAmount);
                paidFromCaptureWithdrawals = paidAmount - paidFromActive;
            } else {
                uint256 payableAmount = currentActiveAssets + capturePeriodWithdrawals + nextPeriodWithdrawals;
                paidFromActive = paidAmount.mulDiv(currentActiveAssets, payableAmount);
                paidFromNextWithdrawals = paidAmount.mulDiv(nextPeriodWithdrawals, payableAmount);
                paidFromCaptureWithdrawals = paidAmount - paidFromActive - paidFromNextWithdrawals;

                if (capturePeriodWithdrawals < paidFromCaptureWithdrawals) {
                    uint256 overflow = paidFromCaptureWithdrawals - capturePeriodWithdrawals;
                    paidFromCaptureWithdrawals = capturePeriodWithdrawals;
                    paidFromNextWithdrawals += overflow;
                }
            }

            _traceTotalAssets.push(Time.timestamp(), currentActiveAssets - paidFromActive);

            withdrawAssets[capturePeriod + 1] = capturePeriodWithdrawals - paidFromCaptureWithdrawals;

            if (paidFromNextWithdrawals > 0) {
                withdrawAssets[capturePeriod + 2] = nextPeriodWithdrawals - paidFromNextWithdrawals;
            }

            pendingWithdrawAssets -= paidFromCaptureWithdrawals + paidFromNextWithdrawals;

            IERC20(asset()).safeTransfer(to, paidAmount);
        }

        emit PayoutExecuted(to, amount, paidAmount, captureTimestamp);
    }

    function _updateDepositLimit(uint256 newLimit) internal {
        if (newLimit == 0) {
            revert InvalidDepositLimit();
        }
        depositLimit = newLimit;
        emit DepositLimitUpdated(newLimit);
    }

    function _depositFunds(
        address caller,
        address receiver,
        uint256 assets,
        uint256 shares,
        uint256 _totalSupply,
        uint256 _totalAssets
    ) private {
        _totalSupply += shares;
        _totalAssets += assets;

        if (_totalAssets > depositLimit) revert DepositLimitExceeded();

        _deposit(caller, receiver, assets, shares);

        _logTrace(receiver, balanceOf(receiver), _totalSupply, _totalAssets, true);
    }

    function _requestWithdraw(
        uint256 assets,
        uint256 shares,
        address receiver,
        address owner
    ) private returns (uint256 ownerBalance) {
        if (receiver == address(0) || owner == address(0)) revert InvalidAddress();

        ownerBalance = balanceOf(owner);
        if (shares > ownerBalance) revert InsufficientShares();
        ownerBalance -= shares;

        address sender = _msgSender();

        uint256 period = currentPeriod() + 1;
        uint256 sharesWithdraw = _convertToSharesTotals(
            assets,
            withdrawShares[period],
            withdrawAssets[period],
            Math.Rounding.Floor
        );
        withdrawAssets[period] += assets;
        withdrawShares[period] += sharesWithdraw;
        withdrawSharesOf[period][receiver] += sharesWithdraw;

        pendingWithdrawAssets += assets;

        if (sender != owner) {
            _spendAllowance(owner, sender, shares);
        }

        _update(owner, address(0), shares);

        emit WithdrawRequest(sender, receiver, owner, period, assets, shares);
    }

    function _previewTotals(
        uint256 assetsOrShares,
        bool isAssets,
        Math.Rounding rounding
    ) private view returns (uint256 amount, uint256 _totalSupply, uint256 _totalAssets) {
        _totalSupply = totalSupply();
        _totalAssets = totalAssets();
        if (isAssets) {
            amount = _convertToSharesTotals(assetsOrShares, _totalSupply, _totalAssets, rounding);
        } else {
            amount = _convertToAssetsTotals(assetsOrShares, _totalSupply, _totalAssets, rounding);
        }
    }

    function _logTrace(
        address owner,
        uint256 balance,
        uint256 _totalSupply,
        uint256 _totalAssets,
        bool isLogAssets
    ) private {
        uint48 ts = Time.timestamp();
        _traceBalanceOf[owner].push(ts, balance);
        _traceTotalSupply.push(ts, _totalSupply);

        if (isLogAssets) _traceTotalAssets.push(ts, _totalAssets);
    }

    function _convertToSharesTotals(
        uint256 assets,
        uint256 totSupply,
        uint256 totAssets,
        Math.Rounding rounding
    ) private view returns (uint256) {
        return assets.mulDiv(totSupply + 10 ** _decimalsOffset(), totAssets + 1, rounding);
    }

    function _convertToAssetsTotals(
        uint256 shares,
        uint256 totSupply,
        uint256 totAssets,
        Math.Rounding rounding
    ) private view returns (uint256) {
        return shares.mulDiv(totAssets + 1, totSupply + 10 ** _decimalsOffset(), rounding);
    }

    function _nowSinceEpoch(uint48 epoch) private view returns (uint48) {
        return _timestampSinceEpoch(Time.timestamp(), epoch);
    }

    function _timestampSinceEpoch(uint48 timestamp, uint48 epoch) private pure returns (uint48) {
        return timestamp - epoch;
    }

    function _addPeriodConfiguration(uint48 newEpoch, uint48 newDuration) private {
        if (
            newDuration < SMALLEST_PERIOD_DURATION ||
            newDuration > MAX_PERIOD_DURATION ||
            newDuration % SMALLEST_PERIOD_DURATION != 0
        ) revert InvalidPeriodConfigurationDuration();

        uint256 startingPeriod;
        if (periodConfigurations.length > 0) {
            PeriodConfiguration memory currentPC = currentPeriodConfiguration();
            if (currentPC.epoch != periodConfigurations[periodConfigurations.length - 1].epoch)
                revert CurrentPeriodConfigurationNotLast();
            if (newEpoch < nextPeriodEnd() || (newEpoch - currentPC.epoch) % currentPC.duration != 0)
                revert InvalidPeriodConfigurationEpoch();

            startingPeriod = currentPC.startingPeriod + (newEpoch - currentPC.epoch) / currentPC.duration;
        } else {
            if (newEpoch < Time.timestamp()) revert InvalidPeriodConfigurationEpoch();

            startingPeriod = 0;
        }

        PeriodConfiguration memory newPeriod = PeriodConfiguration({
            epoch: newEpoch,
            duration: newDuration,
            startingPeriod: startingPeriod
        });
        periodConfigurations.push(newPeriod);
        emit PeriodConfigurationAdded(newPeriod);
    }

    /// @dev True while an incident is active in the current period or the previous one. The previous period is
    /// included because a claim captured then is still payable this period, so deposits stay blocked until that
    /// payout window closes; otherwise fresh deposits would back unresolved exposure.
    function _hasActiveIncident() internal view returns (bool) {
        uint256 period = currentPeriod();
        return hasActiveIncident[period] || (period > 0 && hasActiveIncident[period - 1]);
    }

    /// @dev Resolves a timestamp's period number and period start from a single scan of the
    ///      configuration history: the configuration governing the timestamp also governs
    ///      its period, so both derive from one lookup.
    function _periodAndStartAt(uint48 timestamp) internal view returns (uint256 period, uint48 start) {
        PeriodConfiguration memory pc = periodConfigurationAtTimestamp(timestamp);
        uint48 periodsSinceEpoch = _timestampSinceEpoch(timestamp, pc.epoch) / pc.duration;
        period = pc.startingPeriod + periodsSinceEpoch;
        start = pc.epoch + periodsSinceEpoch * pc.duration;
    }

    function _isPeriodInPayoutWindow(uint256 period, uint256 current) internal pure returns (bool) {
        return current == period || current == period + 1;
    }
}
