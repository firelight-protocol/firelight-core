// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFirelightVault} from "./IFirelightVault.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";
import {CoverNFT} from "../CoverNFT.sol";

/**
 * @title ICoverOrderAllocator
 * @notice Cover order lifecycle, off-chain matching commit/settle, capacity, and
 *         protocol-concentration configuration for the Firelight cover market.
 *
 * ## Decimal convention
 *
 * All on-chain monetary values (cover amounts, premiums, capacity, allocations,
 * protocolConcentration caps × capacity, etc.) are expressed in a **canonical USD unit** with
 * `CANONICAL_DECIMALS` decimals (currently 18), regardless of the underlying premium /
 * first-loss-buffer / vault-asset token decimals. Throughout this interface, "canonical USD"
 * always means `CANONICAL_DECIMALS`-decimal USD. Conversion to/from native token decimals
 * happens only at the boundaries:
 *
 *   - Off-chain: callers MUST normalize inputs (e.g. `MarketAllocationInput.coverAmount`,
 *     merkle leaf `allocatedCover`, `commitAllocation` totalAllocated)
 *     from native decimals to canonical decimals before submitting.
 *   - On-chain transfers: premium `safeTransferFrom`, first-loss-buffer transfer, and
 *     `vault.payout()` are denormalized from canonical decimals back to each token's native
 *     decimals at the transfer call site.
 *
 * Supported tokens must implement `decimals() <= CANONICAL_DECIMALS` (validated on registration).
 *
 * ## Off-chain matching flow
 *
 * The matching algorithm runs off-chain (TypeScript engine). The on-chain contract
 * only validates and applies results via a Merkle commit + settle pattern:
 *
 *   1. Read all PENDING orders for the target period via `getCoverOrdersIdByPeriod(period)`
 *   2. For each orderId, read `getCoverOrder(orderId)` and `getCoverOrderMarkets(orderId)`
 *   3. Read protocolConcentration caps via `getSupportedProtocolConcentrationHashes()` + `getEffectiveProtocolConcentration(hash)
 *   4. Compute capacity: `(config.firstLossBufferToken.balanceOf(config.firstLossBuffer)
 *      + vault.totalAssets() * assetPriceUSD / 10**priceFeedDecimals) * config.effectiveLeverage / config.minCAR`
 *   5. Run the matching algorithm → produces per-order `allocatedCoverPerMarket[]`
 *   6. Build a StandardMerkleTree with leaves: `(uint256 orderId, (bytes32,uint256)[] marketCoverAllocations)`
 *      (premiums are recomputed on-chain at settlement, pro-rata from each order's stored terms)
 *   7. Call `commitAllocation(commitmentPeriod, merkleRoot, totalAllocated)` to commit
 *   8. Call `batchSettleCoverOrder(params)` or `settleCoverOrder(...)` for each order with its Merkle proof
 *
 * ## Leaf encoding
 *
 * Double-hash per OpenZeppelin standard:
 *   `keccak256(bytes.concat(keccak256(abi.encode(orderId, marketCoverAllocations))))`
 *
 * ## ProtocolConcentration cap
 *
 * A market belongs to a protocolConcentration group identified by
 *   `protocolConcentrationHash = keccak256(abi.encode(protocol, chainId))`
 * Multiple markets sharing the same (protocol, chainId) share a single cap. During
 * settlement, cumulative cover per protocolConcentration group must not exceed:
 *   `protocolConcentrationBps * totalAvailableCapacity / 10000`
 *
 * ProtocolConcentration caps are governed independently from market registration. A market
 * whose protocolConcentration has no cap configured is effectively disabled.
 */
interface ICoverOrderAllocator {
    // --- Enums ---

    /// @notice Whether a cover order is a new purchase or a renewal of existing cover.
    enum CoverOrderType {
        NEW,
        RENEWAL
    }

    /// @notice Lifecycle status of a cover order.
    enum CoverOrderStatus {
        PENDING,
        /// Fully settled: allocated cover equals the requested amount.
        MATCHED,
        /// Settled with allocated cover below the requested amount.
        PARTIAL,
        CANCELLED
    }

