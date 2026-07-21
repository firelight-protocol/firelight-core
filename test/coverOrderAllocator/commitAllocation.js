const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')

const NEW = 0
const RENEWAL = 1
const Status = { PENDING: 0, MATCHED: 1, PARTIAL: 2, CANCELLED: 3 }

const BPS = 10_000n
const YEAR = 365n * 24n * 3600n
const ONE_E18 = 10n ** 18n

const prorate = (cover, rateAnnualBps, duration) => {
  const num = cover * BigInt(rateAnnualBps) * BigInt(duration)
  const den = BPS * YEAR
  return (num + den - 1n) / den
}

// Build a merkle tree from settle entries: [orderId, allocatedCoverPerMarket[]]
const buildTree = (entries) => {
  if (entries.length === 0) return { tree: null, root: ethers.ZeroHash }
  const tree = StandardMerkleTree.of(entries.map(e => e.slice(0, 2)), ['uint256', '(bytes32,uint256)[]'])
  return { tree, root: tree.root }
}

const getProof = (tree, orderId) => {
  for (const [i, leaf] of tree.entries()) {
    if (leaf[0] === BigInt(orderId)) return tree.getProof(i)
  }
  throw new Error(`Order ${orderId} not found in tree`)
}

// Helper: build a single-market tuple for tree leaves and settle calls
const mca = (marketId, cover) => [marketId, cover]  // for tree leaves: [bytes32, uint256]
const mcaStruct = (marketId, cover) => ({ marketId, allocatedCover: cover })  // for settleCoverOrder calls

// Create a single-market order. `coverAmount` is in canonical 18d USD.
const createOrder = async (ctx, { buyer, token, coverAmount, rate = 500, orderType = NEW, market }) => {
  const m = market || ctx.marketIdA
  await ctx.allocator.connect(ctx.curator).createCoverOrder(
    buyer.address, buyer.address, buyer.address,
    await token.getAddress(),
    [{ marketId: m, coverRateAnnual: rate, coverAmount: coverAmount }],
    orderType
  )
}

// Scale a canonical 18d premium amount down to a 6d token native amount (ceil — matches
// what _settleCoverOrder transfers via _scaleDownCeil).
const SCALE_18_TO_6 = 10n ** 12n
const premium18ToNative = (p18) => (p18 + SCALE_18_TO_6 - 1n) / SCALE_18_TO_6

const readyToMatch = async (ctx) => { await ctx.advanceToPeriod(2) }

