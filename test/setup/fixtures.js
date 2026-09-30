const { deployFAsset } = require('../../lib/utils_test')
const { upgrades, ethers } = require('hardhat')

const DEFAULT_CONFIG = {
  decimals: 6,
  underlying: 'fXRP',
  lst: 'stfXRP',
  initial_deposit_limit: '50000000000',    // 50k tokens
  period_configuration_duration: 604800             // 1 week
}

const deployVault = async (config = {}) => {
  config = Object.assign({}, DEFAULT_CONFIG, config)
  const abi_coder = ethers.AbiCoder.defaultAbiCoder()
  let token_contract, firelight_vault

  ({ token_contract, asset_manager } = await deployFAsset([config.underlying, config.underlying, 'Ripple', 'XRP', config.decimals]))
  let [deployer, rescuer, blocklister, pauser, limit_updater, period_configuration_updater, user1, user2, user3] = await ethers.getSigners()
  
  const FirelightVaultFactory = await ethers.getContractFactory('FirelightVault')

  const InitParams = {
    defaultAdmin: deployer.address,
    limitUpdater: limit_updater.address,
    blocklister: blocklister.address,
    pauser: pauser.address,
    periodConfigurationUpdater: period_configuration_updater.address,
    rescuer: rescuer.address,
    depositLimit: config.initial_deposit_limit,
    periodConfigurationDuration: config.period_configuration_duration
  }
  const init_params = abi_coder.encode(['address','address','address','address','address','address','uint256','uint48'], Object.values(InitParams))

  // Deploy vault using proxy
  firelight_vault = await upgrades.deployProxy(FirelightVaultFactory, [await token_contract.getAddress(), config.lst, config.lst, init_params])

  const utils = {
    mintAndApprove: async (amount, user) => {
      await token_contract.mintTo(user.address, amount)
      await token_contract.connect(user).approve(firelight_vault.target, amount)
    }
  }

  const payout_signer = await randomSigner()
  const payout_allowlister = await randomSigner()
  const payout_receiver = await randomSigner()
  const incident = await randomSigner()
  await firelight_vault.connect(deployer).grantRole(await firelight_vault.PAYOUT_ROLE(), payout_signer.address)
  await firelight_vault.connect(deployer).grantRole(await firelight_vault.PAYOUT_ALLOWLIST_ROLE(), payout_allowlister.address)
  await firelight_vault.connect(deployer).grantRole(await firelight_vault.INCIDENT_ROLE(), incident.address)
  await firelight_vault.connect(payout_allowlister).addToPayoutAllowlist(payout_receiver.address)

  return {
    token_contract,
    asset_manager,
    firelight_vault,
    deployer,
    rescuer,
    blocklister,
    pauser,
    limit_updater,
    payout_signer,
    payout_allowlister,
    payout_receiver,
    incident,
    period_configuration_updater,
    users: [ user1, user2, user3 ],
    utils,
    config
  }
}

// Helper to compute marketId the same way the contract does
const abiCoder = ethers.AbiCoder.defaultAbiCoder()
const computeMarketId = (chainId, protocol, market) =>
  ethers.keccak256(abiCoder.encode(['uint64', 'string', 'bytes32'], [chainId, protocol, market]))

// Helper to compute protocolConcentration hash the same way the contract does
const computeProtocolConcentrationHash = (chainId, protocol) =>
  ethers.keccak256(abiCoder.encode(['uint64', 'string'], [chainId, protocol]))

const PROTOCOL_MORPHO = 'Morpho'
const PROTOCOL_AAVE   = 'Aave'
const MARKET_A = ethers.encodeBytes32String('market-A')
const MARKET_B = ethers.encodeBytes32String('market-B')

const BPS = 10_000n
const LEV = 10_000n
const SECS_PER_YEAR = 365n * 24n * 3600n

// Produces a funded random signer so tests can run without relying on env-supplied accounts.
const randomSigner = async () => {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider)
  await ethers.provider.send('hardhat_setBalance', [wallet.address, '0x3635C9ADC5DEA00000']) // 1000 ETH
  return wallet
}

/**
 * Deploys a MockCoverOrderAllocatorVault, two mock stablecoins (premium + firstLossBuffer),
 * and the CoverOrderAllocator initialized with two supported markets.
 *
 * Uses a mock vault (instead of the full FirelightVault) so tests are self-contained
 * and can directly set currentPeriod / totalAssets / period duration.
 */
