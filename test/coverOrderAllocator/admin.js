const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator, computeMarketId } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('CoverOrderAllocator / admin + market management', function () {

  describe('setPremiumCollector', () => {
    it('only ADMIN_ROLE', async () => {
      const { allocator, buyer1, configAdmin } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(buyer1).setPremiumCollector(buyer1.address))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      // CONFIG_ADMIN does NOT have ADMIN_ROLE — should also be rejected.
      await expect(allocator.connect(configAdmin).setPremiumCollector(buyer1.address))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })
    it('reverts on zero + updates + emits', async () => {
      const { allocator, adminRole, buyer1 } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(adminRole).setPremiumCollector(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
      await expect(allocator.connect(adminRole).setPremiumCollector(buyer1.address))
        .to.emit(allocator, 'PremiumCollectorUpdated')
      expect(await allocator.premiumCollector()).to.equal(buyer1.address)
    })
  })

  describe('firstLossBufferToken via setCapacityConfig', () => {
    it('rotating the buffer token persists for the next effective period', async () => {
      const { allocator, configAdmin, vault, firstLossBufferWallet, usdc, usdt, capacityConfig } = await loadFixture(deployCoverOrderAllocator)
      // Initial config has USDC as buffer token (set in fixture).
      expect((await allocator.getEffectiveCapacityConfig()).firstLossBufferToken).to.equal(await usdc.getAddress())

      // Rotate to USDT — takes effect at currentPeriod()+1.
      const newCfg = { ...capacityConfig, firstLossBufferToken: await usdt.getAddress(), firstLossBuffer: firstLossBufferWallet.address }
      await allocator.connect(configAdmin).setCapacityConfig(newCfg)

      await vault.setCurrentPeriod(2)
      expect((await allocator.getEffectiveCapacityConfig()).firstLossBufferToken).to.equal(await usdt.getAddress())
    })
  })

  describe('premium token whitelist', () => {
    it('add/remove + duplicates + missing', async () => {
      const { allocator, configAdmin, usdc, usdt, buyer1 } = await loadFixture(deployCoverOrderAllocator)
      const MockERC20 = await ethers.getContractFactory('MockERC20')
      const newToken = await MockERC20.deploy('X', 'X', 6)
      const newAddr = await newToken.getAddress()

      await expect(allocator.connect(buyer1).addSupportedPremiumToken(newAddr))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      await expect(allocator.connect(configAdmin).addSupportedPremiumToken(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
      await expect(allocator.connect(configAdmin).addSupportedPremiumToken(await usdc.getAddress()))
        .to.be.revertedWithCustomError(allocator, 'PremiumTokenAlreadySupported')
      await expect(allocator.connect(configAdmin).addSupportedPremiumToken(newAddr))
        .to.emit(allocator, 'PremiumTokenAdded').withArgs(newAddr)
      expect(await allocator.isPremiumTokenSupported(newAddr)).to.equal(true)

      await expect(allocator.connect(configAdmin).removeSupportedPremiumToken(newAddr))
        .to.emit(allocator, 'PremiumTokenRemoved').withArgs(newAddr)
      await expect(allocator.connect(configAdmin).removeSupportedPremiumToken(newAddr))
        .to.be.revertedWithCustomError(allocator, 'UnsupportedPremiumToken')
    })

    it('getSupportedPremiumTokens returns the configured tokens', async () => {
      const { allocator, usdc, usdt } = await loadFixture(deployCoverOrderAllocator)
      const tokens = [...(await allocator.getSupportedPremiumTokens())]
      expect(tokens).to.have.members([await usdc.getAddress(), await usdt.getAddress()])
    })
  })

  describe('setCapacityConfig', () => {
    it('only admin + validation + emits', async () => {
      const { allocator, configAdmin, buyer1, firstLossBufferWallet, usdc } = await loadFixture(deployCoverOrderAllocator)
      const ok = {
        minCAR: 12000,
        firstLossBufferToken: await usdc.getAddress(),
        firstLossBuffer: firstLossBufferWallet.address,
        effectiveLeverage: 20000,
        minOrderMarketCoverAmount: 1,
        divergenceToleranceBps: 0,
      }
      await expect(allocator.connect(buyer1).setCapacityConfig(ok))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, effectiveLeverage: 0 }))
        .to.be.revertedWithCustomError(allocator, 'InvalidLeverage')
      // Leverage above MAX_LEVERAGE_FACTOR × minCAR (here 5 × 12000) is rejected; the boundary passes.
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, effectiveLeverage: 60001 }))
        .to.be.revertedWithCustomError(allocator, 'InvalidLeverage')
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, effectiveLeverage: 60000 }))
        .to.emit(allocator, 'CapacityConfigUpdated')
      // The cap is relative: the same leverage that fails at minCAR=12000 passes at minCAR=14000.
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, minCAR: 12000, effectiveLeverage: 70000 }))
        .to.be.revertedWithCustomError(allocator, 'InvalidLeverage')
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, minCAR: 14000, effectiveLeverage: 70000 }))
        .to.emit(allocator, 'CapacityConfigUpdated')
      // minCAR floor is MIN_CAR_BPS (1.2x): just below reverts, the exact floor is `ok` itself.
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, minCAR: 11999 }))
        .to.be.revertedWithCustomError(allocator, 'InvalidMinCAR')
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, firstLossBufferToken: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, firstLossBuffer: ethers.ZeroAddress }))
        .to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, minOrderMarketCoverAmount: 0 }))
        .to.be.revertedWithCustomError(allocator, 'InvalidMinOrderMarketCoverAmount')
      // divergenceToleranceBps above the 1000 bps (10%) hard ceiling is rejected.
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, divergenceToleranceBps: 1001 }))
        .to.be.revertedWithCustomError(allocator, 'InvalidDivergenceTolerance')
        .withArgs(1001)
      // The ceiling value (1000) is accepted.
      await expect(allocator.connect(configAdmin).setCapacityConfig({ ...ok, divergenceToleranceBps: 1000 }))
        .to.emit(allocator, 'CapacityConfigUpdated')
      await expect(allocator.connect(configAdmin).setCapacityConfig(ok))
        .to.emit(allocator, 'CapacityConfigUpdated')
    })
  })

  describe('setPriceFeedAdapter', () => {
    const ONE_E18 = 10n ** 18n
    const deployFeed = async (decimals) => {
      const MockAggregator = await ethers.getContractFactory('MockAggregatorV3')
      return MockAggregator.deploy(decimals, ONE_E18)
    }

    it('reverts if caller is not ADMIN_ROLE', async () => {
      const { allocator, buyer1, configAdmin } = await loadFixture(deployCoverOrderAllocator)
      const feed = await deployFeed(8)
      await expect(allocator.connect(buyer1).setPriceFeedAdapter(await feed.getAddress()))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      // CONFIG_ADMIN does NOT have ADMIN_ROLE.
      await expect(allocator.connect(configAdmin).setPriceFeedAdapter(await feed.getAddress()))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })

    it('reverts on zero address', async () => {
      const { allocator, adminRole } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(adminRole).setPriceFeedAdapter(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(allocator, 'InvalidZeroAddress')
    })

    it('reverts on price feed decimals below 6', async () => {
      const { allocator, adminRole } = await loadFixture(deployCoverOrderAllocator)
      const feed = await deployFeed(5)
      await expect(allocator.connect(adminRole).setPriceFeedAdapter(await feed.getAddress()))
        .to.be.revertedWithCustomError(allocator, 'InvalidPriceFeedDecimals')
        .withArgs(5)
    })

    it('reverts on price feed decimals above 18', async () => {
      const { allocator, adminRole } = await loadFixture(deployCoverOrderAllocator)
      const feed = await deployFeed(19)
      await expect(allocator.connect(adminRole).setPriceFeedAdapter(await feed.getAddress()))
        .to.be.revertedWithCustomError(allocator, 'InvalidPriceFeedDecimals')
        .withArgs(19)
    })

    it('accepts the 6 and 18 decimal bounds', async () => {
      const { allocator, adminRole } = await loadFixture(deployCoverOrderAllocator)
      const low = await deployFeed(6)
      await expect(allocator.connect(adminRole).setPriceFeedAdapter(await low.getAddress()))
        .to.emit(allocator, 'PriceFeedUpdated')
      expect(await allocator.priceFeedDecimals()).to.equal(6)

      const high = await deployFeed(18)
      await expect(allocator.connect(adminRole).setPriceFeedAdapter(await high.getAddress()))
        .to.emit(allocator, 'PriceFeedUpdated')
      expect(await allocator.priceFeedDecimals()).to.equal(18)
    })

    it('updates the adapter and emits PriceFeedUpdated with old/new address and decimals', async () => {
      const { allocator, adminRole, priceFeed } = await loadFixture(deployCoverOrderAllocator)
      const oldAddr = await priceFeed.getAddress() // fixture feed: 18 decimals
      const next = await deployFeed(8)
      const nextAddr = await next.getAddress()

      await expect(allocator.connect(adminRole).setPriceFeedAdapter(nextAddr))
        .to.emit(allocator, 'PriceFeedUpdated')
        .withArgs(oldAddr, 18, nextAddr, 8)

      expect(await allocator.priceFeedAdapter()).to.equal(nextAddr)
      expect(await allocator.priceFeedDecimals()).to.equal(8)
    })
  })

  describe('setMaxPriceAge', () => {
    it('reverts if caller is not ADMIN_ROLE', async () => {
      const { allocator, buyer1, configAdmin } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(buyer1).setMaxPriceAge(7200))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      await expect(allocator.connect(configAdmin).setMaxPriceAge(7200))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })

    it('reverts on zero', async () => {
      const { allocator, adminRole } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(adminRole).setMaxPriceAge(0))
        .to.be.revertedWithCustomError(allocator, 'InvalidMaxPriceAge')
    })

    it('updates and emits MaxPriceAgeUpdated with old/new', async () => {
      const { allocator, adminRole } = await loadFixture(deployCoverOrderAllocator)
      const oldAge = await allocator.maxPriceAge() // fixture: 3600
      await expect(allocator.connect(adminRole).setMaxPriceAge(7200))
        .to.emit(allocator, 'MaxPriceAgeUpdated')
        .withArgs(oldAge, 7200)
      expect(await allocator.maxPriceAge()).to.equal(7200)
    })
  })

  describe('market management', () => {
    it('only curator + duplicate + zero chainId', async () => {
      const { allocator, configAdmin, buyer1 } = await loadFixture(deployCoverOrderAllocator)
      const ma = ethers.encodeBytes32String('market-A')

      await expect(allocator.connect(buyer1).addSupportedMarket([1, 'X', ma]))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      await expect(allocator.connect(configAdmin).addSupportedMarket([0, 'X', ma]))
        .to.be.revertedWithCustomError(allocator, 'InvalidChainId')
      // addSupportedMarket no longer touches caps; new markets are disabled until
      // their protocolConcentration is configured. Adding the same market twice still reverts.
      const mb = ethers.encodeBytes32String('market-new')
      await allocator.connect(configAdmin).addSupportedMarket([42, 'NewProtocol', mb])
      await expect(allocator.connect(configAdmin).addSupportedMarket([42, 'NewProtocol', mb]))
        .to.be.revertedWithCustomError(allocator, 'MarketAlreadyExists')

      const expectedId = computeMarketId(42, 'NewProtocol', mb)
      const m = await allocator.getSupportedMarket(expectedId)
      expect(m.chainId).to.equal(42)
      const concHash = await allocator.getProtocolConcentrationHash(m.chainId, m.protocol)
      expect(await allocator.getEffectiveProtocolConcentration(concHash)).to.equal(0)
    })

    it('setProtocolConcentration updates and validates', async () => {
      const { allocator, configAdmin, concHashMorpho, constants } = await loadFixture(deployCoverOrderAllocator)
      // Morpho starts at 6000, Aave at 4000. Per-protocolConcentration bps act as independent
      // ceilings — no aggregate sum invariant. Setting Morpho to 7000 (sum 11000 > 10000)
      // is allowed; the global cover bound is enforced via TotalAllocationOverflow at match.
      await expect(allocator.connect(configAdmin).setProtocolConcentration(
        { protocol: constants.PROTOCOL_MORPHO, chainId: 1, maxProtocolConcentrationBps: 7000 }
      )).to.emit(allocator, 'ProtocolConcentrationUpdated').withArgs(concHashMorpho, 6000, 7000)
      expect(await allocator.getEffectiveProtocolConcentration(concHashMorpho)).to.equal(7000)

      await expect(allocator.connect(configAdmin).setProtocolConcentration(
        { protocol: constants.PROTOCOL_MORPHO, chainId: 1, maxProtocolConcentrationBps: 5000 }
      )).to.emit(allocator, 'ProtocolConcentrationUpdated').withArgs(concHashMorpho, 7000, 5000)
      expect(await allocator.getEffectiveProtocolConcentration(concHashMorpho)).to.equal(5000)

      // Setting to 0 disables the protocolConcentration (and all markets in it)
      await allocator.connect(configAdmin).setProtocolConcentration(
        { protocol: constants.PROTOCOL_MORPHO, chainId: 1, maxProtocolConcentrationBps: 0 }
      )
      expect(await allocator.getEffectiveProtocolConcentration(concHashMorpho)).to.equal(0)

      // bps > BPS_DENOMINATOR reverts InvalidProtocolConcentration
      await expect(allocator.connect(configAdmin).setProtocolConcentration(
        { protocol: constants.PROTOCOL_MORPHO, chainId: 1, maxProtocolConcentrationBps: 10001 }
      )).to.be.revertedWithCustomError(allocator, 'InvalidProtocolConcentration')
    })

    it('setProtocolConcentration reverts on chainId == 0 (prevents sentinel corruption)', async () => {
      const { allocator, configAdmin } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(configAdmin).setProtocolConcentration(
        { protocol: 'X', chainId: 0, maxProtocolConcentrationBps: 1000 }
      )).to.be.revertedWithCustomError(allocator, 'InvalidChainId')
    })

    it('setProtocolConcentration reverts on empty protocol', async () => {
      const { allocator, configAdmin } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(configAdmin).setProtocolConcentration(
        { protocol: '', chainId: 1, maxProtocolConcentrationBps: 1000 }
      )).to.be.revertedWithCustomError(allocator, 'InvalidProtocolConcentration')
    })

    it('setProtocolConcentration registers a new protocolConcentration on first sight', async () => {
      const { allocator, configAdmin, concHashMorpho, computeProtocolConcentrationHash } = await loadFixture(deployCoverOrderAllocator)

      const newHash = computeProtocolConcentrationHash(8453, 'Compound')
      await expect(allocator.connect(configAdmin).setProtocolConcentration(
        { protocol: 'Compound', chainId: 8453, maxProtocolConcentrationBps: 1000 }
      )).to.emit(allocator, 'ProtocolConcentrationRegistered').withArgs(newHash, 'Compound', 8453)

      const hashes = await allocator.getSupportedProtocolConcentrationHashes()
      expect(hashes.length).to.equal(3)
      expect(hashes).to.include(newHash)
      expect(hashes).to.include(concHashMorpho)
      const id = await allocator.getProtocolConcentrationFromHash(newHash)
      expect(id.protocol).to.equal('Compound')
      expect(id.chainId).to.equal(8453)
    })

    it('batchSetProtocolConcentration happy path', async () => {
      const { allocator, configAdmin, concHashMorpho, concHashAave } = await loadFixture(deployCoverOrderAllocator)
      await allocator.connect(configAdmin).batchSetProtocolConcentration([
        { protocol: 'Morpho', chainId: 1,  maxProtocolConcentrationBps: 5000 },
        { protocol: 'Aave',   chainId: 10, maxProtocolConcentrationBps: 5000 }
      ])
      expect(await allocator.getEffectiveProtocolConcentration(concHashMorpho)).to.equal(5000)
      expect(await allocator.getEffectiveProtocolConcentration(concHashAave)).to.equal(5000)
    })

    it('batchSetProtocolConcentration access control', async () => {
      const { allocator, buyer1 } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(buyer1).batchSetProtocolConcentration([
        { protocol: 'Morpho', chainId: 1, maxProtocolConcentrationBps: 5000 }
      ])).to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })

    it('setProtocolConcentration access control', async () => {
      const { allocator, buyer1 } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(buyer1).setProtocolConcentration(
        { protocol: 'Morpho', chainId: 1, maxProtocolConcentrationBps: 5000 }
      )).to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })

    it('settleCoverOrder / batchSettleCoverOrder require ALLOCATOR_ROLE', async () => {
      const { allocator, buyer1 } = await loadFixture(deployCoverOrderAllocator)
      await expect(allocator.connect(buyer1).settleCoverOrder(0, [], 0, []))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
      await expect(allocator.connect(buyer1).batchSettleCoverOrder([]))
        .to.be.revertedWithCustomError(allocator, 'AccessControlUnauthorizedAccount')
    })
  })

  describe('view functions', () => {
    it('getSupportedMarketIds returns all market ids', async () => {
      const { allocator, marketIdA, marketIdB } = await loadFixture(deployCoverOrderAllocator)
      const ids = await allocator.getSupportedMarketIds()
      expect(ids.length).to.equal(2)
      expect(ids).to.include(marketIdA)
      expect(ids).to.include(marketIdB)
    })

    it('per-protocolConcentration bps are independent ceilings — sum > 10000 is allowed', async () => {
      const { allocator, configAdmin, concHashMorpho, concHashAave, computeProtocolConcentrationHash } =
        await loadFixture(deployCoverOrderAllocator)
      // Three protocolConcentrations at 4000 each sum to 12000 (>100%); the contract no longer
      // enforces an aggregate cap so this must succeed.
      const compoundHash = computeProtocolConcentrationHash(8453, 'Compound')
      await allocator.connect(configAdmin).batchSetProtocolConcentration([
        { protocol: 'Morpho',   chainId: 1,    maxProtocolConcentrationBps: 4000 },
        { protocol: 'Aave',     chainId: 10,   maxProtocolConcentrationBps: 4000 },
        { protocol: 'Compound', chainId: 8453, maxProtocolConcentrationBps: 4000 },
      ])
      expect(await allocator.getEffectiveProtocolConcentration(concHashMorpho)).to.equal(4000)
      expect(await allocator.getEffectiveProtocolConcentration(concHashAave)).to.equal(4000)
      expect(await allocator.getEffectiveProtocolConcentration(compoundHash)).to.equal(4000)
    })

    it('getProtocolConcentrationHash is pure helper matching on-chain derivation', async () => {
      const { allocator, computeProtocolConcentrationHash } = await loadFixture(deployCoverOrderAllocator)
      expect(await allocator.getProtocolConcentrationHash(1, 'Morpho')).to.equal(computeProtocolConcentrationHash(1, 'Morpho'))
    })

    it('getMarketId is pure helper matching on-chain derivation', async () => {
      const { allocator, marketIdA, constants } = await loadFixture(deployCoverOrderAllocator)
      // marketIdA is computed off-chain by the fixture using the same formula the contract uses.
      expect(await allocator.getMarketId(1, constants.PROTOCOL_MORPHO, constants.MARKET_A)).to.equal(marketIdA)
    })

    it('coverNFT() returns the address set in initialize', async () => {
      const { allocator, coverNFT } = await loadFixture(deployCoverOrderAllocator)
      expect(await allocator.coverNFT()).to.equal(await coverNFT.getAddress())
    })

    it('getProtocolConcentrationAt returns the cap effective at the given period', async () => {
      const { allocator, configAdmin, vault, concHashMorpho } = await loadFixture(deployCoverOrderAllocator)
      // Fixture seeds Morpho protocolConcentration to 6000 at currentPeriod()+1 = 2 (vault starts at period 1).
      // A subsequent setProtocolConcentration in period 1 takes effect at period 2 as well.
      // Past-period lookup (period 0) finds no checkpoint → returns 0.
      expect(await allocator.getProtocolConcentrationAt(concHashMorpho, 0)).to.equal(0)
      expect(await allocator.getProtocolConcentrationAt(concHashMorpho, 2)).to.equal(6000)

      // Advance to period 2, then update Morpho protocolConcentration → effective at period 3.
      await vault.setCurrentPeriod(2)
      await allocator.connect(configAdmin).setProtocolConcentration({ protocol: 'Morpho', chainId: 1, maxProtocolConcentrationBps: 3000 })
      expect(await allocator.getProtocolConcentrationAt(concHashMorpho, 2)).to.equal(6000) // unchanged at period 2
      expect(await allocator.getProtocolConcentrationAt(concHashMorpho, 3)).to.equal(3000) // new value at period 3
    })
  })
})