    // --- Structs ---

    /// @notice A protected market on a specific chain and protocol.
    struct Market {
        uint64 chainId;
        string protocol;
        /// Protocol-specific market identifier.
        bytes32 market;
    }

    /// @notice Input to set a (protocol, chainId) concentration group's cap.
    struct ProtocolConcentrationInput {
        uint64 chainId;
        string protocol;
        /// Maximum share of capacity the group may take, in bps.
        uint256 maxProtocolConcentrationBps;
    }

    /// @notice The (protocol, chainId) tuple a concentration hash was derived from.
    struct ProtocolConcentration {
        uint64 chainId;
        string protocol;
    }

    /// @notice Initialization parameters for the allocator.
    struct InitParams {
        IFirelightVault vault;
        address premiumCollector;
        CoverNFT coverNFT;
        IAggregatorV3 priceFeedAdapter;
        /// Maximum tolerated price age, in seconds.
        uint48 maxPriceAge;
        address[] premiumTokens;
        /// Receives DEFAULT_ADMIN_ROLE.
        address admin;
        /// Receives ADMIN_ROLE.
        address adminRole;
        address curatorRole;
        address allocatorRole;
        address configAdminRole;
        ProtocolConcentrationInput[] initialProtocolConcentrations;
        Market[] newMarkets;
        /// Initial capacity configuration (effective from period 0).
        CapacityConfig capacityConfig;
    }

    /// @notice Per-market cover request submitted when creating an order.
    struct MarketAllocationInput {
        bytes32 marketId;
        /// Annual cover rate, in bps.
        uint32 coverRateAnnual;
        /// Requested cover in canonical USD, pre-normalized by the caller
        /// (e.g. `nativeAmount * 10**(CANONICAL_DECIMALS - premiumTokenDecimals)`).
        uint256 coverAmount;
    }

    /// @notice Per-market allocation stored for an order (request + settled result).
    struct MarketAllocation {
        bytes32 marketId;
        /// Annual cover rate, in bps.
        uint32 coverRateAnnual;
        /// Requested cover, in canonical USD.
        uint256 coverAmount;
        /// Cover actually allocated on settle, in canonical USD.
        uint256 allocatedCoverAmount;
    }

    /// @notice Full cover order record.
    struct CoverOrder {
        // Slot: buyer (20) + orderType (1) + status (1).
        address buyer;
        CoverOrderType orderType;
        CoverOrderStatus status;
        address payoutRecipient;
        /// Off-chain beneficiary reference.
        string beneficiaryAddress;
        address premiumToken;
        /// Total requested cover across markets, in canonical USD.
        uint256 totalCoverAmount;
        /// Total premium owed, in canonical USD.
        uint256 totalPremiumAmount;
        /// Cover-amount-weighted average annual rate, in bps.
        uint256 weightedAvgRate;
        /// Total cover allocated on settle, in canonical USD.
        uint256 allocatedCoverAmount;
        /// Premium charged for the allocated cover, in canonical USD.
        uint256 allocatedPremiumAmount;
        /// Target period the order is matched and settled in.
        uint256 period;
    }

    /// @notice Per-period capacity configuration (checkpointed; effective at currentPeriod() + 1).
    struct CapacityConfig {
        /// Minimum capital adequacy ratio, in bps (1.2x to 5x, inclusive).
        uint256 minCAR;
        /// ERC20 (decimals ≤ CANONICAL_DECIMALS) used as first-loss-buffer collateral.
        IERC20 firstLossBufferToken;
        /// Custody wallet holding the first-loss-buffer balance.
        address firstLossBuffer;
        /// Leverage applied to collateral when computing capacity, in bps
        /// (> 0, <= MAX_LEVERAGE_FACTOR * minCAR).
        uint256 effectiveLeverage;
        /// Minimum per-market cover amount allowed on an order, in canonical USD.
        uint256 minOrderMarketCoverAmount;
        /// Upper margin (bps) tolerated between the submitted `totalAllocated` and the recomputed
        /// capacity at commit/recommit, to absorb price/FLB drift. 0 = strict (legacy behavior).
        uint16 divergenceToleranceBps;
    }

