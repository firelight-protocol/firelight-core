// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {ICoverOrderAllocator} from "./interfaces/ICoverOrderAllocator.sol";
import {IFirelightVault} from "./interfaces/IFirelightVault.sol";
import {IIncidentManager} from "./interfaces/IIncidentManager.sol";
import {PriceFeed} from "./lib/PriceFeed.sol";
import {Decimals} from "./lib/Decimals.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";

/**
 * @title IncidentManager
 * @notice Coordinates protocol incident reporting, assessment, approval, and payout execution.
 * Incidents are assigned to vault periods using their `captureTimestamp` and assessed against settled cover-market
 * allocations. Incident approvals prioritize unresolved incidents from the previous vault period, then use
 * capture-timestamp order within the current period. Approved assessments execute a payout waterfall that uses the
 * first-loss buffer before requesting any remaining amount from the vault. Payouts are sent to the configured
 * `payoutReceiver`, and any per-recipient distribution is handled off-chain.
 *
 * Incident status flow:
 * - `OPEN` -> `CONFIRMED` -> `UNDER_EVALUATION` -> `CLOSED`
 * - `OPEN` or `CONFIRMED` -> `CANCELED` before assessment starts.
 * - `UNDER_EVALUATION` -> `CANCELED` when an incident is invalidated during assessment.
 *
 * Assessment round status flow:
 * - `DRAFT` -> `UNDER_EVALUATION` -> `APPROVED`
 * - `DRAFT` -> `UNDER_EVALUATION` -> `REJECTED`
 * - `DRAFT` or `UNDER_EVALUATION` -> `CANCELED`
 * - After a round is `REJECTED` or `CANCELED`, the incident remains `UNDER_EVALUATION`, and a new `DRAFT`
 *   assessment round can be opened.
 *
 * Role responsibilities:
 * - `DEFAULT_ADMIN_ROLE`: manages role assignments.
 * - `CURATOR_ROLE`: creates incidents and assessed losses.
 * - `ASSESSMENT_APPROVER_ROLE`: approves assessments and executes payout.
 * - `ASSESSMENT_REJECTER_ROLE`: rejects submitted assessment rounds.
 * - `INCIDENT_INVALIDATOR_ROLE`: cancels incidents that are already under assessment.
 * - `CONFIG_ADMIN_ROLE`: updates incident report URIs.
 * - `PAYOUT_ADMIN_ROLE`: updates the payout receiver.
 * - `PRICE_FEED_ADMIN_ROLE`: updates the price feed adapter and freshness threshold.
 *
 * `CURATOR_ROLE` and `ASSESSMENT_APPROVER_ROLE` are responsible for ensuring assessments do not overstate claims
 * across related incidents.
 * @custom:security-contact securityreport@firelight.finance
 */
