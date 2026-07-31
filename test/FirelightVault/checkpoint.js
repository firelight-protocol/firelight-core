const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')

const DECIMALS = 6

// Deterministic period advance via absolute timestamp, immune to pending
// evm_increaseTime offsets accumulated by other suites.
const advanceOnePeriod = async (vault) => {
  await time.increaseTo((await vault.currentPeriodEnd()) + 1n)
}

const DEPOSIT = ethers.parseUnits('100', DECIMALS)
const REWARDS = ethers.parseUnits('50', DECIMALS)

// Real FirelightVault + real VaultRewardDistributor wired with CHECKPOINT_ROLE.
const checkpointFixture = async () => {
  const ctx = await deployVault()
  const distributorSigner = (await ethers.getSigners())[9]

  const Factory = await ethers.getContractFactory('VaultRewardDistributor')
  const rewarder = await upgrades.deployProxy(Factory, [
    ctx.firelight_vault.target,
    ctx.deployer.address,
    distributorSigner.address,
    ethers.ZeroAddress
  ])

  const CHECKPOINT_ROLE = await ctx.firelight_vault.CHECKPOINT_ROLE()
  await ctx.firelight_vault.connect(ctx.deployer).grantRole(CHECKPOINT_ROLE, rewarder.target)
  await ctx.firelight_vault.connect(ctx.deployer).grantRole(CHECKPOINT_ROLE, ctx.deployer.address)

  // Seed the vault through the regular deposit flow (this checkpoints on its own)
  await ctx.utils.mintAndApprove(DEPOSIT, ctx.users[0])
  await ctx.firelight_vault.connect(ctx.users[0]).deposit(DEPOSIT, ctx.users[0].address)

  // Fund the distributor with vault assets and approve the rewarder to pull them
  await ctx.token_contract.mintTo(distributorSigner.address, REWARDS)
  await ctx.token_contract.connect(distributorSigner).approve(rewarder.target, REWARDS)

  return { ...ctx, rewarder, distributorSigner }
}

describe('FirelightVault totalAssets checkpointing', function () {

  it('documents the desync: a donation without checkpoint is missed by the next period-start snapshot', async () => {
    const ctx = await loadFixture(checkpointFixture)

    // Forward assets directly (donation-style, like the pre-fix distributor did)
    await ctx.token_contract.mintTo(ctx.firelight_vault.target, REWARDS)

    expect(await ctx.firelight_vault.totalAssets()).to.equal(DEPOSIT + REWARDS)   // live view sees it
    await advanceOnePeriod(ctx.firelight_vault)
    const periodStart = await ctx.firelight_vault.currentPeriodStart()
    expect(await ctx.firelight_vault.totalAssetsAt(periodStart)).to.equal(DEPOSIT) // history does not
  })

  it('reverts checkpointTotalAssets without CHECKPOINT_ROLE', async () => {
    const ctx = await loadFixture(checkpointFixture)
    await expect(ctx.firelight_vault.connect(ctx.users[0]).checkpointTotalAssets())
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('records the live total assets, net of pending withdrawals', async () => {
    const ctx = await loadFixture(checkpointFixture)
    const withdrawal = ethers.parseUnits('20', DECIMALS)

    await ctx.firelight_vault.connect(ctx.users[0]).withdraw(withdrawal, ctx.users[0].address, ctx.users[0].address)
    await ctx.token_contract.mintTo(ctx.firelight_vault.target, REWARDS)

    const expected = DEPOSIT - withdrawal + REWARDS
    await expect(ctx.firelight_vault.connect(ctx.deployer).checkpointTotalAssets())
      .to.emit(ctx.firelight_vault, 'TotalAssetsCheckpointed').withArgs(expected)

    expect(await ctx.firelight_vault.totalAssetsAt(await time.latest())).to.equal(expected)
  })

  it('distributeRewards checkpoints atomically so the next period-start snapshot includes the rewards', async () => {
    const ctx = await loadFixture(checkpointFixture)

    await expect(
      ctx.rewarder.connect(ctx.distributorSigner).distributeRewards(REWARDS, ctx.token_contract.target, 1n, await time.latest())
    )
      .to.emit(ctx.firelight_vault, 'TotalAssetsCheckpointed').withArgs(DEPOSIT + REWARDS)
      .and.to.emit(ctx.rewarder, 'RewardsDistributed')

    await advanceOnePeriod(ctx.firelight_vault)
    const periodStart = await ctx.firelight_vault.currentPeriodStart()

    // The finding's exact scenario: the new period's snapshot now includes the rewards
    expect(await ctx.firelight_vault.totalAssetsAt(periodStart)).to.equal(DEPOSIT + REWARDS)

    // And the payout exposure cap sees them too: a larger request is capped at deposit + rewards
    const captureTs = await time.latest()
    const requested = ethers.parseUnits('200', DECIMALS)
    await expect(ctx.firelight_vault.connect(ctx.payout_signer).payout(ctx.payout_receiver.address, requested, captureTs))
      .to.emit(ctx.firelight_vault, 'PayoutExecuted')
      .withArgs(ctx.payout_receiver.address, requested, DEPOSIT + REWARDS, captureTs)
  })

  it('distributeIncentive checkpoints as well', async () => {
    const ctx = await loadFixture(checkpointFixture)

    await expect(ctx.rewarder.connect(ctx.distributorSigner).distributeIncentive(REWARDS, ethers.id('incentive-1')))
      .to.emit(ctx.firelight_vault, 'TotalAssetsCheckpointed').withArgs(DEPOSIT + REWARDS)
      .and.to.emit(ctx.rewarder, 'IncentiveDistributed')
  })

  it('reverts distribution if the distributor lacks CHECKPOINT_ROLE on the vault', async () => {
    const ctx = await loadFixture(checkpointFixture)
    const CHECKPOINT_ROLE = await ctx.firelight_vault.CHECKPOINT_ROLE()
    await ctx.firelight_vault.connect(ctx.deployer).revokeRole(CHECKPOINT_ROLE, ctx.rewarder.target)

    await expect(
      ctx.rewarder.connect(ctx.distributorSigner).distributeRewards(REWARDS, ctx.token_contract.target, 1n, await time.latest())
    ).to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
  })
})
