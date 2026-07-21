// Unit tests for the allocator's premium-token-decimals normalization:
//
//   * On-chain canonical unit is 18 decimals (USD). Cover amounts, premiums, capacity,
//     totalAllocated, totalSettledCover, etc. are stored and validated in 18d.
//   * `addSupportedPremiumToken` / `setCapacityConfig` revert if the buffer or premium
//     token does not implement `decimals()` or returns `> 18`.
//   * `_settleCoverOrder` denormalizes the 18d premium back to the premium token's native
//     decimals with CEIL rounding so the buyer always pays at least the canonical amount.
//   * `getCoverOrder` / `getCoverOrderMarkets` return values in 18d regardless of the order's
//     premium token decimals.

const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')

const NEW = 0
const Status = { PENDING: 0, MATCHED: 1, PARTIAL: 2, CANCELLED: 3 }
const ONE_E18 = 10n ** 18n
const BPS = 10_000n
const YEAR = 365n * 24n * 3600n

// 18d-canonical prorate, ceiling (matches contract's _processMarketAllocations).
const prorate = (cover18, rate, dur) => {
  const num = cover18 * BigInt(rate) * BigInt(dur)
  const den = BPS * YEAR
  return (num + den - 1n) / den
}

// Mirror of _scaleDownCeil(amount18, decimals).
const scaleDownCeil = (amount18, decimals) => {
  if (decimals === 18) return amount18
  const divisor = 10n ** BigInt(18 - decimals)
  return (amount18 + divisor - 1n) / divisor
}

const deployERC20 = async (name, symbol, decimals) => {
  const MockERC20 = await ethers.getContractFactory('MockERC20')
  return MockERC20.deploy(name, symbol, decimals)
}

const buildTree = (entries) =>
  StandardMerkleTree.of(entries.map(e => e.slice(0, 2)), ['uint256', '(bytes32,uint256)[]'])

const proofFor = (tree, orderId) => {
  for (const [i, leaf] of tree.entries()) {
    if (leaf[0] === BigInt(orderId)) return tree.getProof(i)
  }
  throw new Error(`Order ${orderId} not in tree`)
}

const mca = (marketId, cover18) => [marketId, cover18]
const mcaStruct = (marketId, cover18) => ({ marketId, allocatedCover: cover18 })