describe('CoverOrderAllocator / commitAllocation (merkle)', function () {

  describe('access / guards', () => {
    it('reverts if called by non-curator', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await readyToMatch(ctx)
      await expect(ctx.allocator.connect(ctx.buyer1).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), 0))
        .to.be.revertedWithCustomError(ctx.allocator, 'AccessControlUnauthorizedAccount')
    })

    it('reverts on double commit within the same period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await readyToMatch(ctx)
      await ctx.allocator.connect(ctx.allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), 0)
      await expect(ctx.allocator.connect(ctx.allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root2'), 0))
        .to.be.revertedWithCustomError(ctx.allocator, 'PeriodAlreadyCommitted')
    })

    it('reverts when commitmentPeriod is ahead of vault.currentPeriod()', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await readyToMatch(ctx)
      const current = await ctx.vault.currentPeriod()
      await expect(ctx.allocator.connect(ctx.allocatorRole).commitAllocation(current + 1n, ethers.id('root'), 0))
        .to.be.revertedWithCustomError(ctx.allocator, 'InvalidCommitmentPeriod')
        .withArgs(current + 1n, current)
    })

    it('reverts when commitmentPeriod is behind vault.currentPeriod()', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await readyToMatch(ctx)
      const current = await ctx.vault.currentPeriod()
      await expect(ctx.allocator.connect(ctx.allocatorRole).commitAllocation(current - 1n, ethers.id('root'), 0))
        .to.be.revertedWithCustomError(ctx.allocator, 'InvalidCommitmentPeriod')
        .withArgs(current - 1n, current)
    })

    it('reverts on zero merkle root', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await readyToMatch(ctx)
      await expect(ctx.allocator.connect(ctx.allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.ZeroHash, 0))
        .to.be.revertedWithCustomError(ctx.allocator, 'InvalidMerkleRoot')
    })

    it('reverts when oracle returns zero price', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await readyToMatch(ctx)
      // Use raw integer set so updatedAt is not bumped to current block timestamp inside setAnswer:
      // PriceFeed.getPrice rejects answer <= 0 with `InvalidAssetPrice(int256)`.
      await ctx.priceFeed.setAnswer(0n)
      // PriceFeed library lives outside the allocator; revert is a generic Solidity error string.
      await expect(ctx.allocator.connect(ctx.allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), 0))
        .to.be.reverted
    })

    it('reverts when oracle round is stale (PriceFeedTooOld)', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await readyToMatch(ctx)
      // Push updatedAt very far in the past so block.timestamp - updatedAt > maxAge (3600s).
      await ctx.priceFeed.setUpdatedAt(1n)
      await expect(ctx.allocator.connect(ctx.allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), 0))
        .to.be.reverted
    })

    it('reverts when totalAllocated exceeds capacity', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, usdc, firstLossBufferWallet, vault, allocatorRole, curator } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)
      // capacity (18d) = 1000 * 2 = 2000. tooMuch = 3000 > 2000 → reverts.
      const tooMuch = ethers.parseUnits('3000', 18)
      await expect(allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), tooMuch))
        .to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')
    })

    // Regression test for the per-protocolConcentration-ceiling model: per-protocolConcentration bps act
    // as INDEPENDENT ceilings and can sum > 100%, but the global cover bound
    // (`totalAllocated ≤ commit.totalAvailableCapacity`) must still kick in at commit.
    it('reverts with TotalAllocationOverflow when protocolConcentration ceilings sum > 100% and many orders would oversubscribe capacity', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const {
        allocator, usdc, firstLossBufferWallet, vault, allocatorRole, configAdmin, curator,
        buyer1, buyer2,
        marketIdA, marketIdB,
      } = ctx

      // Ceilings: Morpho=60%, Aave=60% (sum 12000 > 100%). Allowed under the new model.
      await allocator.connect(configAdmin).batchSetProtocolConcentration([
        { protocol: 'Morpho', chainId: 1,  maxProtocolConcentrationBps: 6000 },
        { protocol: 'Aave',   chainId: 10, maxProtocolConcentrationBps: 6000 },
      ])

      // Collateral: FLB only. capacity18 = 1000 * leverage(2x) = 2000.
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      // Create 3 orders totalling 2400 cover across both protocolConcentrations:
      // - 1000 on Morpho (under its 1200 ceiling)
      // - 800 on Aave   (under its 1200 ceiling)
      // - 600 on Aave   (cumulative Aave demand 1400 > 1200 ceiling; off-chain would prorata)
      // Cumulative cover (2400) > capacity (2000), even though each per-protocolConcentration ceiling
      // individually accepts the requested demand. A buggy / malicious curator that tries to
      // commit the full 2400 must hit the global guard.
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: ethers.parseUnits('1000', 18), market: marketIdA })
      await createOrder(ctx, { buyer: buyer2, token: usdc, coverAmount: ethers.parseUnits('800',  18), market: marketIdB })
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: ethers.parseUnits('600',  18), market: marketIdB })

      const period = await vault.currentPeriod()
      // 2001 > capacity (2000): TotalAllocationOverflow.
      await expect(allocator.connect(allocatorRole).commitAllocation(period, ethers.id('over'), ethers.parseUnits('2001', 18)))
        .to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')

      // 2000 = capacity: passes (boundary).
      await allocator.connect(allocatorRole).commitAllocation(period, ethers.id('boundary'), ethers.parseUnits('2000', 18))
      const commit = await allocator.getAllocationCommitment(period)
      expect(commit.totalAvailableCapacity).to.equal(ethers.parseUnits('2000', 18))
      expect(commit.totalDeclaredAllocated).to.equal(ethers.parseUnits('2000', 18))
    })

    // Capacity built from BOTH first-loss buffer and staked assets.
    // Verifies the decimals contract: totalAssets is in the underlying's decimals (6 here)
    // and the oracle price is in the feed's own decimals (8 here, default $1 = 1e8). A bug
    // in either side (e.g. wrong-decimal price) makes stakedAssetsValueUSD truncate to 0
    // and capacity falls below the threshold, reverting.
    it('builds capacity from FLB + staked assets at $1.00', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, usdc, firstLossBufferWallet, vault, allocatorRole, curator } = ctx
      // 1k USDC FLB + 2k underlying staked at $1.00 → collateral = 3k, capacity = 3k × 2 = 6k
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(ethers.parseUnits('2000', 6))
      await readyToMatch(ctx)

      // 6k allocation (18d) should pass exactly (boundary)
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), ethers.parseUnits('6000', 18))
      const period = await vault.currentPeriod()
      const commit = await allocator.getAllocationCommitment(period)
      expect(commit.totalAvailableCapacity).to.equal(ethers.parseUnits('6000', 18))
    })

    it('staked asset value scales with oracle price (price = $2 doubles staked contribution)', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, usdc, firstLossBufferWallet, vault, allocatorRole, curator, priceFeed } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(ethers.parseUnits('2000', 6))
      // Oracle: $2 with 18d. stakedUSD18 = 2000 × 2 = 4000. Collateral18 = 5000. Cap18 = 10000.
      await priceFeed.setAnswer(2n * ONE_E18)
      await readyToMatch(ctx)

      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), ethers.parseUnits('10000', 18))
      const period = await vault.currentPeriod()
      const commit = await allocator.getAllocationCommitment(period)
      expect(commit.totalAvailableCapacity).to.equal(ethers.parseUnits('10000', 18))
    })

    it('uses totalAssetsAt(currentPeriodStart) — mid-period deposits do NOT inflate capacity', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, usdc, firstLossBufferWallet, vault, allocatorRole } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      // Snapshot at periodStart: 2k. Current totalAssets simulates a mid-period deposit bumping to 5k.
      // Capacity must be computed from the snapshot (2k), NOT the inflated current value (5k).
      // capacity18 = (FLB 1k + staked 2k) * leverage 2 = 6k. NOT (1k + 5k) * 2 = 12k.
      await vault.setTotalAssetsAtSnapshot(ethers.parseUnits('2000', 6))
      await vault.setTotalAssets(ethers.parseUnits('5000', 6))
      await readyToMatch(ctx)

      // 6k passes (boundary on the snapshot-derived capacity)
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), ethers.parseUnits('6000', 18))
      const period = await vault.currentPeriod()
      const commit = await allocator.getAllocationCommitment(period)
      expect(commit.totalAvailableCapacity).to.equal(ethers.parseUnits('6000', 18))
    })

    it('reverts when allocation exceeds snapshot-based capacity even if current totalAssets would cover it', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, usdc, firstLossBufferWallet, vault, allocatorRole } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssetsAtSnapshot(ethers.parseUnits('2000', 6))
      await vault.setTotalAssets(ethers.parseUnits('5000', 6))
      await readyToMatch(ctx)

      // 10k would fit under (1k+5k)*2=12k but exceeds snapshot capacity (1k+2k)*2=6k.
      const overSnapshot = ethers.parseUnits('10000', 18)
      await expect(allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root'), overSnapshot))
        .to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')
    })

    it('settleCoverOrder reverts if called by non-curator', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await expect(ctx.allocator.connect(ctx.buyer1).settleCoverOrder(0, [], []))
        .to.be.revertedWithCustomError(ctx.allocator, 'AccessControlUnauthorizedAccount')
    })

    it('batchSettleCoverOrder reverts if called by non-curator', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await expect(ctx.allocator.connect(ctx.buyer1).batchSettleCoverOrder([]))
        .to.be.revertedWithCustomError(ctx.allocator, 'AccessControlUnauthorizedAccount')
    })

    it('removeSupportedPremiumToken reverts if called by non-admin', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await expect(ctx.allocator.connect(ctx.buyer1).removeSupportedPremiumToken(await ctx.usdc.getAddress()))
        .to.be.revertedWithCustomError(ctx.allocator, 'AccessControlUnauthorizedAccount')
    })
  })

  describe('commit + settle flow', () => {
    it('single order fully matched', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, premiumCollector, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('5000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      const premiumNative = premium18ToNative(premium)
      await ctx.fundAndApprove(buyer1, usdc, premiumNative)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: RENEWAL })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))

      const o = await allocator.getCoverOrder(0)
      expect(o.status).to.equal(Status.MATCHED)
      expect(o.allocatedCoverAmount).to.equal(cover)
      expect(await usdc.balanceOf(premiumCollector.address)).to.equal(premiumNative)
    })

    it('mints the cover NFT to the buyer (not the beneficiary) on settle', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, coverNFT, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, buyer2, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)

      // buyer1 buys cover on behalf of buyer2's position (distinct beneficiary)
      await allocator.connect(curator).createCoverOrder(
        buyer1.address,
        buyer1.address,
        buyer2.address,
        await usdc.getAddress(),
        [{ marketId: ctx.marketIdA, coverRateAnnual: 500, coverAmount: cover }],
        NEW
      )

      await readyToMatch(ctx)
      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))

      expect(await coverNFT.ownerOf(0)).to.equal(buyer1.address)
      expect(await coverNFT.balanceOf(buyer1.address)).to.equal(1n)
      expect(await coverNFT.balanceOf(buyer2.address)).to.equal(0n)

      const o = await allocator.getCoverOrder(0)
      expect(o.buyer).to.equal(buyer1.address)
      expect(o.beneficiaryAddress).to.equal(buyer2.address)
    })

    it('partial order', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('5000', 6))
      await vault.setTotalAssets(0)
      // capacity = 5000 * 2 = 10000. marketA cap = 60% = 6000

      const cover = ethers.parseUnits('10000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      // Allocate 5000 of 10000 requested (within marketA cap of 6000)
      const allocCover = ethers.parseUnits('5000', 18)
      const allocPremium = prorate(allocCover, 500, PERIOD_DURATION)
      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, allocCover)], allocPremium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, allocCover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, allocCover)], getProof(tree, 0))

      const o = await allocator.getCoverOrder(0)
      expect(o.status).to.equal(Status.PARTIAL)
      expect(o.allocatedCoverAmount).to.equal(allocCover)
    })

    it('settleCoverOrder reverts with invalid proof', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)

      // Wrong cover amount → proof won't verify
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover - 1n)], getProof(tree, 0)))
        .to.be.revertedWithCustomError(allocator, 'InvalidProof')
    })

    it('settleCoverOrder reverts if order already settled', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))

      await expect(allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0)))
        .to.be.revertedWithCustomError(allocator, 'OrderNotPending')
    })

    it('settleCoverOrder reverts if no commit for period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, allocatorRole, curator, buyer1, usdc } = ctx
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: 1000, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      // No commit made — settle should fail
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, 500n)], []))
        .to.be.revertedWithCustomError(allocator, 'NoCommitForPeriod')
    })

    it('totalSettledCover cannot exceed totalDeclaredAllocated', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, buyer2, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await ctx.fundAndApprove(buyer2, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await createOrder(ctx, { buyer: buyer2, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      // Commit declares only 1000 total but tree has two orders of 1000 each
      const { tree, root } = buildTree([
        [0n, [mca(ctx.marketIdA, cover)], premium],
        [1n, [mca(ctx.marketIdA, cover)], premium]
      ])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover) // only 1000 declared

      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))
      // Second settle would push totalSettledCover to 2000 > 1000 declared
      await expect(allocator.connect(allocatorRole).settleCoverOrder(1, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 1)))
        .to.be.revertedWithCustomError(allocator, 'TotalSettledOverflow')
    })

    it('batchSettleCoverOrder settles multiple orders', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, buyer2, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await ctx.fundAndApprove(buyer2, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await createOrder(ctx, { buyer: buyer2, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([
        [0n, [mca(ctx.marketIdA, cover)], premium],
        [1n, [mca(ctx.marketIdA, cover)], premium]
      ])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover * 2n)

      await allocator.connect(allocatorRole).batchSettleCoverOrder([
        { orderId: 0, marketCoverAllocations: [mcaStruct(ctx.marketIdA, cover)], proof: getProof(tree, 0) },
        { orderId: 1, marketCoverAllocations: [mcaStruct(ctx.marketIdA, cover)], proof: getProof(tree, 1) }
      ])

      expect((await allocator.getCoverOrder(0)).status).to.equal(Status.MATCHED)
      expect((await allocator.getCoverOrder(1)).status).to.equal(Status.MATCHED)
    })

    it('settleCoverOrder reverts for non-existent order (buyer == address(0))', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const { tree, root } = buildTree([[999n, [mca(ctx.marketIdA, 100n)], 1n]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, 100n)
      await expect(allocator.connect(allocatorRole).settleCoverOrder(999, [mcaStruct(ctx.marketIdA, 100n)], getProof(tree, 999)))
        .to.be.revertedWithCustomError(allocator, 'InvalidOrder')
    })

    it('settleCoverOrder reverts on allocation markets length mismatch', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      // Tree leaf with 2 market allocations for a 1-market order — proof will verify but length check fails first
      const allocs2 = [mca(ctx.marketIdA, cover / 2n), mca(ctx.marketIdB, cover / 2n)]
      const { tree, root } = buildTree([[0n, allocs2, premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0,
        [mcaStruct(ctx.marketIdA, cover / 2n), mcaStruct(ctx.marketIdB, cover / 2n)],
        getProof(tree, 0)
      )).to.be.revertedWithCustomError(allocator, 'InvalidAllocationMarketsLength')
    })

    it('settleCoverOrder reverts on marketId mismatch', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION, marketIdA, marketIdB } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      // Order created for marketA
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW, market: marketIdA })
      await readyToMatch(ctx)

      // Tree leaf uses marketB instead of marketA
      const { tree, root } = buildTree([[0n, [mca(marketIdB, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0,
        [mcaStruct(marketIdB, cover)], getProof(tree, 0)
      )).to.be.revertedWithCustomError(allocator, 'MarketIdMismatch')
    })

    it('settleCoverOrder reverts when market cover exceeds order cover amount', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      const overCover = cover + 1n
      const { tree, root } = buildTree([[0n, [mca(marketIdA, overCover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, overCover)
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0,
        [mcaStruct(marketIdA, overCover)], getProof(tree, 0)
      )).to.be.revertedWithCustomError(allocator, 'MarketAllocationOverflow')
    })

    it('settleCoverOrder reverts on zero allocation', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(marketIdA, 0n)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0,
        [mcaStruct(marketIdA, 0n)], getProof(tree, 0)
      )).to.be.revertedWithCustomError(allocator, 'ZeroAllocation')
    })

    it('settleCoverOrder charges the exact pro-rata premium for a partial fill', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const halfCover = cover / 2n
      const halfPremium = prorate(halfCover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, halfPremium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      // The premium is not in the leaf: the contract derives it from the order's stored
      // rate and period duration, so a partial fill always pays exactly pro-rata.
      const { tree, root } = buildTree([[0n, [mca(marketIdA, halfCover)]]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(), root, cover)
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0,
        [mcaStruct(marketIdA, halfCover)], getProof(tree, 0)
      )).to.emit(allocator, 'CoverOrderSettled').withArgs(0, Status.PARTIAL, halfCover, halfPremium)

      expect((await allocator.getCoverOrder(0)).allocatedPremiumAmount).to.equal(halfPremium)
    })

    it('getProtocolConcentrationSettledCover returns correct value after settle', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION, marketIdA, concHashMorpho } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))

      expect(await allocator.getProtocolConcentrationSettledCover(2, concHashMorpho)).to.equal(cover)
    })

    it('insufficient buyer allowance reverts on settle, not on commit', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      // Mint but do NOT approve
      await usdc.mint(buyer1.address, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      // Commit succeeds (no transfer happens)
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      // Settle reverts because buyer hasn't approved
      await expect(allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0)))
        .to.be.reverted
    })
  })

  describe('protocolConcentration cap', () => {
    it('reverts when settle exceeds protocolConcentration cap', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, buyer2, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      // capacity = 10000 * 2 = 20000. Morpho protocolConcentration bps = 6000 → cap = 12000

      const cover1 = ethers.parseUnits('10000', 18)
      const cover2 = ethers.parseUnits('5000', 18)
      const p1 = prorate(cover1, 500, PERIOD_DURATION)
      const p2 = prorate(cover2, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, p1)
      await ctx.fundAndApprove(buyer2, usdc, p2)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover1, rate: 500, orderType: NEW, market: marketIdA })
      await createOrder(ctx, { buyer: buyer2, token: usdc, coverAmount: cover2, rate: 500, orderType: NEW, market: marketIdA })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([
        [0n, [mca(marketIdA, cover1)], p1],
        [1n, [mca(marketIdA, cover2)], p2]
      ])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover1 + cover2)

      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover1)], getProof(tree, 0))
      // Second settle pushes Morpho protocolConcentration to 15000 > 12000 cap
      await expect(allocator.connect(allocatorRole).settleCoverOrder(1, [mcaStruct(marketIdA, cover2)], getProof(tree, 1)))
        .to.be.revertedWithCustomError(allocator, 'ProtocolConcentrationOverflow')
    })

    it('settles within market caps across multiple markets', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, buyer2, PERIOD_DURATION, marketIdA, marketIdB } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      // capacity = 20000. marketA cap = 12000 (60%), marketB cap = 8000 (40%)

      const coverA = ethers.parseUnits('10000', 18)
      const coverB = ethers.parseUnits('6000', 18)
      const pA = prorate(coverA, 500, PERIOD_DURATION)
      const pB = prorate(coverB, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, pA)
      await ctx.fundAndApprove(buyer2, usdc, pB)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: coverA, rate: 500, orderType: NEW, market: marketIdA })
      await createOrder(ctx, { buyer: buyer2, token: usdc, coverAmount: coverB, rate: 500, orderType: NEW, market: marketIdB })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([
        [0n, [mca(marketIdA, coverA)], pA],
        [1n, [mca(marketIdB, coverB)], pB]
      ])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, coverA + coverB)

      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, coverA)], getProof(tree, 0))
      await allocator.connect(allocatorRole).settleCoverOrder(1, [mcaStruct(marketIdB, coverB)], getProof(tree, 1))

      expect((await allocator.getCoverOrder(0)).status).to.equal(Status.MATCHED)
      expect((await allocator.getCoverOrder(1)).status).to.equal(Status.MATCHED)
    })
  })

  describe('recommitAllocation', () => {
    it('allows admin to replace root before any settlements', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, curator } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root1'), 0)
      const newRoot = ethers.id('root2')
      await allocator.connect(configAdmin).recommitAllocation(2, newRoot, 0)

      const commit = await allocator.getAllocationCommitment(2)
      expect(commit.root).to.equal(newRoot)
    })

    it('reverts on zero new merkle root', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, curator } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root1'), 0)
      await expect(allocator.connect(configAdmin).recommitAllocation(1, ethers.ZeroHash, 0))
        .to.be.revertedWithCustomError(allocator, 'InvalidMerkleRoot')
    })

    it('reverts when no prior commit exists for period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, configAdmin, vault } = ctx
      const currentPeriod = await vault.currentPeriod()
      await expect(allocator.connect(configAdmin).recommitAllocation(currentPeriod, ethers.id('root'), 0))
        .to.be.revertedWithCustomError(allocator, 'NoCommitForPeriod')
    })

    it('reverts when period is not the current period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const currentPeriod = await ctx.vault.currentPeriod()
      await allocator.connect(allocatorRole).commitAllocation(currentPeriod, ethers.id('root1'), 0)
      await expect(allocator.connect(configAdmin).recommitAllocation(currentPeriod + 1n, ethers.id('root2'), 0))
        .to.be.revertedWithCustomError(allocator, 'InvalidCommitmentPeriod')
    })

    it('reverts when newTotalAllocated exceeds capacity', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, curator } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      // capacity = 1000 * 2 = 2000
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root1'), 0)
      await expect(allocator.connect(configAdmin).recommitAllocation(2, ethers.id('root2'), ethers.parseUnits('3000', 18)))
        .to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')
    })

    it('reverts if called by non-admin', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, curator } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),ethers.id('root1'), 0)
      await expect(allocator.connect(curator).recommitAllocation(2, ethers.id('root2'), 0))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })

    it('reverts if settlements have already started', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))

      await expect(allocator.connect(configAdmin).recommitAllocation(2, ethers.id('new'), cover))
        .to.be.revertedWithCustomError(allocator, 'SettlementsAlreadyStarted')
    })
  })

  describe('cancelCommitAllocation', () => {
    it('cancels the commitment, emits the event and allows a fresh commit for the period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const badRoot = ethers.id('bad-root')
      await allocator.connect(allocatorRole).commitAllocation(2, badRoot, 0)

      await expect(allocator.connect(configAdmin).cancelCommitAllocation(2))
        .to.emit(allocator, 'AllocationCommitmentCancelled').withArgs(2, badRoot)

      const cleared = await allocator.getAllocationCommitment(2)
      expect(cleared.root).to.equal(ethers.ZeroHash)
      expect(cleared.graceExpiresAt).to.equal(0n)

      // PeriodAlreadyCommitted no longer applies: a corrected commit can land
      const goodRoot = ethers.id('good-root')
      await allocator.connect(allocatorRole).commitAllocation(2, goodRoot, 0)
      expect((await allocator.getAllocationCommitment(2)).root).to.equal(goodRoot)
    })

    it('blocks settlement against the cancelled root', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(2, root, cover)
      await allocator.connect(configAdmin).cancelCommitAllocation(2)

      await expect(allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0)))
        .to.be.revertedWithCustomError(allocator, 'NoCommitForPeriod')
    })

    it('works while the price feed is stale, when recommitAllocation cannot', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, priceFeed } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      await allocator.connect(allocatorRole).commitAllocation(2, ethers.id('bad-root'), 0)

      // Oracle goes stale: recommit (which recomputes capacity) is unavailable...
      await priceFeed.setUpdatedAt(1n)
      await expect(allocator.connect(configAdmin).recommitAllocation(2, ethers.id('new-root'), 0))
        .to.be.reverted

      // ...but the emergency cancel still withdraws the bad root
      await expect(allocator.connect(configAdmin).cancelCommitAllocation(2))
        .to.emit(allocator, 'AllocationCommitmentCancelled')
    })

    it('reverts when no commit exists for the period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, configAdmin, vault } = ctx
      await expect(allocator.connect(configAdmin).cancelCommitAllocation(await vault.currentPeriod()))
        .to.be.revertedWithCustomError(allocator, 'NoCommitForPeriod')
    })

    it('reverts when period is not the current period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      await allocator.connect(allocatorRole).commitAllocation(2, ethers.id('root1'), 0)
      await expect(allocator.connect(configAdmin).cancelCommitAllocation(3))
        .to.be.revertedWithCustomError(allocator, 'InvalidCommitmentPeriod')
    })

    it('reverts if called without CONFIG_ADMIN_ROLE', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      await allocator.connect(allocatorRole).commitAllocation(2, ethers.id('root1'), 0)
      await expect(allocator.connect(curator).cancelCommitAllocation(2))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })

    it('reverts if settlements have already started', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(2, root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))

      await expect(allocator.connect(configAdmin).cancelCommitAllocation(2))
        .to.be.revertedWithCustomError(allocator, 'SettlementsAlreadyStarted')
    })
  })

  describe('divergenceTolerance band', () => {
    // Pushes a capacity config that differs from the fixture only in the tolerance.
    // Must be called while currentPeriod < 2 so it is effective at the commit period (2).
    const setTolerance = async (ctx, bps) => {
      await ctx.allocator.connect(ctx.configAdmin).setCapacityConfig({
        minCAR: 12000,
        firstLossBufferToken: await ctx.usdc.getAddress(),
        firstLossBuffer: ctx.firstLossBufferWallet.address,
        effectiveLeverage: 24000,
        minOrderMarketCoverAmount: 1,
        divergenceToleranceBps: bps,
      })
    }

    it('accepts totalAllocated up to capacity × (1 + tolerance) and stores the effective capacity', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole } = ctx
      await setTolerance(ctx, 500) // 5%, effective at period 2
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const period = await vault.currentPeriod()
      // strict capacity = 1000 × 2 = 2000; effective capacity = 2000 × 1.05 = 2100
      const ceiling = ethers.parseUnits('2100', 18)

      await allocator.connect(allocatorRole).commitAllocation(period, ethers.id('atBand'), ceiling)

      const commit = await allocator.getAllocationCommitment(period)
      expect(commit.totalDeclaredAllocated).to.equal(ceiling)
      // Stored capacity is the EFFECTIVE (tolerated) value so per-protocol concentration caps
      // scale by the same margin and a tree committed within tolerance stays settleable.
      expect(commit.totalAvailableCapacity).to.equal(ethers.parseUnits('2100', 18))
    })

    it('reverts when totalAllocated exceeds the tolerated ceiling (and reports the ceiling)', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole } = ctx
      await setTolerance(ctx, 500)
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const period = await vault.currentPeriod()
      const ceiling = ethers.parseUnits('2100', 18)
      // The reverted capacity arg is the tolerated ceiling (2100), proving the band — not the strict 2000.
      await expect(allocator.connect(allocatorRole).commitAllocation(period, ethers.id('over'), ceiling + 1n))
        .to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')
        .withArgs(ceiling + 1n, ceiling)
    })

    it('with tolerance 0 keeps the strict capacity as the ceiling', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole } = ctx
      // fixture default tolerance is already 0; no setTolerance needed.
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const period = await vault.currentPeriod()
      await expect(allocator.connect(allocatorRole).commitAllocation(period, ethers.id('over'), ethers.parseUnits('2001', 18)))
        .to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')
        .withArgs(ethers.parseUnits('2001', 18), ethers.parseUnits('2000', 18))
    })

    it('recommit recomputes capacity and accepts amounts the topped-up collateral now supports', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const period = await vault.currentPeriod()
      // initial capacity = 1000 × 2 = 2000
      await allocator.connect(allocatorRole).commitAllocation(period, ethers.id('root1'), ethers.parseUnits('2000', 18))

      // Top up the first-loss buffer to 2000 USDC → fresh capacity = 4000.
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))

      // 4000 would have overflowed the original commit (2000) but is within the recomputed capacity.
      await allocator.connect(configAdmin).recommitAllocation(period, ethers.id('root2'), ethers.parseUnits('4000', 18))

      const commit = await allocator.getAllocationCommitment(period)
      expect(commit.totalAvailableCapacity).to.equal(ethers.parseUnits('4000', 18))
      expect(commit.totalDeclaredAllocated).to.equal(ethers.parseUnits('4000', 18))
    })

    it('recommit recomputes capacity and rejects amounts the reduced collateral no longer supports', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, buyer1 } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)
      await readyToMatch(ctx)

      const period = await vault.currentPeriod()
      // initial capacity = 2000; commit 2000 is fine.
      await allocator.connect(allocatorRole).commitAllocation(period, ethers.id('root1'), ethers.parseUnits('2000', 18))

      // Buffer holder drains 500 USDC → balance 500 → fresh capacity = 1000.
      await usdc.connect(firstLossBufferWallet).transfer(buyer1.address, ethers.parseUnits('500', 6))

      // 2000 was OK at commit time but exceeds the recomputed capacity (1000).
      await expect(allocator.connect(configAdmin).recommitAllocation(period, ethers.id('root2'), ethers.parseUnits('2000', 18)))
        .to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')
        .withArgs(ethers.parseUnits('2000', 18), ethers.parseUnits('1000', 18))
    })

    // The scenario that motivated applying the tolerance to concentration too: a single 100%
    // concentration protocol with an order whose cover exceeds the strict capacity but fits
    // within the tolerance band. Because the per-protocol cap now scales with the effective
    // (tolerated) capacity, the committed order is actually settleable.
    it('settles an order above strict capacity but within tolerance under a 100% concentration', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const {
        allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, buyer1, marketIdA, PERIOD_DURATION,
      } = ctx

      // marketIdA's protocol (Morpho/1) at 100%, effective next period.
      await allocator.connect(configAdmin).setProtocolConcentration({ protocol: 'Morpho', chainId: 1, maxProtocolConcentrationBps: 10000 })
      await setTolerance(ctx, 500) // 5%
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6)) // strict cap 2000, effective 2100
      await vault.setTotalAssets(0)

      // Cover 2050: above strict (2000), within effective (2100). Single market → all on Morpho.
      const cover = ethers.parseUnits('2050', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW, market: marketIdA })

      await readyToMatch(ctx)
      const period = await vault.currentPeriod()
      const { tree, root } = buildTree([[0n, [mca(marketIdA, cover)], premium]])

      // commit: 2050 ≤ effective 2100 → ok.
      await allocator.connect(allocatorRole).commitAllocation(period, root, cover)

      // settle: per-protocol cap = 100% × effective(2100) = 2100 ≥ 2050 → settles.
      // (Under strict concentration the cap would be 2000 and this would revert ProtocolConcentrationOverflow.)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))

      const order = await allocator.getCoverOrder(0)
      expect(order.status).to.equal(Status.MATCHED)
      const commit = await allocator.getAllocationCommitment(period)
      expect(commit.totalSettledCover).to.equal(cover)
      expect(commit.totalAvailableCapacity).to.equal(ethers.parseUnits('2100', 18))
    })
  })

  describe('getCoverOrderMarketInfo', () => {
    const PENDING = 0n
    const MATCHED = 1n

    it('returns zeros and zero beneficiary for a non-existent order', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const [period, allocated, beneficiary] = await ctx.allocator.getCoverOrderMarketInfo(999, ctx.marketIdA)
      expect(period).to.equal(0n)
      expect(allocated).to.equal(0n)
      expect(beneficiary).to.equal(ethers.ZeroAddress)
    })

    it('returns zeros and zero beneficiary for an existing order but unrelated marketId', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, usdc, buyer1, PERIOD_DURATION } = ctx
      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      const unrelated = ethers.id('not-a-real-market')
      const [period, allocated, beneficiary] = await ctx.allocator.getCoverOrderMarketInfo(0, unrelated)
      expect(period).to.equal(0n)
      expect(allocated).to.equal(0n)
      expect(beneficiary).to.equal(ethers.ZeroAddress)
    })

    it('returns target period, beneficiary and 0 allocation before settle', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, usdc, buyer1, PERIOD_DURATION } = ctx
      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      const [period, allocated, beneficiary] = await ctx.allocator.getCoverOrderMarketInfo(0, ctx.marketIdA)
      expect(period).to.equal(2n)
      expect(allocated).to.equal(0n)
      expect(beneficiary).to.equal(buyer1.address)
    })

    it('returns beneficiary and allocation after settle for the matched market', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)

      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))

      const [period, allocated, beneficiary] = await ctx.allocator.getCoverOrderMarketInfo(0, ctx.marketIdA)
      expect(period).to.equal(2n)
      expect(allocated).to.equal(cover)
      expect(beneficiary).to.equal(buyer1.address)
    })

    it('returns the correct allocation per market for a multi-market order', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('100000', 6))
      await vault.setTotalAssets(0)

      const coverA = ethers.parseUnits('1000', 18)
      const coverB = ethers.parseUnits('2000', 18)
      const totalCover = coverA + coverB
      const premium = prorate(coverA, 500, PERIOD_DURATION) + prorate(coverB, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await allocator.connect(curator).createCoverOrder(
        buyer1.address, buyer1.address, buyer1.address, await usdc.getAddress(),
        [
          { marketId: ctx.marketIdA, coverRateAnnual: 500, coverAmount: coverA },
          { marketId: ctx.marketIdB, coverRateAnnual: 500, coverAmount: coverB },
        ],
        NEW
      )

      await readyToMatch(ctx)

      const { tree, root } = buildTree([
        [0n, [mca(ctx.marketIdA, coverA), mca(ctx.marketIdB, coverB)], premium],
      ])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, totalCover)
      await allocator.connect(allocatorRole).settleCoverOrder(
        0,
        [mcaStruct(ctx.marketIdA, coverA), mcaStruct(ctx.marketIdB, coverB)],
        getProof(tree, 0)
      )

      const [, allocA, beneficiaryA] = await allocator.getCoverOrderMarketInfo(0, ctx.marketIdA)
      const [, allocB, beneficiaryB] = await allocator.getCoverOrderMarketInfo(0, ctx.marketIdB)

      expect(allocA).to.equal(coverA)
      expect(beneficiaryA).to.equal(buyer1.address)
      expect(allocB).to.equal(coverB)
      expect(beneficiaryB).to.equal(buyer1.address)
    })

    it('does not revert on any random orderId/marketId pair', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      await expect(ctx.allocator.getCoverOrderMarketInfo(0, ctx.marketIdA)).to.not.be.reverted
      await expect(ctx.allocator.getCoverOrderMarketInfo(2n ** 200n, ethers.ZeroHash)).to.not.be.reverted
    })
  })

  describe('settle window', () => {
    it('reverts settle when currentPeriod has advanced past order.period (no hindsight settlement)', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium18ToNative(premium))
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)
      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)

      // Advance one period: order.period (2) < currentPeriod (3) → settle window expired
      await ctx.advanceToPeriod(3)
      await expect(
        allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))
      ).to.be.revertedWithCustomError(allocator, 'SettleWindowExpired')
    })

    it('allows settle within order.period', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium18ToNative(premium))
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)
      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)

      // Still at order.period (2) — settle must succeed
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))
      const o = await allocator.getCoverOrder(0)
      expect(o.status).to.equal(Status.MATCHED)
    })
  })

  describe('cancelExpiredOrders', () => {
    const createTwo = async (ctx) => {
      const { usdc, buyer1, buyer2, PERIOD_DURATION } = ctx
      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium18ToNative(premium))
      await ctx.fundAndApprove(buyer2, usdc, premium18ToNative(premium))
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await createOrder(ctx, { buyer: buyer2, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
    }

    it('permissionlessly cancels PENDING orders from past periods in batch', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, buyer1 } = ctx
      await createTwo(ctx)

      // Advance two periods — both orders had targetPeriod=2, now currentPeriod=3
      await ctx.advanceToPeriod(3)

      // Call from a non-privileged signer to prove permissionless
      await allocator.connect(buyer1).cancelExpiredOrders([0, 1])

      const o0 = await allocator.getCoverOrder(0)
      const o1 = await allocator.getCoverOrder(1)
      expect(o0.status).to.equal(Status.CANCELLED)
      expect(o1.status).to.equal(Status.CANCELLED)
    })

    it('emits CoverOrderCancelled per cancelled order', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, buyer1 } = ctx
      await createTwo(ctx)
      await ctx.advanceToPeriod(3)

      await expect(allocator.connect(buyer1).cancelExpiredOrders([0, 1]))
        .to.emit(allocator, 'CoverOrderCancelled').withArgs(0)
        .and.to.emit(allocator, 'CoverOrderCancelled').withArgs(1)
    })

    it('reverts OrderNotExpired when order.period >= currentPeriod', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, buyer1 } = ctx
      await createTwo(ctx)
      // Stay at period 1: order.period (2) > currentPeriod (1) → not expired
      await expect(allocator.connect(buyer1).cancelExpiredOrders([0]))
        .to.be.revertedWithCustomError(allocator, 'OrderNotExpired')

      // Move to period 2: order.period (2) == currentPeriod (2) → still in settle window, not expired
      await ctx.advanceToPeriod(2)
      await expect(allocator.connect(buyer1).cancelExpiredOrders([0]))
        .to.be.revertedWithCustomError(allocator, 'OrderNotExpired')
    })

    it('reverts OrderNotPending when the order is already cancelled or matched', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, buyer1, curator } = ctx
      await createTwo(ctx)

      // Cancel order 0 via curator while still in valid period
      await allocator.connect(curator).cancelCoverOrder(0)
      await ctx.advanceToPeriod(3)
      await expect(allocator.connect(buyer1).cancelExpiredOrders([0]))
        .to.be.revertedWithCustomError(allocator, 'OrderNotPending')
    })

    it('reverts InvalidOrder for non-existent orderId', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, buyer1 } = ctx
      await ctx.advanceToPeriod(3)
      await expect(allocator.connect(buyer1).cancelExpiredOrders([999]))
        .to.be.revertedWithCustomError(allocator, 'InvalidOrder')
    })

    it('blocks settlement of orders cancelled via cancelExpiredOrders', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, buyer1, PERIOD_DURATION } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium18ToNative(premium))
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })

      await readyToMatch(ctx)
      const { tree, root } = buildTree([[0n, [mca(ctx.marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)

      // Expire and clean up
      await ctx.advanceToPeriod(3)
      await allocator.connect(buyer1).cancelExpiredOrders([0])

      // Even if currentPeriod were rewound (hypothetically), the order is no longer PENDING
      // → SettleWindowExpired is checked AFTER OrderNotPending in _settleCoverOrder, so the latter wins.
      await expect(
        allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(ctx.marketIdA, cover)], getProof(tree, 0))
      ).to.be.revertedWithCustomError(allocator, 'OrderNotPending')
    })
  })

  describe('settlementGracePeriod', () => {
    it('default value is 0', async () => {
      const { allocator } = await loadFixture(deployCoverOrderAllocator)
      expect(await allocator.settlementGracePeriod()).to.equal(0)
    })

    it('CONFIG_ADMIN_ROLE can set it; emits SettlementGracePeriodUpdated', async () => {
      const { allocator, configAdmin } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(configAdmin).setSettlementGracePeriod(3600))
        .to.emit(allocator, 'SettlementGracePeriodUpdated')
        .withArgs(0, 3600)
      expect(await allocator.settlementGracePeriod()).to.equal(3600)
    })

    it('reverts if non-CONFIG_ADMIN_ROLE caller', async () => {
      const { allocator, allocatorRole, curator, adminRole } = await loadFixture(deployCoverOrderAllocator)
      for (const signer of [allocatorRole, curator, adminRole]) {
        await expect(allocator.connect(signer).setSettlementGracePeriod(3600))
          .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      }
    })

    it('is hard-capped at 8 hours; the exact ceiling is accepted', async () => {
      const { allocator, configAdmin } = await loadFixture(deployCoverOrderAllocator)
      const maxGrace = 8n * 3600n

      await expect(allocator.connect(configAdmin).setSettlementGracePeriod(maxGrace + 1n))
        .to.be.revertedWithCustomError(allocator, 'InvalidGracePeriod')
        .withArgs(maxGrace + 1n, maxGrace)
      await expect(allocator.connect(configAdmin).setSettlementGracePeriod(maxGrace))
        .to.emit(allocator, 'SettlementGracePeriodUpdated')
        .withArgs(0, maxGrace)
    })

    it('commit reverts when the grace window would reach the period end', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      const GRACE = 3600n
      await allocator.connect(configAdmin).setSettlementGracePeriod(GRACE)

      const { root } = buildTree([[0n, [mca(marketIdA, cover)], premium]])
      const period = await ctx.vault.currentPeriod()

      // Exactly at the boundary (timestamp + grace == period end): no settle instant exists.
      const end = BigInt(await time.latest()) + GRACE + 1000n
      await vault.setCurrentPeriodEnd(end)
      await time.setNextBlockTimestamp(end - GRACE)
      await expect(allocator.connect(allocatorRole).commitAllocation(period, root, cover))
        .to.be.revertedWithCustomError(allocator, 'CommitTooCloseToPeriodEnd')

      // One second earlier the grace window still fits: accepted.
      const end2 = end + GRACE + 1000n
      await vault.setCurrentPeriodEnd(end2)
      await time.setNextBlockTimestamp(end2 - GRACE - 1n)
      await allocator.connect(allocatorRole).commitAllocation(period, root, cover)
    })

    it('settle reverts during grace, succeeds after', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, curator, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      const GRACE = 3600
      await allocator.connect(configAdmin).setSettlementGracePeriod(GRACE)

      const { tree, root } = buildTree([[0n, [mca(marketIdA, cover)], premium]])
      const tx = await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      const block = await ethers.provider.getBlock(tx.blockNumber)
      const expiresAt = block.timestamp + GRACE

      await expect(
        allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))
      ).to.be.revertedWithCustomError(allocator, 'GracePeriodActive').withArgs(expiresAt)

      await time.increaseTo(expiresAt)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))
      expect((await allocator.getCoverOrder(0)).status).to.equal(Status.MATCHED)
    })

    it('resubmit resets the grace timer', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, curator, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      const GRACE = 3600
      await allocator.connect(configAdmin).setSettlementGracePeriod(GRACE)

      const { root: firstRoot } = buildTree([[0n, [mca(marketIdA, cover)], premium]])
      const matchTx = await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),firstRoot, cover)
      const matchBlock = await ethers.provider.getBlock(matchTx.blockNumber)
      const firstExpiry = matchBlock.timestamp + GRACE

      await time.increaseTo(matchBlock.timestamp + GRACE / 2)
      const { tree, root } = buildTree([[0n, [mca(marketIdA, cover)], premium]])
      const resubTx = await allocator.connect(configAdmin).recommitAllocation(2, root, cover)
      const resubBlock = await ethers.provider.getBlock(resubTx.blockNumber)
      const newExpiry = resubBlock.timestamp + GRACE

      // Old grace window expired but the new one (post-resubmit) hasn't.
      await time.increaseTo(firstExpiry)
      await expect(
        allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))
      ).to.be.revertedWithCustomError(allocator, 'GracePeriodActive').withArgs(newExpiry)

      await time.increaseTo(newExpiry)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))
      expect((await allocator.getCoverOrder(0)).status).to.equal(Status.MATCHED)
    })

    it('grace updates after a commit do not move its frozen settle window', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, configAdmin, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      const GRACE = 3600
      await allocator.connect(configAdmin).setSettlementGracePeriod(GRACE)

      const { tree, root } = buildTree([[0n, [mca(marketIdA, cover)], premium]])
      const tx = await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(), root, cover)
      const block = await ethers.provider.getBlock(tx.blockNumber)
      const expiresAt = block.timestamp + GRACE

      // Lowering the grace afterwards does not open the published window earlier.
      await allocator.connect(configAdmin).setSettlementGracePeriod(0)
      await expect(
        allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))
      ).to.be.revertedWithCustomError(allocator, 'GracePeriodActive').withArgs(expiresAt)

      // Raising it does not push the window later: settle opens at the frozen expiry.
      await allocator.connect(configAdmin).setSettlementGracePeriod(4 * 3600)
      await time.increaseTo(expiresAt)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))
      expect((await allocator.getCoverOrder(0)).status).to.equal(Status.MATCHED)
    })

    it('grace period of 0 lets settle in the same block as commit', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, buyer1, PERIOD_DURATION, marketIdA } = ctx
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('10000', 6))
      await vault.setTotalAssets(0)

      const cover = ethers.parseUnits('1000', 18)
      const premium = prorate(cover, 500, PERIOD_DURATION)
      await ctx.fundAndApprove(buyer1, usdc, premium)
      await createOrder(ctx, { buyer: buyer1, token: usdc, coverAmount: cover, rate: 500, orderType: NEW })
      await readyToMatch(ctx)

      expect(await allocator.settlementGracePeriod()).to.equal(0)
      const { tree, root } = buildTree([[0n, [mca(marketIdA, cover)], premium]])
      await allocator.connect(allocatorRole).commitAllocation(await ctx.vault.currentPeriod(),root, cover)
      await allocator.connect(allocatorRole).settleCoverOrder(0, [mcaStruct(marketIdA, cover)], getProof(tree, 0))
      expect((await allocator.getCoverOrder(0)).status).to.equal(Status.MATCHED)
    })
  })
})