    /// @notice Committed off-chain matching results and settlement accounting for a period.
    struct AllocationCommitment {
        /// Root of the StandardMerkleTree of settlement leaves.
        bytes32 root;
        /// Effective period capacity (tolerance included), in canonical USD.
        uint256 totalAvailableCapacity;
        /// Declared sum of allocated cover across the tree, in canonical USD.
        uint256 totalDeclaredAllocated;
        /// Cumulative cover settled so far, in canonical USD.
        uint256 totalSettledCover;
        /// Cumulative premium settled so far, in canonical USD.
        uint256 totalSettledPremium;
        /// Timestamp of the most recent commit (initial or recommit); drives the grace gate.
        uint48 committedAt;
    }

    /// @notice Per-market allocation encoded in a settlement leaf and passed to settle.
    struct MarketCoverAllocation {
        bytes32 marketId;
        /// Allocated cover for the market, in canonical USD.
        uint256 allocatedCover;
    }

    /// @notice Parameters to settle a single order in a batch.
    struct SettleParams {
        uint256 orderId;
        MarketCoverAllocation[] marketCoverAllocations;
        /// Merkle proof of the order's leaf against the period commitment root.
        bytes32[] proof;
    }

    // --- Events ---

    /**
     * @notice Emitted when a cover order is created for the next period.
     * @param coverOrderId New cover order id.
     * @param buyer Account that pays the premium.
     * @param payoutRecipient Account that receives the payout if a covered incident occurs.
     * @param beneficiaryAddress Off-chain beneficiary reference recorded with the order.
     * @param premiumToken ERC20 used to pay the premium.
     * @param totalCoverAmount Total requested cover across markets, in canonical USD.
     * @param totalPremiumAmount Total premium owed for the order, in canonical USD.
     * @param weightedAvgRate Cover-amount-weighted average annual rate, in bps.
     * @param orderType Whether the order is NEW or a RENEWAL.
     * @param period Target period the order will be matched and settled in.
     */
    event CoverOrderCreated(
        uint256 coverOrderId,
        address buyer,
        address payoutRecipient,
        string beneficiaryAddress,
        address premiumToken,
        uint256 totalCoverAmount,
        uint256 totalPremiumAmount,
        uint256 weightedAvgRate,
        CoverOrderType orderType,
        uint256 period
    );

    /**
     * @notice Emitted when an order is settled against the committed Merkle root.
     * @param coverOrderId Settled cover order id.
     * @param status Resulting status (MATCHED or PARTIAL).
     * @param allocatedCoverAmount Total cover allocated to the order, in canonical USD.
     * @param allocatedPremiumAmount Premium charged for the allocated cover, in canonical USD.
     */
    event CoverOrderSettled(
        uint256 coverOrderId,
        CoverOrderStatus status,
        uint256 allocatedCoverAmount,
        uint256 allocatedPremiumAmount
    );

    /**
     * @notice Emitted when a pending order is cancelled.
     * @param coverOrderId Cancelled cover order id.
     */
    event CoverOrderCancelled(uint256 coverOrderId);

    /**
     * @notice Emitted on each commit or recommit of a period's matching results.
     * @param period Period the commitment applies to.
     * @param merkleRoot Root of the StandardMerkleTree of settlement leaves.
     * @param totalAvailableCapacity Effective period capacity (tolerance included), in canonical USD.
     * @param totalAllocated Declared sum of allocated cover across the tree, in canonical USD.
     */
    event AllocationCommitted(
        uint256 indexed period,
        bytes32 merkleRoot,
        uint256 totalAvailableCapacity,
        uint256 totalAllocated
    );

    /**
     * @notice Emitted when a period's allocation commitment is cancelled before any settlement.
     * @param period Period whose commitment was cancelled.
     * @param merkleRoot Root of the cancelled commitment.
     */
    event AllocationCommitmentCancelled(uint256 indexed period, bytes32 merkleRoot);

    /**
     * @notice Emitted when the premium collector address changes.
     * @param oldCollector Previous premium collector.
     * @param newCollector New premium collector.
     */
    event PremiumCollectorUpdated(address oldCollector, address newCollector);

