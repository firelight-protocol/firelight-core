// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {ICoverOrderAllocator} from "./ICoverOrderAllocator.sol";
import {IFirelightVault} from "./IFirelightVault.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";

interface IIncidentManager {
    /// @notice Lifecycle status of an incident.
    enum IncidentStatus {
        /// @notice Sentinel value for a non-existent incident.
        NONE,
        /// @notice Incident was created but has not been confirmed.
        OPEN,
        /// @notice Incident was confirmed and can enter assessment.
        CONFIRMED,
        /// @notice Incident has an active assessment round.
        UNDER_EVALUATION,
        /// @notice Incident was approved, paid, and closed.
        CLOSED,
        /// @notice Incident was canceled before payout.
        CANCELED,
        /// @notice Incident payout window has passed without closure; virtual status not written to storage.
        EXPIRED
    }

    /// @notice Lifecycle status of an incident assessment round.
    enum AssessmentRoundStatus {
        /// @notice Sentinel value for a non-existent assessment round.
        NONE,
        /// @notice Round is being assembled and can receive additional losses.
        DRAFT,
        /// @notice Round was submitted for approval or rejection.
        UNDER_EVALUATION,
        /// @notice Round was approved and used for payout execution.
        APPROVED,
        /// @notice Round was rejected; a new round may be created for the incident.
        REJECTED,
        /// @notice Round was canceled before approval.
        CANCELED
    }

    /// @notice Incident record.
    struct Incident {
        /// @notice Short human-readable incident title.
        string title;
        /// @notice External report URI for the incident.
        string reportURI;
        /// @notice Vault period affected by the incident.
        uint256 period;
        /// @notice Curator-provided duplicate-prevention reference.
        bytes32 incidentRef;
        /// @notice Latest assessment round id for the incident.
        uint256 currentAssessmentRoundId;
        /// @notice Amount actually paid by the vault for the approved assessment, in vault asset units.
        uint256 vaultPaidAmount;
        /// @notice Incident capture timestamp used to determine the affected vault period and payout window.
        uint48 captureTimestamp;
        /// @notice Current incident status.
        IncidentStatus status;
        /// @notice Reason recorded when the incident is canceled.
        string cancelReason;
    }

    /// @notice Aggregate state for one assessment round.
    struct AssessmentRound {
        /// @notice Total assessed loss in CoverOrderAllocator canonical decimals.
        uint256 totalAssessmentLoss;
        /// @notice Current assessment round status.
        AssessmentRoundStatus status;
    }

    /// @notice Loss attributed to one settled cover allocation and market.
    struct AssessmentLoss {
        /// @notice Cover NFT token id identifying the settled cover order.
        uint256 coverTokenId;
        /// @notice Market id within the settled cover order.
        bytes32 marketId;
        /// @notice Assessed loss amount in CoverOrderAllocator canonical decimals.
        uint256 amount;
    }

    /**
     * @notice Emitted when an incident is created. OPEN is its initial status.
     * @param incidentId New incident id.
     * @param period Vault period affected by the incident.
     * @param incidentRef Curator-provided duplicate-prevention reference.
     * @param captureTimestamp Incident capture timestamp.
     * @param title Short human-readable incident title.
     */
    event IncidentCreated(
        uint256 indexed incidentId,
        uint256 indexed period,
        bytes32 incidentRef,
        uint48 captureTimestamp,
        string title
    );

    /**
     * @notice Emitted when an incident moves from OPEN to CONFIRMED.
     * @param incidentId Confirmed incident id.
     */
    event IncidentConfirmed(uint256 indexed incidentId);

    /**
     * @notice Emitted when an incident moves from CONFIRMED to UNDER_EVALUATION.
     * @param incidentId Incident id that entered assessment.
     */
    event IncidentUnderEvaluation(uint256 indexed incidentId);

