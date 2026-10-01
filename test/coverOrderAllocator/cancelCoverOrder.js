const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

const NEW = 0
const Status = { PENDING: 0, MATCHED: 1, PARTIAL: 2, CANCELLED: 3 }
const ONE_E18 = 10n ** 18n
const PARAMS = { effectiveLeverage: 20000n, assetPriceUSD: ONE_E18 }

describe('CoverOrderAllocator / cancelCoverOrder', function () {
  const mkOrder = async (ctx) => {
    const { allocator, curator, buyer1, usdc, marketIdA } = ctx
    await allocator.connect(curator).createCoverOrder(
      buyer1.address, buyer1.address, buyer1.address,
      await usdc.getAddress(),
      [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: 1000 }],
      NEW
    )
  }

  it('reverts if called by non-curator', async () => {
    const ctx = await loadFixture(deployCoverOrderAllocator)
    await mkOrder(ctx)
    await expect(ctx.allocator.connect(ctx.buyer1).cancelCoverOrder(0))
      .to.be.revertedWithCustomError(ctx.allocator, 'AccessControlUnauthorizedAccount')
  })

  it('reverts on non-existent order', async () => {
    const ctx = await loadFixture(deployCoverOrderAllocator)
    await expect(ctx.allocator.connect(ctx.curator).cancelCoverOrder(42))
      .to.be.revertedWithCustomError(ctx.allocator, 'InvalidOrder')
  })

  it('reverts if already cancelled', async () => {
    const ctx = await loadFixture(deployCoverOrderAllocator)
    await mkOrder(ctx)
    await ctx.allocator.connect(ctx.curator).cancelCoverOrder(0)
    await expect(ctx.allocator.connect(ctx.curator).cancelCoverOrder(0))
      .to.be.revertedWithCustomError(ctx.allocator, 'OrderNotPending')
  })

  it('cancels order and it stays cancelled', async () => {
    const ctx = await loadFixture(deployCoverOrderAllocator)
    await mkOrder(ctx)
    await ctx.allocator.connect(ctx.curator).cancelCoverOrder(0)
    const o = await ctx.allocator.getCoverOrder(0)
    expect(o.status).to.equal(Status.CANCELLED)
    expect(o.allocatedCoverAmount).to.equal(0)
    expect(o.allocatedPremiumAmount).to.equal(0)
  })
})