    /**
     * @notice Emitted when a market is registered.
     * @param marketId Derived market id.
     * @param chainId Chain the market lives on.
     * @param protocol Protocol name the market belongs to.
     * @param market Protocol-specific market identifier.
     */
    event MarketAdded(bytes32 marketId, uint64 chainId, string protocol, bytes32 market);

    /**
     * @notice Emitted the first time a (protocol, chainId) concentration group is seen.
     * @param protocolConcentrationHash Hash identifying the concentration group.
     * @param protocol Protocol name of the group.
     * @param chainId Chain id of the group.
     */
    event ProtocolConcentrationRegistered(bytes32 indexed protocolConcentrationHash, string protocol, uint64 chainId);

    /**
     * @notice Emitted when a concentration group's cap is set or updated.
     * @param protocolConcentrationHash Hash identifying the concentration group.
     * @param oldShareBps Previous cap, in bps.
     * @param newShareBps New cap, in bps, effective at currentPeriod() + 1.
     */
    event ProtocolConcentrationUpdated(
        bytes32 indexed protocolConcentrationHash,
        uint256 oldShareBps,
        uint256 newShareBps
    );

    /**
     * @notice Emitted when a premium token is whitelisted.
     * @param token Added premium token.
     */
    event PremiumTokenAdded(address token);

    /**
     * @notice Emitted when a premium token is removed from the whitelist.
     * @param token Removed premium token.
     */
    event PremiumTokenRemoved(address token);

    /**
     * @notice Emitted when a new capacity configuration checkpoint is pushed.
     * @param config The capacity configuration that becomes effective (currentPeriod() + 1, or 0 for the first one).
     */
    event CapacityConfigUpdated(CapacityConfig config);

    /**
     * @notice Emitted when the price feed adapter is replaced.
     * @param oldPriceFeedAdapter Previous adapter.
     * @param oldPriceFeedDecimals Previous adapter decimals.
     * @param newPriceFeedAdapter New adapter.
     * @param newPriceFeedDecimals New adapter decimals.
     */
    event PriceFeedUpdated(
        address oldPriceFeedAdapter,
        uint8 oldPriceFeedDecimals,
        address newPriceFeedAdapter,
        uint8 newPriceFeedDecimals
    );

    /**
     * @notice Emitted when the maximum tolerated price age changes.
     * @param oldMaxPriceAge Previous max age, in seconds.
     * @param newMaxPriceAge New max age, in seconds.
     */
    event MaxPriceAgeUpdated(uint48 oldMaxPriceAge, uint48 newMaxPriceAge);

    /**
     * @notice Emitted when the settlement grace period changes.
     * @param oldGracePeriod Previous grace period, in seconds.
     * @param newGracePeriod New grace period, in seconds.
     */
    event SettlementGracePeriodUpdated(uint48 oldGracePeriod, uint48 newGracePeriod);

    // --- Errors ---

    // -- order creation / market configuration --
    /// @notice Thrown when an order is created with no markets.
    error InvalidMarketsLength();
    /// @notice Thrown when a market entry has a zero cover amount or zero rate.
    error InvalidMarketsZeroValue();
    /// @notice Thrown when an order lists the same market more than once.
    error DuplicateMarket();
    /// @notice Thrown when registering a market that already exists.
    error MarketAlreadyExists();
    /// @notice Thrown when ordering on a market whose concentration cap is unset (disabled).
    error ZeroProtocolConcentrationForMarket();
    /// @notice Thrown when referencing a market that is not registered.
    error MarketNotFound();
    /// @notice Thrown when an order with a zero chainId is referenced.
    error InvalidChainId();
    /// @notice Thrown when a market's cover amount is below the configured minimum.
    /// @param amount Provided cover amount, in canonical USD.
    /// @param minimum Configured minimum, in canonical USD.
    error OrderMarketCoverAmountTooLow(uint256 amount, uint256 minimum);

