const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { DECIMALS, vaultFixture } = require('./helpers.js')

describe('FirelightVault share transfers', function () {
  let ctx
  const AMOUNT = ethers.parseUnits('100', DECIMALS)

  before(async () => {
    ctx = await loadFixture(vaultFixture)
    await ctx.utils.mintAndApprove(AMOUNT, ctx.users[0])
    await ctx.firelight_vault.connect(ctx.users[0]).deposit(AMOUNT, ctx.users[0].address)
  })

  it('transfers shares via transferFrom and records balance checkpoints', async () => {
    const [owner, spender, receiver] = ctx.users
    await ctx.firelight_vault.connect(owner).approve(spender.address, AMOUNT / 2n)

    await expect(ctx.firelight_vault.connect(spender).transferFrom(owner.address, receiver.address, AMOUNT / 2n))
      .to.emit(ctx.firelight_vault, 'Transfer').withArgs(owner.address, receiver.address, AMOUNT / 2n)

    expect(await ctx.firelight_vault.balanceOf(receiver.address)).to.equal(AMOUNT / 2n)

    const now = await time.latest()
    expect(await ctx.firelight_vault.balanceOfAt(owner.address, now)).to.equal(AMOUNT / 2n)
    expect(await ctx.firelight_vault.balanceOfAt(receiver.address, now)).to.equal(AMOUNT / 2n)
  })

  it('reverts transfer, transferFrom, mint and redeem while paused', async () => {
    await ctx.firelight_vault.connect(ctx.pauser).pause()

    await expect(ctx.firelight_vault.connect(ctx.users[0]).transfer(ctx.users[1].address, 1n))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'EnforcedPause')
    await expect(ctx.firelight_vault.connect(ctx.users[1]).transferFrom(ctx.users[0].address, ctx.users[1].address, 1n))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'EnforcedPause')
    await expect(ctx.firelight_vault.connect(ctx.users[0]).mint(1n, ctx.users[0].address))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'EnforcedPause')
    await expect(ctx.firelight_vault.connect(ctx.users[0]).redeem(1n, ctx.users[0].address, ctx.users[0].address))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'EnforcedPause')

    await ctx.firelight_vault.connect(ctx.pauser).unpause()
  })

  it('reverts transferFrom when the from address is blocklisted', async () => {
    const [owner, spender] = ctx.users
    await ctx.firelight_vault.connect(ctx.blocklister).addToBlocklist(owner.address)

    await expect(ctx.firelight_vault.connect(spender).transferFrom(owner.address, spender.address, 1n))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'BlocklistedAddress')

    await ctx.firelight_vault.connect(ctx.blocklister).removeFromBlocklist(owner.address)
  })
})