describe('CoverOrderAllocator / premium token decimals normalization', function () {

  // -----------------------------------------------------------------------------
  // Registration validation
  // -----------------------------------------------------------------------------
  describe('addSupportedPremiumToken / setCapacityConfig', () => {
    it('accepts tokens with decimals ∈ {0, 6, 8, 18}', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const tokens = await Promise.all([
        deployERC20('Zero', 'ZRO', 0),
        deployERC20('USD-6', 'U6', 6),
        deployERC20('USD-8', 'U8', 8),
        deployERC20('USD-18', 'U18', 18),
      ])
      for (const t of tokens) {
        const addr = await t.getAddress()
        await ctx.allocator.connect(ctx.configAdmin).addSupportedPremiumToken(addr)
        expect(await ctx.allocator.isPremiumTokenSupported(addr)).to.equal(true)
      }
    })

    it('addSupportedPremiumToken reverts on decimals > 18', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const odd = await deployERC20('Odd-19', 'O19', 19)
      await expect(
        ctx.allocator.connect(ctx.configAdmin).addSupportedPremiumToken(await odd.getAddress())
      ).to.be.revertedWithCustomError(ctx.allocator, 'UnsupportedDecimals').withArgs(19)
    })

    it('addSupportedPremiumToken reverts when the address has no decimals() (no code)', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const noCode = ethers.Wallet.createRandom().address
      await expect(
        ctx.allocator.connect(ctx.configAdmin).addSupportedPremiumToken(noCode)
      ).to.be.reverted
    })

    it('setCapacityConfig reverts when buffer token decimals > 18', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const odd = await deployERC20('FLB-24', 'F24', 24)
      const cfg = { ...ctx.capacityConfig, firstLossBufferToken: await odd.getAddress() }
      await expect(
        ctx.allocator.connect(ctx.configAdmin).setCapacityConfig(cfg)
      ).to.be.revertedWithCustomError(ctx.allocator, 'UnsupportedDecimals').withArgs(24)
    })
  })

  // -----------------------------------------------------------------------------
  // createCoverOrder: stored amounts are 18d regardless of premium token
  // -----------------------------------------------------------------------------
  describe('createCoverOrder stores 18d canonical amounts', () => {
    it('cover and premium are identical across tokens of different decimals', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, allocatorRole, curator, configAdmin, buyer1, beneficiary, usdc, marketIdA, PERIOD_DURATION } = ctx

      const dai = await deployERC20('DAI', 'DAI', 18)
      const eightDec = await deployERC20('FLT', 'FLT', 8)
      await allocator.connect(configAdmin).addSupportedPremiumToken(await dai.getAddress())
      await allocator.connect(configAdmin).addSupportedPremiumToken(await eightDec.getAddress())

      const tokenSet = [
        { token: usdc, decimals: 6 },
        { token: eightDec, decimals: 8 },
        { token: dai, decimals: 18 },
      ]

      const cover18 = ethers.parseUnits('1234', 18)
      const rate = 500

      let id = 0
      for (const { token } of tokenSet) {
        await allocator.connect(curator).createCoverOrder(
          buyer1.address, buyer1.address, beneficiary.address,
          await token.getAddress(),
          [{ marketId: marketIdA, coverRateAnnual: rate, coverAmount: cover18 }],
          NEW
        )
        const o = await allocator.getCoverOrder(id)
        const expectedPremium18 = prorate(cover18, rate, PERIOD_DURATION)

        expect(o.totalCoverAmount, `order ${id} cover`).to.equal(cover18)
        expect(o.totalPremiumAmount, `order ${id} premium`).to.equal(expectedPremium18)

        const markets = await allocator.getCoverOrderMarkets(id)
        expect(markets[0].coverAmount, `order ${id} market cover`).to.equal(cover18)
        id++
      }
    })

    it('does not transfer any premium tokens on create (only on settle)', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, allocatorRole, curator, configAdmin, buyer1, beneficiary, marketIdA } = ctx
      const dai = await deployERC20('DAI', 'DAI', 18)
      await allocator.connect(configAdmin).addSupportedPremiumToken(await dai.getAddress())

      const cover18 = ethers.parseUnits('1000', 18)
      const before = await dai.balanceOf(buyer1.address)
      await allocator.connect(curator).createCoverOrder(
        buyer1.address, buyer1.address, beneficiary.address, await dai.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18 }],
        NEW
      )
      expect(await dai.balanceOf(buyer1.address)).to.equal(before)
    })
  })

  // -----------------------------------------------------------------------------
  // _settleCoverOrder: transfers premium in token-native decimals (CEIL)
  // -----------------------------------------------------------------------------
  describe('_settleCoverOrder denormalizes premium to token native decimals with ceil', () => {

    // Common test helper: create + match + settle a single order using the supplied premium
    // token; returns the on-chain order plus pre/post balances of buyer & premiumCollector.
    const runSingle = async (ctx, premiumToken, premiumDecimals, cover18) => {
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, premiumCollector, buyer1, marketIdA, PERIOD_DURATION } = ctx
      // FLB token is USDC (6d) by fixture default. Give it enough capacity.
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000000', 6))
      await vault.setTotalAssets(0)

      const premium18 = prorate(cover18, 500, PERIOD_DURATION)
      const premiumNative = scaleDownCeil(premium18, premiumDecimals)
      // Fund buyer in native decimals + approve.
      await premiumToken.mint(buyer1.address, premiumNative)
      await premiumToken.connect(buyer1).approve(await allocator.getAddress(), premiumNative)

      await allocator.connect(curator).createCoverOrder(
        buyer1.address, buyer1.address, buyer1.address, await premiumToken.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18 }],
        NEW
      )

      await ctx.advanceToPeriod(2)

      const tree = buildTree([[0n, [mca(marketIdA, cover18)], premium18]])
      await allocator.connect(allocatorRole).commitAllocation(await vault.currentPeriod(),tree.root, cover18)
      await allocator.connect(allocatorRole).settleCoverOrder(
        0,
        [mcaStruct(marketIdA, cover18)],
        proofFor(tree, 0)
      )

      const order = await allocator.getCoverOrder(0)
      return {
        order,
        premium18,
        premiumNative,
        buyerBalance: await premiumToken.balanceOf(buyer1.address),
        collectorBalance: await premiumToken.balanceOf(premiumCollector.address),
      }
    }

    it('USDC (6d): collector receives ceil(premium18 / 1e12) and buyer is debited exactly that', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const cover18 = ethers.parseUnits('5000', 18)
      const r = await runSingle(ctx, ctx.usdc, 6, cover18)
      expect(r.collectorBalance).to.equal(r.premiumNative)
      expect(r.buyerBalance).to.equal(0n)
      // Sanity: native = ceil(18d / 1e12)
      expect(r.premiumNative).to.equal(scaleDownCeil(r.premium18, 6))
      // Order stores 18d
      expect(r.order.allocatedPremiumAmount).to.equal(r.premium18)
    })

    it('8d token: collector receives ceil(premium18 / 1e10)', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const token = await deployERC20('FLT', 'FLT', 8)
      await ctx.allocator.connect(ctx.configAdmin).addSupportedPremiumToken(await token.getAddress())
      const cover18 = ethers.parseUnits('5000', 18)
      const r = await runSingle(ctx, token, 8, cover18)
      expect(r.collectorBalance).to.equal(r.premiumNative)
      expect(r.premiumNative).to.equal(scaleDownCeil(r.premium18, 8))
      expect(r.order.allocatedPremiumAmount).to.equal(r.premium18)
    })

    it('DAI (18d): premium is the identity — collector receives the full 18d amount', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const dai = await deployERC20('DAI', 'DAI', 18)
      await ctx.allocator.connect(ctx.configAdmin).addSupportedPremiumToken(await dai.getAddress())
      const cover18 = ethers.parseUnits('5000', 18)
      const r = await runSingle(ctx, dai, 18, cover18)
      // 18d → 18d means no scaling
      expect(r.premiumNative).to.equal(r.premium18)
      expect(r.collectorBalance).to.equal(r.premium18)
      expect(r.order.allocatedPremiumAmount).to.equal(r.premium18)
    })

    it('ceil: premium18 not evenly divisible by 10^(18-d) charges buyer 1 wei extra', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      // Pick cover that produces a premium18 with non-zero remainder mod 1e12.
      // For 6d, premium18 mod 1e12 != 0 means scaleDownCeil bumps by 1.
      const cover18 = 1n // wei in 18d — minimum, no min check (fixture min = 1)
      // With cover18=1 and rate*dur > 0, ceil yields 1 wei in 18d.
      // scaleDownCeil(1, 6) = ceil(1 / 1e12) = 1.
      const r = await runSingle(ctx, ctx.usdc, 6, cover18)
      expect(r.premium18).to.equal(1n)
      expect(r.premiumNative).to.equal(1n) // 1 wei USDC, ceiled up from sub-1-wei 18d
      expect(r.collectorBalance).to.equal(1n)
    })

    // Regression test for the CRITICAL fix: `removeSupportedPremiumToken` must NOT
    // delete `premiumTokenDecimals[token]`. If it did, an existing PENDING order with
    // that token would settle with `decimals = 0`, collapsing the premium to ~0 wei
    // (`Decimals.convert(amount, 18, 0, Ceil) ≈ ceil(amount / 1e18)`) — buyer would
    // get full cover + NFT for dust. Confirm the order settles with the correct
    // 6d-native premium even after the token is removed from the whitelist.
    it('regression: order settles with correct premium amount after its premium token is removed', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const {
        allocator, vault, usdc, firstLossBufferWallet,
        allocatorRole, configAdmin, curator, premiumCollector, buyer1,
        marketIdA, PERIOD_DURATION,
      } = ctx

      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000000', 6))
      await vault.setTotalAssets(0)

      // 1) Create order with USDC (6d) while it is still whitelisted.
      const cover18 = ethers.parseUnits('5000', 18)
      const premium18 = prorate(cover18, 500, PERIOD_DURATION)
      const expectedNative = scaleDownCeil(premium18, 6) // what buyer should pay (6d)

      await usdc.mint(buyer1.address, expectedNative)
      await usdc.connect(buyer1).approve(await allocator.getAddress(), expectedNative)

      await allocator.connect(curator).createCoverOrder(
        buyer1.address, buyer1.address, buyer1.address, await usdc.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18 }],
        NEW
      )

      // 2) Remove USDC from the supported premium token whitelist.
      //    The internal `premiumTokenDecimals[USDC]` slot MUST stay set to 6.
      await allocator.connect(configAdmin).removeSupportedPremiumToken(await usdc.getAddress())
      expect(await allocator.isPremiumTokenSupported(await usdc.getAddress())).to.equal(false)

      // 3) Advance, match, settle. Premium charged in native USDC must equal the
      //    pre-remove expected amount — NOT 1 wei (which would mean decimals=0).
      await ctx.advanceToPeriod(2)
      const tree = buildTree([[0n, [mca(marketIdA, cover18)], premium18]])
      await allocator.connect(allocatorRole).commitAllocation(await vault.currentPeriod(), tree.root, cover18)

      const collectorBefore = await usdc.balanceOf(premiumCollector.address)
      const buyerBefore = await usdc.balanceOf(buyer1.address)
      await allocator.connect(allocatorRole).settleCoverOrder(
        0, [mcaStruct(marketIdA, cover18)], proofFor(tree, 0)
      )

      const collectorDelta = (await usdc.balanceOf(premiumCollector.address)) - collectorBefore
      const buyerDelta = buyerBefore - (await usdc.balanceOf(buyer1.address))
      expect(collectorDelta).to.equal(expectedNative)
      expect(buyerDelta).to.equal(expectedNative)
      // Sanity: not the broken-decimals-0 outcome (which would be ceil(premium18 / 1e18) = 1 wei).
      expect(collectorDelta).to.be.gt(1n)

      const order = await allocator.getCoverOrder(0)
      expect(order.allocatedPremiumAmount).to.equal(premium18)
    })
  })

  // -----------------------------------------------------------------------------
  // Batch settle across tokens with different decimals
  // -----------------------------------------------------------------------------
  describe('batchSettleCoverOrder across multiple tokens with different decimals', () => {
    it('three orders, three tokens (6d / 8d / 18d): each collector balance reflects its own scale', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, premiumCollector, buyer1, buyer2, marketIdA, marketIdB, configAdmin, PERIOD_DURATION } = ctx

      // FLB = USDC (6d). Plenty of capacity.
      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000000', 6))
      await vault.setTotalAssets(0)

      const dai = await deployERC20('DAI', 'DAI', 18)
      const eightDec = await deployERC20('FLT', 'FLT', 8)
      await allocator.connect(configAdmin).addSupportedPremiumToken(await dai.getAddress())
      await allocator.connect(configAdmin).addSupportedPremiumToken(await eightDec.getAddress())

      // Need a third signer (fixture only exposes buyer1 / buyer2).
      const buyer3 = ethers.Wallet.createRandom().connect(ethers.provider)
      await ethers.provider.send('hardhat_setBalance', [buyer3.address, '0x3635C9ADC5DEA00000'])

      const cover18A = ethers.parseUnits('1000', 18)
      const cover18B = ethers.parseUnits('2000', 18)
      const cover18C = ethers.parseUnits('3000', 18)
      const p18A = prorate(cover18A, 500, PERIOD_DURATION)
      const p18B = prorate(cover18B, 500, PERIOD_DURATION)
      const p18C = prorate(cover18C, 500, PERIOD_DURATION)

      // Fund each buyer in its premium token's native decimals.
      const nativeA = scaleDownCeil(p18A, 6)
      const nativeB = scaleDownCeil(p18B, 8)
      const nativeC = scaleDownCeil(p18C, 18)
      await usdc.mint(buyer1.address, nativeA)
      await usdc.connect(buyer1).approve(await allocator.getAddress(), nativeA)
      await eightDec.mint(buyer2.address, nativeB)
      await eightDec.connect(buyer2).approve(await allocator.getAddress(), nativeB)
      await dai.mint(buyer3.address, nativeC)
      await dai.connect(buyer3).approve(await allocator.getAddress(), nativeC)

      // Create three orders, one per token (all on marketA so protocolConcentration handles them).
      await allocator.connect(curator).createCoverOrder(
        buyer1.address, buyer1.address, buyer1.address, await usdc.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18A }],
        NEW
      )
      await allocator.connect(curator).createCoverOrder(
        buyer2.address, buyer2.address, buyer2.address, await eightDec.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18B }],
        NEW
      )
      await allocator.connect(curator).createCoverOrder(
        buyer3.address, buyer3.address, buyer3.address, await dai.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18C }],
        NEW
      )

      await ctx.advanceToPeriod(2)
      const total18 = cover18A + cover18B + cover18C
      const tree = buildTree([
        [0n, [mca(marketIdA, cover18A)], p18A],
        [1n, [mca(marketIdA, cover18B)], p18B],
        [2n, [mca(marketIdA, cover18C)], p18C],
      ])
      await allocator.connect(allocatorRole).commitAllocation(await vault.currentPeriod(),tree.root, total18)

      await allocator.connect(allocatorRole).batchSettleCoverOrder([
        { orderId: 0, marketCoverAllocations: [mcaStruct(marketIdA, cover18A)], proof: proofFor(tree, 0) },
        { orderId: 1, marketCoverAllocations: [mcaStruct(marketIdA, cover18B)], proof: proofFor(tree, 1) },
        { orderId: 2, marketCoverAllocations: [mcaStruct(marketIdA, cover18C)], proof: proofFor(tree, 2) },
      ])

      // Each premium-token collector balance is exactly the native ceil per order.
      expect(await usdc.balanceOf(premiumCollector.address)).to.equal(nativeA)
      expect(await eightDec.balanceOf(premiumCollector.address)).to.equal(nativeB)
      expect(await dai.balanceOf(premiumCollector.address)).to.equal(nativeC)

      // Each buyer is debited exactly the native amount.
      expect(await usdc.balanceOf(buyer1.address)).to.equal(0n)
      expect(await eightDec.balanceOf(buyer2.address)).to.equal(0n)
      expect(await dai.balanceOf(buyer3.address)).to.equal(0n)

      // On-chain orders store 18d premiums regardless of underlying token.
      expect((await allocator.getCoverOrder(0)).allocatedPremiumAmount).to.equal(p18A)
      expect((await allocator.getCoverOrder(1)).allocatedPremiumAmount).to.equal(p18B)
      expect((await allocator.getCoverOrder(2)).allocatedPremiumAmount).to.equal(p18C)
      // And aggregated commit accounting is in 18d too.
      const commit = await allocator.getAllocationCommitment(2)
      expect(commit.totalSettledCover).to.equal(total18)
      expect(commit.totalSettledPremium).to.equal(p18A + p18B + p18C)
    })

    it('two buyers share an 18d order each, one uses 6d and the other 18d premium token — orders independent', async () => {
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, vault, usdc, firstLossBufferWallet, allocatorRole, curator, premiumCollector, buyer1, buyer2, marketIdA, configAdmin, PERIOD_DURATION } = ctx

      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000000', 6))
      await vault.setTotalAssets(0)

      const dai = await deployERC20('DAI', 'DAI', 18)
      await allocator.connect(configAdmin).addSupportedPremiumToken(await dai.getAddress())

      const cover18 = ethers.parseUnits('7777', 18)
      const p18 = prorate(cover18, 500, PERIOD_DURATION)
      const usdcNative = scaleDownCeil(p18, 6)
      const daiNative = scaleDownCeil(p18, 18) // == p18

      await usdc.mint(buyer1.address, usdcNative)
      await usdc.connect(buyer1).approve(await allocator.getAddress(), usdcNative)
      await dai.mint(buyer2.address, daiNative)
      await dai.connect(buyer2).approve(await allocator.getAddress(), daiNative)

      await allocator.connect(curator).createCoverOrder(
        buyer1.address, buyer1.address, buyer1.address, await usdc.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18 }],
        NEW
      )
      await allocator.connect(curator).createCoverOrder(
        buyer2.address, buyer2.address, buyer2.address, await dai.getAddress(),
        [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover18 }],
        NEW
      )

      await ctx.advanceToPeriod(2)
      const tree = buildTree([
        [0n, [mca(marketIdA, cover18)], p18],
        [1n, [mca(marketIdA, cover18)], p18],
      ])
      await allocator.connect(allocatorRole).commitAllocation(await vault.currentPeriod(),tree.root, cover18 * 2n)
      await allocator.connect(allocatorRole).batchSettleCoverOrder([
        { orderId: 0, marketCoverAllocations: [mcaStruct(marketIdA, cover18)], proof: proofFor(tree, 0) },
        { orderId: 1, marketCoverAllocations: [mcaStruct(marketIdA, cover18)], proof: proofFor(tree, 1) },
      ])

      // Each token isolated by buyer; balances exactly match the per-token native ceil.
      expect(await usdc.balanceOf(premiumCollector.address)).to.equal(usdcNative)
      expect(await dai.balanceOf(premiumCollector.address)).to.equal(daiNative)
      expect(await usdc.balanceOf(buyer1.address)).to.equal(0n)
      expect(await dai.balanceOf(buyer2.address)).to.equal(0n)
    })
  })
})
