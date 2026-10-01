const { upgrades, ethers } = require('hardhat')

// Random funded signer — mirrors the helper used in CoverOrderAllocator fixtures.
const randomSigner = async () => {
  const wallet = ethers.Wallet.createRandom().connect(ethers.provider)
  await ethers.provider.send('hardhat_setBalance', [wallet.address, '0x3635C9ADC5DEA00000']) // 1000 ETH
  return wallet
}

const ROLES = {
  DEFAULT_ADMIN_ROLE: '0x0000000000000000000000000000000000000000000000000000000000000000',
  CURATOR_ROLE: ethers.id('CURATOR_ROLE'),
  ASSESSMENT_APPROVER_ROLE: ethers.id('ASSESSMENT_APPROVER_ROLE'),
  ASSESSMENT_REJECTER_ROLE: ethers.id('ASSESSMENT_REJECTER_ROLE'),
  INCIDENT_INVALIDATOR_ROLE: ethers.id('INCIDENT_INVALIDATOR_ROLE'),
  CONFIG_ADMIN_ROLE: ethers.id('CONFIG_ADMIN_ROLE'),
  PAYOUT_ADMIN_ROLE: ethers.id('PAYOUT_ADMIN_ROLE'),
  PRICE_FEED_ADMIN_ROLE: ethers.id('PRICE_FEED_ADMIN_ROLE'),
}

const IncidentStatus = {
  NONE: 0, OPEN: 1, CONFIRMED: 2, UNDER_EVALUATION: 3, CLOSED: 4, CANCELED: 5, EXPIRED: 6
}

const AssessmentRoundStatus = {
  NONE: 0, DRAFT: 1, UNDER_EVALUATION: 2, APPROVED: 3, REJECTED: 4, CANCELED: 5
}

const DEFAULT_CAPTURE_TIMESTAMP = 1_700_000_000
const INCIDENT_PERIOD = 2

/**
 * Deploys a self-contained IncidentManager test environment.
 *
 * Layout:
 *   - MockIncidentManagerVault          → vault (settable currentPeriod / periodAtTimestamp / asset / payout)
 *   - MockERC20 (firstLossBufferToken)  → USD-pegged stablecoin (decimals configurable)
 *   - MockERC20 (vault asset)           → token reported via vault.asset() (decimals configurable)
 *   - MockIncidentManagerCoverOrderAllocator → vault + FLB config + canonical decimals + order-market data
 *   - MockPriceFeed                     → Chainlink-shaped aggregator (decimals + price configurable)
 *   - IncidentManager proxy             → the contract under test
 *
 * Defaults: currentPeriod=2, captureTimestamp maps to period 2, canonical=18, vaultAsset=18,
 * flbToken=6, priceFeed=8 decimals, price=$1. assessmentLoss amounts are canonical (18-dec).
 */
