// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IFirelightVault} from "./interfaces/IFirelightVault.sol";
import {ICoverOrderAllocator} from "./interfaces/ICoverOrderAllocator.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {PriceFeed} from "./lib/PriceFeed.sol";
import {Decimals} from "./lib/Decimals.sol";
import {CoverNFT} from "./CoverNFT.sol";

/**
 * @title CoverOrderAllocator
 * @notice Manages the cover order lifecycle and applies off-chain matching results on-chain.
 * Curators create cover orders for the next period; an off-chain engine matches them against
 * available capacity and submits the result as a Merkle commitment. Orders are then settled
 * individually against that commitment, charging premium, minting a CoverNFT, and recording
 * per-market allocations used later by the IncidentManager for payouts.
 *
 * All monetary values are held in a canonical USD unit; conversion to/from each
 * token's native decimals happens only at transfer boundaries. See {ICoverOrderAllocator} for
 * the full decimal convention, matching flow, and Merkle leaf encoding.
 *
 * Capacity is recomputed on-chain at commit/recommit from the first-loss buffer balance plus
 * oracle-priced staked assets, scaled by leverage/minCAR, and widened by the per-period
 * `divergenceToleranceBps` to absorb price/buffer drift between the off-chain snapshot and
 * commit inclusion. The same effective capacity bounds both total allocation and per-protocol
 * concentration caps.
 *
 * Order status flow:
 * - `PENDING` -> `MATCHED` or `PARTIAL` on settle.
 * - `PENDING` -> `CANCELLED` via curator cancel or the permissionless expired-order sweep.
 *
 * Role responsibilities:
 * - `DEFAULT_ADMIN_ROLE`: manages role assignments.
 * - `ADMIN_ROLE`: updates the premium collector, price feed adapter, and max price age.
 * - `CURATOR_ROLE`: creates and cancels cover orders.
 * - `ALLOCATOR_ROLE`: commits matching results and settles orders.
 * - `CONFIG_ADMIN_ROLE`: manages markets, premium tokens, concentration caps, capacity config,
 *   the settlement grace period, and recommits.
 * @custom:security-contact securityreport@firelight.finance
 */
