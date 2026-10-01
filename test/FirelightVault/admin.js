const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { DECIMALS, WEEK, vaultFixture } = require('./helpers.js')

describe('FirelightVault admin functions', function () {

  describe('deposit limit and period configuration', () => {
    let ctx

    before(async () => {
      ctx = await loadFixture(vaultFixture)
    })

    it('reverts updateDepositLimit without DEPOSIT_LIMIT_UPDATE_ROLE', async () => {
      await expect(ctx.firelight_vault.connect(ctx.users[0]).updateDepositLimit(1n))
        .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
    })

    it('reverts updateDepositLimit with a zero limit', async () => {
      await expect(ctx.firelight_vault.connect(ctx.limit_updater).updateDepositLimit(0))
        .to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidDepositLimit')
    })

    it('returns zero maxDeposit and maxMint when total assets exceed the deposit limit', async () => {
      const amount = ethers.parseUnits('100', DECIMALS)
      await ctx.utils.mintAndApprove(amount, ctx.users[0])
      await ctx.firelight_vault.connect(ctx.users[0]).deposit(amount, ctx.users[0].address)

      await ctx.firelight_vault.connect(ctx.limit_updater).updateDepositLimit(amount / 2n)

      expect(await ctx.firelight_vault.maxDeposit(ctx.users[0].address)).to.equal(0n)
      expect(await ctx.firelight_vault.maxMint(ctx.users[0].address)).to.equal(0n)
    })

    it('reverts addPeriodConfiguration without PERIOD_CONFIGURATION_UPDATE_ROLE', async () => {
      await expect(ctx.firelight_vault.connect(ctx.users[0]).addPeriodConfiguration(0, WEEK))
        .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
    })
  })

  describe('blocklist and payout allowlist access control', () => {
    let ctx

    before(async () => {
      ctx = await loadFixture(vaultFixture)
    })

    it('reverts blocklist management without BLOCKLIST_ROLE', async () => {
      await expect(ctx.firelight_vault.connect(ctx.users[0]).removeFromBlocklist(ctx.users[1].address))
        .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
    })

    it('reverts payout allowlist management without PAYOUT_ALLOWLIST_ROLE', async () => {
      await expect(ctx.firelight_vault.connect(ctx.users[0]).addToPayoutAllowlist(ctx.users[1].address))
        .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
      await expect(ctx.firelight_vault.connect(ctx.users[0]).removeFromPayoutAllowlist(ctx.payout_receiver.address))
        .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when allowlisting the zero address', async () => {
      await expect(ctx.firelight_vault.connect(ctx.payout_allowlister).addToPayoutAllowlist(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAddress')
    })

    it('removes an address from the payout allowlist; emits the allowlist events', async () => {
      await expect(ctx.firelight_vault.connect(ctx.payout_allowlister).removeFromPayoutAllowlist(ctx.payout_receiver.address))
        .to.emit(ctx.firelight_vault, 'RemovedFromPayoutAllowlist').withArgs(ctx.payout_receiver.address)
      expect(await ctx.firelight_vault.isPayoutAllowlisted(ctx.payout_receiver.address)).to.equal(false)

      await expect(ctx.firelight_vault.connect(ctx.payout_allowlister).addToPayoutAllowlist(ctx.payout_receiver.address))
        .to.emit(ctx.firelight_vault, 'AddedToPayoutAllowlist').withArgs(ctx.payout_receiver.address)
      expect(await ctx.firelight_vault.isPayoutAllowlisted(ctx.payout_receiver.address)).to.equal(true)
    })
  })
})
