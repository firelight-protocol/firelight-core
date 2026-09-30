// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {FirelightVault} from "contracts/core/FirelightVault.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";

/// @notice Drives pure LP flows (deposit / redeem / claim / transfer) plus time advancement against a
/// live FirelightVault, mirroring `pendingWithdrawAssets` in a ghost so the accounting invariants
/// (x-ray I-1 / I-2) are checked against an independent model. No payout / incident here — that path
/// has a separate handler so the exact ghost-pending equality is not perturbed by the payout haircut.
contract FirelightVaultHandler is Test {
    FirelightVault public vault;
    MockERC20 public asset;

    uint256 public constant NUM_ACTORS = 4;
    address[] public actors;

    /// Independent mirror of vault.pendingWithdrawAssets() under LP flows only.
    uint256 public ghostPending;

    constructor(FirelightVault _vault, MockERC20 _asset) {
        vault = _vault;
        asset = _asset;
        for (uint256 i = 0; i < NUM_ACTORS; i++) {
            actors.push(address(uint160(uint256(keccak256(abi.encode("flt.actor", i))))));
        }
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 assetsSeed, uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        uint256 maxDep = vault.maxDeposit(actor);
        if (maxDep == 0) return;
        uint256 assets = bound(assetsSeed, 1, maxDep > 1e27 ? 1e27 : maxDep);

        asset.mint(actor, assets);
        // Single-shot pranks (leak-safe): avoid a startPrank leaking the actor into the next action.
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

        vm.prank(actor);
        uint256 assets = vault.redeem(shares, actor, actor);
        ghostPending += assets;
    }

    function claim(uint256 periodSeed, uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        uint256 cur = vault.currentPeriod();
        if (cur < 2) return; // nothing is claimable until a full period elapses past the request
        uint256 period = bound(periodSeed, 0, cur - 1);

        vm.prank(actor);
        try vault.claimWithdraw(period) returns (uint256 assets) {
            ghostPending -= assets;
        } catch {
            // already claimed / nothing for this (period, actor) / not yet claimable — ignore
        }
    }

    function transferShares(uint256 sharesSeed, uint256 fromSeed, uint256 toSeed) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        if (from == to) return;
        uint256 bal = vault.balanceOf(from);
        if (bal == 0) return;
        uint256 shares = bound(sharesSeed, 1, bal);

        vm.prank(from);
        vault.transfer(to, shares);
    }

    function warp(uint256 timeSeed) external {
        uint256 delta = bound(timeSeed, 1 hours, 3 days);
        vm.warp(block.timestamp + delta);
    }

    // --- introspection for invariants ---

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function sumActorBalances() external view returns (uint256 sum) {
        for (uint256 i = 0; i < actors.length; i++) {
            sum += vault.balanceOf(actors[i]);
        }
    }
}