    /**
     * @notice Emitted when an incident moves from UNDER_EVALUATION to CLOSED after payout execution.
     * @param incidentId Closed incident id.
     * @param vaultPaidAmount Amount actually paid by the vault, in vault asset units.
     * @param totalAssessmentLoss Total approved assessment loss in CoverOrderAllocator canonical decimals.
     */
    event IncidentClosed(uint256 indexed incidentId, uint256 vaultPaidAmount, uint256 totalAssessmentLoss);

    /**
     * @notice Emitted when an incident is canceled before assessment begins.
     * The incident moves from OPEN or CONFIRMED to CANCELED.
     * @param incidentId Canceled incident id.
     * @param cancelReason Cancellation reason.
     */
    event IncidentCanceledPreAssessment(uint256 indexed incidentId, string cancelReason);

    /**
     * @notice Emitted when an incident is invalidated after assessment begins.
     * The incident moves from UNDER_EVALUATION to CANCELED.
     * @param incidentId Invalidated incident id.
     * @param cancelReason Cancellation reason.
     */
    event IncidentInvalidated(uint256 indexed incidentId, string cancelReason);

    /**
     * @notice Emitted when a new assessment round is opened. DRAFT is its initial status.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId New assessment round id.
     */
    event AssessmentRoundOpened(uint256 indexed incidentId, uint256 indexed assessmentRoundId);

    /**
     * @notice Emitted when assessment losses are appended to a DRAFT assessment round.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Assessment round id receiving the losses.
     * @param count Number of assessment losses added.
     * @param addedAssessmentLossAmount Sum of losses added in this call, in CoverOrderAllocator canonical decimals.
     */
    event AssessmentLossesAdded(
        uint256 indexed incidentId,
        uint256 indexed assessmentRoundId,
        uint256 count,
        uint256 addedAssessmentLossAmount
    );

    /**
     * @notice Emitted when an assessment round moves from DRAFT to UNDER_EVALUATION.
     * The round is ready for approval or rejection and can no longer receive losses.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Submitted assessment round id.
     * @param totalAssessmentLoss Total submitted assessment loss in CoverOrderAllocator canonical decimals.
     */
    event AssessmentRoundSubmitted(
        uint256 indexed incidentId,
        uint256 indexed assessmentRoundId,
        uint256 totalAssessmentLoss
    );

    /**
     * @notice Emitted when an assessment round moves from UNDER_EVALUATION to APPROVED.
     * Approval triggers payout execution and closes the incident.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Approved assessment round id.
     * @param totalAssessmentLoss Total approved assessment loss in CoverOrderAllocator canonical decimals.
     */
    event AssessmentRoundApproved(
        uint256 indexed incidentId,
        uint256 indexed assessmentRoundId,
        uint256 totalAssessmentLoss
    );

    /**
     * @notice Emitted when an assessment round moves from UNDER_EVALUATION to REJECTED.
     * The incident remains UNDER_EVALUATION and a new assessment round may be opened.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Rejected assessment round id.
     */
    event AssessmentRoundRejected(uint256 indexed incidentId, uint256 indexed assessmentRoundId);

    /**
     * @notice Emitted when an assessment round moves from DRAFT or UNDER_EVALUATION to CANCELED.
     * The incident remains UNDER_EVALUATION unless the incident itself is also canceled.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Canceled assessment round id.
     */
    event AssessmentRoundCanceled(uint256 indexed incidentId, uint256 indexed assessmentRoundId);

