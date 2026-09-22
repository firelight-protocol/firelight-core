const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator, randomSigner } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')

const NEW = 0
const RENEWAL = 1
const Status = { PENDING: 0, MATCHED: 1, PARTIAL: 2, CANCELLED: 3 }
const IncidentStatus = { NONE: 0, OPEN: 1, CONFIRMED: 2, UNDER_EVALUATION: 3, CLOSED: 4, CANCELED: 5, EXPIRED: 6 }

const BPS = 10_000n
const YEAR = 365n * 24n * 3600n
const SCALE_18_TO_6 = 10n ** 12n

const prorate = (cover, rateAnnualBps, duration) => {
  const num = cover * BigInt(rateAnnualBps) * BigInt(duration)
  const den = BPS * YEAR
  return (num + den - 1n) / den
}
const premium18ToNative = (p18) => (p18 + SCALE_18_TO_6 - 1n) / SCALE_18_TO_6

// A capture timestamp safely in the past, mapped to the orders' period on the mock vault.
const CAPTURE_TS = 1_700_000_000
const ORDER_PERIOD = 2

/**
 * End-to-end: one NEW and one RENEWAL order that are otherwise identical
 * (same buyer, payout recipient, beneficiary, market, rate, cover amount and
 * premium token), settled in the same allocation, producing two nearly
 * identical cover NFTs — then a real IncidentManager pays out losses against
 * both covers through the FLB + vault waterfall.
 */
const deployIntegration = async () => {
  const ctx = await deployCoverOrderAllocator()
  const [assessmentApprover, assessmentRejecter, incidentInvalidator, payoutAdmin, priceFeedAdmin, payoutReceiver] =
    await Promise.all([randomSigner(), randomSigner(), randomSigner(), randomSigner(), randomSigner(), randomSigner()])

  // Chainlink-shaped feed for the IncidentManager: $1.00 with 8 decimals
  const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
  const priceFeed = await MockPriceFeed.deploy(8, 10n ** 8n)

  // Real IncidentManager wired to the REAL allocator (which reports the mock vault)
  const IncidentManagerFactory = await ethers.getContractFactory('IncidentManager')
  const incidentManager = await upgrades.deployProxy(
    IncidentManagerFactory,
    [
      ctx.admin.address,
      ctx.curator.address,
      assessmentApprover.address,
      assessmentRejecter.address,
      incidentInvalidator.address,
      ctx.configAdmin.address,
      payoutAdmin.address,
      priceFeedAdmin.address,
      payoutReceiver.address,
      await ctx.allocator.getAddress(),
      await priceFeed.getAddress(),
      3600
    ],
    { kind: 'transparent', unsafeAllow: ['missing-initializer-call'] }
  )

  return { ...ctx, incidentManager, assessmentApprover, payoutReceiver }
}

