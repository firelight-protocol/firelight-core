// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IFirelightVault} from "./interfaces/IFirelightVault.sol";

/**
 * @title VaultRewardDistributor
 * @notice Forwards reward and incentive vault assets into the Firelight vault.
 * @dev The contract does not perform swaps or mint vault shares. It only pulls
 * vault assets from authorized distributors, transfers them directly to the
 * vault, and emits metadata events for off-chain accounting.
 * @custom:security-contact securityreport@firelight.finance
 */
contract VaultRewardDistributor is AccessControlUpgradeable {
    using SafeERC20 for IERC20;

    /// @notice Role allowed to forward reward and incentive vault assets into the vault.
    bytes32 public constant DISTRIBUTOR_ROLE = keccak256("DISTRIBUTOR_ROLE");

    /// @notice Role allowed to recover tokens accidentally sent to this contract.
    bytes32 public constant SWEEPER_ROLE = keccak256("SWEEPER_ROLE");

    // --- ERC-7201 Namespaced Storage ---
    /// @custom:storage-location erc7201:firelight.vaultrewarddistributor.storage
    struct VaultRewardDistributorStorage {
        /// @notice Firelight vault receiving forwarded vault assets.
        IFirelightVault vault;
        /// @notice ERC20 asset accepted by the vault and forwarded by this contract.
        IERC20 vaultAsset;
    }

    // keccak256(abi.encode(uint256(keccak256("firelight.vaultrewarddistributor.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x651ce661f7078ecd2e4440f466af8c7b90ea5bb0ee816595039a0e5aea2c8b00;

    function _getStorage() private pure returns (VaultRewardDistributorStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /**
     * @notice Emitted when premium-sale proceeds are forwarded to the vault as vault assets.
     * @param vaultPeriod Vault period at the time the vault assets are transferred.
     * @param premiumToken Premium token that was swapped off-chain into the vault asset.
     * @param vaultAssetAmount Amount of vault asset transferred into the vault.
     * @param premiumTokenAmount Amount of premium token swapped off-chain.
     * @param premiumSwapTimestamp Timestamp when the off-chain premium-token swap occurred.
     */
    event RewardsDistributed(
        uint256 indexed vaultPeriod,
        address indexed premiumToken,
        uint256 vaultAssetAmount,
        uint256 premiumTokenAmount,
        uint48 premiumSwapTimestamp
    );

    /**
     * @notice Emitted when incentive funds are forwarded to the vault.
     * @param vaultPeriod Vault period at the time the vault assets are transferred.
     * @param incentiveRef Optional external reference for the incentive program or payment.
     * @param vaultAssetAmount Amount of vault asset transferred into the vault.
     */
    event IncentiveDistributed(uint256 indexed vaultPeriod, bytes32 indexed incentiveRef, uint256 vaultAssetAmount);

    /**
     * @notice Emitted when tokens accidentally sent to this contract are recovered.
     * @param token Token recovered from this contract.
     * @param to Address receiving the recovered tokens.
     * @param amount Amount of tokens recovered.
     */
    event TokenSwept(address indexed token, address indexed to, uint256 amount);

    /// @notice Reverts when a required address argument is zero.
    error InvalidZeroAddress();

    /// @notice Reverts when an amount argument is zero.
    error InvalidAmount();

    /// @notice Reverts when premium swap metadata has a zero or future timestamp.
    error InvalidSwapTimestamp();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the vault reward distributor proxy.
     * @dev Reads and stores the vault asset from `_vault.asset()`.
     * @param _vault Firelight vault receiving forwarded vault assets.
     * @param admin Address receiving the default admin role.
     * @param distributor Address allowed to forward reward and incentive funds.
     * @param sweeper Optional address allowed to recover tokens accidentally sent to this contract.
     */
    function initialize(
        IFirelightVault _vault,
        address admin,
        address distributor,
        address sweeper
    ) public initializer {
        if (admin == address(0) || distributor == address(0) || address(_vault) == address(0)) {
            revert InvalidZeroAddress();
        }

        __AccessControl_init();

        VaultRewardDistributorStorage storage $ = _getStorage();

        $.vault = IFirelightVault(_vault);
        $.vaultAsset = IERC20(_vault.asset());

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(DISTRIBUTOR_ROLE, distributor);
        if (sweeper != address(0)) _grantRole(SWEEPER_ROLE, sweeper);
    }

    /**
     * @notice Forwards premium-sale proceeds into the vault as vault assets.
     * @dev The caller must approve this contract to transfer `vaultAssetAmount`
     * of the vault asset. `premiumToken`, `premiumTokenAmount`, and
     * `premiumSwapTimestamp` are accounting metadata only; no premium tokens are
     * transferred by this function.
     * @param vaultAssetAmount Amount of vault asset to transfer into the vault.
     * @param premiumToken Premium token swapped off-chain into the vault asset.
     * @param premiumTokenAmount Amount of premium token swapped off-chain.
     * @param premiumSwapTimestamp Timestamp when the off-chain premium-token swap occurred.
     */
    function distributeRewards(
        uint256 vaultAssetAmount,
        address premiumToken,
        uint256 premiumTokenAmount,
        uint48 premiumSwapTimestamp
    ) external onlyRole(DISTRIBUTOR_ROLE) {
        if (premiumToken == address(0)) revert InvalidZeroAddress();
        if (vaultAssetAmount == 0 || premiumTokenAmount == 0) revert InvalidAmount();
        if (premiumSwapTimestamp == 0 || premiumSwapTimestamp > block.timestamp) revert InvalidSwapTimestamp();

        VaultRewardDistributorStorage storage $ = _getStorage();

        IFirelightVault _vault = $.vault;
        uint256 vaultPeriod = _vault.currentPeriod();
        $.vaultAsset.safeTransferFrom(msg.sender, address(_vault), vaultAssetAmount);

        // Checkpoint atomically so historical totalAssetsAt lookups (period-start
        // snapshots) include the forwarded assets. Requires CHECKPOINT_ROLE on the vault.
        _vault.checkpointTotalAssets();

        emit RewardsDistributed(vaultPeriod, premiumToken, vaultAssetAmount, premiumTokenAmount, premiumSwapTimestamp);
    }

    /**
     * @notice Forwards incentive funds into the vault as vault assets.
     * @dev The caller must approve this contract to transfer `vaultAssetAmount`
     * of the vault asset. `incentiveRef` is emitted as opaque metadata and is
     * not interpreted on-chain.
     * @param vaultAssetAmount Amount of vault asset to transfer into the vault.
     * @param incentiveRef Optional external reference for the incentive program or payment.
     */
    function distributeIncentive(uint256 vaultAssetAmount, bytes32 incentiveRef) external onlyRole(DISTRIBUTOR_ROLE) {
        if (vaultAssetAmount == 0) revert InvalidAmount();

        VaultRewardDistributorStorage storage $ = _getStorage();

        IFirelightVault _vault = $.vault;
        uint256 vaultPeriod = _vault.currentPeriod();
        $.vaultAsset.safeTransferFrom(msg.sender, address(_vault), vaultAssetAmount);

        // Checkpoint atomically so historical totalAssetsAt lookups (period-start
        // snapshots) include the forwarded assets. Requires CHECKPOINT_ROLE on the vault.
        _vault.checkpointTotalAssets();

        emit IncentiveDistributed(vaultPeriod, incentiveRef, vaultAssetAmount);
    }

    /**
     * @notice Recovers tokens accidentally sent to this contract.
     * @dev Restricted to `SWEEPER_ROLE`. This contract should not retain token
     * balances during normal reward distribution flows.
     * @param token Token to recover.
     * @param to Address receiving the recovered tokens.
     * @param amount Amount of tokens to recover.
     */
    function sweep(IERC20 token, address to, uint256 amount) external onlyRole(SWEEPER_ROLE) {
        if (address(token) == address(0) || to == address(0)) revert InvalidZeroAddress();
        if (amount == 0) revert InvalidAmount();
        token.safeTransfer(to, amount);

        emit TokenSwept(address(token), to, amount);
    }

    /**
     * @notice Returns the Firelight vault receiving forwarded vault assets.
     * @return Firelight vault receiving forwarded vault assets.
     */
    function vault() external view returns (IFirelightVault) {
        return _getStorage().vault;
    }

    /**
     * @notice Returns the vault asset token distributed to the vault.
     * @return The vault asset token.
     */
    function vaultAsset() external view returns (IERC20) {
        return _getStorage().vaultAsset;
    }
}
