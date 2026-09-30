const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { DECIMALS, vaultFixture, advanceOnePeriod } = require('./helpers.js')

describe('FirelightVault payout edge cases', function () {
  let ctx

  before(async () => {
    ctx = await loadFixture(vaultFixture)
  })

  it('reverts payout without PAYOUT_ROLE', async () => {
    await expect(ctx.firelight_vault.connect(ctx.users[0]).payout(ctx.payout_receiver.address, 1n, await time.latest()))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('reverts payout to a non-allowlisted receiver', async () => {
    await expect(ctx.firelight_vault.connect(ctx.payout_signer).payout(ctx.users[0].address, 1n, await time.latest()))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccountNotAllowlisted')
  })

  it('reverts payout with a zero amount', async () => {
    await expect(ctx.firelight_vault.connect(ctx.payout_signer).payout(ctx.payout_receiver.address, 0, await time.latest()))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAmount')
  })

  it('emits the payout event with zero paid amount when there is no exposure', async () => {
    const ts = await time.latest()
    const amount = ethers.parseUnits('10', DECIMALS)

    // Vault is empty: assets at the capture-period start are zero, so nothing can be paid
    await expect(ctx.firelight_vault.connect(ctx.payout_signer).payout(ctx.payout_receiver.address, amount, ts))
      .to.emit(ctx.firelight_vault, 'PayoutExecuted')
      .withArgs(ctx.payout_receiver.address, amount, 0n, ts)

    expect(await ctx.token_contract.balanceOf(ctx.payout_receiver.address)).to.equal(0n)
  })

  it('reassigns rounding overflow from capture-period withdrawals to next-period withdrawals', async () => {
    const deposit = ethers.parseUnits('150', DECIMALS)   // 150_000000
    const withdrawal = ethers.parseUnits('50', DECIMALS) // 50_000000
    const requested = ethers.parseUnits('100', DECIMALS) // 100_000000

    await ctx.utils.mintAndApprove(deposit, ctx.users[0])
    await ctx.firelight_vault.connect(ctx.users[0]).deposit(deposit, ctx.users[0].address)

    // Capture timestamp inside the period after the deposit
    await advanceOnePeriod(ctx.firelight_vault)
    const captureTs = await time.latest()
    const capturePeriod = await ctx.firelight_vault.periodAtTimestamp(captureTs)

    // Move to capture + 1 and create a withdrawal assigned to capture + 2
    await advanceOnePeriod(ctx.firelight_vault)
    expect(await ctx.firelight_vault.currentPeriod()).to.equal(capturePeriod + 1n)
    await ctx.firelight_vault.connect(ctx.users[0]).withdraw(withdrawal, ctx.users[0].address, ctx.users[0].address)

    // paidFromActive = floor(100e6 * 100e6 / 150e6) = 66_666_666
    // paidFromNext   = floor(100e6 *  50e6 / 150e6) = 33_333_333
    // remainder (1) exceeds the zero capture-period withdrawals and is shifted to next-period withdrawals
    await expect(ctx.firelight_vault.connect(ctx.payout_signer).payout(ctx.payout_receiver.address, requested, captureTs))
      .to.emit(ctx.firelight_vault, 'PayoutExecuted')
      .withArgs(ctx.payout_receiver.address, requested, requested, captureTs)

    expect(await ctx.token_contract.balanceOf(ctx.payout_receiver.address)).to.equal(requested)
    expect(await ctx.firelight_vault.withdrawAssets(capturePeriod + 2n)).to.equal(16_666_666n)
    expect(await ctx.firelight_vault.pendingWithdrawAssets()).to.equal(16_666_666n)
  })
})
