// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {IFirelightVault} from "../core/interfaces/IFirelightVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @dev Minimal mock of IFirelightVault for CoverOrderAllocator tests.
 *
 *      CoverOrderAllocator only consumes `currentPeriod`, `totalAssetsAt`,
 *      `currentPeriodStart` and `periodConfigurationAtNumber`. All other interface members are stubbed with
 *      safe zero / no-op defaults so the mock satisfies the full interface but is
 *      not exercised beyond the CoverOrderAllocator's needs.
 */
contract MockCoverOrderAllocatorVault is IFirelightVault {
    uint256 private _currentPeriod;
    uint256 private _totalAssets;
    address private _asset;
    uint48 private _currentPeriodStart;
    bool private _hasSnapshot;
    uint256 private _totalAssetsAtSnapshot;
    mapping(uint256 => PeriodConfiguration) private _periodConfigs;

    // -------------------------------------------------------------------------
    // Test setters
    // -------------------------------------------------------------------------

    constructor() {
        // Mirror FirelightVault semantics: a period is always "in progress", so
        // its start is never in the future and never zero on a live chain.
        _currentPeriodStart = uint48(block.timestamp);
    }

    function setCurrentPeriod(uint256 p) external {
        _currentPeriod = p;
        // Mirror FirelightVault semantics for the off-chain matcher: the current
        // period started the moment it rolled. The off-chain engine pins its
        // matching reads to the first block at/after this timestamp. Tests that
        // need a different start can still override via setCurrentPeriodStart.
        _currentPeriodStart = uint48(block.timestamp);
    }
    function setTotalAssets(uint256 a) external { _totalAssets = a; }
    function setAsset(address a) external { _asset = a; }
    function setCurrentPeriodStart(uint48 ts) external { _currentPeriodStart = ts; }
    function setTotalAssetsAtSnapshot(uint256 a) external {
        _totalAssetsAtSnapshot = a;
        _hasSnapshot = true;
    }
    function setPeriodConfiguration(uint256 periodNumber, PeriodConfiguration calldata cfg) external {
        _periodConfigs[periodNumber] = cfg;
    }

    // -------------------------------------------------------------------------
    // Functions exercised by CoverOrderAllocator
    // -------------------------------------------------------------------------

    function currentPeriod() external view override returns (uint256) { return _currentPeriod; }
    function isPeriodInPayoutWindow(uint256 period) external view override returns (bool) {
        return _currentPeriod == period || _currentPeriod == period + 1;
    }
    function totalAssets() external view override returns (uint256) { return _totalAssets; }

    function periodConfigurationAtNumber(uint256 periodNumber)
        external
        view
        override
        returns (PeriodConfiguration memory)
    {
        return _periodConfigs[periodNumber];
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

    function asset() external view override returns (address) { return _asset; }
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

    function periodConfigurations(uint256)
        external
        pure
        override
        returns (uint48, uint48, uint256)
    {
        return (0, 0, 0);
    }

    function withdrawShares(uint256) external pure override returns (uint256) { return 0; }
    function withdrawAssets(uint256) external pure override returns (uint256) { return 0; }
    function withdrawSharesOf(uint256, address) external pure override returns (uint256) { return 0; }
    function isWithdrawClaimed(uint256, address) external pure override returns (bool) { return false; }
    function isBlocklisted(address) external pure override returns (bool) { return false; }

    // -------------------------------------------------------------------------
    // Initialization stub
    // -------------------------------------------------------------------------

    function initialize(IERC20, string memory, string memory, bytes memory) external override {}

    // -------------------------------------------------------------------------
    // Period query stubs
    // -------------------------------------------------------------------------

    function periodConfigurationAtTimestamp(uint48)
        external
        pure
        override
        returns (PeriodConfiguration memory pc)
    {
        return pc;
    }

    function periodAtTimestamp(uint48) external pure override returns (uint256) { return 0; }

    function currentPeriodConfiguration()
        external
        pure
        override
        returns (PeriodConfiguration memory pc)
    {
        return pc;
    }

    function currentPeriodStart() external view override returns (uint48) { return _currentPeriodStart; }
    function currentPeriodEnd() external pure override returns (uint48) { return 0; }
    function nextPeriodEnd() external pure override returns (uint48) { return 0; }
    function periodConfigurationsLength() external pure override returns (uint256) { return 0; }

    // -------------------------------------------------------------------------
    // Historical query stubs
    // -------------------------------------------------------------------------

    function balanceOfAt(address, uint48) external pure override returns (uint256) { return 0; }
    function totalSupplyAt(uint48) external pure override returns (uint256) { return 0; }
    function totalAssetsAt(uint48) external view override returns (uint256) {
        return _hasSnapshot ? _totalAssetsAtSnapshot : _totalAssets;
    }
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
    // Incident stubs
    // -------------------------------------------------------------------------

    function hasActiveIncident(uint256) external pure override returns (bool) { return false; }
    function setActiveIncident(uint256, bool) external override {}
    function checkpointTotalAssets() external override {}

    // -------------------------------------------------------------------------
    // Admin / configuration stubs
    // -------------------------------------------------------------------------

    function updateDepositLimit(uint256) external override {}
    function addPeriodConfiguration(uint48, uint48) external override {}

    // -------------------------------------------------------------------------
    // Blocklist stubs
    // -------------------------------------------------------------------------

    function addToBlocklist(address) external override {}
    function removeFromBlocklist(address) external override {}

    // -------------------------------------------------------------------------
    // Rescue stubs
    // -------------------------------------------------------------------------

    function rescueSharesFromBlocklisted(address, address) external override {}
    function rescueWithdrawFromBlocklisted(address, address, uint256[] calldata) external override {}


    // -------------------------------------------------------------------------
    // Firelight V2 
    // -------------------------------------------------------------------------

    function payout(address, uint256 amount, uint48) external pure override returns (uint256 paidAmount) {
        return amount;
    }
}
