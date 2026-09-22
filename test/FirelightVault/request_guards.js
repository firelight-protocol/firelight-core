const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { DECIMALS, vaultFixture } = require('./helpers.js')

describe('FirelightVault deposit and withdrawal request guards', function () {
  let ctx
  const AMOUNT = ethers.parseUnits('100', DECIMALS)

  before(async () => {
    ctx = await loadFixture(vaultFixture)
    await ctx.utils.mintAndApprove(AMOUNT, ctx.users[0])
    await ctx.firelight_vault.connect(ctx.users[0]).deposit(AMOUNT, ctx.users[0].address)
  })

  it('reverts deposit, mint, redeem and withdraw with zero amounts', async () => {
    const vault = ctx.firelight_vault.connect(ctx.users[0])
    await expect(vault.deposit(0, ctx.users[0].address)).to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAmount')
    await expect(vault.mint(0, ctx.users[0].address)).to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAmount')
    await expect(vault.redeem(0, ctx.users[0].address, ctx.users[0].address)).to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAmount')
    await expect(vault.withdraw(0, ctx.users[0].address, ctx.users[0].address)).to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAmount')
  })

  it('reverts withdrawal requests with zero receiver or owner', async () => {
    const vault = ctx.firelight_vault.connect(ctx.users[0])
    await expect(vault.withdraw(1n, ethers.ZeroAddress, ctx.users[0].address))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAddress')
    await expect(vault.withdraw(1n, ctx.users[0].address, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidAddress')
  })

  it('creates a withdrawal request through redeem', async () => {
    const shares = ethers.parseUnits('10', DECIMALS)
    const period = (await ctx.firelight_vault.currentPeriod()) + 1n

    await expect(ctx.firelight_vault.connect(ctx.users[0]).redeem(shares, ctx.users[0].address, ctx.users[0].address))
      .to.emit(ctx.firelight_vault, 'WithdrawRequest')

    expect(await ctx.firelight_vault.withdrawSharesOf(period, ctx.users[0].address)).to.be.gt(0n)
  })

  it('lets an approved spender request a withdrawal on behalf of the owner', async () => {
    const [owner, spender] = ctx.users
    const assets = ethers.parseUnits('10', DECIMALS)

    await ctx.firelight_vault.connect(owner).approve(spender.address, ethers.MaxUint256 / 2n)
    await expect(ctx.firelight_vault.connect(spender).withdraw(assets, spender.address, owner.address))
      .to.emit(ctx.firelight_vault, 'WithdrawRequest')
  })

  it('reverts rescueWithdrawFromBlocklisted with an empty periods array', async () => {
    const [, , blocked] = ctx.users
    await ctx.firelight_vault.connect(ctx.blocklister).addToBlocklist(blocked.address)

    await expect(ctx.firelight_vault.connect(ctx.rescuer).rescueWithdrawFromBlocklisted(blocked.address, ctx.users[0].address, []))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'InvalidArrayLength')
  })
})