    // -- commit / settle --
    /// @notice Thrown when an order is not in PENDING status for the attempted action.
    error OrderNotPending();
    /// @notice Thrown when committing to a period that already has a commitment.
    error PeriodAlreadyCommitted();
    /// @notice Thrown when the commit/recommit period is not the current vault period.
    /// @param commitmentPeriod Period the caller passed.
    /// @param currentPeriod Current vault period at execution.
    error InvalidCommitmentPeriod(uint256 commitmentPeriod, uint256 currentPeriod);
    /// @notice Thrown when the Merkle root is the zero hash.
    error InvalidMerkleRoot();
    /// @notice Thrown when the declared/settled cover exceeds the effective capacity.
    /// @param allocation Requested allocation, in canonical USD.
    /// @param capacity Effective capacity ceiling, in canonical USD.
    error TotalAllocationOverflow(uint256 allocation, uint256 capacity);
    /// @notice Thrown when a market's allocated cover exceeds its requested cover.
    /// @param allocation Allocated cover, in canonical USD.
    /// @param capacity Requested cover for that market, in canonical USD.
    error MarketAllocationOverflow(uint256 allocation, uint256 capacity);
    /// @notice Thrown when cumulative settled cover for a concentration group exceeds its cap.
    /// @param allocation Cumulative cover for the group, in canonical USD.
    /// @param capacity Group cap, in canonical USD.
    error ProtocolConcentrationOverflow(uint256 allocation, uint256 capacity);
    /// @notice Thrown when cumulative settled cover exceeds the declared allocation.
    /// @param allocation Cumulative settled cover, in canonical USD.
    /// @param capacity Declared allocation, in canonical USD.
    error TotalSettledOverflow(uint256 allocation, uint256 capacity);
    /// @notice Thrown when the settle market list length differs from the order's markets.
    error InvalidAllocationMarketsLength();
    /// @notice Thrown when a settle market id does not match the order's market at that index.
    error MarketIdMismatch();
    /// @notice Thrown when an order settles with zero total allocated cover.
    error ZeroAllocation();
    /// @notice Thrown when there is no commitment for the period being settled/recommitted.
    error NoCommitForPeriod();
    /// @notice Thrown when the supplied Merkle proof does not verify against the commitment root.
    error InvalidProof();
    /// @notice Thrown when recommitting after settlement of the period has already started.
    error SettlementsAlreadyStarted();
    /// @notice Thrown when settling before the commitment's grace period has elapsed.
    /// @param expiresAt Timestamp at which settlement becomes allowed.
    error GracePeriodActive(uint48 expiresAt);
    /// @notice Thrown when settling outside the order's settlement window (period advanced).
    error SettleWindowExpired();
    /// @notice Thrown when cancelling a non-expired order via the permissionless path.
    error OrderNotExpired();
    /// @notice Thrown when an order/orderId is otherwise invalid for the operation.
    error InvalidOrder();

    // -- admin / configuration --
    /// @notice Thrown when a required address argument is the zero address.
    error InvalidZeroAddress();
    /// @notice Thrown when the configured leverage is zero.
    error InvalidLeverage();
    /// @notice Thrown when the configured minimum CAR is outside the supported 1.2x to 5x range.
    error InvalidMinCAR();
    /// @notice Thrown when the configured maximum price age is zero.
    error InvalidMaxPriceAge();
    /// @notice Thrown when the price feed adapter decimals are outside [6, 18].
    /// @param decimals Reported adapter decimals.
    error InvalidPriceFeedDecimals(uint8 decimals);
    /// @notice Thrown when a concentration input is invalid (zero chainId/protocol or bps > 100%).
    error InvalidProtocolConcentration();
    /// @notice Thrown when the configured minimum order-market cover amount is zero.
    error InvalidMinOrderMarketCoverAmount();
    /// @notice Thrown when the configured divergence tolerance exceeds the hard ceiling.
    /// @param bps Provided tolerance, in bps.
    error InvalidDivergenceTolerance(uint16 bps);
    /// @notice Thrown when referencing a premium token that is not whitelisted.
    error UnsupportedPremiumToken();
    /// @notice Thrown when a token reports decimals greater than the canonical 18.
    /// @param decimals Reported token decimals.
    error UnsupportedDecimals(uint8 decimals);
    /// @notice Thrown when adding a premium token that is already whitelisted.
    error PremiumTokenAlreadySupported();
    /// @notice Reserved: thrown when an action is blocked because matching is in progress.
    error MatchingInProgress();
    /// @notice Reserved: thrown when a period duration is invalid.
    error InvalidPeriodDuration();

