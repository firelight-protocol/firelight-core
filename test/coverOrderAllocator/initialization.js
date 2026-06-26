const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployCoverOrderAllocator } = require('../setup/fixtures.js')
const { expect } = require('chai')
const { ethers } = require('hardhat')

describe('CoverOrderAllocator / initialization', function () {
  it('grants admin, curator, allocator and configAdmin roles', async () => {
    const { allocator, admin, curator, allocatorRole, configAdmin, adminRole } = await loadFixture(deployCoverOrderAllocator)
    const DEFAULT_ADMIN_ROLE = '0x0000000000000000000000000000000000000000000000000000000000000000'
    const CURATOR_ROLE = ethers.id('CURATOR_ROLE')
    const ALLOCATOR_ROLE = ethers.id('ALLOCATOR_ROLE')
    const CONFIG_ADMIN_ROLE = ethers.id('CONFIG_ADMIN_ROLE')
    const ADMIN_ROLE = ethers.id('ADMIN_ROLE')
    expect(await allocator.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
    expect(await allocator.hasRole(CURATOR_ROLE, curator.address)).to.equal(true)
    expect(await allocator.hasRole(ALLOCATOR_ROLE, allocatorRole.address)).to.equal(true)
    expect(await allocator.hasRole(CONFIG_ADMIN_ROLE, configAdmin.address)).to.equal(true)
    // ADMIN_ROLE is NOT granted by initialize; the fixture grants it post-deploy via DEFAULT_ADMIN.
    expect(await allocator.hasRole(ADMIN_ROLE, adminRole.address)).to.equal(true)
  })

  it('stores vault, premium collector and firstLossBufferToken (via capacityConfig)', async () => {
    const { allocator, vault, premiumCollector, usdc } = await loadFixture(deployCoverOrderAllocator)
    expect(await allocator.vault()).to.equal(await vault.getAddress())
    expect(await allocator.premiumCollector()).to.equal(premiumCollector.address)
    const cfg = await allocator.getEffectiveCapacityConfig()
    expect(cfg.firstLossBufferToken).to.equal(await usdc.getAddress())
  })

  it('seeds supported markets, protocolConcentrations and premium tokens', async () => {
    const { allocator, marketIdA, marketIdB, concHashMorpho, concHashAave, usdc, usdt } = await loadFixture(deployCoverOrderAllocator)
    const mA = await allocator.getSupportedMarket(marketIdA)
    const mB = await allocator.getSupportedMarket(marketIdB)
    expect(mA.chainId).to.equal(1)
    expect(mB.chainId).to.equal(10)
    expect(await allocator.getEffectiveProtocolConcentration(concHashMorpho)).to.equal(6000)
    expect(await allocator.getEffectiveProtocolConcentration(concHashAave)).to.equal(4000)
    const hashes = await allocator.getSupportedProtocolConcentrationHashes()
    expect(hashes.length).to.equal(2)
    expect(await allocator.isPremiumTokenSupported(await usdc.getAddress())).to.equal(true)
    expect(await allocator.isPremiumTokenSupported(await usdt.getAddress())).to.equal(true)
    expect(await allocator.isPremiumTokenSupported(ethers.ZeroAddress)).to.equal(false)
  })

  it('stores the capacity config', async () => {
    const { allocator, firstLossBufferWallet } = await loadFixture(deployCoverOrderAllocator)
    const cfg = await allocator.getEffectiveCapacityConfig()
    expect(cfg.minCAR).to.equal(10000)
    expect(cfg.firstLossBuffer).to.equal(firstLossBufferWallet.address)
    expect(cfg.effectiveLeverage).to.equal(20000)
  })

  it('initialize reverts on zero-address arguments', async () => {
    const {
      coverNFT, vault, premiumCollector, usdc, admin, curator,
      allocatorRole, configAdmin, adminRole, capacityConfig, priceFeed,
    } = await loadFixture(deployCoverOrderAllocator)
    const { upgrades } = require('hardhat')
    const Factory = await ethers.getContractFactory('CoverOrderAllocator')
    const usdcAddr = await usdc.getAddress()
    const vaultAddr = await vault.getAddress()
    const nftAddr = await coverNFT.getAddress()
    const priceFeedAddr = await priceFeed.getAddress()
    const proxyOpts = { kind: 'transparent', unsafeAllow: ['missing-initializer-call'] }

    const baseParams = {
      vault: vaultAddr,
      premiumCollector: premiumCollector.address,
      coverNFT: nftAddr,
      priceFeedAdapter: priceFeedAddr,
      maxPriceAge: 3600,
      premiumTokens: [usdcAddr],
      admin: admin.address,
      adminRole: adminRole.address,
      curatorRole: curator.address,
      allocatorRole: allocatorRole.address,
      configAdminRole: configAdmin.address,
      initialProtocolConcentrations: [],
      newMarkets: [],
      capacityConfig,
      priceFeedAdapter: await priceFeed.getAddress(),
      maxPriceAge: 7 * 24 * 3600
    }
    const Z = ethers.ZeroAddress

    const cases = [
      { ...baseParams, vault: Z },
      { ...baseParams, premiumCollector: Z },
      { ...baseParams, capacityConfig: { ...capacityConfig, firstLossBufferToken: Z } },
      { ...baseParams, coverNFT: Z },
      { ...baseParams, priceFeedAdapter: Z },
      { ...baseParams, maxPriceAge: 0 },
      { ...baseParams, admin: Z },
      { ...baseParams, adminRole: Z },
      { ...baseParams, curatorRole: Z },
      { ...baseParams, allocatorRole: Z },
      { ...baseParams, configAdminRole: Z },
      { ...baseParams, premiumTokens: [Z] }
    ]
    for (const params of cases) {
      await expect(upgrades.deployProxy(Factory, [params], proxyOpts)).to.be.reverted
    }
  })

  it('ERC-7201 STORAGE_LOCATION constant matches the namespace derivation', async () => {
    // The contract uses the ERC-7201 formula to derive its namespaced storage slot from
    // the string "firelight.coverorderallocator.storage". If the namespace string is ever
    // changed without recomputing the constant, the storage layout silently shifts and
    // a fresh deploy would read/write the WRONG slots — and any prior deploy would lose
    // its data on the next upgrade. This test pins the constant to the formula.
    const NAMESPACE = 'firelight.coverorderallocator.storage'

    // keccak256(abi.encode(uint256(keccak256(namespace)) - 1)) & ~bytes32(uint256(0xff))
    const inner = ethers.toBigInt(ethers.id(NAMESPACE)) - 1n
    const innerBytes = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [inner])
    const mask = (1n << 256n) - (1n << 8n) // ~bytes32(uint256(0xff))
    const expected = ethers.toBeHex(ethers.toBigInt(ethers.keccak256(innerBytes)) & mask, 32)

    const onChain = '0x89fd6609332cbe19e528bcd8d4a7f5648af9fc2ad8e8f65d6e02fc4dfabfd000'
    expect(onChain).to.equal(expected)
  })

  it('reverts when re-initialized', async () => {
    const ctx = await loadFixture(deployCoverOrderAllocator)
    const { allocator, vault, premiumCollector, usdc, admin, curator, allocatorRole, configAdmin, adminRole, coverNFT, capacityConfig, priceFeed } = ctx
    const attempt = allocator.initialize({
      vault: await vault.getAddress(),
      premiumCollector: premiumCollector.address,
      coverNFT: await coverNFT.getAddress(),
      priceFeedAdapter: await priceFeed.getAddress(),
      maxPriceAge: 3600,
      premiumTokens: [],
      admin: admin.address,
      adminRole: adminRole.address,
      curatorRole: curator.address,
      allocatorRole: allocatorRole.address,
      configAdminRole: configAdmin.address,
      initialProtocolConcentrations: [],
      newMarkets: [],
      capacityConfig,
      priceFeedAdapter: await priceFeed.getAddress(),
      maxPriceAge: 7 * 24 * 3600
    })
    await expect(attempt).to.be.revertedWithCustomError(allocator, 'InvalidInitialization')
  })
})