contract CoverOrderAllocator is ICoverOrderAllocator, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Math for uint256;
    // 32 bits for period 224 for configId
    using Checkpoints for Checkpoints.Trace224;
    using EnumerableSet for EnumerableSet.AddressSet;
    using PriceFeed for IAggregatorV3;

    // --- Roles ---
    /// @notice Role allowed to create and cancel cover orders.
    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");
    /// @notice Role allowed to commit matching results and settle orders.
    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    /// @notice Role allowed to manage markets, premium tokens, concentration caps, capacity
    ///         config, the settlement grace period, and recommits.
    bytes32 public constant CONFIG_ADMIN_ROLE = keccak256("CONFIG_ADMIN_ROLE");
    /// @notice Role allowed to update the premium collector, price feed adapter, and max price age.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // --- Constants ---
    /// @notice Canonical decimals used for all on-chain monetary values.
    uint8 public constant CANONICAL_DECIMALS = 18;
    uint256 private constant SECONDS_PER_YEAR = 365 days;
    uint256 private constant BPS_DENOMINATOR = 10_000;
    // Hard ceiling for `CapacityConfig.divergenceToleranceBps`. Kept small: the tolerance
    // is accepted under-collateralization vs the CAR target, only meant to absorb the
    // price/FLB drift between the off-chain matcher snapshot and commit inclusion.
    uint16 private constant MAX_DIVERGENCE_TOLERANCE_BPS = 1_000; // 10%
    // Cap on `effectiveLeverage` relative to `minCAR`. Real backing behind sold cover is
    // `minCAR / (effectiveLeverage × (1 + tolerance))`, so bounding the ratio floors it at
    // `1 / (MAX_LEVERAGE_FACTOR × (1 + tolerance))` regardless of the configured `minCAR`.
    uint256 private constant MAX_LEVERAGE_FACTOR = 5;
    // Keep governance-set CAR targets within the risk policy's approved operating range.
    uint256 private constant MIN_CAR_BPS = 12_000;
    uint256 private constant MAX_CAR_BPS = 50_000;
    // Hard ceiling for `settlementGracePeriod`. Keeps the grace from consuming the settle
    // window: settlement requires the grace elapsed AND the order's period still current.
    // The vault enforces every period duration to be a multiple of SMALLEST_PERIOD_DURATION
    // (1 day), so this bound is at most a third of any period under any future schedule.
    uint48 private constant MAX_GRACE_PERIOD = 8 hours;

    // --- ERC-7201 Namespaced Storage ---
    /// @custom:storage-location erc7201:firelight.coverorderallocator.storage
    struct CoverOrderAllocatorStorage {
        IFirelightVault vault;
        address premiumCollector;
        CoverNFT coverNFT;
        uint256 nextCoverOrderId;
        mapping(uint256 coverOrderId => CoverOrder) orders;
        mapping(uint256 coverOrderId => MarketAllocation[]) orderMarkets;
        mapping(bytes32 marketId => Market) supportedMarkets;
        EnumerableSet.AddressSet supportedPremiumTokens;
        CapacityConfig[] capacityConfigHistory;
        Checkpoints.Trace224 capacityConfigCheckpoints; // period => index in capacityConfigHistory
        mapping(uint256 period => AllocationCommitment) allocationCommitments;
        mapping(uint256 period => uint256[]) ordersIdByPeriod;
        mapping(uint256 period => mapping(bytes32 protocolConcentrationHash => uint256)) protocolConcentrationSettledCover;
        bytes32[] supportedMarketIds;
        mapping(bytes32 protocolConcentrationHash => Checkpoints.Trace224) protocolConcentrationCheckpoints;
        bytes32[] supportedProtocolConcentrationHashes;
        mapping(bytes32 protocolConcentrationHash => ProtocolConcentration) protocolConcentrations;
        // Cached `decimals()` of each registered premium token and the vault asset.
        // Populated on registration; read on hot paths to avoid per-call STATICCALLs.
        // The first-loss-buffer token lives inside `CapacityConfig` (checkpointed
        // per period) and its decimals are read on-demand in `commitAllocation`.
        mapping(address token => uint8) premiumTokenDecimals;
        uint8 vaultAssetDecimals;
        // Vault-asset USD oracle. Read on `commitAllocation` to value staked assets.
        IAggregatorV3 priceFeedAdapter;
        uint48 maxPriceAge;
        uint8 priceFeedDecimals;
        uint48 settlementGracePeriod;
    }

    // keccak256(abi.encode(uint256(keccak256("firelight.coverorderallocator.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x89fd6609332cbe19e528bcd8d4a7f5648af9fc2ad8e8f65d6e02fc4dfabfd000;

    function _getStorage() private pure returns (CoverOrderAllocatorStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        // Disable initializers on the implementation following the best practices
        _disableInitializers();
    }

    /// @notice Initializes dependencies, roles, premium tokens, markets, concentration caps,
    ///         and the initial capacity configuration.
    /// @param params Initialization parameters; see {ICoverOrderAllocator.InitParams}.
    function initialize(InitParams calldata params) external initializer {
        _requireNonZero(address(params.vault));
        _requireNonZero(address(params.coverNFT));
        _requireNonZero(params.admin);
        _requireNonZero(params.adminRole);
        _requireNonZero(params.curatorRole);
        _requireNonZero(params.allocatorRole);
        _requireNonZero(params.configAdminRole);

        __AccessControl_init();
        __ReentrancyGuard_init();

        CoverOrderAllocatorStorage storage $ = _getStorage();
        $.vault = params.vault;
        $.coverNFT = params.coverNFT;

        $.vaultAssetDecimals = _readDecimals(params.vault.asset());

        _setPremiumCollector(params.premiumCollector);
        _setMaxPriceAge(params.maxPriceAge);
        _setPriceFeedAdapter(params.priceFeedAdapter);

        for (uint256 i; i < params.premiumTokens.length; ++i) {
            _addSupportedPremiumToken(params.premiumTokens[i]);
        }

        for (uint256 i; i < params.initialProtocolConcentrations.length; ++i) {
            _setProtocolConcentration(params.initialProtocolConcentrations[i]);
        }

        for (uint256 i; i < params.newMarkets.length; ++i) {
            _addSupportedMarket(params.newMarkets[i]);
        }

        _setCapacityConfig(params.capacityConfig);

        _grantRole(DEFAULT_ADMIN_ROLE, params.admin);
        _grantRole(ADMIN_ROLE, params.adminRole);
        _grantRole(CURATOR_ROLE, params.curatorRole);
        _grantRole(ALLOCATOR_ROLE, params.allocatorRole);
        _grantRole(CONFIG_ADMIN_ROLE, params.configAdminRole);
    }

    // =========================================================================
    // createCoverOrder
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function createCoverOrder(
        address buyer,
        address payoutRecipient,
        string calldata beneficiaryAddress,
        address premiumToken,
        MarketAllocationInput[] calldata markets,
        CoverOrderType orderType
    ) external onlyRole(CURATOR_ROLE) returns (uint256 coverOrderId) {
        _requireNonZero(buyer);
        _requireNonZero(payoutRecipient);
        if (bytes(beneficiaryAddress).length == 0) revert InvalidZeroAddress();
        if (markets.length == 0) revert InvalidMarketsLength();

        CoverOrderAllocatorStorage storage $ = _getStorage();

        if (!$.supportedPremiumTokens.contains(premiumToken)) revert UnsupportedPremiumToken();

        uint256 targetPeriod = _currentPeriod() + 1;
        uint256 periodDuration = uint256(_periodDuration(targetPeriod));
        if (periodDuration == 0) revert InvalidPeriodDuration();

        coverOrderId = $.nextCoverOrderId++;

        (uint256 totalCoverAmount, uint256 totalPremiumAmount, uint256 sumWeightedRate) = _processMarketAllocations(
            coverOrderId,
            markets,
            periodDuration,
            targetPeriod
        );

        uint256 weightedAvgRate = sumWeightedRate / totalCoverAmount;

        CoverOrder storage order = $.orders[coverOrderId];
        order.buyer = buyer;
        order.payoutRecipient = payoutRecipient;
        order.beneficiaryAddress = beneficiaryAddress;
        order.premiumToken = premiumToken;
        order.totalCoverAmount = totalCoverAmount;
        order.totalPremiumAmount = totalPremiumAmount;
        order.weightedAvgRate = weightedAvgRate;
        order.orderType = orderType;
        order.status = CoverOrderStatus.PENDING;
        order.period = targetPeriod;

        $.ordersIdByPeriod[targetPeriod].push(coverOrderId);

        emit CoverOrderCreated(
            coverOrderId,
            buyer,
            payoutRecipient,
            beneficiaryAddress,
            premiumToken,
            totalCoverAmount,
            totalPremiumAmount,
            weightedAvgRate,
            orderType,
            targetPeriod
        );
    }

    /// @dev Validates each market allocation, persists it under `coverOrderId`,
    ///      and returns aggregate totals. Extracted from `createCoverOrder` to
    ///      keep stack pressure low under viaIR
    function _processMarketAllocations(
        uint256 coverOrderId,
        MarketAllocationInput[] calldata markets,
        uint256 periodDuration,
        uint256 targetPeriod
    ) private returns (uint256, uint256, uint256) {
        uint256 totalCoverAmount;
        uint256 totalPremiumAmount;
        uint256 sumWeightedRate;
        CoverOrderAllocatorStorage storage $ = _getStorage();
        uint256 minMarketCover = _getEffectiveCapacityConfig(targetPeriod).minOrderMarketCoverAmount;

        for (uint256 i; i < markets.length; ++i) {
            MarketAllocationInput calldata ma = markets[i];
            _validateMarketAllocation(ma, markets, i, minMarketCover, targetPeriod);

            totalCoverAmount += ma.coverAmount;
            sumWeightedRate += uint256(ma.coverRateAnnual) * ma.coverAmount;

            totalPremiumAmount += _calculatePremium(ma.coverAmount, ma.coverRateAnnual, periodDuration);

            MarketAllocation storage stored = $.orderMarkets[coverOrderId].push();
            stored.marketId = ma.marketId;
            stored.coverRateAnnual = ma.coverRateAnnual;
            stored.coverAmount = ma.coverAmount;
            // allocatedCoverAmount stays 0 (set on settle).
        }

        return (totalCoverAmount, totalPremiumAmount, sumWeightedRate);
    }

    function _calculatePremium(
        uint256 coverAmount,
        uint32 coverRateAnnual,
        uint256 periodDuration
    ) private pure returns (uint256) {
        return
            coverAmount.mulDiv(
                uint256(coverRateAnnual) * periodDuration,
                BPS_DENOMINATOR * SECONDS_PER_YEAR,
                Math.Rounding.Ceil
            );
    }

    /// @dev Validates a single market allocation (zero-values, min cover, duplicates,
    ///      market exists & enabled at targetPeriod). Extracted to reduce stack pressure.
    function _validateMarketAllocation(
        MarketAllocationInput calldata ma,
        MarketAllocationInput[] calldata markets,
        uint256 i,
        uint256 minMarketCover,
        uint256 targetPeriod
    ) private view {
        if (ma.coverAmount == 0 || ma.coverRateAnnual == 0) revert InvalidMarketsZeroValue();
        if (ma.coverAmount < minMarketCover) revert OrderMarketCoverAmountTooLow(ma.coverAmount, minMarketCover);

        // Duplicate market check via O(n²) backwards scan
        for (uint256 j; j < i; ++j) {
            if (markets[j].marketId == ma.marketId) revert DuplicateMarket();
        }

        Market storage m = _getStorage().supportedMarkets[ma.marketId];
        if (m.chainId == 0) revert MarketNotFound();
        if (_getEffectiveProtocolConcentration(_getProtocolConcentrationHash(m.chainId, m.protocol), targetPeriod) == 0)
            revert ZeroProtocolConcentrationForMarket();
    }

    // =========================================================================
    // commitAllocation — Merkle commit
    // =========================================================================

    /**
     * @inheritdoc ICoverOrderAllocator
     * @dev The vault asset price in USD is fetched from the registered `priceFeedAdapter`
     *      oracle, validated against `maxPriceAge` inside `PriceFeed.getPrice`. Capacity is
     *      recomputed live and widened by the period's `divergenceToleranceBps` to bound
     *      the caller's `matchingCapacity`.
     */
    function commitAllocation(
        uint256 commitmentPeriod,
        bytes32 merkleRoot,
        uint256 totalAllocated,
        uint256 matchingCapacity
    ) external onlyRole(ALLOCATOR_ROLE) {
        if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();

        CoverOrderAllocatorStorage storage $ = _getStorage();

        uint256 currentPeriod = _currentPeriod();
        if (commitmentPeriod != currentPeriod) revert InvalidCommitmentPeriod(commitmentPeriod, currentPeriod);
        if ($.allocationCommitments[currentPeriod].root != bytes32(0)) revert PeriodAlreadyCommitted();
        uint48 graceExpiresAt = uint48(block.timestamp) + $.settlementGracePeriod;
        if (graceExpiresAt >= $.vault.currentPeriodEnd()) revert CommitTooCloseToPeriodEnd();

        _validateMatchingCapacity($, currentPeriod, matchingCapacity, totalAllocated);

        AllocationCommitment storage commit = $.allocationCommitments[currentPeriod];
        commit.root = merkleRoot;
        commit.totalAvailableCapacity = matchingCapacity;
        commit.totalDeclaredAllocated = totalAllocated;
        commit.graceExpiresAt = graceExpiresAt;

        emit AllocationCommitted(currentPeriod, merkleRoot, matchingCapacity, totalAllocated);
    }

    /// @inheritdoc ICoverOrderAllocator
    function recommitAllocation(
        uint256 period,
        bytes32 newMerkleRoot,
        uint256 newTotalAllocated,
        uint256 newMatchingCapacity
    ) external onlyRole(CONFIG_ADMIN_ROLE) {
        if (newMerkleRoot == bytes32(0)) revert InvalidMerkleRoot();

        CoverOrderAllocatorStorage storage $ = _getStorage();

        AllocationCommitment storage commit = _replaceableCommitment($, period);

        uint48 graceExpiresAt = uint48(block.timestamp) + $.settlementGracePeriod;
        if (graceExpiresAt >= $.vault.currentPeriodEnd()) revert CommitTooCloseToPeriodEnd();

        // Validate against fresh capacity (symmetric with commitAllocation) so recommit can
        // capture recovered price/FLB and stays bound to the period's real collateral within
        // tolerance.
        _validateMatchingCapacity($, period, newMatchingCapacity, newTotalAllocated);

        commit.root = newMerkleRoot;
        commit.totalAvailableCapacity = newMatchingCapacity;
        commit.totalDeclaredAllocated = newTotalAllocated;
        commit.graceExpiresAt = graceExpiresAt;

        emit AllocationCommitted(period, newMerkleRoot, newMatchingCapacity, newTotalAllocated);
    }

    /**
     * @dev A commitment stores the capacity THE MATCHER RAN AGAINST (`matchingCapacity`),
     *      not a capacity recomputed at transaction time: settlement re-derives the merkle
     *      tree off-chain from the commitment, so the stored value must be the exact input
     *      that produced the committed root.
     */
    function _validateMatchingCapacity(
        CoverOrderAllocatorStorage storage $,
        uint256 period,
        uint256 matchingCapacity,
        uint256 totalAllocated
    ) private view {
        uint256 maxCapacity = _computeAvailableCapacity($, period);
        if (matchingCapacity > maxCapacity) revert MatchingCapacityOverflow(matchingCapacity, maxCapacity);
        if (totalAllocated > matchingCapacity) revert TotalAllocationOverflow(totalAllocated, matchingCapacity);
    }

    /**
     * @inheritdoc ICoverOrderAllocator
     * @dev Intentionally avoids `_computeAvailableCapacity` (and therefore the price feed):
     *      withdrawing a bad root must remain possible while the oracle is down or stale,
     *      which is exactly when `recommitAllocation` reverts.
     */
    function cancelCommitAllocation(uint256 period) external onlyRole(CONFIG_ADMIN_ROLE) {
        CoverOrderAllocatorStorage storage $ = _getStorage();

        bytes32 root = _replaceableCommitment($, period).root;

        delete $.allocationCommitments[period];

        emit AllocationCommitmentCancelled(period, root);
    }

    /// @dev Loads a period's commitment for replacement or cancellation, enforcing the shared
    ///      guards: `period` must be the current vault period (live capacity and period-start
    ///      reads only correspond to it), a commit must exist, and no order may have settled
    ///      against it yet.
    function _replaceableCommitment(
        CoverOrderAllocatorStorage storage $,
        uint256 period
    ) private view returns (AllocationCommitment storage commit) {
        uint256 currentPeriod = _currentPeriod();
        if (period != currentPeriod) revert InvalidCommitmentPeriod(period, currentPeriod);

        commit = $.allocationCommitments[period];
        if (commit.root == bytes32(0)) revert NoCommitForPeriod();
        if (commit.totalSettledCover > 0) revert SettlementsAlreadyStarted();
    }

    // =========================================================================
    // settleCoverOrder / batchSettleCoverOrder
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function settleCoverOrder(
        uint256 orderId,
        MarketCoverAllocation[] calldata marketCoverAllocations,
        bytes32[] calldata proof
    ) external nonReentrant onlyRole(ALLOCATOR_ROLE) {
        _settleCoverOrder(orderId, marketCoverAllocations, proof);
    }

    /// @inheritdoc ICoverOrderAllocator
    function batchSettleCoverOrder(SettleParams[] calldata params) external nonReentrant onlyRole(ALLOCATOR_ROLE) {
        for (uint256 i; i < params.length; ++i) {
            _settleCoverOrder(params[i].orderId, params[i].marketCoverAllocations, params[i].proof);
        }
    }

    function _settleCoverOrder(
        uint256 orderId,
        MarketCoverAllocation[] calldata marketCoverAllocations,
        bytes32[] calldata proof
    ) internal {
        CoverOrderAllocatorStorage storage $ = _getStorage();

        CoverOrder storage order = $.orders[orderId];
        if (order.buyer == address(0)) revert InvalidOrder();
        if (order.status != CoverOrderStatus.PENDING) revert OrderNotPending();
        if (_currentPeriod() != order.period) revert SettleWindowExpired();

        MarketAllocation[] storage markets = $.orderMarkets[orderId];
        if (marketCoverAllocations.length != markets.length) revert InvalidAllocationMarketsLength();

        AllocationCommitment storage commit = $.allocationCommitments[order.period];
        if (commit.root == bytes32(0)) revert NoCommitForPeriod();

        if (block.timestamp < commit.graceExpiresAt) revert GracePeriodActive(commit.graceExpiresAt);

        // Verify merkle proof (double-hash leaf per OZ standard)
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(orderId, marketCoverAllocations))));
        if (!MerkleProof.verify(proof, commit.root, leaf)) revert InvalidProof();

        // Sum allocated cover, recompute the premium pro-rata per market (same formula
        // and rounding as order creation), and enforce per-market concentration caps.
        // The duration read here matches the one used at creation: a committed period's
        // configuration is immutable (vault updates only apply from future periods).
        uint256 periodDuration = uint256(_periodDuration(order.period));
        uint256 allocatedCover;
        uint256 allocatedPremium;
        for (uint256 i; i < markets.length; ++i) {
            if (marketCoverAllocations[i].marketId != markets[i].marketId) revert MarketIdMismatch();

            uint256 mCover = marketCoverAllocations[i].allocatedCover;
            if (mCover > markets[i].coverAmount) revert MarketAllocationOverflow(mCover, markets[i].coverAmount);

            allocatedCover += mCover;
            allocatedPremium += _calculatePremium(mCover, markets[i].coverRateAnnual, periodDuration);

            // Set settled amount
            markets[i].allocatedCoverAmount = mCover;

            // Per-protocolConcentration cap: protocolConcentrationBps * totalAvailableCapacity / BPS
            // The cap comes from the checkpoint active at order.period.
            Market storage mStored = $.supportedMarkets[marketCoverAllocations[i].marketId];
            bytes32 concHash = _getProtocolConcentrationHash(mStored.chainId, mStored.protocol);
            uint256 newProtocolConcentrationCover =
                $.protocolConcentrationSettledCover[order.period][concHash] + mCover;
            uint256 protocolConcentrationCap =
                (_getEffectiveProtocolConcentration(concHash, order.period) * commit.totalAvailableCapacity) /
                    BPS_DENOMINATOR;
            if (newProtocolConcentrationCover > protocolConcentrationCap)
                revert ProtocolConcentrationOverflow(newProtocolConcentrationCover, protocolConcentrationCap);

            $.protocolConcentrationSettledCover[order.period][concHash] = newProtocolConcentrationCover;
        }

        if (allocatedCover == 0) revert ZeroAllocation();

        // A full match allocates every market exactly, so the recomputed premium equals
        // `totalPremiumAmount` by construction (same per-market formula and rounding).
        order.status = allocatedCover == order.totalCoverAmount ? CoverOrderStatus.MATCHED : CoverOrderStatus.PARTIAL;

        order.allocatedCoverAmount = allocatedCover;
        order.allocatedPremiumAmount = allocatedPremium;

        commit.totalSettledCover += allocatedCover;
        if (commit.totalSettledCover > commit.totalDeclaredAllocated)
            revert TotalSettledOverflow(commit.totalSettledCover, commit.totalDeclaredAllocated);
        commit.totalSettledPremium += allocatedPremium;

        uint256 finalPremiumNative = Decimals.convert(
            allocatedPremium,
            CANONICAL_DECIMALS,
            $.premiumTokenDecimals[order.premiumToken],
            Math.Rounding.Ceil
        );
        IERC20(order.premiumToken).safeTransferFrom(order.buyer, $.premiumCollector, finalPremiumNative);

        $.coverNFT.safeMint(order.buyer, orderId);

        emit CoverOrderSettled(orderId, order.status, allocatedCover, allocatedPremium);
    }

    // =========================================================================
    // cancelCoverOrder
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function cancelCoverOrder(uint256 coverOrderId) external onlyRole(CURATOR_ROLE) {
        CoverOrderAllocatorStorage storage $ = _getStorage();
        CoverOrder storage order = $.orders[coverOrderId];
        if (order.buyer == address(0)) revert InvalidOrder();
        if (order.status != CoverOrderStatus.PENDING) revert OrderNotPending();

        order.status = CoverOrderStatus.CANCELLED;

        emit CoverOrderCancelled(coverOrderId);
    }

    /// @inheritdoc ICoverOrderAllocator
    function cancelExpiredOrders(uint256[] calldata coverOrderIds) external {
        CoverOrderAllocatorStorage storage $ = _getStorage();
        uint256 currentPeriod = _currentPeriod();
        for (uint256 i; i < coverOrderIds.length; ++i) {
            uint256 coverOrderId = coverOrderIds[i];
            CoverOrder storage order = $.orders[coverOrderId];
            if (order.buyer == address(0)) revert InvalidOrder();
            if (order.status != CoverOrderStatus.PENDING) revert OrderNotPending();
            if (order.period >= currentPeriod) revert OrderNotExpired();

            order.status = CoverOrderStatus.CANCELLED;

            emit CoverOrderCancelled(coverOrderId);
        }
    }

    // =========================================================================
    // setPremiumCollector
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function setPremiumCollector(address newCollector) external onlyRole(ADMIN_ROLE) {
        _setPremiumCollector(newCollector);
    }

    function _setPremiumCollector(address newCollector) internal {
        _requireNonZero(newCollector);

        CoverOrderAllocatorStorage storage $ = _getStorage();
        address old = $.premiumCollector;
        $.premiumCollector = newCollector;

        emit PremiumCollectorUpdated(old, newCollector);
    }

    // =========================================================================
    // Oracle (vault asset USD price feed) management
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function setPriceFeedAdapter(IAggregatorV3 newPriceFeedAdapter) external onlyRole(ADMIN_ROLE) {
        _setPriceFeedAdapter(newPriceFeedAdapter);
    }

    /// @inheritdoc ICoverOrderAllocator
    function setMaxPriceAge(uint48 newMaxPriceAge) external onlyRole(ADMIN_ROLE) {
        _setMaxPriceAge(newMaxPriceAge);
    }

    /// @inheritdoc ICoverOrderAllocator
    function setSettlementGracePeriod(uint48 newGracePeriod) external onlyRole(CONFIG_ADMIN_ROLE) {
        CoverOrderAllocatorStorage storage $ = _getStorage();
        if (newGracePeriod > MAX_GRACE_PERIOD) revert InvalidGracePeriod(newGracePeriod, MAX_GRACE_PERIOD);

        uint48 oldGracePeriod = $.settlementGracePeriod;
        $.settlementGracePeriod = newGracePeriod;
        emit SettlementGracePeriodUpdated(oldGracePeriod, newGracePeriod);
    }

    function _setPriceFeedAdapter(IAggregatorV3 newPriceFeedAdapter) internal {
        _requireNonZero(address(newPriceFeedAdapter));

        CoverOrderAllocatorStorage storage $ = _getStorage();

        uint8 newPriceFeedDecimals = newPriceFeedAdapter.decimals();
        if (newPriceFeedDecimals < 6 || newPriceFeedDecimals > 18) {
            revert InvalidPriceFeedDecimals(newPriceFeedDecimals);
        }

        address oldPriceFeedAdapter = address($.priceFeedAdapter);
        uint8 oldPriceFeedDecimals = $.priceFeedDecimals;

        $.priceFeedAdapter = newPriceFeedAdapter;
        $.priceFeedDecimals = newPriceFeedDecimals;

        emit PriceFeedUpdated(
            oldPriceFeedAdapter,
            oldPriceFeedDecimals,
            address(newPriceFeedAdapter),
            newPriceFeedDecimals
        );
    }

    function _setMaxPriceAge(uint48 newMaxPriceAge) internal {
        if (newMaxPriceAge == 0) revert InvalidMaxPriceAge();

        CoverOrderAllocatorStorage storage $ = _getStorage();
        uint48 oldMaxPriceAge = $.maxPriceAge;
        $.maxPriceAge = newMaxPriceAge;

        emit MaxPriceAgeUpdated(oldMaxPriceAge, newMaxPriceAge);
    }

    // =========================================================================
    // setCapacityConfig
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function setCapacityConfig(CapacityConfig calldata config) external onlyRole(CONFIG_ADMIN_ROLE) {
        _setCapacityConfig(config);
    }

    function _setCapacityConfig(CapacityConfig calldata config) internal {
        if (config.minCAR < MIN_CAR_BPS || config.minCAR > MAX_CAR_BPS) revert InvalidMinCAR();
        _requireNonZero(address(config.firstLossBufferToken));
        _requireNonZero(config.firstLossBuffer);
        if (config.effectiveLeverage == 0 || config.effectiveLeverage > MAX_LEVERAGE_FACTOR * config.minCAR)
            revert InvalidLeverage();
        if (config.minOrderMarketCoverAmount == 0) revert InvalidMinOrderMarketCoverAmount();
        if (config.divergenceToleranceBps > MAX_DIVERGENCE_TOLERANCE_BPS)
            revert InvalidDivergenceTolerance(config.divergenceToleranceBps);
        _readDecimals(address(config.firstLossBufferToken));

        CoverOrderAllocatorStorage storage $ = _getStorage();
        uint256 idx = $.capacityConfigHistory.length;
        $.capacityConfigHistory.push(config);
        // First-ever config is effective from period 0 so any past-period
        // lookup hits a real checkpoint. Subsequent updates take effect next period.
        uint32 effectivePeriod = idx == 0 ? 0 : uint32(_currentPeriod() + 1);
        $.capacityConfigCheckpoints.push(effectivePeriod, uint224(idx));

        emit CapacityConfigUpdated(config);
    }

    function _getEffectiveCapacityConfig(uint256 period) internal view returns (CapacityConfig storage) {
        CoverOrderAllocatorStorage storage $ = _getStorage();
        uint224 idx = $.capacityConfigCheckpoints.upperLookupRecent(uint32(period));
        return $.capacityConfigHistory[uint256(idx)];
    }

    /// @notice Recomputes the period's effective cover capacity from live inputs.
    /// @dev Values staked assets at `currentPeriodStart()`, so it is only meaningful for the
    ///      current period (enforced by callers). Capacity is in canonical USD.
    ///      The divergence tolerance is folded in here as the period's EFFECTIVE capacity, so
    ///      both the global allocation cap (commit/recommit) and the per-protocol concentration
    ///      caps in `_settleCoverOrder` (which read `commit.totalAvailableCapacity`) scale by the
    ///      same margin — a tree committed within tolerance therefore stays settleable.
    function _computeAvailableCapacity(
        CoverOrderAllocatorStorage storage $,
        uint256 period
    ) internal view returns (uint256 totalAvailableCapacity) {
        uint256 assetPriceUSD = $.priceFeedAdapter.getPrice($.maxPriceAge);

        CapacityConfig storage config = _getEffectiveCapacityConfig(period);

        uint256 firstLossBufferUSDCanonical = Decimals.convert(
            config.firstLossBufferToken.balanceOf(config.firstLossBuffer),
            _readDecimals(address(config.firstLossBufferToken)),
            CANONICAL_DECIMALS,
            Math.Rounding.Floor
        );
        uint256 totalAssetsCanonical = Decimals.convert(
            $.vault.totalAssetsAt($.vault.currentPeriodStart()),
            $.vaultAssetDecimals,
            CANONICAL_DECIMALS,
            Math.Rounding.Floor
        );
        uint256 stakedAssetsValueUSDCanonical = totalAssetsCanonical.mulDiv(assetPriceUSD, 10 ** $.priceFeedDecimals);
        uint256 availableCollateralCanonical = firstLossBufferUSDCanonical + stakedAssetsValueUSDCanonical;

        uint256 strictCapacity = availableCollateralCanonical.mulDiv(config.effectiveLeverage, config.minCAR);
        // Fold in the divergence tolerance as the period's effective capacity.
        totalAvailableCapacity = strictCapacity.mulDiv(
            BPS_DENOMINATOR + config.divergenceToleranceBps,
            BPS_DENOMINATOR
        );
    }

    function _getEffectiveProtocolConcentration(
        bytes32 protocolConcentrationHash,
        uint256 period
    ) internal view returns (uint256) {
        return
            uint256(
                _getStorage().protocolConcentrationCheckpoints[protocolConcentrationHash].upperLookupRecent(
                    uint32(period)
                )
            );
    }

    function _getProtocolConcentrationHash(uint64 chainId, string memory protocol) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, protocol));
    }

    /// @dev Shared write path for setProtocolConcentration and initialize. Always pushes the
    ///      checkpoint at currentPeriod() + 1. Validates bps, registers the hash on first
    ///      sight, emits ProtocolConcentrationUpdated. Per-protocolConcentration bps act as independent
    ///      ceilings: no aggregate sum invariant is enforced — the global cover bound is
    ///      enforced via `commit.totalAvailableCapacity` / `TotalAllocationOverflow` in
    ///      `commitAllocation`.
    function _setProtocolConcentration(ProtocolConcentrationInput calldata c) internal {
        if (c.chainId == 0) revert InvalidChainId();
        if (bytes(c.protocol).length == 0) revert InvalidProtocolConcentration();
        if (c.maxProtocolConcentrationBps > BPS_DENOMINATOR) revert InvalidProtocolConcentration();

        CoverOrderAllocatorStorage storage $ = _getStorage();
        bytes32 hash = _getProtocolConcentrationHash(c.chainId, c.protocol);

        uint256 oldShare = $.protocolConcentrationCheckpoints[hash].latest();

        ProtocolConcentration storage id = $.protocolConcentrations[hash];
        if (id.chainId == 0) {
            id.protocol = c.protocol;
            id.chainId = c.chainId;
            $.supportedProtocolConcentrationHashes.push(hash);
            emit ProtocolConcentrationRegistered(hash, c.protocol, c.chainId);
        }
        uint32 effectivePeriod = uint32(_currentPeriod() + 1);
        $.protocolConcentrationCheckpoints[hash].push(effectivePeriod, uint224(c.maxProtocolConcentrationBps));

        emit ProtocolConcentrationUpdated(hash, oldShare, c.maxProtocolConcentrationBps);
    }

    // =========================================================================
    // SupportedMarkets functions
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function addSupportedMarket(Market calldata newMarket) external onlyRole(CONFIG_ADMIN_ROLE) returns (bytes32) {
        return _addSupportedMarket(newMarket);
    }

    function _addSupportedMarket(Market memory newMarket) internal returns (bytes32 marketId) {
        if (newMarket.chainId == 0) revert InvalidChainId();

        CoverOrderAllocatorStorage storage $ = _getStorage();
        marketId = _getMarketId(newMarket.chainId, newMarket.protocol, newMarket.market);

        Market storage m = $.supportedMarkets[marketId];
        if (m.chainId != 0) revert MarketAlreadyExists();

        // Add market to storage
        m.chainId = newMarket.chainId;
        m.protocol = newMarket.protocol;
        m.market = newMarket.market;

        $.supportedMarketIds.push(marketId);

        emit MarketAdded(marketId, newMarket.chainId, newMarket.protocol, newMarket.market);
    }

    function _getMarketId(uint64 chainId, string memory protocol, bytes32 market) internal pure returns (bytes32) {
        return keccak256(abi.encode(chainId, protocol, market));
    }

    /**
     * @inheritdoc ICoverOrderAllocator
     * @dev The new cap becomes effective at currentPeriod() + 1 — the same period in which
     *      orders created RIGHT NOW will settle. **Lowering a cap mid-period can therefore
     *      leave already-created orders unsettleable**: the order was created with the assumption
     *      that the cap was X, but `_settleCoverOrder` will read the new lower cap and may revert
     *      `ProtocolConcentrationOverflow`.
     *
     *      Curator MUST coordinate with the off-chain matching engine to avoid this:
     *        - Raising a cap mid-period is always safe.
     *        - Lowering a cap is only safe if no orders pointing to this protocolConcentration exist
     *          in the same period, or if the curator excludes the affected orders from the
     *          matching tree (they will remain PENDING and can be cancelled).
     *
     *      A future hard mitigation would be to deferr decreases to currentPeriod() + 2,
     *      preserving the original cap for orders already on the book; not implemented today
     *      so that the curator retains immediate control.
     */
    function setProtocolConcentration(
        ProtocolConcentrationInput calldata protocolConcentration
    ) external onlyRole(CONFIG_ADMIN_ROLE) {
        _setProtocolConcentration(protocolConcentration);
    }

    /// @inheritdoc ICoverOrderAllocator
    function batchSetProtocolConcentration(
        ProtocolConcentrationInput[] calldata protocolConcentrations
    ) external onlyRole(CONFIG_ADMIN_ROLE) {
        for (uint256 i; i < protocolConcentrations.length; ++i) {
            _setProtocolConcentration(protocolConcentrations[i]);
        }
    }

    // =========================================================================
    // Premium token management
    // =========================================================================

    /// @inheritdoc ICoverOrderAllocator
    function addSupportedPremiumToken(address token) external onlyRole(CONFIG_ADMIN_ROLE) {
        _addSupportedPremiumToken(token);
    }

    function _addSupportedPremiumToken(address token) internal {
        _requireNonZero(token);
        CoverOrderAllocatorStorage storage $ = _getStorage();
        if (!$.supportedPremiumTokens.add(token)) revert PremiumTokenAlreadySupported();

        $.premiumTokenDecimals[token] = _readDecimals(token);

        emit PremiumTokenAdded(token);
    }

    /// @inheritdoc ICoverOrderAllocator
    function removeSupportedPremiumToken(address token) external onlyRole(CONFIG_ADMIN_ROLE) {
        CoverOrderAllocatorStorage storage $ = _getStorage();
        if (!$.supportedPremiumTokens.remove(token)) revert UnsupportedPremiumToken();

        emit PremiumTokenRemoved(token);
    }

    // =========================================================================
    // View functions
    // =========================================================================

    function isPremiumTokenSupported(address token) external view returns (bool) {
        return _getStorage().supportedPremiumTokens.contains(token);
    }

    /// @inheritdoc ICoverOrderAllocator
    function getSupportedPremiumTokens() external view returns (address[] memory) {
        return _getStorage().supportedPremiumTokens.values();
    }

    function vault() external view returns (IFirelightVault) {
        return _getStorage().vault;
    }

    function coverNFT() external view returns (CoverNFT) {
        return _getStorage().coverNFT;
    }

    function priceFeedAdapter() external view returns (IAggregatorV3) {
        return _getStorage().priceFeedAdapter;
    }

    function maxPriceAge() external view returns (uint48) {
        return _getStorage().maxPriceAge;
    }

    function settlementGracePeriod() external view returns (uint48) {
        return _getStorage().settlementGracePeriod;
    }

    function priceFeedDecimals() external view returns (uint8) {
        return _getStorage().priceFeedDecimals;
    }

    function premiumCollector() external view returns (address) {
        return _getStorage().premiumCollector;
    }

    function nextCoverOrderId() external view returns (uint256) {
        return _getStorage().nextCoverOrderId;
    }

    function getCoverOrder(uint256 coverOrderId) external view returns (CoverOrder memory) {
        return _getStorage().orders[coverOrderId];
    }

    function getCoverOrderMarkets(uint256 coverOrderId) external view returns (MarketAllocation[] memory) {
        return _getStorage().orderMarkets[coverOrderId];
    }

    function getCoverOrderMarketInfo(
        uint256 coverOrderId,
        bytes32 marketId
    ) external view returns (uint256 period, uint256 allocatedCoverAmount, address payoutRecipient) {
        CoverOrderAllocatorStorage storage $ = _getStorage();
        MarketAllocation[] storage markets = $.orderMarkets[coverOrderId];
        uint256 len = markets.length;
        for (uint256 i; i < len; ) {
            if (markets[i].marketId == marketId) {
                CoverOrder storage order = $.orders[coverOrderId];
                return (order.period, markets[i].allocatedCoverAmount, order.payoutRecipient);
            }

            unchecked {
                ++i;
            }
        }
    }

    function getSupportedMarket(bytes32 marketId) external view returns (Market memory) {
        return _getStorage().supportedMarkets[marketId];
    }

    function getEffectiveCapacityConfig() external view returns (CapacityConfig memory) {
        return _getEffectiveCapacityConfig(_currentPeriod() + 1);
    }

    function getCapacityConfigAt(uint256 period) external view returns (CapacityConfig memory) {
        return _getEffectiveCapacityConfig(period);
    }

    function getCoverOrdersIdByPeriod(uint256 period) external view returns (uint256[] memory) {
        return _getStorage().ordersIdByPeriod[period];
    }

    function getAllocationCommitment(uint256 period) external view returns (AllocationCommitment memory) {
        return _getStorage().allocationCommitments[period];
    }

    function getSupportedMarketIds() external view returns (bytes32[] memory) {
        return _getStorage().supportedMarketIds;
    }

    function getSupportedProtocolConcentrationHashes() external view returns (bytes32[] memory) {
        return _getStorage().supportedProtocolConcentrationHashes;
    }

    function getProtocolConcentrationFromHash(
        bytes32 protocolConcentrationHash
    ) external view returns (ProtocolConcentration memory) {
        return _getStorage().protocolConcentrations[protocolConcentrationHash];
    }

    function getProtocolConcentrationSettledCover(
        uint256 period,
        bytes32 protocolConcentrationHash
    ) external view returns (uint256) {
        return _getStorage().protocolConcentrationSettledCover[period][protocolConcentrationHash];
    }

    function getEffectiveProtocolConcentration(bytes32 protocolConcentrationHash) external view returns (uint256) {
        return _getEffectiveProtocolConcentration(protocolConcentrationHash, _currentPeriod() + 1);
    }

    function getProtocolConcentrationAt(
        bytes32 protocolConcentrationHash,
        uint256 period
    ) external view returns (uint256) {
        return _getEffectiveProtocolConcentration(protocolConcentrationHash, period);
    }

    // =========================================================================
    // Decimals helpers
    // =========================================================================

    /// @dev Reads ERC20.decimals() and reverts if > CANONICAL_DECIMALS (we only support ≤ canonical).
    function _readDecimals(address token) private view returns (uint8 dec) {
        dec = IERC20Metadata(token).decimals();
        if (dec > CANONICAL_DECIMALS) revert UnsupportedDecimals(dec);
    }

    /// @dev Shared zero-address guard; deduplicated into a helper to keep bytecode size down.
    function _requireNonZero(address account) private pure {
        if (account == address(0)) revert InvalidZeroAddress();
    }

    /// @dev Duration (seconds) of `period` per the vault's configuration.
    function _periodDuration(uint256 period) private view returns (uint48) {
        return _getStorage().vault.periodConfigurationAtNumber(period).duration;
    }

    /// @dev Current vault period; deduplicated into a helper to keep bytecode size down.
    function _currentPeriod() private view returns (uint256) {
        return _getStorage().vault.currentPeriod();
    }
}
