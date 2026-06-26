// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRules} from
    "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IFlareContractRegistry} from
    "flare-smart-contracts/contracts/userInterfaces/IFlareContractRegistry.sol";

import {IAggregatorV3} from "../core/interfaces/IAggregatorV3.sol";

/**
 * @title  IFtsoV2View
 * @notice View-shaped slice of FTSO v2's `getFeedByIdInWei`.
 *
 *         The upstream `FtsoV2Interface` declares the function `payable`. We
 *         redeclare the same selector here as `view` so the Solidity
 *         compiler emits a `STATICCALL` instead of a `CALL`. While the
 *         wrapped feed carries a zero fee — FTSO v2's default today — the
 *         call is state-neutral and the `STATICCALL` succeeds, letting this
 *         contract serve a fully-`view` Chainlink read surface.
 */
interface IFtsoV2View {
    function getFeedByIdInWei(bytes21 _feedId)
        external
        view
        returns (uint256 _value, uint64 _timestamp);
}

/**
 * @title  FtsoChainlinkAdapter
 * @notice Chainlink `AggregatorV3`-shaped, fully-`view` aggregator backed
 *         by Flare FTSO v2.
 *
 *         **Read-surface semantics**
 *
 *         Every read pulls live from FTSO over a `STATICCALL` — no keeper,
 *         no cached round, no storage writes on the hot path. Consumers
 *         that only call `latestRoundData()` (the vast majority of
 *         Chainlink integrations) plug in unchanged.
 *
 *         - `decimals() == 18` — `getFeedByIdInWei` returns 1e18-scaled
 *           values, so `int256 answer` is the 1e18-wei price.
 *         - `roundId` is the FTSO publication timestamp cast to `uint80`.
 *           Within a single publication window every read returns the
 *           same round id; across a feed rotation, monotonicity is *not*
 *           guaranteed. Consumers that rely on monotone round ids must
 *           guard themselves.
 *         - `getRoundData(roundId)` reverts `NotImplemented()` — only the
 *           currently-published round exists on-chain. For verified
 *           history, use the source FTSO + a Merkle proof.
 *         - `answer == 0` is passed through unchanged. Downstream
 *           consumers must check freshness (`updatedAt`) and zero-value
 *           handling per their own policy.
 *
 *         **Zero-fee feeds only.** This contract only works while FTSO's
 *         `getFeedByIdInWei` is callable without paying a fee. When Flare
 *         turns fees on for the wrapped pair, reads start reverting and
 *         operators must migrate consumers to a fee-aware variant.
 *
 *         **Governance — role-based, no timelock**
 *
 *         Two roles, both managed via {AccessControlDefaultAdminRules}:
 *
 *         - `DEFAULT_ADMIN_ROLE` — single-holder meta-role. The only role
 *           that may grant or revoke `FEED_ADMIN_ROLE`. Transferring the
 *           admin role is itself two-step and delayed (the {ACDAR} guarantee),
 *           which removes the "instant admin takeover" failure mode that
 *           plain {AccessControl} carries.
 *         - `FEED_ADMIN_ROLE` — gates {setFeedConfig}, the single mutating
 *           administrative function. Holders may rotate the feed
 *           atomically with its description.
 *
 *         **Compromise model**
 *
 *         By design, this contract has no execution delay. A stolen
 *         `FEED_ADMIN_ROLE` key can rotate the feed in a single transaction
 *         — accept this risk explicitly by holding the role on a
 *         multisig. The admin's remediation is to call `revokeRole` on
 *         the compromised holder; ACDAR's delay on the admin role itself
 *         prevents an attacker from locking the legitimate admin out.
 *
 *         If you want execution delays as well, deploy this adapter
 *         downstream of an {OpenZeppelin TimelockController} that holds
 *         `FEED_ADMIN_ROLE`.
 */
