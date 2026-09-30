// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FirelightVault} from "contracts/core/FirelightVault.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";

/// @notice Stresses the payout waterfall (the proportional active/withdrawal split + overflow reroute in
/// FirelightVault.payout) together with direct donations (x-ray I-11) and LP flows, under valid payout
/// preconditions, so that any arithmetic revert in the reroute math surfaces as a flag (x-ray X-3).
/// The handler itself holds PAYOUT_ROLE; `receiver` is pre-allowlisted by the test.
contract FirelightVaultPayoutHandler is Test {
    FirelightVault public vault;
    MockERC20 public asset;
    address public receiver;

    uint256 public constant NUM_ACTORS = 4;
    address[] public actors;

    /// Set true if a payout reverted despite satisfying all documented preconditions (allowlisted
    /// receiver, amount > 0, capture period inside the payout window) — i.e. an unexpected/arith revert.
    bool public payoutRevertedUnexpectedly;
    bytes public lastRevert;

    /// Every withdrawal period a request has landed in — lets invariants iterate the buckets that
    /// actually exist (including drained/decoupled ones) instead of guessing period numbers.
    uint256[] public touchedPeriods;
    mapping(uint256 => bool) internal _periodSeen;

    /// Count of times drainAndReenter reached the full decoupling (bucket assets == 0, shares > 0).
    uint256 public decouplingsReached;

    constructor(FirelightVault _vault, MockERC20 _asset, address _receiver) {
        vault = _vault;
        asset = _asset;
        receiver = _receiver;
        for (uint256 i = 0; i < NUM_ACTORS; i++) {
            actors.push(address(uint160(uint256(keccak256(abi.encode("flt.payout.actor", i))))));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _recordPeriod(uint256 period) internal {
        if (!_periodSeen[period]) {
            _periodSeen[period] = true;
            touchedPeriods.push(period);
        }
    }

    function _mintApproveDeposit(address who, uint256 amount) internal {
        asset.mint(who, amount);
        vm.prank(who);
        asset.approve(address(vault), amount);
        vm.prank(who);
        vault.deposit(amount, who);
    }

    function deposit(uint256 assetsSeed, uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        uint256 maxDep = vault.maxDeposit(actor);
        if (maxDep == 0) return;
        uint256 assets = bound(assetsSeed, 1, maxDep > 1e26 ? 1e26 : maxDep);
        asset.mint(actor, assets);
        // Single-shot pranks (leak-safe): a startPrank left open by a reverting call would leak the
        // actor identity into the next handler action (e.g. payout would run as the actor, not the handler).
        vm.prank(actor);
        asset.approve(address(vault), assets);
        vm.prank(actor);
        vault.deposit(assets, actor);
    }

    function requestWithdraw(uint256 sharesSeed, uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        uint256 bal = vault.balanceOf(actor);
        if (bal == 0) return;
        uint256 shares = bound(sharesSeed, 1, bal);
        _recordPeriod(vault.currentPeriod() + 1);
        vm.prank(actor);
        vault.redeem(shares, actor, actor);
    }

    /// Directed action that manufactures the payout/withdraw-share DECOUPLING and then re-enters the
    /// same bucket — the exact state random fuzzing rarely lines up (drove the F1 finding). Recipe:
    ///   1) actor A deposits D, one period elapses, A withdraws everything -> bucket = D assets / D shares
    ///   2) an incident payout drains that bucket's ASSETS to 0 (shares are left untouched -> decoupled)
    ///   3) a second actor B deposits + requests into that SAME still-open bucket (assets 0, shares > 0)
    /// The bucket-solvency invariant then checks this decoupled state cannot over-credit claims.
    function drainAndReenter(uint256 dSeed, uint256 reenterSeed) external {
        address a = _actor(dSeed);
        uint256 depositAmt = bound(dSeed, 1e12, 1e24);

        // (1) A takes a position, a period elapses, A withdraws all -> a funded bucket forms.
        _mintApproveDeposit(a, depositAmt);
        vm.warp(block.timestamp + 1 days + 1);
        uint48 captureTs = vault.currentPeriodStart();
        uint256 bucket = vault.currentPeriod() + 1;

        uint256 balA = vault.balanceOf(a);
        if (balA == 0) return;
        vm.prank(a);
        uint256 bucketAssets = vault.redeem(balA, a, a);

        // (2) payout drains the bucket's assets to 0 (exposure cap == assetsAtCapture == depositAmt).
        try vault.payout(receiver, bucketAssets, captureTs) returns (uint256) {
            // expected
        } catch (bytes memory reason) {
            payoutRevertedUnexpectedly = true;
            lastRevert = reason;
            return;
        }

        _recordPeriod(bucket);
        if (vault.withdrawAssets(bucket) == 0 && vault.withdrawShares(bucket) > 0) {
            decouplingsReached++;
        }

        // (3) B re-enters the same, now-decoupled bucket (still current period, no warp).
        address b = _actor(reenterSeed);
        if (b == a) b = _actor(reenterSeed + 1);
        uint256 reenterAmt = bound(reenterSeed, 1, 1e24);
        _mintApproveDeposit(b, reenterAmt);
        uint256 balB = vault.balanceOf(b);
        if (balB == 0) return;
        vm.prank(b);
        vault.redeem(balB, b, b);
    }

    /// Direct asset transfer into the vault (not via deposit) — exercises I-11.
    function donate(uint256 amountSeed) external {
        uint256 amount = bound(amountSeed, 1, 1e24);
        asset.mint(address(vault), amount);
    }

    function warp(uint256 timeSeed) external {
        uint256 delta = bound(timeSeed, 1 hours, 3 days);
        vm.warp(block.timestamp + delta);
    }

    /// Calls payout with valid preconditions, alternating between same-period and following-period
    /// (the latter exercises the overflow-reroute branch). Any revert here is unexpected.
    function payout(uint256 amountSeed, bool followingPeriod) external {
        uint256 cur = vault.currentPeriod();
        uint48 captureTimestamp;
        if (followingPeriod) {
            if (cur < 1) return;
            uint48 start = vault.currentPeriodStart();
            if (start == 0) return;
            captureTimestamp = start - 1; // one second before current period start -> previous period
        } else {
            captureTimestamp = uint48(block.timestamp); // current period
        }

        uint256 amount = bound(amountSeed, 1, 1e27);

        try vault.payout(receiver, amount, captureTimestamp) returns (uint256) {
            // success (paidAmount may be 0) — expected
        } catch (bytes memory reason) {
            payoutRevertedUnexpectedly = true;
            lastRevert = reason;
        }
    }

    function sumActorBalances() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += vault.balanceOf(actors[i]);
        }
    }

    // --- introspection for invariants ---

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function touchedPeriodsLength() external view returns (uint256) {
        return touchedPeriods.length;
    }
}
