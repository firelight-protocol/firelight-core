const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { DECIMALS, WEEK, vaultFixture, advanceOnePeriod } = require('./helpers.js')

describe('FirelightVault view helpers', function () {
  let ctx

  before(async () => {
    ctx = await loadFixture(vaultFixture)
    await ctx.utils.mintAndApprove(ethers.parseUnits('100', DECIMALS), ctx.users[0])
    await ctx.firelight_vault.connect(ctx.users[0]).deposit(ethers.parseUnits('100', DECIMALS), ctx.users[0].address)
  })

  it('returns the historical total supply with totalSupplyAt', async () => {
    const now = await time.latest()
    expect(await ctx.firelight_vault.totalSupplyAt(now)).to.equal(ethers.parseUnits('100', DECIMALS))
    expect(await ctx.firelight_vault.totalSupplyAt(1)).to.equal(0n)
  })

  it('reports the payout window correctly', async () => {
    const p = await ctx.firelight_vault.currentPeriod()

    // the current period is payable, the next one is not yet
    expect(await ctx.firelight_vault.isPeriodInPayoutWindow(p)).to.equal(true)
    expect(await ctx.firelight_vault.isPeriodInPayoutWindow(p + 1n)).to.equal(false)

    await advanceOnePeriod(ctx.firelight_vault)
    // one period later: both the new period and the previous one are payable
    expect(await ctx.firelight_vault.isPeriodInPayoutWindow(p + 1n)).to.equal(true)
    expect(await ctx.firelight_vault.isPeriodInPayoutWindow(p)).to.equal(true)
  })

  it('returns the period configurations length and resolves numbers across configurations', async () => {
    expect(await ctx.firelight_vault.periodConfigurationsLength()).to.equal(1n)

    const nextEnd = await ctx.firelight_vault.nextPeriodEnd()
    await ctx.firelight_vault.connect(ctx.period_configuration_updater).addPeriodConfiguration(nextEnd, WEEK)
    expect(await ctx.firelight_vault.periodConfigurationsLength()).to.equal(2n)

    // period 0 belongs to the first configuration: the lookup must break before the second one
    const firstConfig = await ctx.firelight_vault.periodConfigurations(0)
    const resolved = await ctx.firelight_vault.periodConfigurationAtNumber(0)
    expect(resolved.epoch).to.equal(firstConfig.epoch)
  })
})
