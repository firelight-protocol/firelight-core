// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FirelightVault} from "contracts/core/FirelightVault.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";

/// @notice Regression / verification harness for audit Finding F1:
/// `payout` reduces `withdrawAssets[period]` but never `withdrawShares[period]`, while that same
/// period is still the target for new withdrawal requests. This test EMPIRICALLY checks the three
/// claims made about F1:
///   (A) the decoupling is real (a payout can leave withdrawAssets[P]==0 with withdrawShares[P]>0);
///   (B) a new requester into that period is over-credited withdraw-shares (ratio poisoning);
///   (C) whether the economic-agent's geometric "overflow DoS" is actually reachable;
///   (D) whether a late entrant suffers material loss, or only dust, at realistic (1e18) scale.
/// No contract fix is applied — this documents the true behavior before any fix.
contract F1PayoutShareDecoupling is Test {
    FirelightVault internal vault;
    MockERC20 internal asset;

    address internal alice = address(0xA11CE);
    address internal receiver = address(0xBEEF);

    uint48 internal start;
    uint256 internal constant D = 1000e18; // Alice's deposit/withdrawal

    function setUp() public {
        start = uint48(1_000_000); // realistic, positive timestamp
        vm.warp(start);

        asset = new MockERC20("Mock Asset", "mASSET", 18);
        FirelightVault impl = new FirelightVault();
        FirelightVault.InitParams memory p = FirelightVault.InitParams({
            defaultAdmin: address(this),
            limitUpdater: address(this),
            blocklister: address(this),
            pauser: address(this),
            periodConfigurationUpdater: address(this),
            rescuer: address(this),
            depositLimit: 1e30,
            periodConfigurationDuration: uint48(1 days)
        });
        bytes memory initCall = abi.encodeWithSelector(
            FirelightVault.initialize.selector, IERC20(address(asset)), "FL", "FL", abi.encode(p)
        );
        vault = FirelightVault(address(new ERC1967Proxy(address(impl), initCall)));

        vault.grantRole(vault.PAYOUT_ROLE(), address(this));
        vault.grantRole(vault.PAYOUT_ALLOWLIST_ROLE(), address(this));
        vault.addToPayoutAllowlist(receiver);

        // --- Drive the vault into the "drained withdrawal bucket" state ---
        // 1) Alice deposits D at the period-0 start (checkpoint _traceTotalAssets@start = D).
        _deposit(alice, D);
        // 2) Move within period 0, Alice withdraws everything -> bucket period 1 holds D assets / D shares,
        //    active assets drop to 0, all shares burned.
        vm.warp(start + 1 hours);
        vm.prank(alice);
        vault.withdraw(D, alice, alice);

        assertEq(vault.currentPeriod(), 0, "still period 0");
        assertEq(vault.withdrawAssets(1), D, "bucket assets");
        assertEq(vault.withdrawShares(1), D, "bucket shares");
        assertEq(vault.totalAssets(), 0, "active assets drained to pending");

        // 3) Incident payout for capture period 0 drains the full capture+1 withdrawal bucket.
        //    assetsAtCapturePeriod = totalAssetsAt(start) = D ; active = 0 -> paidFromCapture = D.
        vault.payout(receiver, D, start);

        // Post-condition: bucket assets zeroed, bucket SHARES untouched -> the decoupling.
        assertEq(vault.withdrawAssets(1), 0, "F1(A): bucket assets drained to 0");
        assertEq(vault.withdrawShares(1), D, "F1(A): bucket shares NOT reduced (decoupling)");
    }

    function _deposit(address who, uint256 amt) internal {
        asset.mint(who, amt);
        vm.prank(who);
        asset.approve(address(vault), amt);
        vm.prank(who);
        vault.deposit(amt, who);
    }

    /// F1(A): the payout left the period-1 withdrawal pool with 0 assets but a nonzero share supply.
    function test_F1_A_decouplingExists() public view {
        assertEq(vault.withdrawAssets(1), 0);
        assertGt(vault.withdrawShares(1), 0);
    }

    /// F1(B): a new requester into the drained period is credited shares wildly out of proportion
    /// to the assets they bring (denominator collapsed to withdrawAssets+1 == 1).
    function test_F1_B_newRequesterOvercredited() public {
        address bob = address(0xB0B);
        _deposit(bob, 1e18);
        vm.prank(bob);
        vault.withdraw(1e18, bob, bob); // targets period 1 (currentPeriod 0 + 1)

        uint256 bobShares = vault.withdrawSharesOf(1, bob);
        // Bob brought 1e18 assets but is credited ~ 1e18 * (withdrawShares+1) withdraw-shares.
        assertGt(bobShares, 1e30, "F1(B): grossly over-credited vs 1e18 assets brought");
        emit log_named_uint("bob withdraw-shares for 1e18 assets", bobShares);
    }

    /// F1(C): the economic-agent claimed escalating requests overflow `mulDiv` (geometric blowup).
    /// In reality each request ADDS its assets to withdrawAssets[P], so the denominator grows and the
    /// growth is LINEAR, not geometric. This test makes several large sequential requests and asserts
    /// none revert — i.e. the "overflow DoS" is NOT reachable at realistic scale.
    function test_F1_C_noOverflowDoS() public {
        for (uint256 i = 0; i < 8; i++) {
            address req = address(uint160(0xC0DE0000 + i));
            _deposit(req, 1e21); // 1000-token deposits, realistic upper end
            vm.prank(req);
            vault.withdraw(1e21, req, req); // must NOT revert (no mulDiv overflow)
        }
        // Reached here without reverting -> overflow DoS refuted at realistic scale.
        assertGt(vault.withdrawShares(1), 0);
    }

    /// F1(D): a late entrant who withdraws into the drained period and later claims — does it lose
    /// material value, or only rounding dust? Measured at 1e18 scale.
    function test_F1_D_lateEntrantLossIsDust() public {
        address carol = address(0xCA401);
        uint256 amt = 100e18;
        _deposit(carol, amt);
        // Read balance BEFORE pranking: an inline vault.balanceOf(carol) call would consume the prank,
        // leaving redeem to run as the test contract (sender != owner -> spurious share-allowance spend).
        uint256 carolShares = vault.balanceOf(carol);
        vm.prank(carol);
        vault.redeem(carolShares, carol, carol); // request into period 1

        // Advance past period 1 so the bucket is claimable.
        vm.warp(start + 2 days + 1 hours);
        assertGt(vault.currentPeriod(), 1, "period 1 claimable");

        uint256 before = asset.balanceOf(carol);
        vm.prank(carol);
        vault.claimWithdraw(1);
        uint256 received = asset.balanceOf(carol) - before;

        emit log_named_uint("carol deposited", amt);
        emit log_named_uint("carol received", received);
        // Loss should be dust (well under 1e9 wei on a 100e18 round-trip), NOT material.
        assertGe(received, amt - 1e9, "F1(D): late-entrant loss exceeds dust");
        assertLe(received, amt, "cannot profit");
    }
}
