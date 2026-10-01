// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console} from "forge-std/console.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {FirelightVault} from "contracts/core/FirelightVault.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";
import {FirelightVaultPayoutHandler} from "../harness/FirelightVaultPayoutHandler.sol";

/// @notice Stateful invariants for FirelightVault including incident payouts + donations.
/// Targets x-ray X-3 (payout per-call caps / reroute math never underflows) and I-2 / I-11 solvency.
contract FirelightVaultPayoutInvariant is Test {
    FirelightVault internal vault;
    MockERC20 internal asset;
    FirelightVaultPayoutHandler internal handler;

    address internal receiver = address(0xBEEF);

    function setUp() public {
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
            FirelightVault.initialize.selector,
            IERC20(address(asset)),
            "Firelight Vault",
            "fVLT",
            abi.encode(p)
        );
        vault = FirelightVault(address(new ERC1967Proxy(address(impl), initCall)));

        handler = new FirelightVaultPayoutHandler(vault, asset, receiver);

        // Grant the handler payout power and allowlist the receiver (test contract is DEFAULT_ADMIN).
        vault.grantRole(vault.PAYOUT_ROLE(), address(handler));
        vault.grantRole(vault.PAYOUT_ALLOWLIST_ROLE(), address(this));
        vault.addToPayoutAllowlist(receiver);

        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.requestWithdraw.selector;
        selectors[2] = handler.donate.selector;
        selectors[3] = handler.warp.selector;
        selectors[4] = handler.payout.selector;
        selectors[5] = handler.drainAndReenter.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// Sanity: the directed action deterministically reaches the decoupling from a clean state
    /// (bucket assets drained to 0, shares left > 0). Proves the fuzzer is actually exploring the
    /// F1 state — not just calling drainAndReenter and bailing out early.
    function test_drainAndReenter_reachesDecoupling() public {
        handler.drainAndReenter(1e21, 12345);

        // The decoupling was hit mid-action (bucket assets == 0, shares > 0 right after the payout).
        assertGe(handler.decouplingsReached(), 1, "directed action never reached the decoupling");

        // After B re-enters, the ratio distortion persists: withdrawShares vastly exceeds
        // withdrawAssets (B was over-credited shares against the drained bucket).
        uint256 n = handler.touchedPeriodsLength();
        uint256 bucket = handler.touchedPeriods(n - 1);
        assertGt(vault.withdrawShares(bucket), vault.withdrawAssets(bucket), "no ratio distortion");
    }

    /// X-3: payout with valid preconditions must never revert (catches reroute underflow / mis-scaling).
    function invariant_payoutNeverRevertsUnexpectedly() public view {
        if (handler.payoutRevertedUnexpectedly()) {
            console.logBytes(handler.lastRevert());
        }
        assertFalse(handler.payoutRevertedUnexpectedly(), "payout reverted under valid preconditions");
    }

    /// I-2: solvency holds even with payouts + donations.
    function invariant_pendingNeverExceedsBalance() public view {
        assertLe(vault.pendingWithdrawAssets(), asset.balanceOf(address(vault)), "pending > balance");
    }

    /// totalAssets() never underflows (= balance - pending).
    function invariant_totalAssetsConsistent() public view {
        assertEq(
            vault.totalAssets(),
            asset.balanceOf(address(vault)) - vault.pendingWithdrawAssets(),
            "totalAssets mismatch"
        );
    }

    /// No phantom shares even after donations (donations mint no shares).
    function invariant_noPhantomShares() public view {
        assertEq(handler.sumActorBalances(), vault.totalSupply(), "sum balances != totalSupply");
    }

    /// Bucket solvency (the property the payout/withdraw-share DECOUPLING could break): for every
    /// withdrawal period, the sum of assets all holders can claim never exceeds the assets actually
    /// earmarked in that bucket. Even when payout drains withdrawAssets[p] to 0 while withdrawShares[p]
    /// stays > 0 (the F1 decoupling), the claim formula divides back by the same inflated share supply,
    /// so no holder is over-paid and the bucket can never owe more than it holds.
    function invariant_bucketClaimsNeverExceedBucketAssets() public view {
        uint256 nPeriods = handler.touchedPeriodsLength();
        uint256 nActors = handler.actorsLength();
        for (uint256 i = 0; i < nPeriods; i++) {
            uint256 p = handler.touchedPeriods(i);
            uint256 totShares = vault.withdrawShares(p);
            if (totShares == 0) continue;
            uint256 totAssets = vault.withdrawAssets(p);

            uint256 sumClaim;
            for (uint256 j = 0; j < nActors; j++) {
                uint256 s = vault.withdrawSharesOf(p, handler.actorAt(j));
                // Mirror FirelightVault._convertToAssetsTotals (Floor, _decimalsOffset == 0).
                sumClaim += Math.mulDiv(s, totAssets + 1, totShares + 1, Math.Rounding.Floor);
            }
            assertLe(sumClaim, totAssets, "bucket over-credits claims vs earmarked assets");
        }
    }
}
