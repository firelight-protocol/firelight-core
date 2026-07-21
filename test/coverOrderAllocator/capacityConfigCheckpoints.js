// Tests targeting the OZ Checkpoints integration for `capacityConfig`.
//
// `_setCapacityConfig` pushes a checkpoint at key = vault.currentPeriod() + 1,
// so a config update at period N takes effect at period N+1. Reads must
// return, for any queried period P, the most recently pushed config whose
// effectivePeriod is ≤ P. That is the semantic of `upperLookup`. Using
// `lowerLookup` (which returns the *first* checkpoint with key ≥ P) flips
// the lookup and breaks every scenario where the queried period falls
// between two checkpoints — or strictly after the last checkpoint.
//
// All tests in the "lookup semantics" suite are designed to FAIL with
// `lowerLookup` and PASS with `upperLookup`.

const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

const PERIOD_DURATION = 604_800
const ONE_E18 = 10n ** 18n

const ensurePeriod = async (vault, p) => {
  await vault.setPeriodConfiguration(p, { epoch: 0, duration: PERIOD_DURATION, startingPeriod: p })
}

const cfgWith = (firstLossBuffer, firstLossBufferToken, overrides = {}) => ({
  minCAR: 12000n,
  firstLossBufferToken,
  firstLossBuffer,
  effectiveLeverage: 24000n,
  minOrderMarketCoverAmount: 1n,
  divergenceToleranceBps: 0,
  ...overrides,
})