    /**
     * @notice Emitted after an approved assessment payout is executed and the incident moves to CLOSED.
     * Payouts are sent to the configured payout receiver. Any per-recipient
     * distribution is handled off-chain.
     * @param incidentId Incident id paid.
     * @param assessmentRoundId Approved assessment round id.
     * @param incidentPeriod Vault period affected by the incident.
     * @param executionPeriod Vault period when payout execution occurred.
     * @param payoutReceiver Address receiving first-loss-buffer and vault payouts.
     * @param firstLossBufferPayer Address funding the first-loss-buffer payment.
     * @param firstLossBufferToken Token used for the first-loss-buffer payment.
     * @param firstLossTokenAmount Amount paid from the first-loss-buffer token.
     * @param totalAssessmentLoss Total approved assessment loss in CoverOrderAllocator canonical decimals.
     * @param vaultRequestedAmount Vault asset amount requested from the vault after first-loss-buffer payment.
     * @param vaultPaidAmount Vault asset amount actually paid by the vault.
     */
    event IncidentPayoutExecuted(
        uint256 indexed incidentId,
        uint256 indexed assessmentRoundId,
        uint256 indexed incidentPeriod,
        uint256 executionPeriod,
        address payoutReceiver,
        address firstLossBufferPayer,
        address firstLossBufferToken,
        uint256 firstLossTokenAmount,
        uint256 totalAssessmentLoss,
        uint256 vaultRequestedAmount,
        uint256 vaultPaidAmount
    );

    /**
     * @notice Emitted when the price feed adapter is updated.
     * @param oldPriceFeedAdapter Previous price feed adapter address.
     * @param oldPriceFeedDecimals Previous price feed decimals.
     * @param newPriceFeedAdapter New price feed adapter address.
     * @param newPriceFeedDecimals New price feed decimals.
     */
    event PriceFeedAdapterUpdated(
        address oldPriceFeedAdapter,
        uint8 oldPriceFeedDecimals,
        address newPriceFeedAdapter,
        uint8 newPriceFeedDecimals
    );

    /**
     * @notice Emitted when the maximum accepted price age is updated.
     * @param oldMaxPriceAge Previous maximum price age, in seconds.
     * @param newMaxPriceAge New maximum price age, in seconds.
     */
    event MaxPriceAgeUpdated(uint48 oldMaxPriceAge, uint48 newMaxPriceAge);

    /**
     * @notice Emitted when the receiver for incident payouts is updated.
     * @param oldReceiver Previous payout receiver.
     * @param newReceiver New payout receiver.
     */
    event PayoutReceiverUpdated(address oldReceiver, address newReceiver);

    /**
     * @notice Emitted when an incident report URI is updated.
     * @param incidentId Incident id whose report URI was updated.
     * @param oldReportURI Previous report URI.
     * @param newReportURI New report URI.
     */
    event IncidentReportURIUpdated(uint256 indexed incidentId, string oldReportURI, string newReportURI);

    /// @notice Reverts when an incident title is empty.
    error InvalidIncidentTitle();

    /// @notice Reverts when an incident title exceeds the configured maximum length.
    error IncidentTitleTooLong();

    /// @notice Reverts when an incident reference is zero.
    error InvalidIncidentRef();

    /**
     * @notice Reverts when the vault resolves the capture timestamp to a period outside the
     * payout window, or when the capture timestamp is later than the current block timestamp.
     * @param captureTimestamp Incident capture timestamp.
     * @param capturePeriod Vault period derived from the capture timestamp.
     * @param currentPeriod Current vault period.
     */
    error InvalidCaptureTimestamp(uint48 captureTimestamp, uint256 capturePeriod, uint256 currentPeriod);

    /**
     * @notice Reverts when an incident reference was already used.
     * @param incidentRef Duplicate incident reference.
     * @param existingIncidentId Incident id already using the reference.
     */
    error IncidentReferenceAlreadyExists(bytes32 incidentRef, uint256 existingIncidentId);

    /**
     * @notice Reverts when another incident already uses the same capture timestamp in the same vault period.
     * Capture timestamps must be unique because incident approvals are ordered by timestamp.
     * @param period Vault period containing the duplicate timestamp.
     * @param captureTimestamp Duplicate incident capture timestamp.
     * @param existingIncidentId Incident id already using the timestamp.
     */
    error IncidentTimestampAlreadyExists(uint256 period, uint48 captureTimestamp, uint256 existingIncidentId);