contract FtsoChainlinkAdapter is AccessControlDefaultAdminRules, IAggregatorV3 {
    // ------------------------------------------------------------------
    // Roles
    // ------------------------------------------------------------------

    /// @notice Holder may rotate the feed id + description via
    ///         {setFeedConfig}. Granted and revoked by `DEFAULT_ADMIN_ROLE`.
    bytes32 public constant FEED_ADMIN_ROLE = keccak256("FEED_ADMIN_ROLE");

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error FeedIdEmpty();
    error FeedIdUnchanged();
    error FeedValueExceedsInt256(uint256 value);
    error NotImplemented();

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event FeedConfigUpdated(
        bytes21 indexed oldFeedId,
        bytes21 indexed newFeedId,
        string oldDescription,
        string newDescription
    );

    // ------------------------------------------------------------------
    // Constants — Chainlink conventions
    // ------------------------------------------------------------------

    uint256 public constant override version = 1;
    uint8 public constant override decimals = 18;

    /// @notice Canonical `FlareContractRegistry`, identical address on every
    ///         Flare-family network (Flare, Songbird, Coston, Coston2).
    IFlareContractRegistry public constant REGISTRY =
        IFlareContractRegistry(0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019);

    // ------------------------------------------------------------------
    // Storage
    // ------------------------------------------------------------------

    /// @notice FTSO feed id this aggregator wraps.
    bytes21 public feedId;

    /// @notice Aggregator description (e.g. `"XRP / USD"`). Rotated
    ///         atomically with {feedId} via {setFeedConfig}.
    string public override description;

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /**
     * @param admin              Initial `DEFAULT_ADMIN_ROLE` holder
     *                           (multisig / governance). Must be non-zero.
     * @param adminTransferDelay Cooldown enforced on
     *                           `DEFAULT_ADMIN_ROLE` transfers (see
     *                           {AccessControlDefaultAdminRules}). Three
     *                           days is a sensible default — long enough
     *                           to react to a hostile transfer, short
     *                           enough to recover from operational
     *                           mistakes.
     * @param feedAdmin          Initial `FEED_ADMIN_ROLE` holder
     *                           (multisig / hot wallet that may rotate
     *                           the feed).
     * @param initialFeedId      FTSO v2 feed id to wrap.
     * @param initialDescription Human-readable description, Chainlink-style.
     */
    constructor(
        address admin,
        uint48 adminTransferDelay,
        address feedAdmin,
        bytes21 initialFeedId,
        string memory initialDescription
    ) AccessControlDefaultAdminRules(adminTransferDelay, admin) {
        // Skip the grant when `feedAdmin == 0` so deployers can spin up a
        // role-frozen adapter and have the admin appoint a holder later.
        // Avoids the AccessControl footgun of `hasRole(role, address(0)) == true`.
        if (feedAdmin != address(0)) _grantRole(FEED_ADMIN_ROLE, feedAdmin);
        _setFeedId(initialFeedId, initialDescription);
    }

    // ------------------------------------------------------------------
    // Admin — atomic feed rotation
    // ------------------------------------------------------------------

    /**
     * @notice Rotate the FTSO feed id and the human-readable description
     *         atomically. Callable only by `FEED_ADMIN_ROLE`.
     */
    function setFeedConfig(bytes21 newFeedId, string calldata newDescription)
        external
        onlyRole(FEED_ADMIN_ROLE)
    {
        _setFeedId(newFeedId, newDescription);
    }

    /// @dev Shared write path for both the constructor and {setFeedConfig}.
    ///      Validates `newFeedId`, persists the pair, and emits the event.
    ///      Reads the previous values straight from storage so the
    ///      constructor naturally emits the `(0, "")` baseline.
    function _setFeedId(bytes21 newFeedId, string memory newDescription) internal {
        if (newFeedId == bytes21(0)) revert FeedIdEmpty();
        if (newFeedId == feedId) revert FeedIdUnchanged();

        bytes21 oldFeedId = feedId;
        string memory oldDescription = description;

        feedId = newFeedId;
        description = newDescription;

        emit FeedConfigUpdated(oldFeedId, newFeedId, oldDescription, newDescription);
    }

    // ------------------------------------------------------------------
    // IAggregatorV3 — read surface
    // ------------------------------------------------------------------

    /// @inheritdoc IAggregatorV3
    /// @dev Historical lookup is not supported — only the currently
    ///      published round exists on-chain. Mutability is narrowed to
    ///      `pure` (a permitted Solidity override).
    function getRoundData(uint80)
        external
        pure
        override
        returns (uint80, int256, uint256, uint256, uint80)
    {
        revert NotImplemented();
    }

    /// @inheritdoc IAggregatorV3
    function latestRoundData()
        external
        view
        override
        returns (
            uint80 roundId,
            int256 answer,
            uint256 startedAt,
            uint256 updatedAt,
            uint80 answeredInRound
        )
    {
        (uint256 priceWei, uint64 ftsoTs) = _ftsoV2View().getFeedByIdInWei(feedId);
        if (priceWei > uint256(type(int256).max)) revert FeedValueExceedsInt256(priceWei);

        roundId = uint80(ftsoTs);
        answer = int256(priceWei); // safe: bounded by the check immediately above.
        startedAt = uint256(ftsoTs);
        updatedAt = uint256(ftsoTs);
        answeredInRound = roundId;
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    function _ftsoV2View() internal view returns (IFtsoV2View) {
        return IFtsoV2View(REGISTRY.getContractAddressByName("FtsoV2"));
    }
}