const PERIOD_DURATION = 604800 // 1 week
const deployCoverOrderAllocator = async (config = {}) => {
  const deployer = (await ethers.getSigners())[0]
  const admin = await randomSigner()
  const curator = await randomSigner()
  const allocatorRole = await randomSigner()
  const configAdmin = await randomSigner()
  const adminRole = await randomSigner()
  const premiumCollector = await randomSigner()
  const firstLossBufferWallet = await randomSigner()
  const buyer1 = await randomSigner()
  const buyer2 = await randomSigner()
  const beneficiary = await randomSigner()

  // Mock vault — starts at currentPeriod = 1 to match production (period 0 never exists).
  // Initialize will push the capacity config checkpoint at effectivePeriod = 2,
  // so tests advance to period 2 before matching.
  const MockVault = await ethers.getContractFactory('MockCoverOrderAllocatorVault')
  const vault = await MockVault.connect(deployer).deploy()
  await vault.setCurrentPeriod(1)
  await vault.setTotalAssets(0)
  // Configure periods 1, 2, and 3 with valid duration
  await vault.setPeriodConfiguration(1, { epoch: 0, duration: PERIOD_DURATION, startingPeriod: 1 })
  await vault.setPeriodConfiguration(2, { epoch: 0, duration: PERIOD_DURATION, startingPeriod: 2 })
  await vault.setPeriodConfiguration(3, { epoch: 0, duration: PERIOD_DURATION, startingPeriod: 3 })

  // Mock stablecoins
  const MockERC20 = await ethers.getContractFactory('MockERC20')
  const usdc = await MockERC20.connect(deployer).deploy('MockUSDC', 'mUSDC', 6)
  const usdt = await MockERC20.connect(deployer).deploy('MockUSDT', 'mUSDT', 6)
  await vault.setAsset(await usdc.getAddress())

  // Mock aggregator. Default: $1.00 with 18 decimals. Tests can override the price
  // via `priceFeed.setAnswer(newAnswer)` (in feed-native decimals).
  const MockAggregator = await ethers.getContractFactory('MockAggregatorV3')
  const ONE_E18 = 10n ** 18n
  const priceFeed = await MockAggregator.connect(deployer).deploy(18, ONE_E18)

  // Deploy CoverNFT proxy
  const CoverNFTFactory = await ethers.getContractFactory('CoverNFT')
  const coverNFT = await upgrades.deployProxy(
    CoverNFTFactory,
    ['Firelight Cover', 'FLCOVER', '', admin.address, deployer.address, ethers.ZeroAddress, ethers.ZeroAddress],
    { kind: 'transparent' }
  )

  // The allocator contract
  const Factory = await ethers.getContractFactory('CoverOrderAllocator')

  const markets = [
    { chainId: 1,  protocol: PROTOCOL_MORPHO, market: MARKET_A },
    { chainId: 10, protocol: PROTOCOL_AAVE,   market: MARKET_B }
  ]

  const initialProtocolConcentrations = [
    { protocol: PROTOCOL_MORPHO, chainId: 1,  maxProtocolConcentrationBps: 6000 },
    { protocol: PROTOCOL_AAVE,   chainId: 10, maxProtocolConcentrationBps: 4000 }
  ]

  const capacityConfig = {
    minCAR: 12000,       // 1.2x (the contract's MIN_CAR_BPS floor)
    firstLossBufferToken: await usdc.getAddress(),
    firstLossBuffer: firstLossBufferWallet.address,
    effectiveLeverage: 24000,  // keeps the capacity multiplier at 2.0x (24000/12000)
    minOrderMarketCoverAmount: 1,
    divergenceToleranceBps: 0
  }

  const initParams = {
    vault: await vault.getAddress(),
    premiumCollector: premiumCollector.address,
    coverNFT: await coverNFT.getAddress(),
    priceFeedAdapter: await priceFeed.getAddress(),
    maxPriceAge: 3600,
    premiumTokens: [await usdc.getAddress(), await usdt.getAddress()],
    admin: admin.address,
    adminRole: adminRole.address,
    curatorRole: curator.address,
    allocatorRole: allocatorRole.address,
    configAdminRole: configAdmin.address,
    initialProtocolConcentrations,
    newMarkets: markets,
    capacityConfig,
    priceFeedAdapter: await priceFeed.getAddress(),
    maxPriceAge: 7 * 24 * 3600
  }

  const allocator = await upgrades.deployProxy(
    Factory,
    [initParams],
    {
      kind: 'transparent',
      unsafeAllow: ['missing-initializer-call']
    }
  )

  // Grant MINTER_ROLE on CoverNFT to the allocator
  const MINTER_ROLE = ethers.id('MINTER_ROLE')
  await coverNFT.connect(admin).grantRole(MINTER_ROLE, await allocator.getAddress())

  const marketIdA = computeMarketId(markets[0].chainId, PROTOCOL_MORPHO, MARKET_A)
  const marketIdB = computeMarketId(markets[1].chainId, PROTOCOL_AAVE, MARKET_B)

  const concHashMorpho = computeProtocolConcentrationHash(1, PROTOCOL_MORPHO)
  const concHashAave   = computeProtocolConcentrationHash(10, PROTOCOL_AAVE)

  // Utility: mint tokens to a buyer and approve the allocator to pull them
  const fundAndApprove = async (buyer, token, amount) => {
    await token.mint(buyer.address, amount)
    await token.connect(buyer).approve(await allocator.getAddress(), amount)
  }

  // Move the mock vault to the next period (period + 1 == lastMatched target period)
  const advanceToPeriod = async (p) => { await vault.setCurrentPeriod(p) }

  return {
    allocator,
    coverNFT,
    vault,
    priceFeed,
    usdc,
    usdt,
    priceFeed,
    deployer,
    admin,
    curator,
    allocatorRole,
    configAdmin,
    adminRole,
    premiumCollector,
    firstLossBufferWallet,
    buyer1,
    buyer2,
    beneficiary,
    markets,
    marketIdA,
    marketIdB,
    concHashMorpho,
    concHashAave,
    initialProtocolConcentrations,
    capacityConfig,
    fundAndApprove,
    advanceToPeriod,
    computeMarketId,
    computeProtocolConcentrationHash,
    PERIOD_DURATION,
    constants: { BPS, LEV, SECS_PER_YEAR, PROTOCOL_MORPHO, PROTOCOL_AAVE, MARKET_A, MARKET_B }
  }
}

module.exports = {
  deployVault,
  deployCoverOrderAllocator,
  computeMarketId,
  computeProtocolConcentrationHash,
  randomSigner
}