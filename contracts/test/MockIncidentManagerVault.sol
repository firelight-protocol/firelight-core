// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IFirelightVault} from "../core/interfaces/IFirelightVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Minimal IFirelightVault mock for IncidentManager tests.
 *
 *      IncidentManager consumes: `asset()` (once in initialize), `periodAtTimestamp`, `currentPeriod`
 *      and `payout`. All are settable so tests can drive incident periods, expiry checks and
 *      the amount the vault reports as paid. Everything else is stubbed to safe defaults.
 */
contract MockIncidentManagerVault is IFirelightVault {
    uint256 private _currentPeriod;
    address private _asset;
    mapping(uint48 => uint256) private _periodAtTimestamp;

    // When set, `payout` returns this fixed value; otherwise it echoes the requested amount.
    bool private _payoutReturnIsSet;
    uint256 private _payoutReturn;

    // -------------------------------------------------------------------------
    // Test setters
    // -------------------------------------------------------------------------

    function setCurrentPeriod(uint256 p) external { _currentPeriod = p; }
    function setAsset(address a) external { _asset = a; }
    function setPeriodAtTimestamp(uint48 timestamp, uint256 period) external {
        _periodAtTimestamp[timestamp] = period;
    }
    function isPeriodInPayoutWindow(uint256 period) external view override returns (bool) {
        return _currentPeriod == period || _currentPeriod == period + 1;
    }
    function setPayoutReturn(uint256 r) external { _payoutReturn = r; _payoutReturnIsSet = true; }

    // -------------------------------------------------------------------------
    // Functions exercised by IncidentManager
    // -------------------------------------------------------------------------

    function currentPeriod() external view override returns (uint256) { return _currentPeriod; }
    function asset() external view override returns (address) { return _asset; }

    function periodAtTimestamp(uint48 timestamp) external view override returns (uint256) {
        return _periodAtTimestamp[timestamp];
    }

    function payout(address, uint256 amount, uint48) external view override returns (uint256 paidAmount) {
        if (_payoutReturnIsSet) return _payoutReturn;
        return amount;
    }

    // -------------------------------------------------------------------------
    // IERC20 / IERC20Metadata stubs
    // -------------------------------------------------------------------------

    function name() external pure override returns (string memory) { return ""; }
    function symbol() external pure override returns (string memory) { return ""; }
    function decimals() external pure override returns (uint8) { return 18; }
    function totalSupply() external pure override returns (uint256) { return 0; }
    function balanceOf(address) external pure override returns (uint256) { return 0; }
    function transfer(address, uint256) external pure override returns (bool) { return false; }
    function allowance(address, address) external pure override returns (uint256) { return 0; }
    function approve(address, uint256) external pure override returns (bool) { return false; }
    function transferFrom(address, address, uint256) external pure override returns (bool) { return false; }

    // -------------------------------------------------------------------------
    // IERC4626 stubs
    // -------------------------------------------------------------------------

    function convertToShares(uint256) external pure override returns (uint256) { return 0; }
    function convertToAssets(uint256) external pure override returns (uint256) { return 0; }
    function maxDeposit(address) external pure override returns (uint256) { return 0; }
    function previewDeposit(uint256) external pure override returns (uint256) { return 0; }
    function deposit(uint256, address) external pure override returns (uint256) { return 0; }
    function maxMint(address) external pure override returns (uint256) { return 0; }
    function previewMint(uint256) external pure override returns (uint256) { return 0; }
    function mint(uint256, address) external pure override returns (uint256) { return 0; }
    function maxWithdraw(address) external pure override returns (uint256) { return 0; }
    function previewWithdraw(uint256) external pure override returns (uint256) { return 0; }
    function withdraw(uint256, address, address) external pure override returns (uint256) { return 0; }
    function maxRedeem(address) external pure override returns (uint256) { return 0; }
    function previewRedeem(uint256) external pure override returns (uint256) { return 0; }
    function redeem(uint256, address, address) external pure override returns (uint256) { return 0; }

    // -------------------------------------------------------------------------
    // IAccessControl stubs
    // -------------------------------------------------------------------------

    function hasRole(bytes32, address) external pure override returns (bool) { return false; }
    function getRoleAdmin(bytes32) external pure override returns (bytes32) { return bytes32(0); }
    function grantRole(bytes32, address) external override {}
    function revokeRole(bytes32, address) external override {}
    function renounceRole(bytes32, address) external override {}

    // -------------------------------------------------------------------------
    // Role / constant getters
    // -------------------------------------------------------------------------

    function DEPOSIT_LIMIT_UPDATE_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function RESCUER_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function BLOCKLIST_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function PAUSE_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function PERIOD_CONFIGURATION_UPDATE_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function SMALLEST_PERIOD_DURATION() external pure override returns (uint48) { return 0; }
    function MAX_PERIOD_DURATION() external pure override returns (uint48) { return 0; }
    function PAYOUT_ALLOWLIST_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function PAYOUT_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function INCIDENT_ROLE() external pure override returns (bytes32) { return bytes32(0); }
    function CHECKPOINT_ROLE() external pure override returns (bytes32) { return bytes32(0); }

    // -------------------------------------------------------------------------
    // Storage-getter stubs
    // -------------------------------------------------------------------------

    function depositLimit() external pure override returns (uint256) { return 0; }
    function contractVersion() external pure override returns (uint256) { return 0; }
    function pendingWithdrawAssets() external pure override returns (uint256) { return 0; }

    function periodConfigurations(uint256) external pure override returns (uint48, uint48, uint256) {
        return (0, 0, 0);
    }

    function withdrawShares(uint256) external pure override returns (uint256) { return 0; }
    function withdrawAssets(uint256) external pure override returns (uint256) { return 0; }
    function withdrawSharesOf(uint256, address) external pure override returns (uint256) { return 0; }
    function isWithdrawClaimed(uint256, address) external pure override returns (bool) { return false; }
    function isBlocklisted(address) external pure override returns (bool) { return false; }
    function isPayoutAllowlisted(address) external pure override returns (bool) { return false; }

    // -------------------------------------------------------------------------
    // Initialization stub
    // -------------------------------------------------------------------------

    function initialize(IERC20, string memory, string memory, bytes memory) external override {}

    // -------------------------------------------------------------------------
    // Period query stubs
    // -------------------------------------------------------------------------

    function periodConfigurationAtTimestamp(uint48) external pure override returns (PeriodConfiguration memory pc) {
        return pc;
    }

    function periodConfigurationAtNumber(uint256) external pure override returns (PeriodConfiguration memory pc) {
        return pc;
    }

    function currentPeriodConfiguration() external pure override returns (PeriodConfiguration memory pc) {
        return pc;
    }

    function currentPeriodStart() external pure override returns (uint48) { return 0; }
    function currentPeriodEnd() external pure override returns (uint48) { return 0; }
    function nextPeriodEnd() external pure override returns (uint48) { return 0; }
    function periodConfigurationsLength() external pure override returns (uint256) { return 0; }

    function totalAssets() external pure override returns (uint256) { return 0; }

    // -------------------------------------------------------------------------
    // Historical query stubs
    // -------------------------------------------------------------------------

    function balanceOfAt(address, uint48) external pure override returns (uint256) { return 0; }
    function totalSupplyAt(uint48) external pure override returns (uint256) { return 0; }
    function totalAssetsAt(uint48) external pure override returns (uint256) { return 0; }
    function withdrawalsOf(uint256, address) external pure override returns (uint256) { return 0; }

    // -------------------------------------------------------------------------
    // Withdrawal lifecycle stub
    // -------------------------------------------------------------------------

    function claimWithdraw(uint256) external pure override returns (uint256) { return 0; }

    // -------------------------------------------------------------------------
    // Pausing stubs
    // -------------------------------------------------------------------------

    function paused() external pure override returns (bool) { return false; }
    function pause() external override {}
    function unpause() external override {}

    // -------------------------------------------------------------------------
    // Admin / configuration stubs
    // -------------------------------------------------------------------------

    function updateDepositLimit(uint256) external override {}
    function addPeriodConfiguration(uint48, uint48) external override {}
    function checkpointTotalAssets() external override {}

    // -------------------------------------------------------------------------
    // Blocklist stubs
    // -------------------------------------------------------------------------

    function addToBlocklist(address) external override {}
    function removeFromBlocklist(address) external override {}

    // -------------------------------------------------------------------------
    // Payout allowlist stubs
    // -------------------------------------------------------------------------

    function addToPayoutAllowlist(address) external override {}
    function removeFromPayoutAllowlist(address) external override {}

    // -------------------------------------------------------------------------
    // Rescue stubs
    // -------------------------------------------------------------------------

    function rescueSharesFromBlocklisted(address, address) external override {}
    function rescueWithdrawFromBlocklisted(address, address, uint256[] calldata) external override {}


    // -------------------------------------------------------------------------
    // Incident stubs
    // -------------------------------------------------------------------------
    
    function hasActiveIncident(uint256) external pure override returns (bool) {return false;}
    function setActiveIncident(uint256, bool) external override {}

}