    // =========================================================================
    // Write functions
    // =========================================================================

    /// @notice Creates a cover order for the next period. Only CURATOR_ROLE.
    /// @param buyer Account that will pay the premium.
    /// @param payoutRecipient Account that receives the payout if a covered incident occurs.
    /// @param beneficiaryAddress Off-chain beneficiary reference stored with the order.
    /// @param premiumToken Whitelisted ERC20 used to pay the premium.
    /// @param markets Per-market cover requests; `coverAmount` pre-normalized to canonical decimals.
    /// @param orderType NEW or RENEWAL.
    /// @return coverOrderId Id assigned to the new order.
    function createCoverOrder(
        address buyer,
        address payoutRecipient,
        string calldata beneficiaryAddress,
        address premiumToken,
        MarketAllocationInput[] calldata markets,
        CoverOrderType orderType
    ) external returns (uint256 coverOrderId);

    /// @notice Commits a Merkle root with matching results. Only ALLOCATOR_ROLE.
    /// @dev The vault asset price is read from the registered `priceFeedAdapter` oracle.
    /// @param commitmentPeriod The period the caller intends to match. Must equal
    ///        `vault.currentPeriod()` at execution time, otherwise the call reverts.
    /// @param merkleRoot Root of the StandardMerkleTree containing settlement leaves.
    ///        Each leaf encodes `(orderId, MarketCoverAllocation[])` with
    ///        `allocatedCover` in canonical USD.
    /// @param totalAllocated Sum of all allocated cover across all orders in the tree,
    ///        in canonical USD.
    function commitAllocation(uint256 commitmentPeriod, bytes32 merkleRoot, uint256 totalAllocated) external;

    /// @notice Settles a single order against the committed Merkle root. Only ALLOCATOR_ROLE.
    /// @dev The premium is computed on-chain, pro-rata per market from the order's stored
    ///      rates and the vault's period duration — never taken from the caller or the leaf.
    /// @param orderId Order to settle.
    /// @param marketCoverAllocations Per-market allocated cover, in canonical USD;
    ///        order and market ids must match the order's markets.
    /// @param proof Merkle proof of the leaf for this order against the period commitment root.
    function settleCoverOrder(
        uint256 orderId,
        MarketCoverAllocation[] calldata marketCoverAllocations,
        bytes32[] calldata proof
    ) external;

    /// @notice Settles multiple orders in a single transaction. Only ALLOCATOR_ROLE.
    /// @param params Per-order settle parameters (orderId, allocations, proof).
    function batchSettleCoverOrder(SettleParams[] calldata params) external;

    /// @notice Cancels a pending cover order. Only CURATOR_ROLE.
    /// @param coverOrderId Order to cancel; must still be PENDING.
    function cancelCoverOrder(uint256 coverOrderId) external;

    /// @notice Permissionlessly cancels PENDING orders whose cover period has already elapsed.
    /// @dev Once `currentPeriod() > order.period` the settle window has closed and the order can
    ///      never be settled; anyone may clean up the dangling PENDING state in batch.
    /// @param coverOrderIds Ids of expired PENDING orders to cancel.
    function cancelExpiredOrders(uint256[] calldata coverOrderIds) external;

    /// @notice Replaces a committed Merkle root if no orders have been settled yet. Only CONFIG_ADMIN_ROLE.
    /// @dev Restricted to the current period; recomputes capacity from live inputs so the new
    ///      declared allocation is bound to the period's real collateral within tolerance.
    /// @param period Period whose commitment is replaced; must equal the current vault period.
    /// @param newMerkleRoot New StandardMerkleTree root of settlement leaves.
    /// @param newTotalAllocated New declared sum of allocated cover, in canonical USD.
    function recommitAllocation(uint256 period, bytes32 newMerkleRoot, uint256 newTotalAllocated) external;

