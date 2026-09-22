const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { DECIMALS, vaultFixture, advanceOnePeriod } = require('./helpers.js')

describe('FirelightVault incident gating', function () {
  let ctx, incidentPeriod

  before(async () => {
    ctx = await loadFixture(vaultFixture)
    await ctx.utils.mintAndApprove(ethers.parseUnits('100', DECIMALS), ctx.users[0])
    incidentPeriod = await ctx.firelight_vault.currentPeriod()
  })

  it('reverts when called without INCIDENT_ROLE', async () => {
    await expect(ctx.firelight_vault.connect(ctx.users[0]).setActiveIncident(incidentPeriod, true))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'AccessControlUnauthorizedAccount')
  })

  it('sets an active incident for the current period and blocks deposits and mints', async () => {
    await expect(ctx.firelight_vault.connect(ctx.incident).setActiveIncident(incidentPeriod, true))
      .to.emit(ctx.firelight_vault, 'ActiveIncidentUpdated').withArgs(incidentPeriod, true)

    expect(await ctx.firelight_vault.hasActiveIncident(incidentPeriod)).to.equal(true)
    expect(await ctx.firelight_vault.maxDeposit(ctx.users[0].address)).to.equal(0n)
    expect(await ctx.firelight_vault.maxMint(ctx.users[0].address)).to.equal(0n)

    await expect(ctx.firelight_vault.connect(ctx.users[0]).deposit(1n, ctx.users[0].address))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'CurrentPeriodHasActiveIncident')
    await expect(ctx.firelight_vault.connect(ctx.users[0]).mint(1n, ctx.users[0].address))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'CurrentPeriodHasActiveIncident')
  })

  it('still blocks deposits when the incident belongs to the previous period', async () => {
    await advanceOnePeriod(ctx.firelight_vault)
    expect(await ctx.firelight_vault.currentPeriod()).to.equal(incidentPeriod + 1n)

    // the incident of the previous period is still unresolved: deposits stay blocked
    expect(await ctx.firelight_vault.maxDeposit(ctx.users[0].address)).to.equal(0n)
    await expect(ctx.firelight_vault.connect(ctx.users[0]).deposit(1n, ctx.users[0].address))
      .to.be.revertedWithCustomError(ctx.firelight_vault, 'CurrentPeriodHasActiveIncident')
  })

  it('allows deposits again once the incident is cleared', async () => {
    await ctx.firelight_vault.connect(ctx.incident).setActiveIncident(incidentPeriod, false)
    await ctx.firelight_vault.connect(ctx.users[0]).deposit(ethers.parseUnits('1', DECIMALS), ctx.users[0].address)
    expect(await ctx.firelight_vault.balanceOf(ctx.users[0].address)).to.be.gt(0n)
  })
})