    /**
     * @notice Reverts when an incident id does not exist.
     * @param incidentId Missing incident id.
     */
    error IncidentNotFound(uint256 incidentId);

    /**
     * @notice Reverts when an incident is not in the required status for the operation.
     * @param incidentId Incident id with the invalid status.
     * @param currentStatus Current incident status.
     */
    error InvalidIncidentStatus(uint256 incidentId, IncidentStatus currentStatus);

    /**
     * @notice Reverts when an incident's payout window has expired. Blocks every state
     * transition on the incident, including confirmation, assessment, all three
     * cancellation paths, and report URI updates.
     * @param incidentId Expired incident id.
     * @param incidentPeriod Vault period affected by the incident.
     */
    error IncidentPayoutWindowExpired(uint256 incidentId, uint256 incidentPeriod);

    /**
     * @notice Reverts when a cancellation reason exceeds the maximum length.
     * @param cancelReasonLength Cancellation reason length.
     * @param maxLength Maximum allowed cancellation reason length.
     */
    error CancelReasonTooLong(uint256 cancelReasonLength, uint256 maxLength);

    /**
     * @notice Reverts when an assessment round is not in the required status for the operation.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Assessment round id with the invalid status.
     * @param currentStatus Current assessment round status.
     */
    error InvalidAssessmentRoundStatus(
        uint256 incidentId,
        uint256 assessmentRoundId,
        AssessmentRoundStatus currentStatus
    );

    /// @notice Reverts when an assessment loss payload is empty.
    error InvalidAssessmentLosses();

    /**
     * @notice Reverts when a cover-market loss already exists in the current assessment round.
     * @param index Index of the duplicate loss in the submitted assessment loss payload.
     */
    error AssessmentLossAlreadyExists(uint256 index);

    /**
     * @notice Reverts when an assessed loss exceeds the allocated cover for the cover-market.
     * @param coverTokenId Cover NFT token id identifying the settled cover order.
     * @param marketId Market id within the settled cover order.
     * @param allocatedCoverAmount Allocated cover amount for the cover-market.
     * @param assessmentLossAmount Submitted assessment loss amount.
     */
    error AssessmentLossAmountTooBig(
        uint256 coverTokenId,
        bytes32 marketId,
        uint256 allocatedCoverAmount,
        uint256 assessmentLossAmount
    );

    /**
     * @notice Reverts when an assessment loss amount is zero.
     * @param coverTokenId Cover NFT token id identifying the settled cover order.
     * @param marketId Market id within the settled cover order.
     */
    error AssessmentLossZeroAmount(uint256 coverTokenId, bytes32 marketId);

    /**
     * @notice Reverts when the submitted loss does not match a settled cover-market allocation in CoverOrderAllocator.
     * @param coverTokenId Cover NFT token id identifying the settled cover order.
     * @param marketId Market id within the settled cover order.
     */
    error OrderNotFound(uint256 coverTokenId, bytes32 marketId);

    /**
     * @notice Reverts when a cover-market allocation period does not match the incident period.
     * @param coverTokenId Cover NFT token id identifying the settled cover order.
     * @param orderPeriod Vault period of the cover-market allocation.
     * @param incidentPeriod Vault period affected by the incident.
     */
    error InvalidOrderPeriod(uint256 coverTokenId, uint256 orderPeriod, uint256 incidentPeriod);

    /**
     * @notice Reverts when an incident is approved before an earlier payable incident.
     * Incident approvals follow FIFO ordering by capture timestamp.
     * @param incidentId Incident id submitted for approval.
     * @param expectedIncidentId Earliest incident id that must be resolved first.
     */
    error IncidentApprovalOutOfOrder(uint256 incidentId, uint256 expectedIncidentId);

    /**
     * @notice Reverts when an approved loss rounds to zero for both payout sources.
     * @param remainderAmount Remaining approved loss after first-loss-buffer payment.
     * @param totalAssessmentLoss Total approved assessment loss in CoverOrderAllocator canonical decimals.
     */
    error PayoutRoundsToZero(uint256 remainderAmount, uint256 totalAssessmentLoss);