    /// @notice Cancels a period's commitment if no orders have been settled yet. Only CONFIG_ADMIN_ROLE.
    /// @dev Emergency path to withdraw a bad Merkle root without providing a replacement and
    ///      without touching the price feed (unlike `recommitAllocation`, it works while the
    ///      oracle is down or stale). After cancelling, `commitAllocation` can be called again
    ///      for the period; if no new commit lands, pending orders expire unsettled and can be
    ///      cleaned up via `cancelExpiredOrders`.
    /// @param period Period whose commitment is cancelled; must equal the current vault period.
    function cancelCommitAllocation(uint256 period) external;

    // =========================================================================
    // Admin functions
    // =========================================================================

    /// @notice Sets the address that receives collected premiums. Only ADMIN_ROLE.
    /// @param newCollector New premium collector; must be non-zero.
    function setPremiumCollector(address newCollector) external;

    /// @notice Whitelists a premium token and caches its decimals. Only CONFIG_ADMIN_ROLE.
    /// @param token ERC20 to whitelist; must report `decimals() <= CANONICAL_DECIMALS`.
    function addSupportedPremiumToken(address token) external;

    /// @notice Removes a premium token from the whitelist. Only CONFIG_ADMIN_ROLE.
    /// @param token ERC20 to remove.
    function removeSupportedPremiumToken(address token) external;

    /// @notice Pushes a new capacity configuration checkpoint. Only CONFIG_ADMIN_ROLE.
    /// @dev Effective at currentPeriod() + 1 (or period 0 for the first configuration).
    /// @param config New capacity configuration.
    function setCapacityConfig(CapacityConfig calldata config) external;

    /// @notice Replaces the vault-asset USD price feed adapter. Only ADMIN_ROLE.
    /// @param newPriceFeedAdapter New adapter; must report decimals in [6, 18].
    function setPriceFeedAdapter(IAggregatorV3 newPriceFeedAdapter) external;

    /// @notice Sets the maximum tolerated price age. Only ADMIN_ROLE.
    /// @param newMaxPriceAge New max age in seconds; must be non-zero.
    function setMaxPriceAge(uint48 newMaxPriceAge) external;

    /// @notice Minimum delay between `commitAllocation`/`recommitAllocation` and `settleCoverOrder`.
    ///         Gives operators a grace window to swap a bad merkle root via
    ///         `recommitAllocation` before any settle finalizes. Defaults to 0 (disabled).
    function setSettlementGracePeriod(uint48 newGracePeriod) external;

    /// @notice Registers a new market. Only CONFIG_ADMIN_ROLE.
    /// @param newMarket Market to register (chainId, protocol, market).
    /// @return marketId Derived id of the registered market.
    function addSupportedMarket(Market calldata newMarket) external returns (bytes32 marketId);

    /// @notice Sets the maxProtocolConcentrationBps cap for a protocolConcentration group derived from (protocol, chainId).
    /// @dev Affects ALL markets sharing the same (protocol, chainId). Effective from currentPeriod() + 1.
    /// @param protocolConcentration Group key (chainId, protocol) and its new cap in bps.
    function setProtocolConcentration(ProtocolConcentrationInput calldata protocolConcentration) external;

    /// @notice Batch variant of {setProtocolConcentration}. Only CONFIG_ADMIN_ROLE.
    /// @param protocolConcentrations Concentration inputs to apply.
    function batchSetProtocolConcentration(ProtocolConcentrationInput[] calldata protocolConcentrations) external;

    // =========================================================================
    // View functions — all data needed for off-chain matching
    // =========================================================================

    /// @notice The internal canonical decimals used for all on-chain monetary values.
    function CANONICAL_DECIMALS() external view returns (uint8);

    /// @notice Returns the vault contract (use to call currentPeriod(), totalAssets(), periodConfigurationAtNumber()).
    function vault() external view returns (IFirelightVault);

    /// @notice Address receiving premium payments.
    function premiumCollector() external view returns (address);