contract IncidentManager is IIncidentManager, AccessControlUpgradeable, ReentrancyGuardUpgradeable {
    using SafeERC20 for IERC20;
    using Math for uint256;
    using PriceFeed for IAggregatorV3;

    /// @notice Role allowed to create incidents and assessed losses.
    bytes32 public constant CURATOR_ROLE = keccak256("CURATOR_ROLE");
    /// @notice Role allowed to approve assessments and execute payout.
    bytes32 public constant ASSESSMENT_APPROVER_ROLE = keccak256("ASSESSMENT_APPROVER_ROLE");
    /// @notice Role allowed to reject submitted assessment rounds.
    bytes32 public constant ASSESSMENT_REJECTER_ROLE = keccak256("ASSESSMENT_REJECTER_ROLE");
    /// @notice Role allowed to cancel incidents that are already under assessment.
    bytes32 public constant INCIDENT_INVALIDATOR_ROLE = keccak256("INCIDENT_INVALIDATOR_ROLE");
    /// @notice Role allowed to update incident report URIs.
    bytes32 public constant CONFIG_ADMIN_ROLE = keccak256("CONFIG_ADMIN_ROLE");
    /// @notice Role allowed to update the payout receiver.
    bytes32 public constant PAYOUT_ADMIN_ROLE = keccak256("PAYOUT_ADMIN_ROLE");
    /// @notice Role allowed to update the price feed adapter and freshness threshold.
    bytes32 public constant PRICE_FEED_ADMIN_ROLE = keccak256("PRICE_FEED_ADMIN_ROLE");

    /// @notice Maximum length of an incident title.
    uint256 public constant MAX_INCIDENT_TITLE_LENGTH = 64;
    /// @notice Maximum length of an incident cancel reason.
    uint256 public constant MAX_CANCEL_REASON_LENGTH = 256;

    // --- ERC-7201 Namespaced Storage ---
    /// @custom:storage-location erc7201:firelight.incidentmanager.storage
    struct IncidentManagerStorage {
        ICoverOrderAllocator coverOrderAllocator;
        IFirelightVault vault;
        IAggregatorV3 priceFeedAdapter;
        address payoutReceiver;
        uint256 nextIncidentId;
        uint48 maxPriceAge;
        uint8 priceFeedDecimals;
        uint8 vaultAssetDecimals;
        uint8 canonicalDecimals;
        mapping(uint256 incidentId => Incident) incidents;
        mapping(bytes32 incidentRef => uint256 incidentId) incidentRefs;
        mapping(uint256 incidentId => mapping(uint256 assessmentRoundId => AssessmentRound)) assessmentRounds;
        mapping(uint256 incidentId => mapping(uint256 assessmentRoundId => AssessmentLoss[])) assessmentLosses;
        mapping(uint256 incidentId => mapping(uint256 assessmentRoundId => mapping(uint256 coverTokenId => mapping(bytes32 marketId => bool)))) assessmentLossExists;
        mapping(uint256 incidentId => mapping(uint256 assessmentRoundId => mapping(address payoutRecipient => uint256 amount))) payoutRecipientAssessmentLoss;
        mapping(uint256 period => uint256 count) activeIncidentCountByPeriod;
        // Used to enforce FIFO priority by capture timestamp within each period.
        mapping(uint256 period => uint48[] timestamps) incidentTimestamps;
        mapping(uint256 period => mapping(uint48 timestamp => uint256 incidentId)) incidentIdByTimestamp;
    }

    // keccak256(abi.encode(uint256(keccak256("firelight.incidentmanager.storage")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xb6f563f2177a2296ef417ede66b7ea0704c1a671ddd9f25275dcd155f1fd2a00;

    function _getStorage() private pure returns (IncidentManagerStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the incident manager dependencies, roles, payout receiver, and price feed settings.
     * @param admin Address receiving `DEFAULT_ADMIN_ROLE`.
     * @param curator Address receiving `CURATOR_ROLE`.
     * @param assessmentApprover Address receiving `ASSESSMENT_APPROVER_ROLE`.
     * @param assessmentRejecter Address receiving `ASSESSMENT_REJECTER_ROLE`.
     * @param incidentInvalidator Address receiving `INCIDENT_INVALIDATOR_ROLE`.
     * @param configAdmin Optional address receiving `CONFIG_ADMIN_ROLE`.
     * @param payoutAdmin Optional address receiving `PAYOUT_ADMIN_ROLE`.
     * @param priceFeedAdmin Optional address receiving `PRICE_FEED_ADMIN_ROLE`.
     * @param _payoutReceiver Address receiving approved incident payouts.
     * @param _coverOrderAllocator Cover order allocator used for settled allocation checks.
     * @param _priceFeedAdapter Price feed used to value first-loss buffer payouts.
     * @param _maxPriceAge Maximum allowed age for price feed answers.
     */
    function initialize(
        address admin,
        address curator,
        address assessmentApprover,
        address assessmentRejecter,
        address incidentInvalidator,
        address configAdmin,
        address payoutAdmin,
        address priceFeedAdmin,
        address _payoutReceiver,
        ICoverOrderAllocator _coverOrderAllocator,
        IAggregatorV3 _priceFeedAdapter,
        uint48 _maxPriceAge
    ) external initializer {
        if (
            admin == address(0) ||
            curator == address(0) ||
            assessmentApprover == address(0) ||
            assessmentRejecter == address(0) ||
            incidentInvalidator == address(0) ||
            address(_coverOrderAllocator) == address(0)
        ) {
            revert InvalidZeroAddress();
        }

        __AccessControl_init();
        __ReentrancyGuard_init();

        IncidentManagerStorage storage $ = _getStorage();
        $.coverOrderAllocator = _coverOrderAllocator;
        _setPayoutReceiver(_payoutReceiver);
        $.vault = _coverOrderAllocator.vault();
        $.nextIncidentId = 1;
        $.vaultAssetDecimals = IERC20Metadata($.vault.asset()).decimals();
        $.canonicalDecimals = _coverOrderAllocator.CANONICAL_DECIMALS();

        _setMaxPriceAge(_maxPriceAge);
        _setPriceFeedAdapter(_priceFeedAdapter);

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(CURATOR_ROLE, curator);
        _grantRole(ASSESSMENT_APPROVER_ROLE, assessmentApprover);
        _grantRole(ASSESSMENT_REJECTER_ROLE, assessmentRejecter);
        _grantRole(INCIDENT_INVALIDATOR_ROLE, incidentInvalidator);
        if (configAdmin != address(0)) _grantRole(CONFIG_ADMIN_ROLE, configAdmin);
        if (payoutAdmin != address(0)) _grantRole(PAYOUT_ADMIN_ROLE, payoutAdmin);
        if (priceFeedAdmin != address(0)) _grantRole(PRICE_FEED_ADMIN_ROLE, priceFeedAdmin);
    }

    /**
     * @inheritdoc IIncidentManager
     * @dev `incidentRef` only prevents exact reference reuse and cannot detect different refs for the same
     * real-world event. Curators should use a consistent external report id, and a versioned ref when replacing a
     * canceled incident.
     */
    function createIncident(
        uint48 captureTimestamp,
        string calldata title,
        bytes32 incidentRef
    ) external onlyRole(CURATOR_ROLE) returns (uint256 incidentId) {
        uint256 titleLength = bytes(title).length;
        if (titleLength == 0) revert InvalidIncidentTitle();
        if (titleLength > MAX_INCIDENT_TITLE_LENGTH) revert IncidentTitleTooLong();

        IncidentManagerStorage storage $ = _getStorage();

        if (incidentRef == bytes32(0)) revert InvalidIncidentRef();

        uint256 existingRefIncidentId = $.incidentRefs[incidentRef];
        if (existingRefIncidentId != 0) {
            revert IncidentReferenceAlreadyExists(incidentRef, existingRefIncidentId);
        }

        uint256 period = $.vault.periodAtTimestamp(captureTimestamp);
        if (_isPeriodExpired(period) || captureTimestamp > block.timestamp) {
            revert InvalidCaptureTimestamp(captureTimestamp, period, $.vault.currentPeriod());
        }

        incidentId = $.nextIncidentId++;

        _insertIncidentTimestamp($, period, captureTimestamp, incidentId);

        $.incidents[incidentId] = Incident({
            title: title,
            reportURI: "",
            period: period,
            incidentRef: incidentRef,
            currentAssessmentRoundId: 0,
            vaultPaidAmount: 0,
            captureTimestamp: captureTimestamp,
            status: IncidentStatus.OPEN,
            cancelReason: ""
        });

        $.incidentRefs[incidentRef] = incidentId;

        _increaseIncident(period);

        emit IncidentCreated(incidentId, period, incidentRef, captureTimestamp, title);
    }

    /// @inheritdoc IIncidentManager
    function confirmIncident(uint256 incidentId, string calldata reportURI) external onlyRole(CURATOR_ROLE) {
        Incident storage incident = _activeIncidentWithStatus(incidentId, IncidentStatus.OPEN);
        _updateIncidentReportURI(incidentId, incident, reportURI);
        incident.status = IncidentStatus.CONFIRMED;
        emit IncidentConfirmed(incidentId);
    }

    /// @inheritdoc IIncidentManager
    function cancelPreAssessmentIncident(
        uint256 incidentId,
        string calldata cancelReason
    ) external onlyRole(CURATOR_ROLE) {
        _validateCancelReason(cancelReason);

        Incident storage incident = _incident(incidentId);

        _validateIncidentPeriod(incidentId, incident.period);

        IncidentStatus status = incident.status;
        if (status != IncidentStatus.OPEN && status != IncidentStatus.CONFIRMED) {
            revert InvalidIncidentStatus(incidentId, status);
        }

        incident.status = IncidentStatus.CANCELED;
        incident.cancelReason = cancelReason;

        _decreaseIncident(incident.period);

        emit IncidentCanceledPreAssessment(incidentId, cancelReason);
    }

    /// @inheritdoc IIncidentManager
    function cancelIncident(
        uint256 incidentId,
        string calldata cancelReason
    ) external onlyRole(INCIDENT_INVALIDATOR_ROLE) {
        _validateCancelReason(cancelReason);

        Incident storage incident = _activeIncidentWithStatus(incidentId, IncidentStatus.UNDER_EVALUATION);

        // Keep the assessment round lifecycle aligned with the canceled incident.
        uint256 roundId = incident.currentAssessmentRoundId;
        AssessmentRound storage assessmentRound = _getStorage().assessmentRounds[incidentId][roundId];
        AssessmentRoundStatus roundStatus = assessmentRound.status;
        if (roundStatus == AssessmentRoundStatus.DRAFT || roundStatus == AssessmentRoundStatus.UNDER_EVALUATION) {
            assessmentRound.status = AssessmentRoundStatus.CANCELED;
            emit AssessmentRoundCanceled(incidentId, roundId);
        }

        incident.status = IncidentStatus.CANCELED;
        incident.cancelReason = cancelReason;

        _decreaseIncident(incident.period);

        emit IncidentInvalidated(incidentId, cancelReason);
    }

    /// @inheritdoc IIncidentManager
    function addAssessmentLosses(
        uint256 incidentId,
        AssessmentLoss[] calldata assessmentLosses
    ) external onlyRole(CURATOR_ROLE) returns (uint256 assessmentRoundId) {
        if (assessmentLosses.length == 0) revert InvalidAssessmentLosses();

        Incident storage incident = _incident(incidentId);

        _validateIncidentPeriod(incidentId, incident.period);

        IncidentStatus status = incident.status;
        if (status != IncidentStatus.CONFIRMED && status != IncidentStatus.UNDER_EVALUATION) {
            revert InvalidIncidentStatus(incidentId, status);
        }

        if (status == IncidentStatus.CONFIRMED) {
            incident.status = IncidentStatus.UNDER_EVALUATION;
            emit IncidentUnderEvaluation(incidentId);
        }

        IncidentManagerStorage storage $ = _getStorage();

        assessmentRoundId = incident.currentAssessmentRoundId;
        AssessmentRound storage assessmentRound = $.assessmentRounds[incidentId][assessmentRoundId];

        AssessmentRoundStatus roundStatus = assessmentRound.status;
        if (
            assessmentRoundId == 0 ||
            roundStatus == AssessmentRoundStatus.REJECTED ||
            roundStatus == AssessmentRoundStatus.CANCELED
        ) {
            assessmentRoundId = ++incident.currentAssessmentRoundId;
            assessmentRound = $.assessmentRounds[incidentId][assessmentRoundId];
            assessmentRound.status = AssessmentRoundStatus.DRAFT;

            emit AssessmentRoundOpened(incidentId, assessmentRoundId);
        } else if (roundStatus != AssessmentRoundStatus.DRAFT) {
            revert InvalidAssessmentRoundStatus(incidentId, assessmentRoundId, roundStatus);
        }

        AssessmentLoss[] storage roundAssessmentLoss = $.assessmentLosses[incidentId][assessmentRoundId];

        uint256 addedAssessmentLossAmount;
        uint256 len = assessmentLosses.length;

        for (uint256 i = 0; i < len; i++) {
            uint256 coverTokenId = assessmentLosses[i].coverTokenId;
            bytes32 marketId = assessmentLosses[i].marketId;
            uint256 amount = assessmentLosses[i].amount;

            if ($.assessmentLossExists[incidentId][assessmentRoundId][coverTokenId][marketId]) {
                revert AssessmentLossAlreadyExists(i);
            }

            if (amount == 0) revert AssessmentLossZeroAmount(coverTokenId, marketId);

            // Validate that the order-market allocation exists and the assessment loss amount does not exceed it.
            (uint256 orderPeriod, uint256 allocatedCoverAmount, address payoutRecipient) = $
                .coverOrderAllocator
                .getCoverOrderMarketInfo(coverTokenId, marketId);
            if (payoutRecipient == address(0)) revert OrderNotFound(coverTokenId, marketId);
            if (amount > allocatedCoverAmount) {
                revert AssessmentLossAmountTooBig(coverTokenId, marketId, allocatedCoverAmount, amount);
            }
            uint256 incidentPeriod = incident.period;
            if (orderPeriod != incidentPeriod) revert InvalidOrderPeriod(coverTokenId, orderPeriod, incidentPeriod);

            addedAssessmentLossAmount += amount;
            $.assessmentLossExists[incidentId][assessmentRoundId][coverTokenId][marketId] = true;
            roundAssessmentLoss.push(assessmentLosses[i]);

            // Accumulate the payout recipient's total assessed loss for this assessment round.
            $.payoutRecipientAssessmentLoss[incidentId][assessmentRoundId][payoutRecipient] += amount;
        }

        assessmentRound.totalAssessmentLoss += addedAssessmentLossAmount;

        emit AssessmentLossesAdded(incidentId, assessmentRoundId, len, addedAssessmentLossAmount);
    }

    /// @inheritdoc IIncidentManager
    function submitCurrentAssessment(uint256 incidentId) external onlyRole(CURATOR_ROLE) {
        Incident storage incident = _activeIncidentWithStatus(incidentId, IncidentStatus.UNDER_EVALUATION);

        (uint256 assessmentRoundId, AssessmentRound storage assessmentRound) = _setCurrentAssessmentStatus(
            incidentId,
            incident,
            AssessmentRoundStatus.DRAFT,
            AssessmentRoundStatus.UNDER_EVALUATION
        );

        emit AssessmentRoundSubmitted(incidentId, assessmentRoundId, assessmentRound.totalAssessmentLoss);
    }

    /// @inheritdoc IIncidentManager
    function cancelCurrentAssessment(uint256 incidentId) external onlyRole(CURATOR_ROLE) {
        Incident storage incident = _activeIncidentWithStatus(incidentId, IncidentStatus.UNDER_EVALUATION);

        uint256 assessmentRoundId = incident.currentAssessmentRoundId;
        AssessmentRound storage assessmentRound = _getStorage().assessmentRounds[incidentId][assessmentRoundId];

        AssessmentRoundStatus status = assessmentRound.status;
        if (status != AssessmentRoundStatus.DRAFT && status != AssessmentRoundStatus.UNDER_EVALUATION) {
            revert InvalidAssessmentRoundStatus(incidentId, assessmentRoundId, status);
        }

        assessmentRound.status = AssessmentRoundStatus.CANCELED;

        emit AssessmentRoundCanceled(incidentId, assessmentRoundId);
    }

    /// @inheritdoc IIncidentManager
    function approveCurrentAssessment(uint256 incidentId) external onlyRole(ASSESSMENT_APPROVER_ROLE) nonReentrant {
        Incident storage incident = _activeIncidentWithStatus(incidentId, IncidentStatus.UNDER_EVALUATION);

        IncidentManagerStorage storage $ = _getStorage();

        uint256 expectedIncidentId = _earliestPayableIncidentId($);
        if (incidentId != expectedIncidentId) {
            revert IncidentApprovalOutOfOrder(incidentId, expectedIncidentId);
        }

        (uint256 assessmentRoundId, AssessmentRound storage assessmentRound) = _setCurrentAssessmentStatus(
            incidentId,
            incident,
            AssessmentRoundStatus.UNDER_EVALUATION,
            AssessmentRoundStatus.APPROVED
        );

        uint256 totalAssessmentLoss = assessmentRound.totalAssessmentLoss;
        emit AssessmentRoundApproved(incidentId, assessmentRoundId, totalAssessmentLoss);

        uint256 vaultPaidAmount = _executePayout(
            $,
            incidentId,
            assessmentRoundId,
            incident.period,
            incident.captureTimestamp,
            totalAssessmentLoss
        );

        if (vaultPaidAmount > 0) incident.vaultPaidAmount = vaultPaidAmount;

        incident.status = IncidentStatus.CLOSED;

        _decreaseIncident(incident.period);

        emit IncidentClosed(incidentId, vaultPaidAmount, totalAssessmentLoss);
    }

    /// @inheritdoc IIncidentManager
    function rejectCurrentAssessment(uint256 incidentId) external onlyRole(ASSESSMENT_REJECTER_ROLE) {
        Incident storage incident = _activeIncidentWithStatus(incidentId, IncidentStatus.UNDER_EVALUATION);

        (uint256 assessmentRoundId, ) = _setCurrentAssessmentStatus(
            incidentId,
            incident,
            AssessmentRoundStatus.UNDER_EVALUATION,
            AssessmentRoundStatus.REJECTED
        );

        emit AssessmentRoundRejected(incidentId, assessmentRoundId);
    }

    // -- admin functions --

    /// @inheritdoc IIncidentManager
    function updateIncidentReportURI(
        uint256 incidentId,
        string calldata reportURI
    ) external onlyRole(CONFIG_ADMIN_ROLE) {
        Incident storage incident = _incident(incidentId);

        _validateIncidentPeriod(incidentId, incident.period);

        IncidentStatus status = incident.status;
        if (status == IncidentStatus.CLOSED || status == IncidentStatus.CANCELED) {
            revert ReportURIUpdateNotAllowed(incidentId, status);
        }
        _updateIncidentReportURI(incidentId, incident, reportURI);
    }

    /// @inheritdoc IIncidentManager
    function setPayoutReceiver(address newPayoutReceiver) external onlyRole(PAYOUT_ADMIN_ROLE) {
        _setPayoutReceiver(newPayoutReceiver);
    }

    /// @inheritdoc IIncidentManager
    function setPriceFeedAdapter(IAggregatorV3 newPriceFeedAdapter) external onlyRole(PRICE_FEED_ADMIN_ROLE) {
        _setPriceFeedAdapter(newPriceFeedAdapter);
    }

    /// @inheritdoc IIncidentManager
    function setMaxPriceAge(uint48 newMaxPriceAge) external onlyRole(PRICE_FEED_ADMIN_ROLE) {
        _setMaxPriceAge(newMaxPriceAge);
    }

    // -- view functions --

    /// @inheritdoc IIncidentManager
    function coverOrderAllocator() external view returns (ICoverOrderAllocator) {
        return _getStorage().coverOrderAllocator;
    }

    /// @inheritdoc IIncidentManager
    function vault() external view returns (IFirelightVault) {
        return _getStorage().vault;
    }

    /// @inheritdoc IIncidentManager
    function getAssessmentLosses(
        uint256 incidentId,
        uint256 assessmentRoundId
    ) external view returns (AssessmentLoss[] memory) {
        return _getStorage().assessmentLosses[incidentId][assessmentRoundId];
    }

    /// @inheritdoc IIncidentManager
    function getAssessmentLoss(
        uint256 incidentId,
        uint256 assessmentRoundId,
        uint256 index
    ) external view returns (AssessmentLoss memory) {
        return _getStorage().assessmentLosses[incidentId][assessmentRoundId][index];
    }

    /// @inheritdoc IIncidentManager
    function getAssessmentLossesLength(uint256 incidentId, uint256 assessmentRoundId) external view returns (uint256) {
        return _getStorage().assessmentLosses[incidentId][assessmentRoundId].length;
    }

    /// @inheritdoc IIncidentManager
    function getIncident(uint256 incidentId) external view returns (Incident memory incident, bool exists) {
        incident = _getStorage().incidents[incidentId];
        exists = incident.status != IncidentStatus.NONE;
        if (
            exists &&
            incident.status != IncidentStatus.CLOSED &&
            incident.status != IncidentStatus.CANCELED &&
            _isPeriodExpired(incident.period)
        ) {
            incident.status = IncidentStatus.EXPIRED;
        }
    }

    /// @inheritdoc IIncidentManager
    function incidentIdByRef(bytes32 incidentRef) external view returns (uint256) {
        return _getStorage().incidentRefs[incidentRef];
    }

    /// @inheritdoc IIncidentManager
    function getAssessmentRound(
        uint256 incidentId,
        uint256 assessmentRoundId
    ) public view returns (AssessmentRound memory assessmentRound, bool exists) {
        assessmentRound = _getStorage().assessmentRounds[incidentId][assessmentRoundId];
        exists = assessmentRound.status != AssessmentRoundStatus.NONE;
    }

    /// @inheritdoc IIncidentManager
    function getCurrentAssessmentRound(
        uint256 incidentId
    ) external view returns (AssessmentRound memory assessmentRound, bool exists) {
        Incident storage incident = _getStorage().incidents[incidentId];
        if (incident.status == IncidentStatus.NONE) return (assessmentRound, false);
        (assessmentRound, exists) = getAssessmentRound(incidentId, incident.currentAssessmentRoundId);
    }

    /// @inheritdoc IIncidentManager
    function getPayoutRecipientAssessmentLoss(
        uint256 incidentId,
        uint256 assessmentRoundId,
        address payoutRecipient
    ) public view returns (uint256 amount, bool roundExists) {
        IncidentManagerStorage storage $ = _getStorage();

        AssessmentRound storage assessmentRound = $.assessmentRounds[incidentId][assessmentRoundId];
        roundExists = assessmentRound.status != AssessmentRoundStatus.NONE;

        if (!roundExists) return (0, false);

        amount = $.payoutRecipientAssessmentLoss[incidentId][assessmentRoundId][payoutRecipient];
    }

    /// @inheritdoc IIncidentManager
    function getCurrentPayoutRecipientAssessmentLoss(
        uint256 incidentId,
        address payoutRecipient
    ) external view returns (uint256 amount, bool roundExists) {
        Incident storage incident = _getStorage().incidents[incidentId];
        if (incident.status == IncidentStatus.NONE) return (0, false);
        uint256 assessmentRoundId = incident.currentAssessmentRoundId;
        (amount, roundExists) = getPayoutRecipientAssessmentLoss(incidentId, assessmentRoundId, payoutRecipient);
    }

    /// @inheritdoc IIncidentManager
    function payoutReceiver() external view returns (address) {
        return _getStorage().payoutReceiver;
    }

    /// @inheritdoc IIncidentManager
    function nextIncidentId() external view returns (uint256) {
        return _getStorage().nextIncidentId;
    }

    /// @inheritdoc IIncidentManager
    function maxPriceAge() external view returns (uint48) {
        return _getStorage().maxPriceAge;
    }

    /// @inheritdoc IIncidentManager
    function priceFeedAdapter() external view returns (IAggregatorV3) {
        return _getStorage().priceFeedAdapter;
    }

    /**
     * @inheritdoc IIncidentManager
     * @dev The raw counter may remain nonzero for old periods, but it does not affect payout ordering or vault
     * deposit blocking once the payout window has passed.
     */
    function activeIncidentCount(uint256 period) external view returns (uint256) {
        if (_isPeriodExpired(period)) return 0;
        return _getStorage().activeIncidentCountByPeriod[period];
    }

    // -- internal functions --

    // Trust assumption: the per-period firstLossBuffer account in CoverOrderAllocator has approved
    // IncidentManager to pull its buffer balance. A funded buffer without that allowance makes the
    // first-loss transfer (and therefore the whole payout) revert.
    function _executePayout(
        IncidentManagerStorage storage $,
        uint256 incidentId,
        uint256 assessmentRoundId,
        uint256 period,
        uint48 captureTimestamp,
        uint256 totalAssessmentLoss
    ) internal returns (uint256 vaultPaidAmount) {
        uint8 canonicalDecimals = $.canonicalDecimals;
        address receiver = $.payoutReceiver;

        // Token + custody travel together inside the per-period CapacityConfig, so a
        // mid-life buffer-token rotation never desynchronizes from the wallet that
        // holds (and pre-approved) the funds for the incident's period.
        // Assumes the firstLossBufferToken is a stablecoin pegged to the same asset as the orders.
        ICoverOrderAllocator.CapacityConfig memory periodConfig = $.coverOrderAllocator.getCapacityConfigAt(period);
        address flbPayer = periodConfig.firstLossBuffer;
        IERC20 flbToken = periodConfig.firstLossBufferToken;

        // Intentionally let safeTransferFrom revert if a funded FLB payer has not approved IncidentManager.
        uint256 flbPayerBalance = flbToken.balanceOf(flbPayer);
        uint256 flbAmount;
        uint256 remainderAmount = totalAssessmentLoss;

        // Take from buffer account first
        if (flbPayerBalance > 0) {
            uint8 flbTokenDecimals = IERC20Metadata(address(flbToken)).decimals();
            uint256 totalAssessmentLossFlb = Decimals.convert(
                totalAssessmentLoss,
                canonicalDecimals,
                flbTokenDecimals,
                Math.Rounding.Floor
            );

            flbAmount = Math.min(totalAssessmentLossFlb, flbPayerBalance);

            if (flbAmount > 0) {
                flbToken.safeTransferFrom(flbPayer, receiver, flbAmount);
            }

            // Convert the transferred flbAmount back to canonical decimals
            uint256 flbAmountCanonical = Decimals.convert(
                flbAmount,
                flbTokenDecimals,
                canonicalDecimals,
                Math.Rounding.Floor
            );

            remainderAmount = flbAmountCanonical >= totalAssessmentLoss ? 0 : totalAssessmentLoss - flbAmountCanonical;
        }

        uint256 vaultRequestedAmount;
        if (remainderAmount > 0) {
            uint256 assetPriceUSD = $.priceFeedAdapter.getPrice($.maxPriceAge);

            // Convert remaining USD loss into vault asset units.
            vaultRequestedAmount = remainderAmount.mulDiv(10 ** $.priceFeedDecimals, assetPriceUSD).mulDiv(
                10 ** $.vaultAssetDecimals,
                10 ** canonicalDecimals
            );

            // In case of rounding dust
            if (vaultRequestedAmount > 0) {
                vaultPaidAmount = $.vault.payout(receiver, vaultRequestedAmount, captureTimestamp);
            } else if (flbAmount == 0) {
                // Revert only if the approved loss rounds to zero for both payout sources.
                // A zero vault payout is still allowed when vault slashable capacity is exhausted.
                revert PayoutRoundsToZero(remainderAmount, totalAssessmentLoss);
            }
        }

        uint256 executionPeriod = $.vault.currentPeriod();
        emit IncidentPayoutExecuted(
            incidentId,
            assessmentRoundId,
            period,
            executionPeriod,
            receiver,
            flbPayer,
            address(flbToken),
            flbAmount,
            totalAssessmentLoss,
            vaultRequestedAmount,
            vaultPaidAmount
        );
    }

    function _incident(uint256 incidentId) internal view returns (Incident storage incident) {
        incident = _getStorage().incidents[incidentId];
        if (incident.status == IncidentStatus.NONE) revert IncidentNotFound(incidentId);
    }

    // Loads an incident and guarantees it exists, its payout window has not expired, and it matches the
    // expected status; reverts otherwise.
    function _activeIncidentWithStatus(
        uint256 incidentId,
        IncidentStatus expectedStatus
    ) internal view returns (Incident storage incident) {
        incident = _incident(incidentId);
        _validateIncidentPeriod(incidentId, incident.period);
        IncidentStatus currentStatus = incident.status;
        if (currentStatus != expectedStatus) revert InvalidIncidentStatus(incidentId, currentStatus);
    }

    function _setCurrentAssessmentStatus(
        uint256 incidentId,
        Incident storage incident,
        AssessmentRoundStatus expectedStatus,
        AssessmentRoundStatus newStatus
    ) internal returns (uint256 assessmentRoundId, AssessmentRound storage assessmentRound) {
        assessmentRoundId = incident.currentAssessmentRoundId;
        assessmentRound = _getStorage().assessmentRounds[incidentId][assessmentRoundId];

        AssessmentRoundStatus currentStatus = assessmentRound.status;
        if (currentStatus != expectedStatus) {
            revert InvalidAssessmentRoundStatus(incidentId, assessmentRoundId, currentStatus);
        }

        assessmentRound.status = newStatus;
    }

    function _setPayoutReceiver(address newPayoutReceiver) internal {
        if (newPayoutReceiver == address(0)) revert InvalidZeroAddress();

        IncidentManagerStorage storage $ = _getStorage();
        address oldPayoutReceiver = $.payoutReceiver;
        if (oldPayoutReceiver == newPayoutReceiver) return;
        $.payoutReceiver = newPayoutReceiver;

        emit PayoutReceiverUpdated(oldPayoutReceiver, newPayoutReceiver);
    }

    function _setMaxPriceAge(uint48 newMaxPriceAge) internal {
        if (newMaxPriceAge == 0) revert InvalidMaxPriceAge();

        IncidentManagerStorage storage $ = _getStorage();
        uint48 oldMaxPriceAge = $.maxPriceAge;
        if (oldMaxPriceAge == newMaxPriceAge) return;
        $.maxPriceAge = newMaxPriceAge;

        emit MaxPriceAgeUpdated(oldMaxPriceAge, newMaxPriceAge);
    }

    function _setPriceFeedAdapter(IAggregatorV3 newPriceFeedAdapter) internal {
        if (address(newPriceFeedAdapter) == address(0)) revert InvalidZeroAddress();

        IncidentManagerStorage storage $ = _getStorage();

        IAggregatorV3 oldPriceFeedAdapter = $.priceFeedAdapter;
        uint8 oldPriceFeedDecimals = $.priceFeedDecimals;
        if (oldPriceFeedAdapter == newPriceFeedAdapter) return;
        uint8 newPriceFeedDecimals = newPriceFeedAdapter.decimals();

        // Bound feed decimals to a sane range so the payout conversion math stays well-scaled and cannot
        // under/overflow on unusual feeds.
        if (newPriceFeedDecimals < 6 || newPriceFeedDecimals > 18) {
            revert InvalidPriceFeedDecimals(newPriceFeedDecimals);
        }

        $.priceFeedAdapter = newPriceFeedAdapter;
        $.priceFeedDecimals = newPriceFeedDecimals;

        emit PriceFeedAdapterUpdated(
            address(oldPriceFeedAdapter),
            oldPriceFeedDecimals,
            address(newPriceFeedAdapter),
            newPriceFeedDecimals
        );
    }

    function _updateIncidentReportURI(
        uint256 incidentId,
        Incident storage incident,
        string calldata reportURI
    ) internal {
        if (bytes(reportURI).length == 0) revert InvalidIncidentReportURI();

        string memory oldReportURI = incident.reportURI;
        if (keccak256(bytes(oldReportURI)) == keccak256(bytes(reportURI))) return;

        incident.reportURI = reportURI;
        emit IncidentReportURIUpdated(incidentId, oldReportURI, reportURI);
    }

    // Tracks active incidents per period so the vault can block deposits only while
    // at least one incident for that period is unresolved. The vault flag is updated
    // only on the 0 -> 1 transition to avoid redundant external calls.
    function _increaseIncident(uint256 period) internal {
        IncidentManagerStorage storage $ = _getStorage();
        uint256 count = ++$.activeIncidentCountByPeriod[period];
        if (count == 1) {
            // First active incident for this period: tell the vault to block deposits.
            $.vault.setActiveIncident(period, true);
        }
    }

    // Decrements the active incident counter for the period. The vault deposit block
    // is cleared only when the last unresolved incident for that period is closed or canceled.
    function _decreaseIncident(uint256 period) internal {
        IncidentManagerStorage storage $ = _getStorage();
        uint256 count = $.activeIncidentCountByPeriod[period];
        // Terminal incident transitions should not call this with a zero count.
        if (count == 0) return;

        --count;
        $.activeIncidentCountByPeriod[period] = count;
        if (count == 0) {
            // Last active incident for this period resolved: allow deposits again.
            $.vault.setActiveIncident(period, false);
        }
    }

    function _validateIncidentPeriod(uint256 incidentId, uint256 incidentPeriod) internal view {
        if (_isPeriodExpired(incidentPeriod)) {
            revert IncidentPayoutWindowExpired(incidentId, incidentPeriod);
        }
    }

    function _isPeriodExpired(uint256 incidentPeriod) internal view returns (bool) {
        return !_getStorage().vault.isPeriodInPayoutWindow(incidentPeriod);
    }

    // Insert incident in captureTimestamp order and reject duplicate timestamps for the period.
    function _insertIncidentTimestamp(
        IncidentManagerStorage storage $,
        uint256 period,
        uint48 captureTimestamp,
        uint256 incidentId
    ) internal {
        uint256 existingIncidentId = $.incidentIdByTimestamp[period][captureTimestamp];
        if (existingIncidentId != 0) {
            revert IncidentTimestampAlreadyExists(period, captureTimestamp, existingIncidentId);
        }

        $.incidentIdByTimestamp[period][captureTimestamp] = incidentId;

        uint48[] storage timestamps = $.incidentTimestamps[period];
        timestamps.push(captureTimestamp);

        uint256 i = timestamps.length - 1;
        while (i > 0 && timestamps[i - 1] > captureTimestamp) {
            timestamps[i] = timestamps[i - 1];
            --i;
        }

        timestamps[i] = captureTimestamp;
    }

    // Returns the incident that must be approved next, or 0 when none is payable. Unresolved incidents from the
    // previous period take priority over the current period; within a period the earliest capture timestamp wins.
    function _earliestPayableIncidentId(IncidentManagerStorage storage $) internal view returns (uint256) {
        uint256 currentPeriod = $.vault.currentPeriod();
        uint256 previousId = currentPeriod > 0 ? _earliestActiveIncidentIdAt($, currentPeriod - 1) : 0;

        if (previousId > 0) return previousId;

        uint256 currentId = _earliestActiveIncidentIdAt($, currentPeriod);

        return currentId;
    }

    // Timestamps are maintained in sorted order by _insertIncidentTimestamp, so the first incident that is not
    // closed or canceled is the earliest payable one by capture time. Returns 0 when none is active.
    function _earliestActiveIncidentIdAt(
        IncidentManagerStorage storage $,
        uint256 period
    ) internal view returns (uint256) {
        uint48[] storage timestamps = $.incidentTimestamps[period];
        uint256 len = timestamps.length;
        for (uint256 i; i < len; ++i) {
            uint256 incidentId = $.incidentIdByTimestamp[period][timestamps[i]];
            IncidentStatus status = $.incidents[incidentId].status;

            if (status != IncidentStatus.CLOSED && status != IncidentStatus.CANCELED) {
                return incidentId;
            }
        }

        return 0;
    }

    function _validateCancelReason(string calldata cancelReason) internal pure {
        uint256 len = bytes(cancelReason).length;
        if (len > MAX_CANCEL_REASON_LENGTH) {
            revert CancelReasonTooLong(len, MAX_CANCEL_REASON_LENGTH);
        }
    }
}