describe('CoverOrderAllocator / capacityConfig checkpoints', function () {

  describe('lookup semantics across periods', () => {
    it('returns the initial config right after deploy', async () => {
      const { allocator } = await loadFixture(deployCoverOrderAllocator)
      const cfg = await allocator.getEffectiveCapacityConfig()
      expect(cfg.effectiveLeverage).to.equal(24000n)
      expect(cfg.minCAR).to.equal(12000n)
      expect(cfg.minOrderMarketCoverAmount).to.equal(1n)
    })

    it('returns the prior config when the queried period sits in the gap before the next update takes effect', async () => {
      // Initialize at vault.currentPeriod=1 → checkpoint (key=2, A=initial).
      // Push B at vault.currentPeriod=3 → checkpoint (key=4, B).
      // Query at period 3 (in the gap):
      //   upperLookup(3) → last key ≤ 3 → (2, A) ✓
      //   lowerLookup(3) → first key ≥ 3 → (4, B) ✗
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, configAdmin, vault, firstLossBufferWallet } = ctx

      await ensurePeriod(vault, 4)
      const currentPeriod = 3;
      await vault.setCurrentPeriod(currentPeriod)
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 11111n })
      )

      // Still at period 3 → must return the initial config (A), not the pending B.
      const cfg = await allocator.getCapacityConfigAt(currentPeriod)
      expect(cfg.effectiveLeverage).to.equal(24000n)
    })

    it('returns the latest past config when the query is far past the last update', async () => {
      // Checkpoints: [(2, A=20000), (4, B=11111)]. Advance to period 10.
      //   upperLookup(10) → (4, B) → 11111 ✓
      //   lowerLookup(10) → no key ≥ 10 → 0 → history[0] = A → 20000 ✗
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, configAdmin, vault, firstLossBufferWallet } = ctx

      await ensurePeriod(vault, 4)
      await vault.setCurrentPeriod(3)
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 11111n })
      )

      await ensurePeriod(vault, 10)
      await vault.setCurrentPeriod(10)

      const cfg = await allocator.getEffectiveCapacityConfig()
      expect(cfg.effectiveLeverage).to.equal(11111n)
    })

    it('walks correctly through three configs spanning multiple periods', async () => {
      // Checkpoints to build:
      //   (3, A=20000)   — initial
      //   (5, B=15000)   — pushed at vault.currentPeriod=3
      //   (8, C=11111)   — pushed at vault.currentPeriod=6
      // Config is updated at effective period (currentPeriod + 1)
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, configAdmin, vault, firstLossBufferWallet } = ctx

      await ensurePeriod(vault, 4)
      await vault.setCurrentPeriod(3)
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 15000n })
      )

      await ensurePeriod(vault, 6)
      await ensurePeriod(vault, 7)
      await vault.setCurrentPeriod(6)
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 11111n })
      )

      // Period 5 (gap between B and C) → B is the active config.
      //   upperLookup(5) → (4, B) ✓
      await ensurePeriod(vault, 5)
      await vault.setCurrentPeriod(5)
      expect((await allocator.getEffectiveCapacityConfig()).effectiveLeverage).to.equal(15000n)

      // Period 8 (past last checkpoint) → C is the active config.
      //   upperLookup(8) → (7, C) ✓
      await ensurePeriod(vault, 8)
      await vault.setCurrentPeriod(8)
      expect((await allocator.getEffectiveCapacityConfig()).effectiveLeverage).to.equal(11111n)

      // Period 2 (gap between A and B) → A is the active config.
      //   upperLookup(2) → (2, A) ✓
      await vault.setCurrentPeriod(2)
      const con = await await allocator.getEffectiveCapacityConfig();
      const pwe = await vault.currentPeriod();
      expect((await allocator.getEffectiveCapacityConfig()).effectiveLeverage).to.equal(24000n)
    })

    it('first config is anchored at period 0 (no orphan history slot before init)', async () => {
      // The init config must be reachable at any period >= 0, even periods *before* the
      // vault's currentPeriod at deploy time. Without the idx==0 special-case, init would
      // push at key=currentPeriod()+1 and queries at period 0..currentPeriod would silently
      // hit upperLookupRecent's default-zero return → history[0] (correct only by accident).
      // After the fix, key=0 is an explicit checkpoint so the lookup is well-defined.
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator } = ctx

      const cfgAt0 = await allocator.getCapacityConfigAt(0)
      const cfgAt1 = await allocator.getCapacityConfigAt(1)
      expect(cfgAt0.effectiveLeverage).to.equal(24000n)
      expect(cfgAt0.minCAR).to.equal(12000n)
      expect(cfgAt1.effectiveLeverage).to.equal(24000n)
    })

    it('immediate update right after init does not orphan the lookup at past periods', async () => {
      // Reproduces the historical bug: deploy at currentPeriod=1, update in same period.
      // Pre-fix: init pushed at (2, idx=0); update overwrote to (2, idx=1). Querying period 0/1
      // hit upperLookup default 0 → history[0] = orphan A while admin had replaced it with B.
      // Post-fix: init at (0, 0), update at (2, 1). Query at periods 0/1 returns A (correctly,
      // since B is only effective from period 2), and period 2 returns B.
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, configAdmin, firstLossBufferWallet } = ctx

      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 49999n })
      )

      // Before the update takes effect (next period), past lookups still see A=20000.
      expect((await allocator.getCapacityConfigAt(0)).effectiveLeverage).to.equal(24000n)
      expect((await allocator.getCapacityConfigAt(1)).effectiveLeverage).to.equal(24000n)
      // From period 2 onwards, B is active.
      expect((await allocator.getCapacityConfigAt(2)).effectiveLeverage).to.equal(49999n)
    })

    it('latest write wins when multiple updates land on the same effectivePeriod', async () => {
      // Both updates while vault.currentPeriod=1 → both push at key=2 (overwrite).
      // history grows but only the last value is reachable via the checkpoint.
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, configAdmin, vault, firstLossBufferWallet } = ctx

      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 30000n })
      )
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 25000n })
      )

      await vault.setCurrentPeriod(2)
      expect((await allocator.getEffectiveCapacityConfig()).effectiveLeverage).to.equal(25000n)
    })
  })

  describe('commitAllocation consults the config effective at currentPeriod', () => {
    it('uses the prior config (not a future-pending update) when matching in the gap', async () => {
      // Setup yields two checkpoints with a gap at period 3:
      //   (2, A: leverage 20000 → capacity 2000 USDC)
      //   (4, B: leverage 10000 → capacity 1000 USDC)
      // commitAllocation at period 3 with totalAllocated = 1500 USDC:
      //   upperLookup → A → 1500 ≤ 2000 ✓ (no revert)
      //   lowerLookup → B → 1500 > 1000 ✗ (TotalAllocationOverflow)
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, allocatorRole, configAdmin, vault, usdc, firstLossBufferWallet } = ctx

      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)

      await ensurePeriod(vault, 4)
      await vault.setCurrentPeriod(3)
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 10000n })
      )

      // totalAllocated is canonical 18d; FLB has 1000 USDC native (= 1000 in 18d).
      // Capacity (A, leverage 2): 1000 * 2 = 2000 in 18d. 1500 in 18d ≤ 2000 ✓
      const totalAllocated = ethers.parseUnits('1500', 18)
      await expect(
        allocator.connect(allocatorRole).commitAllocation(await vault.currentPeriod(),ethers.id('root'), totalAllocated, totalAllocated)
      ).to.not.be.reverted
    })

    it('uses the latest past config when matching long after the last update', async () => {
      // Checkpoints: (2, A: leverage 24000 = 2.0x), (4, B: leverage 12000 = 1.0x).
      // Match at period 9 with totalAllocated = 1500 USDC, FLB = 1000 USDC:
      //   upperLookup(9) → B → capacity 1000 → 1500 > 1000 → revert ✓
      //   lowerLookup(9) → no key ≥ 9 → A → capacity 2000 → 1500 ≤ 2000 → no revert ✗
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const { allocator, allocatorRole, configAdmin, vault, usdc, firstLossBufferWallet } = ctx

      await usdc.mint(firstLossBufferWallet.address, ethers.parseUnits('1000', 6))
      await vault.setTotalAssets(0)

      await ensurePeriod(vault, 4)
      await vault.setCurrentPeriod(3)
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, { effectiveLeverage: 12000n })
      )

      await ensurePeriod(vault, 9)
      await vault.setCurrentPeriod(9)

      // After period 9: B is active (leverage 1.0). FLB = 1000 USDC native (= 1000 in 18d).
      // Capacity (B): 1000 * 1 = 1000 in 18d. 1500 in 18d > 1000 → revert.
      const totalAllocated = ethers.parseUnits('1500', 18)
      await expect(
        allocator.connect(allocatorRole).commitAllocation(await vault.currentPeriod(),ethers.id('root'), totalAllocated, ethers.parseUnits('1000', 18))
      ).to.be.revertedWithCustomError(allocator, 'TotalAllocationOverflow')
    })
  })

  describe('createCoverOrder consults the config effective at targetPeriod', () => {
    it('rejects an order whose cover is below the latest past config min, even with no future update queued', async () => {
      // Checkpoints: (2, A: min=1), (4, B: min=1000 USDC).
      // At vault.currentPeriod=5, createCoverOrder with cover=500 USDC:
      //   targetPeriod = 6 → upperLookup(6) → (4, B: min=1000) → 500 < 1000 → revert ✓
      //                       lowerLookup(6) → no key ≥ 6 → history[0]=A: min=1 → 500 ≥ 1 → no revert ✗
      const ctx = await loadFixture(deployCoverOrderAllocator)
      const {
        allocator, curator, configAdmin, vault, usdc, firstLossBufferWallet,
        buyer1, beneficiary, marketIdA,
      } = ctx

      await ensurePeriod(vault, 4)
      await vault.setCurrentPeriod(3)
      await allocator.connect(configAdmin).setCapacityConfig(
        cfgWith(firstLossBufferWallet.address, ctx.usdc.target, {
          minOrderMarketCoverAmount: ethers.parseUnits('1000', 18),
        })
      )

      await ensurePeriod(vault, 5)
      await ensurePeriod(vault, 6)
      await vault.setCurrentPeriod(5)

      const cover = ethers.parseUnits('500', 18)
      await expect(
        allocator.connect(curator).createCoverOrder(
          buyer1.address, buyer1.address, beneficiary.address, await usdc.getAddress(),
          [{ marketId: marketIdA, coverRateAnnual: 500, coverAmount: cover }],
          0
        )
      ).to.be.revertedWithCustomError(allocator, 'OrderMarketCoverAmountTooLow')
    })
  })
})