    /// @notice The CoverNFT contract minted on settle (immutable, set in constructor).
    function coverNFT() external view returns (CoverNFT);

    /// @notice Chainlink-compatible oracle queried to price the vault asset against USD.
    function priceFeedAdapter() external view returns (IAggregatorV3);

    /// @notice Max age (seconds) tolerated on `priceFeedAdapter.latestRoundData().updatedAt`.
    function maxPriceAge() external view returns (uint48);

    /// @notice Grace period (seconds) enforced between commit and settlement.
    function settlementGracePeriod() external view returns (uint48);

    /// @notice Cached `decimals()` of the registered `priceFeedAdapter`.
    function priceFeedDecimals() external view returns (uint8);

    /// @notice Next orderId that will be assigned.
    function nextCoverOrderId() external view returns (uint256);

    /// @notice Full order struct for a given orderId.
    function getCoverOrder(uint256 coverOrderId) external view returns (CoverOrder memory);

    /// @notice Per-market allocations for an order (marketId, coverRateAnnual, coverAmount).
    ///         `coverAmount` and `allocatedCoverAmount` are in canonical USD.
    function getCoverOrderMarkets(uint256 coverOrderId) external view returns (MarketAllocation[] memory);

    /// @notice Period, allocated cover, and payoutRecipient for a given (orderId, marketId) pair.
    /// @return period Period the order belongs to. Zero when not found.
    /// @return allocatedCoverAmount Amount allocated to that market on settle, in canonical
    ///         USD. Zero when not found.
    /// @return payoutRecipient EVM address that will receive the payout for this cover if a
    ///         covered incident occurs. `address(0)` means the pair was not found.
    function getCoverOrderMarketInfo(
        uint256 coverOrderId,
        bytes32 marketId
    ) external view returns (uint256 period, uint256 allocatedCoverAmount, address payoutRecipient);

    /// @notice All orderIds created for a given period.
    function getCoverOrdersIdByPeriod(uint256 period) external view returns (uint256[] memory);

    /// @notice Market configuration by marketId.
    function getSupportedMarket(bytes32 marketId) external view returns (Market memory);

    /// @notice All registered marketIds (including markets whose protocolConcentration cap is 0).
    function getSupportedMarketIds() external view returns (bytes32[] memory);

    /// @notice Whether a premium token is whitelisted.
    function isPremiumTokenSupported(address token) external view returns (bool);

    /// @notice All currently whitelisted premium tokens.
    /// @return The set of supported premium token addresses.
    function getSupportedPremiumTokens() external view returns (address[] memory);

    /// @notice Current capacity configuration.
    function getEffectiveCapacityConfig() external view returns (CapacityConfig memory);

    /// @notice get active capacity config at a given period
    function getCapacityConfigAt(uint256 period) external view returns (CapacityConfig memory);

    /// @notice Committed matching data for a given period.
    function getAllocationCommitment(uint256 period) external view returns (AllocationCommitment memory);

    /// @notice All protocolConcentration hashes ever registered via setProtocolConcentration / initialize.
    ///         May include entries currently set to 0 bps (disabled).
    function getSupportedProtocolConcentrationHashes() external view returns (bytes32[] memory);

    /// @notice Returns the (protocol, chainId) tuple that originated the protocolConcentration hash.
    function getProtocolConcentrationFromHash(
        bytes32 protocolConcentrationHash
    ) external view returns (ProtocolConcentration memory);

    /// @notice ProtocolConcentration cap (bps) effective at currentPeriod() + 1.
    function getEffectiveProtocolConcentration(bytes32 protocolConcentrationHash) external view returns (uint256);

    /// @notice ProtocolConcentration cap (bps) active at the given `period`. Reads from the
    ///         checkpoint history — useful for auditing past settlements.
    function getProtocolConcentrationAt(
        bytes32 protocolConcentrationHash,
        uint256 period
    ) external view returns (uint256);

    /// @notice Cumulative settled cover for a specific protocolConcentration group in a given period.
    function getProtocolConcentrationSettledCover(
        uint256 period,
        bytes32 protocolConcentrationHash
    ) external view returns (uint256);
}