    /// @notice Reverts when a required address argument is zero.
    error InvalidZeroAddress();

    /// @notice Reverts when an incident report URI is empty.
    error InvalidIncidentReportURI();

    /**
     * @notice Reverts when an incident report URI cannot be updated in the current incident status.
     * @param incidentId Incident id whose report URI update was rejected.
     * @param status Current incident status.
     */
    error ReportURIUpdateNotAllowed(uint256 incidentId, IncidentStatus status);

    /// @notice Reverts when the maximum accepted price age is zero.
    error InvalidMaxPriceAge();

    /**
     * @notice Reverts when a price feed uses unsupported decimals.
     * @param decimals Price feed decimals.
     */
    error InvalidPriceFeedDecimals(uint8 decimals);

    /**
     * @notice Reverts when the specified assessment round is not the incident's current assessment round.
     * @param incidentId Incident id associated with the assessment round.
     * @param assessmentRoundId Assessment round id supplied by the caller.
     * @param currentAssessmentRoundId Incident's current assessment round id.
     */
    error InvalidAssessmentRoundId(uint256 incidentId, uint256 assessmentRoundId, uint256 currentAssessmentRoundId);

    /**
     * @notice Creates an incident in OPEN status.
     * The vault determines the affected period from `captureTimestamp`.
     * `captureTimestamp` is a Unix timestamp in seconds. If multiple incidents occur at the same second within one
     * period, curators must provide distinct timestamps because approvals follow timestamp FIFO order.
     * @param captureTimestamp Incident capture timestamp.
     * @param title Short human-readable incident title.
     * @param incidentRef Curator-provided duplicate-prevention reference.
     * @return incidentId New incident id.
     */
    function createIncident(
        uint48 captureTimestamp,
        string calldata title,
        bytes32 incidentRef
    ) external returns (uint256 incidentId);

    /**
     * @notice Confirms an OPEN incident and moves it to CONFIRMED.
     * The report URI can be updated later with `updateIncidentReportURI` by `CONFIG_ADMIN_ROLE`.
     * @param incidentId Incident id to confirm.
     * @param reportURI External report URI for the incident.
     */
    function confirmIncident(uint256 incidentId, string calldata reportURI) external;

    /**
     * @notice Cancels an incident before assessment begins.
     * Use this for OPEN or CONFIRMED incidents that should not enter assessment.
     * The incident moves from OPEN or CONFIRMED to CANCELED.
     * @param incidentId Incident id to cancel.
     * @param cancelReason Cancellation reason.
     */
    function cancelPreAssessmentIncident(uint256 incidentId, string calldata cancelReason) external;

    /**
     * @notice Invalidates an incident after assessment begins.
     * Use this for UNDER_EVALUATION incidents that must be stopped during assessment.
     * The incident moves from UNDER_EVALUATION to CANCELED.
     * If the current assessment round is DRAFT or UNDER_EVALUATION, it is also canceled.
     * @param incidentId Incident id to invalidate.
     * @param cancelReason Cancellation reason.
     */
    function cancelIncident(uint256 incidentId, string calldata cancelReason) external;

    /**
     * @notice Adds losses to the current DRAFT assessment round.
     * Opens a new DRAFT round if the incident has no current round or the latest round was rejected or canceled.
     * Can be called multiple times while the round remains DRAFT, including to split large loss payloads across
     * transactions.
     * Losses are checked against each cover-market allocation, but cumulative
     * loss across different incidents is not capped on-chain. Curators and
     * approvers must prevent duplicate or excessive claims for the same period,
     * cover token, and market.
     * @param incidentId Incident id receiving assessment losses.
     * @param assessmentLosses Losses to append, expressed in CoverOrderAllocator canonical decimals.
     * @return assessmentRoundId Assessment round id that received the losses.
     */
    function addAssessmentLosses(
        uint256 incidentId,
        AssessmentLoss[] calldata assessmentLosses
    ) external returns (uint256 assessmentRoundId);

