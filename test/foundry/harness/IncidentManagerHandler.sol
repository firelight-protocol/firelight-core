// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IncidentManager} from "contracts/core/IncidentManager.sol";
import {IIncidentManager} from "contracts/core/interfaces/IIncidentManager.sol";
import {MockIncidentManagerVault} from "contracts/test/MockIncidentManagerVault.sol";

/// @notice Drives the incident lifecycle (create/confirm/assess/submit/approve/reject/cancel) for a single
/// fixed period, mirroring terminal states + the active counter in ghosts and flagging any approval that
/// jumps the FIFO queue. Targets x-ray I-7 (incident state machine), I-9/G-17 (FIFO), and the manager side
/// of X-1 (active counter). FLB custody holds 0 balance so the payout waterfall goes straight to the mock
/// vault, which echoes the requested amount (approve always closes the incident).
contract IncidentManagerHandler is Test {
    IncidentManager public im;
    MockIncidentManagerVault public vault;

    uint256 public constant PERIOD = 1;
    uint256 public constant COVER_ID = 1;
    bytes32 public constant MARKET_ID = bytes32(uint256(0xAA));
    uint256 public constant POOL = 40;

    uint48 internal baseTs;
    uint256 public createCount;

    uint256[] public incidentIds;
    uint256 public ghostActive;
    mapping(uint256 => bool) public terminalRecorded;
    mapping(uint256 => IIncidentManager.IncidentStatus) public terminalStatus;
    bool public fifoViolated;

    constructor(IncidentManager _im, MockIncidentManagerVault _vault, uint48 _baseTs) {
        im = _im;
        vault = _vault;
        baseTs = _baseTs;
    }

    function getIncidentIds() external view returns (uint256[] memory) {
        return incidentIds;
    }

    function _pick(uint256 seed) internal view returns (uint256) {
        if (incidentIds.length == 0) return 0;
        return incidentIds[seed % incidentIds.length];
    }

    /// First non-terminal incident in creation (== capture-timestamp) order — the FIFO-earliest payable.
    function _earliestActive() internal view returns (uint256) {
        for (uint256 i = 0; i < incidentIds.length; i++) {
            (IIncidentManager.Incident memory inc, bool ok) = im.getIncident(incidentIds[i]);
            if (!ok) continue;
            if (
                inc.status != IIncidentManager.IncidentStatus.CLOSED &&
                inc.status != IIncidentManager.IncidentStatus.CANCELED
            ) {
                return incidentIds[i];
            }
        }
        return 0;
    }

    function _record(uint256 id) internal {
        if (id == 0 || terminalRecorded[id]) return;
        (IIncidentManager.Incident memory inc, bool ok) = im.getIncident(id);
        if (!ok) return;
        if (
            inc.status == IIncidentManager.IncidentStatus.CLOSED ||
            inc.status == IIncidentManager.IncidentStatus.CANCELED
        ) {
            terminalRecorded[id] = true;
            terminalStatus[id] = inc.status;
            ghostActive--;
        }
    }

    function createIncident(uint256) external {
        if (createCount >= POOL) return;
        uint48 ts = baseTs + uint48(createCount);
        bytes32 ref = bytes32(uint256(createCount + 1));
        uint256 id = im.createIncident(ts, "incident", ref);
        incidentIds.push(id);
        ghostActive++;
        createCount++;
    }

    function confirm(uint256 idSeed) external {
        uint256 id = _pick(idSeed);
        try im.confirmIncident(id, "uri") {} catch {}
        _record(id);
    }

    function addLosses(uint256 idSeed, uint256 amtSeed) external {
        uint256 id = _pick(idSeed);
        IIncidentManager.AssessmentLoss[] memory losses = new IIncidentManager.AssessmentLoss[](1);
        losses[0] = IIncidentManager.AssessmentLoss({
            coverTokenId: COVER_ID,
            marketId: MARKET_ID,
            amount: bound(amtSeed, 1, 1e24)
        });
        try im.addAssessmentLosses(id, losses) {} catch {}
        _record(id);
    }

    function submit(uint256 idSeed) external {
        uint256 id = _pick(idSeed);
        try im.submitCurrentAssessment(id) {} catch {}
        _record(id);
    }

    function approveSpecific(uint256 idSeed) external {
        uint256 id = _pick(idSeed);
        uint256 earliest = _earliestActive();
        try im.approveCurrentAssessment(id) {
            if (id != earliest) fifoViolated = true;
            _record(id);
        } catch {}
    }

    function reject(uint256 idSeed) external {
        uint256 id = _pick(idSeed);
        try im.rejectCurrentAssessment(id) {} catch {}
        _record(id);
    }

    function cancelPre(uint256 idSeed) external {
        uint256 id = _pick(idSeed);
        try im.cancelPreAssessmentIncident(id, "reason") {} catch {}
        _record(id);
    }

    function cancelInc(uint256 idSeed) external {
        uint256 id = _pick(idSeed);
        try im.cancelIncident(id, "reason") {} catch {}
        _record(id);
    }
}
