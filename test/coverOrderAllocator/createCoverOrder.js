const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

// CoverOrderType: 0=NEW, 1=RENEWAL
const NEW = 0
const RENEWAL = 1
// beneficiaryAddress is a chain-agnostic string identifier — for EVM use the address as-is

// Period-prorated premium (ceil): coverAmount * rateAnnualBps * duration / (10000 * 365d)
const BPS = 10_000n
const YEAR = 365n * 24n * 3600n
const prorate = (cover, rateAnnualBps, duration) => {
  const num = cover * BigInt(rateAnnualBps) * BigInt(duration)
  const den = BPS * YEAR
  return (num + den - 1n) / den
}

describe('CoverOrderAllocator / createCoverOrder', function () {
  let ctx

  beforeEach(async () => {
    ctx = await loadFixture(deployCoverOrderAllocator)
  })

  it('reverts if called by non-curator', async () => {
    const { allocator, buyer1, beneficiary, usdc, marketIdA } = ctx
    const attempt = allocator.connect(buyer1).createCoverOrder(
      buyer1.address,
      buyer1.address,
      beneficiary.address,
      await usdc.getAddress(),
      [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: 1000 }],
      NEW
    )
    await expect(attempt).to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
  })

  it('reverts on zero buyer / payoutRecipient / beneficiary / empty markets / unsupported premium token', async () => {
    const { allocator, curator, buyer1, beneficiary, usdc, marketIdA } = ctx
    const token = await usdc.getAddress()
    const m = [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: 1000 }]
    await expect(
      allocator.connect(curator).createCoverOrder(ethers.ZeroAddress, buyer1.address, beneficiary.address, token, m, NEW)
    ).to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
    await expect(
      allocator.connect(curator).createCoverOrder(buyer1.address, ethers.ZeroAddress, beneficiary.address, token, m, NEW)
    ).to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
    await expect(
      allocator.connect(curator).createCoverOrder(buyer1.address, buyer1.address, '', token, m, NEW)
    ).to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
    await expect(
      allocator.connect(curator).createCoverOrder(buyer1.address, buyer1.address, beneficiary.address, token, [], NEW)
    ).to.be.revertedWithCustomError(allocator, 'InvalidMarketsLength')
    await expect(
      allocator.connect(curator).createCoverOrder(buyer1.address, buyer1.address, beneficiary.address, ethers.ZeroAddress, m, NEW)
    ).to.be.revertedWithCustomError(allocator, 'UnsupportedPremiumToken')
  })

  it('reverts on zero coverAmount / zero rate / unknown market / disabled market', async () => {
    const { allocator, curator, configAdmin, buyer1, beneficiary, usdc, marketIdA, marketIdB } = ctx
    const token = await usdc.getAddress()
    await expect(allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: 0 }], NEW
    )).to.be.revertedWithCustomError(allocator, 'InvalidMarketsZeroValue')
    await expect(allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [{ marketId: marketIdA, coverRateAnnual: 0, coverAmount: 1000 }], NEW
    )).to.be.revertedWithCustomError(allocator, 'InvalidMarketsZeroValue')
    const bogusMarketId = ethers.id('non-existent')
    await expect(allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [{ marketId: bogusMarketId, coverRateAnnual: 500, coverAmount: 1000 }], NEW
    )).to.be.revertedWithCustomError(allocator, 'MarketNotFound')

    // Disable Aave protocolConcentration by setting bps to 0 — marketB belongs to it
    await allocator.connect(configAdmin).setProtocolConcentration({ protocol: ctx.constants.PROTOCOL_AAVE, chainId: 10, maxProtocolConcentrationBps: 0 })
    await ctx.advanceToPeriod(2) // protocolConcentration update effective on currentPeriod() + 1
    await expect(allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [{ marketId: marketIdB, coverRateAnnual: 500, coverAmount: 1000 }], NEW
    )).to.be.revertedWithCustomError(allocator, 'ZeroProtocolConcentrationForMarket')
  })

  it('reverts on duplicate marketId in same order', async () => {
    const { allocator, curator, buyer1, beneficiary, usdc, marketIdA } = ctx
    const token = await usdc.getAddress()
    await expect(allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [
        { marketId: marketIdA, coverRateAnnual: 500, coverAmount: 1000 },
        { marketId: marketIdA, coverRateAnnual: 300, coverAmount: 2000 }
      ], NEW
    )).to.be.revertedWithCustomError(allocator, 'DuplicateMarket')
  })

  it('reverts when period duration is zero', async () => {
    const { allocator, curator, buyer1, beneficiary, usdc, vault, marketIdA } = ctx
    const token = await usdc.getAddress()
    // Set target period (currentPeriod+1 = 2) duration to 0
    await vault.setPeriodConfiguration(2, { epoch: 0, duration: 0, startingPeriod: 2 })
    await expect(allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: 1000 }], NEW
    )).to.be.revertedWithCustomError(allocator, 'InvalidPeriodDuration')
  })

  it('reverts when coverAmount is below minOrderMarketCoverAmount', async () => {
    const { allocator, curator, configAdmin, buyer1, beneficiary, usdc, marketIdA, firstLossBufferWallet } = ctx
    const token = await usdc.getAddress()
    // Set a higher minimum (in 18d canonical units).
    await allocator.connect(configAdmin).setCapacityConfig({
      minCAR: 10000,
      firstLossBufferToken: token,
      firstLossBuffer: firstLossBufferWallet.address,
      effectiveLeverage: 20000,
      minOrderMarketCoverAmount: 5000,
      divergenceToleranceBps: 0
    })
    await expect(allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: 4999 }], NEW
    )).to.be.revertedWithCustomError(allocator, 'OrderMarketCoverAmountTooLow')
  })

  it('creates a single-market order with correct fields and does not move funds', async () => {
    const { allocator, curator, buyer1, beneficiary, usdc, marketIdA, PERIOD_DURATION } = ctx
    const token = await usdc.getAddress()
    const cover = ethers.parseUnits('10000', 18) // canonical 18d
    const rateAnnualBps = 500 // 5% annual
    const expectedPremium = prorate(cover, rateAnnualBps, PERIOD_DURATION) // 18d
    // No minting / approvals — balance should remain 0
    const balanceBefore = await usdc.balanceOf(buyer1.address)

    const tx = await allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [{ marketId: marketIdA, coverRateAnnual: rateAnnualBps, coverAmount: cover }], NEW
    )
    await expect(tx).to.emit(allocator, 'CoverOrderCreated')

    const order = await allocator.getCoverOrder(0)
    expect(order.buyer).to.equal(buyer1.address)
    expect(order.payoutRecipient).to.equal(buyer1.address)
    expect(order.beneficiaryAddress).to.equal(beneficiary.address)
    expect(order.premiumToken).to.equal(token)
    expect(order.totalCoverAmount).to.equal(cover)
    expect(order.totalPremiumAmount).to.equal(expectedPremium)
    expect(order.weightedAvgRate).to.equal(rateAnnualBps)
    expect(order.orderType).to.equal(NEW)
    expect(order.status).to.equal(0) // PENDING
    expect(order.period).to.equal(2)
    expect(await usdc.balanceOf(buyer1.address)).to.equal(balanceBefore)

    const ids = await allocator.getCoverOrdersIdByPeriod(2)
    expect(ids.length).to.equal(1)
    expect(ids[0]).to.equal(0)
  })

  it('multi-market: correctly sums premium (per-market ceil) and weighted avg rate', async () => {
    const { allocator, curator, buyer1, beneficiary, usdc, marketIdA, marketIdB, PERIOD_DURATION } = ctx
    const token = await usdc.getAddress()
    const cA = ethers.parseUnits('10000', 18), rA = 500
    const cB = ethers.parseUnits('5000', 18),  rB = 800
    const tx = await allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, beneficiary.address, token,
      [
        { marketId: marketIdA, coverRateAnnual: rA, coverAmount: cA },
        { marketId: marketIdB, coverRateAnnual: rB, coverAmount: cB }
      ],
      RENEWAL
    )
    await tx.wait()
    const order = await allocator.getCoverOrder(0)
    expect(order.totalCoverAmount).to.equal(cA + cB)
    const expectedPremium = prorate(cA, rA, PERIOD_DURATION) + prorate(cB, rB, PERIOD_DURATION)
    expect(order.totalPremiumAmount).to.equal(expectedPremium)
    // weightedAvgRate = floor((rA*cA + rB*cB) / (cA+cB))
    const wAvg = (BigInt(rA) * cA + BigInt(rB) * cB) / (cA + cB)
    expect(order.weightedAvgRate).to.equal(wAvg)
    // Pushed to ordersIdByPeriod
    const ids = await allocator.getCoverOrdersIdByPeriod(2)
    expect(ids.length).to.equal(1)
    // Stored markets
    const stored = await allocator.getCoverOrderMarkets(0)
    expect(stored.length).to.equal(2)
    expect(stored[0].marketId).to.equal(marketIdA)
    expect(stored[1].marketId).to.equal(marketIdB)
  })
})