    /**
     * @notice Submits the current DRAFT assessment round for approval or rejection.
     * The round moves to UNDER_EVALUATION and can no longer receive losses.
     * @param incidentId Incident id whose current assessment round is submitted.
     */
    function submitCurrentAssessment(uint256 incidentId) external;

    /**
     * @notice Cancels the current DRAFT or UNDER_EVALUATION assessment round.
     * Use this for upload mistakes discovered while losses are loading or the round is being evaluated.
     * The incident remains UNDER_EVALUATION and may receive a new assessment round.
     * @param incidentId Incident id whose current assessment round is canceled.
     */
    function cancelCurrentAssessment(uint256 incidentId) external;

    /**
     * @notice Approves the specified UNDER_EVALUATION assessment round and executes the payout waterfall.
     * The assessment round moves to APPROVED and the incident moves to CLOSED.
     * The payout uses the first-loss buffer first and requests any remaining amount from the vault.
     * This contract must be authorized to call vault payouts, and the configured payout receiver must be allowlisted
     * by the vault. A valid incident can close even if the vault pays less than requested, including zero, when
     * slashable vault capacity is exhausted.
     * The specified `assessmentRoundId` must be the incident's current assessment round when the transaction executes.
     * Approvers are responsible for confirming the assessment is valid and does not overstate claims across
     * related incidents.
     * @param incidentId Incident id associated with the assessment round.
     * @param assessmentRoundId Assessment round id reviewed and authorized for approval.
     */
    function approveAssessment(uint256 incidentId, uint256 assessmentRoundId) external;

    /**
     * @notice Rejects the specified UNDER_EVALUATION assessment round.
     * The specified `assessmentRoundId` must be the incident's current assessment round when the transaction executes.
     * The incident remains UNDER_EVALUATION and may receive a new assessment round.
     * The next call to `addAssessmentLosses` opens a new DRAFT assessment round.
     * @param incidentId Incident id associated with the assessment round.
     * @param assessmentRoundId Assessment round id reviewed and authorized for rejection.
     */
    function rejectAssessment(uint256 incidentId, uint256 assessmentRoundId) external;

    /**
     * @notice Updates the report URI for an active incident.
     * The report URI cannot be updated after the incident is CLOSED or CANCELED, or after its
     * payout window has expired.
     * @param incidentId Incident id whose report URI is updated.
     * @param reportURI New external report URI.
     */
    function updateIncidentReportURI(uint256 incidentId, string calldata reportURI) external;

    /**
     * @notice Updates the receiver used for future incident payouts.
     * @param newPayoutReceiver New payout receiver address.
     */
    function setPayoutReceiver(address newPayoutReceiver) external;

    /**
     * @notice Updates the maximum accepted age for oracle prices.
     * @param newMaxPriceAge New maximum price age, in seconds.
     */
    function setMaxPriceAge(uint48 newMaxPriceAge) external;

    /**
     * @notice Updates the price feed adapter used to price the vault asset.
     * @param newPriceFeedAdapter New price feed adapter.
     */
    function setPriceFeedAdapter(IAggregatorV3 newPriceFeedAdapter) external;

    /**
     * @notice Returns the cover order allocator used to validate assessed losses.
     * @return Cover order allocator contract.
     */
    function coverOrderAllocator() external view returns (ICoverOrderAllocator);

    /**
     * @notice Returns the price feed adapter used to price the vault asset.
     * @return Price feed adapter.
     */
    function priceFeedAdapter() external view returns (IAggregatorV3);

    /**
     * @notice Returns the Firelight vault used for active incident tracking and payout execution.
     * @return Firelight vault contract.
     */
    function vault() external view returns (IFirelightVault);