const deployIncidentManager = async (config = {}) => {
  const {
    canonicalDecimals = 18,
    vaultAssetDecimals = 18,
    flbTokenDecimals = 6,
    priceFeedDecimals = 8,
    price = 10n ** 8n,            // $1 expressed in priceFeedDecimals (8)
    currentPeriod = INCIDENT_PERIOD
  } = config

  const deployer = (await ethers.getSigners())[0]
  const admin = await randomSigner()
  const curator = await randomSigner()
  const assessmentApprover = await randomSigner()
  const assessmentRejecter = await randomSigner()
  const incidentInvalidator = await randomSigner()
  const configAdmin = await randomSigner()
  const payoutAdmin = await randomSigner()
  const priceFeedAdmin = await randomSigner()
  const payoutReceiver = await randomSigner()
  const firstLossBufferPayer = await randomSigner()
  const payoutRecipient1 = await randomSigner()
  const payoutRecipient2 = await randomSigner()
  const stranger = await randomSigner()

  // Mock vault
  const MockVault = await ethers.getContractFactory('MockIncidentManagerVault')
  const vault = await MockVault.connect(deployer).deploy()
  await vault.setCurrentPeriod(currentPeriod)
  await vault.setPeriodAtTimestamp(DEFAULT_CAPTURE_TIMESTAMP, INCIDENT_PERIOD)

  // Vault asset + first-loss-buffer token
  const MockERC20 = await ethers.getContractFactory('MockERC20')
  const vaultAsset = await MockERC20.connect(deployer).deploy('MockVaultAsset', 'mVA', vaultAssetDecimals)
  await vault.setAsset(vaultAsset.target)
  const firstLossBufferToken = await MockERC20.connect(deployer).deploy('MockUSDC', 'mUSDC', flbTokenDecimals)

  // Mock CoverOrderAllocator
  const MockCoverOrderAllocator = await ethers.getContractFactory('MockIncidentManagerCoverOrderAllocator')
  const coverOrderAllocator = await MockCoverOrderAllocator.connect(deployer).deploy()
  await coverOrderAllocator.setVault(vault.target)
  await coverOrderAllocator.setCanonicalDecimals(canonicalDecimals)
  await coverOrderAllocator.setMockCapacityConfig({
    minCAR: 10000,
    firstLossBufferToken: firstLossBufferToken.target,
    firstLossBuffer: firstLossBufferPayer.address,
    effectiveLeverage: 20000,
    minOrderMarketCoverAmount: 1,
    divergenceToleranceBps: 0
  })

  // Price feed
  const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
  const priceFeed = await MockPriceFeed.connect(deployer).deploy(priceFeedDecimals, price)

  const maxPriceAge = 3600 // 1 hour

  // IncidentManager proxy
  const IncidentManagerFactory = await ethers.getContractFactory('IncidentManager')
  const incidentManager = await upgrades.deployProxy(
    IncidentManagerFactory,
    [
      admin.address,
      curator.address,
      assessmentApprover.address,
      assessmentRejecter.address,
      incidentInvalidator.address,
      configAdmin.address,
      payoutAdmin.address,
      priceFeedAdmin.address,
      payoutReceiver.address,
      coverOrderAllocator.target,
      priceFeed.target,
      maxPriceAge
    ],
    { kind: 'transparent', unsafeAllow: ['missing-initializer-call'] }
  )

  // Helper: encode a curator-defined incident reference.
  const refOf = (s) => ethers.keccak256(ethers.toUtf8Bytes(s))

  // Helper: register one (orderId, marketId) tuple on the mock CoverOrderAllocator.
  const setOrderMarket = (coverTokenId, marketId, allocatedCoverAmount, payoutRecipient, period = INCIDENT_PERIOD) =>
    coverOrderAllocator.setOrderMarket(coverTokenId, marketId, period, allocatedCoverAmount, payoutRecipient)

  // Helper: assessment-loss tuple consumed by addAssessmentLosses (amount in canonical decimals).
  const lossOf = (coverTokenId, marketId, amount) => ({ coverTokenId, marketId, amount })

  // Helper: fund the first-loss-buffer payer and approve IncidentManager to pull `amount` (flbToken units).
  const fundFlb = async (amount) => {
    await firstLossBufferToken.mint(firstLossBufferPayer.address, amount)
    await firstLossBufferToken.connect(firstLossBufferPayer).approve(incidentManager.target, amount)
  }

  const marketIdA = ethers.id('market-A')
  const marketIdB = ethers.id('market-B')

  return {
    incidentManager,
    coverOrderAllocator,
    vault,
    vaultAsset,
    firstLossBufferToken,
    priceFeed,
    deployer,
    admin,
    curator,
    assessmentApprover,
    assessmentRejecter,
    incidentInvalidator,
    configAdmin,
    payoutAdmin,
    priceFeedAdmin,
    payoutReceiver,
    firstLossBufferPayer,
    payoutRecipient1,
    payoutRecipient2,
    stranger,
    maxPriceAge,
    DEFAULT_CAPTURE_TIMESTAMP,
    INCIDENT_PERIOD,
    decimals: { canonicalDecimals, vaultAssetDecimals, flbTokenDecimals, priceFeedDecimals },
    price,
    refOf,
    setOrderMarket,
    lossOf,
    fundFlb,
    marketIdA,
    marketIdB,
    ROLES,
    IncidentStatus,
    AssessmentRoundStatus
  }
}

module.exports = {
  deployIncidentManager,
  ROLES,
  IncidentStatus,
  AssessmentRoundStatus
}
