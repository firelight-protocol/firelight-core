// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {FirelightVault} from "contracts/core/FirelightVault.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";
import {FirelightVaultHandler} from "../harness/FirelightVaultHandler.sol";

/// @notice Stateful invariants for FirelightVault under pure LP flows (deposit/redeem/claim/transfer/warp).
/// Targets x-ray invariants:
///   I-1  — pendingWithdrawAssets tracks the exact sum of outstanding withdrawal value (ghost mirror)
///   I-2  — pendingWithdrawAssets <= asset.balanceOf(vault) (totalAssets never underflows / solvency)
///   I-15 — share<->asset conversions never create value (round-trip is vault-favorable)
///   plus: no phantom shares (sum of balances == totalSupply)
contract FirelightVaultInvariant is Test {
    FirelightVault internal vault;
    MockERC20 internal asset;
    FirelightVaultHandler internal handler;

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

        ERC1967Proxy proxy = new ERC1967Proxy(address(impl), initCall);
        vault = FirelightVault(address(proxy));

        handler = new FirelightVaultHandler(vault, asset);

        // Only the LP-flow actions are fuzzed.
        bytes4[] memory selectors = new bytes4[](5);
        selectors[0] = handler.deposit.selector;
        selectors[1] = handler.requestWithdraw.selector;
        selectors[2] = handler.claim.selector;
        selectors[3] = handler.transferShares.selector;
        selectors[4] = handler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// I-1: the global pending counter equals the independently-tracked sum of outstanding withdrawals.
    function invariant_pendingMatchesGhost() public view {
        assertEq(vault.pendingWithdrawAssets(), handler.ghostPending(), "pending != ghost");
    }

    /// I-2: pending can never exceed the vault's real balance (totalAssets() would otherwise underflow).
    function invariant_pendingNeverExceedsBalance() public view {
        assertLe(vault.pendingWithdrawAssets(), asset.balanceOf(address(vault)), "pending > balance");
    }

    /// totalAssets() must never revert and must equal balance - pending.
    function invariant_totalAssetsConsistent() public view {
        assertEq(
            vault.totalAssets(),
            asset.balanceOf(address(vault)) - vault.pendingWithdrawAssets(),
            "totalAssets mismatch"
        );
    }

    /// No phantom shares: the sum over all actors equals totalSupply (handler covers every holder).
    function invariant_noPhantomShares() public view {
        assertEq(handler.sumActorBalances(), vault.totalSupply(), "sum balances != totalSupply");
    }

    /// I-15: round-tripping assets -> shares -> assets never creates value.
    function invariant_shareRoundTripNoValueCreation() public view {
        uint256[3] memory samples = [uint256(1), 1e18, 1e24];
        for (uint256 i = 0; i < samples.length; i++) {
            uint256 a = samples[i];
            assertLe(vault.convertToAssets(vault.convertToShares(a)), a, "assets round-trip created value");
            uint256 s = samples[i];
            assertLe(vault.convertToShares(vault.convertToAssets(s)), s, "shares round-trip created value");
        }
    }
}