    /**
     * @notice Returns all assessment losses recorded for an assessment round.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Assessment round id.
     * @return Assessment losses recorded for the round.
     */
    function getAssessmentLosses(
        uint256 incidentId,
        uint256 assessmentRoundId
    ) external view returns (AssessmentLoss[] memory);

    /**
     * @notice Returns one assessment loss from an assessment round.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Assessment round id.
     * @param index Assessment loss index.
     * @return Assessment loss at `index`.
     */
    function getAssessmentLoss(
        uint256 incidentId,
        uint256 assessmentRoundId,
        uint256 index
    ) external view returns (AssessmentLoss memory);

    /**
     * @notice Returns the number of losses recorded for an assessment round.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Assessment round id.
     * @return Number of assessment losses recorded for the round.
     */
    function getAssessmentLossesLength(uint256 incidentId, uint256 assessmentRoundId) external view returns (uint256);

    /**
     * @notice Returns an incident and whether it exists.
     * @dev The returned status may be `EXPIRED` when the payout window has passed without closure, even though that
     * status is never written to storage.
     * @param incidentId Incident id to query.
     * @return incident Incident record.
     * @return exists True if the incident exists.
     */
    function getIncident(uint256 incidentId) external view returns (Incident memory incident, bool exists);

    /**
     * @notice Returns the incident id registered for an incident reference.
     * @param incidentRef Curator-provided duplicate-prevention reference.
     * @return Incident id for the reference, or zero if none exists.
     */
    function incidentIdByRef(bytes32 incidentRef) external view returns (uint256);

    /**
     * @notice Returns an assessment round and whether it exists.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Assessment round id.
     * @return assessmentRound Assessment round record.
     * @return exists True if the assessment round exists.
     */
    function getAssessmentRound(
        uint256 incidentId,
        uint256 assessmentRoundId
    ) external view returns (AssessmentRound memory assessmentRound, bool exists);

    /**
     * @notice Returns the current assessment round for an incident.
     * @param incidentId Incident id to query.
     * @return assessmentRound Current assessment round record.
     * @return exists True if the current assessment round exists.
     */
    function getCurrentAssessmentRound(
        uint256 incidentId
    ) external view returns (AssessmentRound memory assessmentRound, bool exists);

    /**
     * @notice Returns the assessed loss attributed to a payout recipient for one assessment round.
     * @param incidentId Incident id the round belongs to.
     * @param assessmentRoundId Assessment round id.
     * @param payoutRecipient Payout recipient to query.
     * @return amount Assessed loss attributed to the payout recipient.
     * @return roundExists True if the assessment round exists.
     */
    function getPayoutRecipientAssessmentLoss(
        uint256 incidentId,
        uint256 assessmentRoundId,
        address payoutRecipient
    ) external view returns (uint256 amount, bool roundExists);

    /**
     * @notice Returns the assessed loss attributed to a payout recipient for the current assessment round.
     * @param incidentId Incident id to query.
     * @param payoutRecipient Payout recipient to query.
     * @return amount Assessed loss attributed to the payout recipient.
     * @return roundExists True if the current assessment round exists.
     */
    function getCurrentPayoutRecipientAssessmentLoss(
        uint256 incidentId,
        address payoutRecipient
    ) external view returns (uint256 amount, bool roundExists);

    /**
     * @notice Returns the receiver used for incident payouts.
     * @return Payout receiver address.
     */
    function payoutReceiver() external view returns (address);

    /**
     * @notice Returns the maximum accepted age for oracle prices.
     * @return Maximum price age, in seconds.
     */
    function maxPriceAge() external view returns (uint48);

    /**
     * @notice Returns the next incident id to be assigned.
     * @return Next incident id.
     */
    function nextIncidentId() external view returns (uint256);

    /**
     * @notice Returns the active incident count for a vault period.
     * Expired periods are reported as zero without mutating storage.
     * @param period Vault period to query.
     * @return Active incident count for the period.
     */
    function activeIncidentCount(uint256 period) external view returns (uint256);
}