describe('Integration: identical NEW + RENEWAL orders through settle and incident payout', function () {
  const COVER = ethers.parseUnits('5000', 18)          // per order, canonical 18d USD
  const RATE = 500                                     // 5% annual, in bps
  const FLB_FUNDING = ethers.parseUnits('10000', 6)    // capacity source: 10000 * 2x leverage = 20000e18

  let ctx, premium, premiumNative

  before(async () => {
    ctx = await loadFixture(deployIntegration)
    premium = prorate(COVER, RATE, ctx.PERIOD_DURATION)
    premiumNative = premium18ToNative(premium)

    // Capacity comes from the first-loss buffer: totalAssets 0, FLB 10000 USDC, 2x leverage
    await ctx.usdc.mint(ctx.firstLossBufferWallet.address, FLB_FUNDING)
    await ctx.vault.setTotalAssets(0)
    await ctx.fundAndApprove(ctx.buyer1, ctx.usdc, premiumNative * 2n)

    // Two orders identical in everything except orderType
    const marketInput = [{ marketId: ctx.marketIdA, coverRateAnnual: RATE, coverAmount: COVER }]
    const usdcAddress = await ctx.usdc.getAddress()
    await ctx.allocator.connect(ctx.curator).createCoverOrder(
      ctx.buyer1.address, ctx.beneficiary.address, ctx.buyer1.address, usdcAddress, marketInput, NEW
    )
    await ctx.allocator.connect(ctx.curator).createCoverOrder(
      ctx.buyer1.address, ctx.beneficiary.address, ctx.buyer1.address, usdcAddress, marketInput, RENEWAL
    )
  })

  it('settles both orders fully from the same allocation commit', async () => {
    await ctx.advanceToPeriod(ORDER_PERIOD)

    const leaves = [
      [0n, [[ctx.marketIdA, COVER]]],
      [1n, [[ctx.marketIdA, COVER]]]
    ]
    const tree = StandardMerkleTree.of(leaves, ['uint256', '(bytes32,uint256)[]'])

    await ctx.allocator.connect(ctx.allocatorRole).commitAllocation(ORDER_PERIOD, tree.root, COVER * 2n, ethers.parseUnits('20000', 18))

    const proofOf = (orderId) => {
      for (const [i, leaf] of tree.entries()) if (leaf[0] === orderId) return tree.getProof(i)
    }
    await ctx.allocator.connect(ctx.allocatorRole).batchSettleCoverOrder([
      { orderId: 0, marketCoverAllocations: [{ marketId: ctx.marketIdA, allocatedCover: COVER }], proof: proofOf(0n) },
      { orderId: 1, marketCoverAllocations: [{ marketId: ctx.marketIdA, allocatedCover: COVER }], proof: proofOf(1n) }
    ])

    // Both premiums charged exactly once each
    expect(await ctx.usdc.balanceOf(ctx.premiumCollector.address)).to.equal(premiumNative * 2n)
  })

  it('mints two NFTs to the same buyer with identical cover data except the order type', async () => {
    expect(await ctx.coverNFT.balanceOf(ctx.buyer1.address)).to.equal(2n)
    expect(await ctx.coverNFT.ownerOf(0)).to.equal(ctx.buyer1.address)
    expect(await ctx.coverNFT.ownerOf(1)).to.equal(ctx.buyer1.address)

    const [a, b] = [await ctx.allocator.getCoverOrder(0), await ctx.allocator.getCoverOrder(1)]

    // Everything matches except the order type
    expect(a.buyer).to.equal(b.buyer)
    expect(a.payoutRecipient).to.equal(b.payoutRecipient)
    expect(a.beneficiaryAddress).to.equal(b.beneficiaryAddress)
    expect(a.premiumToken).to.equal(b.premiumToken)
    expect(a.totalCoverAmount).to.equal(b.totalCoverAmount)
    expect(a.totalPremiumAmount).to.equal(b.totalPremiumAmount)
    expect(a.weightedAvgRate).to.equal(b.weightedAvgRate)
    expect(a.period).to.equal(b.period)
    expect(a.status).to.equal(Status.MATCHED)
    expect(b.status).to.equal(Status.MATCHED)
    expect(a.allocatedCoverAmount).to.equal(COVER)
    expect(b.allocatedCoverAmount).to.equal(COVER)
    expect(a.allocatedPremiumAmount).to.equal(b.allocatedPremiumAmount)
    expect(a.orderType).to.equal(NEW)
    expect(b.orderType).to.equal(RENEWAL)

    // The allocator reports both covers independently per (tokenId, marketId)
    const infoA = await ctx.allocator.getCoverOrderMarketInfo(0, ctx.marketIdA)
    const infoB = await ctx.allocator.getCoverOrderMarketInfo(1, ctx.marketIdA)
    expect(infoA).to.deep.equal(infoB)
    expect(infoA.allocatedCoverAmount).to.equal(COVER)
  })

  it('pays an incident that assesses losses against both covers', async () => {
    const { incidentManager, usdc, vault, curator, assessmentApprover, payoutReceiver, firstLossBufferWallet } = ctx
    const LOSS_PER_COVER = COVER                              // full loss on each cover: 5000e18
    const TOTAL_LOSS = LOSS_PER_COVER * 2n                    // 10000e18 canonical
    const FLB_LEFT = ethers.parseUnits('4000', 6)             // waterfall: 4000 from FLB, 6000 from vault

    // Map the capture timestamp to the orders' period and drain the FLB so both
    // waterfall legs are exercised
    await vault.setPeriodAtTimestamp(CAPTURE_TS, ORDER_PERIOD)
    const flbBalance = await usdc.balanceOf(firstLossBufferWallet.address)
    await usdc.connect(firstLossBufferWallet).transfer(ctx.buyer2.address, flbBalance - FLB_LEFT)
    await usdc.connect(firstLossBufferWallet).approve(await incidentManager.getAddress(), FLB_LEFT)

    await incidentManager.connect(curator).createIncident(CAPTURE_TS, 'Duplicate covers incident', ethers.id('dup-incident'))
    await incidentManager.connect(curator).confirmIncident(1, 'ipfs://report')

    // One loss entry per cover NFT — same market, same recipient, no collision
    await incidentManager.connect(curator).addAssessmentLosses(1, [
      { coverTokenId: 0, marketId: ctx.marketIdA, amount: LOSS_PER_COVER },
      { coverTokenId: 1, marketId: ctx.marketIdA, amount: LOSS_PER_COVER }
    ])

    // Losses of both covers aggregate under the shared payout recipient
    const [recipientLoss] = await incidentManager.getPayoutRecipientAssessmentLoss(1, 1, ctx.beneficiary.address)
    expect(recipientLoss).to.equal(TOTAL_LOSS)

    await incidentManager.connect(curator).submitCurrentAssessment(1)

    // FLB pays 4000e6; the remaining 6000e18 canonical converts to 6000e6 vault
    // asset units at $1 and is requested from the vault
    const VAULT_LEG = ethers.parseUnits('6000', 6)
    await expect(incidentManager.connect(assessmentApprover).approveAssessment(1, 1))
      .to.emit(incidentManager, 'IncidentPayoutExecuted')
      .withArgs(
        1, 1, ORDER_PERIOD, ORDER_PERIOD,
        payoutReceiver.address, firstLossBufferWallet.address, await usdc.getAddress(),
        FLB_LEFT, TOTAL_LOSS, VAULT_LEG, VAULT_LEG
      )

    // FLB leg actually transferred; vault leg is reported by the (mock) vault
    expect(await usdc.balanceOf(payoutReceiver.address)).to.equal(FLB_LEFT)

    const [incident] = await incidentManager.getIncident(1)
    expect(incident.status).to.equal(IncidentStatus.CLOSED)
    expect(incident.vaultPaidAmount).to.equal(VAULT_LEG)
  })

  it('keeps both cover NFTs transferable and intact after the incident', async () => {
    await ctx.coverNFT.connect(ctx.buyer1).transferFrom(ctx.buyer1.address, ctx.buyer2.address, 1)
    expect(await ctx.coverNFT.ownerOf(0)).to.equal(ctx.buyer1.address)
    expect(await ctx.coverNFT.ownerOf(1)).to.equal(ctx.buyer2.address)

    // Cover accounting is untouched by the incident payout (payout accrues to the
    // configured receiver, not against the order records)
    const a = await ctx.allocator.getCoverOrder(0)
    expect(a.allocatedCoverAmount).to.equal(COVER)
  })
})
