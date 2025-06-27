/* SPDX-License-Identifier: UNLICENSED */
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
 * @notice Upgradeable ERC4626-compatible vault
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
     * @param blacklister Address assigned the BLACKLIST_ROLE at initialization.
     * @param pauser Address assigned the PAUSE_ROLE at initialization.
     * @param periodInitUpdater Address assigned the PERIOD_INIT_UPDATE_ROLE at initialization.
     * @param depositLimit Initial total deposit limit.
     * @param periodInitDuration Initial period duration of the vault.
     */
    struct InitParams {
        address defaultAdmin;
        address limitUpdater;
        address blacklister;
        address pauser;
        address periodInitUpdater;
        uint256 depositLimit;
        uint48 periodInitDuration;
    }

    /**
     * @notice Emitted when the vault's deposit limit is updated.
     * @param limit The new maximum amount of assets allowed in the vault.
     */
    event DepositLimitUpdated(uint256 limit);

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

    error BlacklistedAddress();
    error DepositLimitExceeded();
    error InvalidDepositLimit();
    error InvalidPeriodInitEpoch();
    error InvalidPeriodInitDuration();
    error InsufficientShares();
    error InvalidAssetAddress();
    error InvalidAdminAddress();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidPeriod();
    error CurrentPeriodInitNotLast();
    error AlreadyClaimedPeriod();
    error NoWithdrawalAmount();

    modifier notBlacklisted(address account) {
        if (isBlacklisted[account]) {
            revert BlacklistedAddress();
        }
        _;
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

        if (initParams.depositLimit == 0) {
            revert InvalidDepositLimit();
        }

        if (initParams.periodInitDuration == 0) {
            revert InvalidPeriodInitDuration();
        }

        if (initParams.defaultAdmin == address(0)) {
            revert InvalidAdminAddress();
        }

        depositLimit = initParams.depositLimit;
        _appendPeriodInit(Time.timestamp(), initParams.periodInitDuration);
        contractVersion = 1;

        _grantRole(DEFAULT_ADMIN_ROLE, initParams.defaultAdmin);

        if (initParams.limitUpdater != address(0)) {
            _grantRole(DEPOSIT_LIMIT_UPDATE_ROLE, initParams.limitUpdater);
        }

        if (initParams.blacklister != address(0)) {
            _grantRole(BLACKLIST_ROLE, initParams.blacklister);
        }

        if (initParams.pauser != address(0)) {
            _grantRole(PAUSE_ROLE, initParams.pauser);
        }

        if (initParams.periodInitUpdater != address(0)) {
            _grantRole(PERIOD_INIT_UPDATE_ROLE, initParams.periodInitUpdater);
        }
    }

    /**
     * @notice Returns the current active period.
     * @return The current period number since contract deployment.
     */
    function currentPeriod() public view returns (uint256) {
        PeriodInit memory currentPeriodInit = _currentPeriodInit();
        return currentPeriodInit.startingPeriod + _sinceEpoch(currentPeriodInit.epoch) / currentPeriodInit.duration;        
    }

    /**
     * @notice Returns the start timestamp of the current period.
     * @return Timestamp of the current start period.
     */
    function currentPeriodStart() external view returns (uint48) {
        PeriodInit memory currentPeriodInit = _currentPeriodInit();
        return currentPeriodInit.epoch + (_sinceEpoch(currentPeriodInit.epoch) / currentPeriodInit.duration) * currentPeriodInit.duration;
    }

    /**
     * @notice Returns the end timestamp of the current period.
     * @return Timestamp of the current end period.
     */
    function currentPeriodEnd() public view returns (uint48) {
        PeriodInit memory currentPeriodInit = _currentPeriodInit();
        return currentPeriodInit.epoch + (_sinceEpoch(currentPeriodInit.epoch) / currentPeriodInit.duration + 1) * currentPeriodInit.duration;
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
    function totalAssetsAt(uint48 timestamp) external view returns (uint256) {
        return _traceTotalAssets.upperLookupRecent(timestamp);
    }

    /**
     * @notice Gets the amount an account can withdraw for a given period.
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
     * @notice Updates the maximum deposit limit for the vault. Requires DEPOSIT_LIMIT_UPDATE_ROLE.
     * @param newLimit The new deposit limit.
     */
    function updateDepositLimit(uint256 newLimit) external onlyRole(DEPOSIT_LIMIT_UPDATE_ROLE) {
        if (newLimit == 0) {
            revert InvalidDepositLimit();
        }
        depositLimit = newLimit;
        emit DepositLimitUpdated(newLimit);
    }

    /**
     * @notice Appends a period init. Requires PERIOD_INIT_UPDATE_ROLE.
     * @param epoch The epoch timestamp.
     * @param duration The period duration.
     */
    function appendPeriodInit(uint48 epoch, uint48 duration) external onlyRole(PERIOD_INIT_UPDATE_ROLE) {
        _appendPeriodInit(epoch, duration);
    }

    /**
     * @notice Adds an address to the blacklist. Requires BLACKLIST_ROLE.
     * @param account Address to blacklist.
     */
    function addToBlacklist(address account) external onlyRole(BLACKLIST_ROLE) {
        isBlacklisted[account] = true;
    }

    /**
     * @notice Removes an address from the blacklist. Requires BLACKLIST_ROLE.
     * @param account Address to remove from blacklist.
     */
    function removeFromBlacklist(address account) external onlyRole(BLACKLIST_ROLE) {
        isBlacklisted[account] = false;
    }

    /**
     * @notice Mints shares to a specified receiver. Requires MINTER_ROLE.
     * @param shares Amount of shares to mint.
     * @param receiver Address receiving the shares.
     * @return Number of shares minted.
     */
    function mint(uint256 shares, address receiver) public override onlyRole(MINTER_ROLE) returns (uint256) {
        _mint(receiver, shares);
        _logTrace(receiver, balanceOf(receiver), totalSupply(), 0, false);
        return shares;
    }

    /**
     * @notice Burns shares from an owner's balance. Requires BURNER_ROLE.
     * @param shares Number of shares to burn.
     * @param owner Shares' owner.
     */
    function burn(uint256 shares, address owner) external onlyRole(BURNER_ROLE) {
        _burn(owner, shares);
        _logTrace(owner, balanceOf(owner), totalSupply(), 0, false);
    }

    /**
     * @notice Transfers shares to an address, with blacklist and pause checks.
     * @param to Recipient address.
     * @param shares Number of shares to transfer.
     * @return Boolean indicating transfer success.
     */
    function transfer(
        address to,
        uint256 shares
    ) public override(ERC20Upgradeable, IERC20) whenNotPaused notBlacklisted(_msgSender()) returns (bool) {
        super.transfer(to, shares);

        uint48 ts = Time.timestamp();
        address sender = _msgSender();
        _traceBalanceOf[sender].push(ts, balanceOf(sender));
        _traceBalanceOf[to].push(ts, balanceOf(to));

        return true;
    }

    /**
     * @notice Transfers shares from one account to another using allowance, with blacklist and pause checks.
     * @param from Address sending the shares.
     * @param to Address receiving the shares.
     * @param shares Number of shares to transfer.
     * @return Boolean indicating transfer success.
     */
    function transferFrom(
        address from,
        address to,
        uint256 shares
    ) public override(ERC20Upgradeable, IERC20) whenNotPaused notBlacklisted(from) returns (bool) {
        super.transferFrom(from, to, shares);

        uint48 ts = Time.timestamp();
        _traceBalanceOf[from].push(ts, balanceOf(from));
        _traceBalanceOf[to].push(ts, balanceOf(to));

        return true;
    }

    /**
     * @notice Deposits assets into the vault and receive shares, with blacklist and pause checks.
     * @param assets Amount of assets to deposit.
     * @param receiver Address receiving the shares.
     * @return Amount of shares received.
     */
    function deposit(
        uint256 assets,
        address receiver
    ) public override whenNotPaused notBlacklisted(_msgSender()) nonReentrant returns (uint256) {
        if (assets == 0) revert InvalidAmount();

        (uint256 shares, uint256 _totalSupply, uint256 _totalAssets) = _previewTotals(
            assets,
            true,
            Math.Rounding.Floor
        );

        _totalSupply += shares;
        _totalAssets += assets;

        if (_totalAssets > depositLimit) revert DepositLimitExceeded();

        _deposit(_msgSender(), receiver, assets, shares);

        _logTrace(receiver, balanceOf(receiver), _totalSupply, _totalAssets, true);

        return shares;
    }

    /**
     * @notice Redeems shares from the vault and receives underlying assets, with blacklist and pause checks.
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
    ) public override whenNotPaused notBlacklisted(owner) nonReentrant returns (uint256) {
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
     * @notice Withdraws assets from the vault and receive underlying assets, with blacklist and pause checks.
     * Create a withdrawal request which will be available in the next period. The calculated shares are burned.
     * @param assets The amount of assets to withdraw.
     * @param receiver The address to receive the assets in the next period.
     * @param owner The address whose shares are being withdrawn.
     * @return The amount of shares that were burned.
     */
    function withdraw(
        uint256 assets,
        address receiver,
        address owner
    ) public override whenNotPaused notBlacklisted(owner) nonReentrant returns (uint256) {
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
    ) external whenNotPaused notBlacklisted(_msgSender()) returns (uint256 assets) {
        if (period >= currentPeriod()) revert InvalidPeriod();

        address sender = _msgSender();
        if (isWithdrawClaimed[period][sender]) revert AlreadyClaimedPeriod();

        assets = _convertToAssetsTotals(
            withdrawSharesOf[period][sender],
            withdrawShares[period],
            withdrawAssets[period],
            Math.Rounding.Floor
        );

        if (assets == 0) revert NoWithdrawalAmount();

        pendingWithdrawAssets -= assets;
        isWithdrawClaimed[period][sender] = true;

        IERC20(asset()).safeTransfer(sender, assets);

        emit CompleteWithdraw(sender, assets, period);
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
            Math.Rounding.Ceil
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

    function _sinceEpoch(uint48 epoch) private view returns (uint48) {
        return Time.timestamp() - epoch;
    }

    function _periodInitAt(uint48 timestamp) private view returns (PeriodInit memory) {
        if (periodInits.length == 0) revert InvalidPeriod();

        PeriodInit memory periodInit;
        for (uint i = 0; i < periodInits.length; i++) {
            if (timestamp < periodInits[i].epoch)
                break;
            periodInit = periodInits[i];
        }
        if (periodInit.epoch == 0) revert InvalidPeriod();
        return periodInit;
    }

    function _currentPeriodInit() private view returns (PeriodInit memory) {
        return _periodInitAt(Time.timestamp());
    }

    function _nextPeriodEnd() private view returns (uint48) {
        uint48 currentEnd = currentPeriodEnd();
        return currentEnd + _periodInitAt(currentEnd).duration;
    }

    function _appendPeriodInit(uint48 newEpoch, uint48 newDuration) private {
        if (newDuration < SMALLEST_PERIOD_DURATION || newDuration % SMALLEST_PERIOD_DURATION != 0) revert InvalidPeriodInitDuration();

        uint startingPeriod;
        if (periodInits.length > 0) {
            PeriodInit memory currentPeriodInit = _currentPeriodInit();
            if (currentPeriodInit.epoch != periodInits[periodInits.length - 1].epoch) revert CurrentPeriodInitNotLast();
            if (newEpoch < _nextPeriodEnd() || (newEpoch - currentPeriodInit.epoch) % currentPeriodInit.duration != 0) revert InvalidPeriodInitEpoch();

            startingPeriod = currentPeriodInit.startingPeriod + (newEpoch - currentPeriodInit.epoch) / currentPeriodInit.duration;
        } else {
            if (newEpoch < Time.timestamp()) revert InvalidPeriodInitEpoch();

            startingPeriod = 0;
        }

        PeriodInit memory newPeriod = PeriodInit({
            epoch: newEpoch,
            duration: newDuration,
            startingPeriod: startingPeriod
        });
        periodInits.push(newPeriod);
    }
}
