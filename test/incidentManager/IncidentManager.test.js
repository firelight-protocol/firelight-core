const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployIncidentManager, ROLES, IncidentStatus, AssessmentRoundStatus } = require('./fixtures.js')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')

// Canonical-decimal (18) and flb/vault-asset (6) amount helpers.
const e18 = (n) => ethers.parseUnits(n.toString(), 18)
const e6 = (n) => ethers.parseUnits(n.toString(), 6)

// Ordered initialize args, so tests can mutate a single slot.
const initArgs = (ctx, overrides = {}) => {
  const base = {
    admin: ctx.admin.address,
    curator: ctx.curator.address,
    assessmentApprover: ctx.assessmentApprover.address,
    assessmentRejecter: ctx.assessmentRejecter.address,
    incidentInvalidator: ctx.incidentInvalidator.address,
    configAdmin: ctx.configAdmin.address,
    payoutAdmin: ctx.payoutAdmin.address,
    priceFeedAdmin: ctx.priceFeedAdmin.address,
    payoutReceiver: ctx.payoutReceiver.address,
    coverOrderAllocator: ctx.coverOrderAllocator.target,
    priceFeed: ctx.priceFeed.target,
    maxPriceAge: ctx.maxPriceAge,
    ...overrides
  }
  return [
    base.admin, base.curator, base.assessmentApprover, base.assessmentRejecter, base.incidentInvalidator,
    base.configAdmin, base.payoutAdmin, base.priceFeedAdmin, base.payoutReceiver,
    base.coverOrderAllocator, base.priceFeed, base.maxPriceAge
  ]
}

const deployProxyWith = async (args) => {
  const Factory = await ethers.getContractFactory('IncidentManager')
  return upgrades.deployProxy(Factory, args, { kind: 'transparent', unsafeAllow: ['missing-initializer-call'] })
}

// Helper: incident in CONFIRMED state, ready for addAssessmentLosses.
async function withConfirmedIncident(ctx) {
  await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
  await ctx.incidentManager.connect(ctx.curator).confirmIncident(1, 'ipfs://r')
  return 1
}

// Helper: incident with a DRAFT round (incident is UNDER_EVALUATION).
async function withDraftRound(ctx, { amount = 100n, allocated = 1000n } = {}) {
  await withConfirmedIncident(ctx)
  await ctx.setOrderMarket(1, ctx.marketIdA, allocated, ctx.payoutRecipient1.address)
  await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, amount)])
}

// Helper: incident whose current round has been submitted (round UNDER_EVALUATION), ready to approve.
async function withSubmittedRound(ctx, opts = {}) {
  await withDraftRound(ctx, opts)
  await ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1)
}

// Fixture variant with the mock vault still in period zero.
const deployAtPeriodZero = () => deployIncidentManager({ currentPeriod: 0 })

// Helper: drives an already-created incident `incidentId` to a submitted (UNDER_EVALUATION) round.
async function submitRoundFor(ctx, incidentId) {
  await ctx.incidentManager.connect(ctx.curator).confirmIncident(incidentId, 'ipfs://r')
  await ctx.setOrderMarket(incidentId, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
  await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(incidentId, [ctx.lossOf(incidentId, ctx.marketIdA, 100n)])
  await ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(incidentId)
}

describe('IncidentManager', function () {
  describe('initialization', () => {
    it('emits the initial payout receiver', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const Factory = await ethers.getContractFactory('IncidentManager')
      const incidentManager = await upgrades.deployProxy(Factory, [], { kind: 'transparent', initializer: false })

      await expect(incidentManager.initialize(...initArgs(ctx)))
        .to.emit(incidentManager, 'PayoutReceiverUpdated')
        .withArgs(ethers.ZeroAddress, ctx.payoutReceiver.address)
    })

    it('stores wired dependencies', async () => {
      const { incidentManager, coverOrderAllocator, vault, payoutReceiver, priceFeed, maxPriceAge } = await loadFixture(deployIncidentManager)
      expect(await incidentManager.coverOrderAllocator()).to.equal(coverOrderAllocator.target)
      expect(await incidentManager.vault()).to.equal(vault.target)
      expect(await incidentManager.payoutReceiver()).to.equal(payoutReceiver.address)
      expect(await incidentManager.priceFeedAdapter()).to.equal(priceFeed.target)
      expect(await incidentManager.maxPriceAge()).to.equal(maxPriceAge)
      expect(await incidentManager.nextIncidentId()).to.equal(1)
    })

    it('grants every role to the address passed in initialize', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const { incidentManager } = ctx
      expect(await incidentManager.hasRole(ROLES.DEFAULT_ADMIN_ROLE, ctx.admin.address)).to.equal(true)
      expect(await incidentManager.hasRole(ROLES.CURATOR_ROLE, ctx.curator.address)).to.equal(true)
      expect(await incidentManager.hasRole(ROLES.ASSESSMENT_APPROVER_ROLE, ctx.assessmentApprover.address)).to.equal(true)
      expect(await incidentManager.hasRole(ROLES.ASSESSMENT_REJECTER_ROLE, ctx.assessmentRejecter.address)).to.equal(true)
      expect(await incidentManager.hasRole(ROLES.INCIDENT_INVALIDATOR_ROLE, ctx.incidentInvalidator.address)).to.equal(true)
      expect(await incidentManager.hasRole(ROLES.CONFIG_ADMIN_ROLE, ctx.configAdmin.address)).to.equal(true)
      expect(await incidentManager.hasRole(ROLES.PAYOUT_ADMIN_ROLE, ctx.payoutAdmin.address)).to.equal(true)
      expect(await incidentManager.hasRole(ROLES.PRICE_FEED_ADMIN_ROLE, ctx.priceFeedAdmin.address)).to.equal(true)
    })

    it('public role constants match keccak256 of their names', async () => {
      const { incidentManager } = await loadFixture(deployIncidentManager)
      expect(await incidentManager.CURATOR_ROLE()).to.equal(ROLES.CURATOR_ROLE)
      expect(await incidentManager.ASSESSMENT_APPROVER_ROLE()).to.equal(ROLES.ASSESSMENT_APPROVER_ROLE)
      expect(await incidentManager.ASSESSMENT_REJECTER_ROLE()).to.equal(ROLES.ASSESSMENT_REJECTER_ROLE)
      expect(await incidentManager.INCIDENT_INVALIDATOR_ROLE()).to.equal(ROLES.INCIDENT_INVALIDATOR_ROLE)
      expect(await incidentManager.CONFIG_ADMIN_ROLE()).to.equal(ROLES.CONFIG_ADMIN_ROLE)
      expect(await incidentManager.PAYOUT_ADMIN_ROLE()).to.equal(ROLES.PAYOUT_ADMIN_ROLE)
      expect(await incidentManager.PRICE_FEED_ADMIN_ROLE()).to.equal(ROLES.PRICE_FEED_ADMIN_ROLE)
    })

    it('skips granting optional roles (config / payout / priceFeed admin) when their initializers are zero', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const proxy = await deployProxyWith(initArgs(ctx, {
        configAdmin: ethers.ZeroAddress,
        payoutAdmin: ethers.ZeroAddress,
        priceFeedAdmin: ethers.ZeroAddress
      }))
      expect(await proxy.hasRole(ROLES.CONFIG_ADMIN_ROLE, ctx.configAdmin.address)).to.equal(false)
      expect(await proxy.hasRole(ROLES.PAYOUT_ADMIN_ROLE, ctx.payoutAdmin.address)).to.equal(false)
      expect(await proxy.hasRole(ROLES.PRICE_FEED_ADMIN_ROLE, ctx.priceFeedAdmin.address)).to.equal(false)
      expect(await proxy.hasRole(ROLES.DEFAULT_ADMIN_ROLE, ctx.admin.address)).to.equal(true)
      expect(await proxy.hasRole(ROLES.CURATOR_ROLE, ctx.curator.address)).to.equal(true)
    })

    it('reverts on zero-address required initializer arguments', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const Z = ethers.ZeroAddress
      // Required: admin(0), curator(1), assessmentApprover(2), assessmentRejecter(3),
      // incidentInvalidator(4), payoutReceiver(8), coverOrderAllocator(9), priceFeed(10).
      const requiredSlots = [0, 1, 2, 3, 4, 8, 9, 10]
      for (const slot of requiredSlots) {
        const args = initArgs(ctx)
        args[slot] = Z
        await expect(deployProxyWith(args)).to.be.reverted
      }
    })

    it('reverts on zero maxPriceAge', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await expect(deployProxyWith(initArgs(ctx, { maxPriceAge: 0 }))).to.be.reverted
    })

    it('reverts on zero-address price feed adapter', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await expect(deployProxyWith(initArgs(ctx, { priceFeed: ethers.ZeroAddress }))).to.be.reverted
    })

    it('reverts on price feed decimals out of [6, 18]', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
      const lowFeed = await MockPriceFeed.deploy(5, 10n ** 5n)
      const highFeed = await MockPriceFeed.deploy(19, 10n ** 19n)
      await expect(deployProxyWith(initArgs(ctx, { priceFeed: lowFeed.target }))).to.be.reverted
      await expect(deployProxyWith(initArgs(ctx, { priceFeed: highFeed.target }))).to.be.reverted
    })

    it('reverts on re-initialization', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await expect(ctx.incidentManager.initialize(...initArgs(ctx)))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidInitialization')
    })

    it('ERC-7201 STORAGE_LOCATION matches the namespace derivation', async () => {
      const NAMESPACE = 'firelight.incidentmanager.storage'
      const inner = ethers.toBigInt(ethers.id(NAMESPACE)) - 1n
      const innerBytes = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [inner])
      const mask = (1n << 256n) - (1n << 8n)
      const expected = ethers.toBeHex(ethers.toBigInt(ethers.keccak256(innerBytes)) & mask, 32)
      const onChain = '0xb6f563f2177a2296ef417ede66b7ea0704c1a671ddd9f25275dcd155f1fd2a00'
      expect(onChain).to.equal(expected)
    })
  })

  describe('createIncident', () => {
    it('reverts if called by non-curator', async () => {
      const { incidentManager, stranger, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await expect(
        incidentManager.connect(stranger).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A title', refOf('alert:1'))
      ).to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts on empty title', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await expect(
        incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, '', refOf('alert:1'))
      ).to.be.revertedWithCustomError(incidentManager, 'InvalidIncidentTitle')
    })

    it('reverts on title longer than MAX_INCIDENT_TITLE_LENGTH', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      const tooLong = 'x'.repeat(65) // MAX is 64
      await expect(
        incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, tooLong, refOf('alert:1'))
      ).to.be.revertedWithCustomError(incidentManager, 'IncidentTitleTooLong')
    })

    it('reverts on zero incidentRef', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP } = await loadFixture(deployIncidentManager)
      await expect(
        incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A title', ethers.ZeroHash)
      ).to.be.revertedWithCustomError(incidentManager, 'InvalidIncidentRef')
    })

    it('reverts on duplicate incidentRef', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      const ref = refOf('alert:1')
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A title', ref)
      await expect(
        incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'Another title', ref)
      )
        .to.be.revertedWithCustomError(incidentManager, 'IncidentReferenceAlreadyExists')
        .withArgs(ref, 1)
    })

    it('reverts when captureTimestamp falls in a future period', async () => {
      const { incidentManager, vault, curator, refOf } = await loadFixture(deployIncidentManager)
      const ts = 2_000_000_000
      await vault.setPeriodAtTimestamp(ts, 3) // current period is 2
      await expect(
        incidentManager.connect(curator).createIncident(ts, 'A title', refOf('alert:future'))
      ).to.be.revertedWithCustomError(incidentManager, 'InvalidCaptureTimestamp')
    })

    it('reverts when captureTimestamp falls more than one period in the past', async () => {
      const { incidentManager, vault, curator, refOf } = await loadFixture(deployIncidentManager)
      const ts = 1_500_000_000
      await vault.setPeriodAtTimestamp(ts, 0) // current period is 2 → 0 < 2-1 = 1
      await expect(
        incidentManager.connect(curator).createIncident(ts, 'A title', refOf('alert:past'))
      ).to.be.revertedWithCustomError(incidentManager, 'InvalidCaptureTimestamp')
    })

    it('accepts captureTimestamp in current period and previous period', async () => {
      const { incidentManager, vault, curator, refOf } = await loadFixture(deployIncidentManager)
      const tsCurrent = 1_700_000_000
      const tsPrev = 1_690_000_000
      await vault.setPeriodAtTimestamp(tsCurrent, 2)
      await vault.setPeriodAtTimestamp(tsPrev, 1)
      await expect(incidentManager.connect(curator).createIncident(tsCurrent, 'cur', refOf('cur')))
        .to.emit(incidentManager, 'IncidentCreated')
      await expect(incidentManager.connect(curator).createIncident(tsPrev, 'prev', refOf('prev')))
        .to.emit(incidentManager, 'IncidentCreated')
    })

    it('accepts boundary when currentPeriod == 0 (no underflow)', async () => {
      const { incidentManager, vault, curator, refOf } = await loadFixture(deployIncidentManager)
      await vault.setCurrentPeriod(0)
      const ts = 1_700_000_001
      await vault.setPeriodAtTimestamp(ts, 0)
      await expect(incidentManager.connect(curator).createIncident(ts, 'genesis', refOf('genesis')))
        .to.emit(incidentManager, 'IncidentCreated')
    })

    it('creates an incident, stores all fields, increments nextIncidentId, and indexes the ref', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, INCIDENT_PERIOD, refOf } = await loadFixture(deployIncidentManager)
      const ref = refOf('alert:42')
      const title = 'Exploit on protocol X'
      await expect(
        incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, title, ref)
      )
        .to.emit(incidentManager, 'IncidentCreated')
        .withArgs(1, INCIDENT_PERIOD, ref, DEFAULT_CAPTURE_TIMESTAMP, title)

      const [incident, exists] = await incidentManager.getIncident(1)
      expect(exists).to.equal(true)
      expect(incident.title).to.equal(title)
      expect(incident.reportURI).to.equal('')
      expect(incident.period).to.equal(INCIDENT_PERIOD)
      expect(incident.incidentRef).to.equal(ref)
      expect(incident.currentAssessmentRoundId).to.equal(0)
      expect(incident.vaultPaidAmount).to.equal(0)
      expect(incident.captureTimestamp).to.equal(DEFAULT_CAPTURE_TIMESTAMP)
      expect(incident.status).to.equal(IncidentStatus.OPEN)

      expect(await incidentManager.nextIncidentId()).to.equal(2)
      expect(await incidentManager.incidentIdByRef(ref)).to.equal(1)
    })

    it('assigns ids sequentially across multiple incidents', async () => {
      const { incidentManager, vault, curator, DEFAULT_CAPTURE_TIMESTAMP, INCIDENT_PERIOD, refOf } = await loadFixture(deployIncidentManager)

      const ts1 = DEFAULT_CAPTURE_TIMESTAMP
      const ts2 = DEFAULT_CAPTURE_TIMESTAMP + 1
      const ts3 = DEFAULT_CAPTURE_TIMESTAMP + 2

      await vault.setPeriodAtTimestamp(ts2, INCIDENT_PERIOD)
      await vault.setPeriodAtTimestamp(ts3, INCIDENT_PERIOD)

      await incidentManager.connect(curator).createIncident(ts1, 'one', refOf('one'))
      await incidentManager.connect(curator).createIncident(ts2, 'two', refOf('two'))
      await incidentManager.connect(curator).createIncident(ts3, 'three', refOf('three'))
      expect(await incidentManager.nextIncidentId()).to.equal(4)
      expect(await incidentManager.incidentIdByRef(refOf('two'))).to.equal(2)
      expect(await incidentManager.incidentIdByRef(refOf('three'))).to.equal(3)
    })
  })

  describe('confirmIncident', () => {
    it('reverts if called by non-curator', async () => {
      const { incidentManager, curator, stranger, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await expect(incidentManager.connect(stranger).confirmIncident(1, 'ipfs://r'))
        .to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when the incident does not exist', async () => {
      const { incidentManager, curator } = await loadFixture(deployIncidentManager)
      await expect(incidentManager.connect(curator).confirmIncident(99, 'ipfs://r'))
        .to.be.revertedWithCustomError(incidentManager, 'IncidentNotFound')
    })

    it('reverts on empty report URI', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await expect(incidentManager.connect(curator).confirmIncident(1, ''))
        .to.be.revertedWithCustomError(incidentManager, 'InvalidIncidentReportURI')
    })

    it('moves OPEN → CONFIRMED, sets the URI, and emits both events', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      const uri = 'ipfs://QmReport'
      const tx = incidentManager.connect(curator).confirmIncident(1, uri)
      await expect(tx)
        .to.emit(incidentManager, 'IncidentReportURIUpdated').withArgs(1, '', uri)
        .and.to.emit(incidentManager, 'IncidentConfirmed').withArgs(1)

      const [incident] = await incidentManager.getIncident(1)
      expect(incident.reportURI).to.equal(uri)
      expect(incident.status).to.equal(IncidentStatus.CONFIRMED)
    })

    it('reverts if the incident is not OPEN', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await incidentManager.connect(curator).confirmIncident(1, 'ipfs://r1')
      await expect(incidentManager.connect(curator).confirmIncident(1, 'ipfs://r2'))
        .to.be.revertedWithCustomError(incidentManager, 'InvalidIncidentStatus')
    })
  })

  describe('updateIncidentReportURI', () => {
    it('reverts if called by non-config-admin', async () => {
      const { incidentManager, curator, stranger, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await expect(incidentManager.connect(stranger).updateIncidentReportURI(1, 'ipfs://r'))
        .to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when the incident does not exist', async () => {
      const { incidentManager, configAdmin } = await loadFixture(deployIncidentManager)
      await expect(incidentManager.connect(configAdmin).updateIncidentReportURI(7, 'ipfs://r'))
        .to.be.revertedWithCustomError(incidentManager, 'IncidentNotFound')
    })

    it('reverts on empty URI', async () => {
      const { incidentManager, curator, configAdmin, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await expect(incidentManager.connect(configAdmin).updateIncidentReportURI(1, ''))
        .to.be.revertedWithCustomError(incidentManager, 'InvalidIncidentReportURI')
    })

    it('updates URI while incident is OPEN', async () => {
      const { incidentManager, curator, configAdmin, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await expect(incidentManager.connect(configAdmin).updateIncidentReportURI(1, 'ipfs://fix'))
        .to.emit(incidentManager, 'IncidentReportURIUpdated').withArgs(1, '', 'ipfs://fix')
      const [incident] = await incidentManager.getIncident(1)
      expect(incident.reportURI).to.equal('ipfs://fix')
    })

    it('updates URI while incident is CONFIRMED or UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await ctx.incidentManager.connect(ctx.curator).confirmIncident(1, 'ipfs://r1')
      await expect(ctx.incidentManager.connect(ctx.configAdmin).updateIncidentReportURI(1, 'ipfs://r2'))
        .to.emit(ctx.incidentManager, 'IncidentReportURIUpdated').withArgs(1, 'ipfs://r1', 'ipfs://r2')

      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      await expect(ctx.incidentManager.connect(ctx.configAdmin).updateIncidentReportURI(1, 'ipfs://r3'))
        .to.emit(ctx.incidentManager, 'IncidentReportURIUpdated').withArgs(1, 'ipfs://r2', 'ipfs://r3')
    })

    it('reverts when incident is CANCELED', async () => {
      const { incidentManager, curator, configAdmin, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await incidentManager.connect(curator).cancelPreAssessmentIncident(1, "")
      await expect(incidentManager.connect(configAdmin).updateIncidentReportURI(1, 'ipfs://x'))
        .to.be.revertedWithCustomError(incidentManager, 'ReportURIUpdateNotAllowed')
    })

    it('reverts when incident is CLOSED', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withSubmittedRound(ctx, { amount: e18(1000), allocated: e18(1000) })
      await ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1) // → CLOSED
      await expect(ctx.incidentManager.connect(ctx.configAdmin).updateIncidentReportURI(1, 'ipfs://x'))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'ReportURIUpdateNotAllowed')
    })
  })

  describe('addAssessmentLosses', () => {
    it('reverts if called by non-curator', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await expect(ctx.incidentManager.connect(ctx.stranger).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts on empty losses array', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, []))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidAssessmentLosses')
    })

    it('reverts when the incident does not exist', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'IncidentNotFound')
    })

    it('reverts when the incident is not CONFIRMED or UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 10n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidIncidentStatus')
      await ctx.incidentManager.connect(ctx.curator).cancelPreAssessmentIncident(1, "")
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 10n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidIncidentStatus')
    })

    it('reverts on zero loss amount', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 0n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AssessmentLossZeroAmount')
    })

    it('reverts when the order is not found in the CoverOrderAllocator', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'OrderNotFound')
    })

    it('reverts when amount exceeds the allocated cover', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 1001n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AssessmentLossAmountTooBig')
    })

    it('reverts when the order period does not match the incident period', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address, 3) // period 3 ≠ incident period 2
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidOrderPeriod')
    })

    it('reverts on duplicate (coverTokenId, marketId) within the same payload', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [
        ctx.lossOf(1, ctx.marketIdA, 100n),
        ctx.lossOf(1, ctx.marketIdA, 50n)
      ])).to.be.revertedWithCustomError(ctx.incidentManager, 'AssessmentLossAlreadyExists')
    })

    it('reverts on duplicate (coverTokenId, marketId) across appended payloads', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 50n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AssessmentLossAlreadyExists')
    })

    it('creates the first round, moves CONFIRMED → UNDER_EVALUATION and accumulates totals', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.setOrderMarket(1, ctx.marketIdB, 2000n, ctx.payoutRecipient2.address)
      const tx = ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [
        ctx.lossOf(1, ctx.marketIdA, 100n),
        ctx.lossOf(1, ctx.marketIdB, 250n)
      ])
      await expect(tx)
        .to.emit(ctx.incidentManager, 'IncidentUnderEvaluation').withArgs(1)
        .and.to.emit(ctx.incidentManager, 'AssessmentRoundOpened').withArgs(1, 1)
        .and.to.emit(ctx.incidentManager, 'AssessmentLossesAdded').withArgs(1, 1, 2, 350)

      const [round, exists] = await ctx.incidentManager.getAssessmentRound(1, 1)
      expect(exists).to.equal(true)
      expect(round.totalAssessmentLoss).to.equal(350)
      expect(round.status).to.equal(AssessmentRoundStatus.DRAFT)

      expect(await ctx.incidentManager.getAssessmentLossesLength(1, 1)).to.equal(2)
      const [r1] = await ctx.incidentManager.getPayoutRecipientAssessmentLoss(1, 1, ctx.payoutRecipient1.address)
      const [r2] = await ctx.incidentManager.getPayoutRecipientAssessmentLoss(1, 1, ctx.payoutRecipient2.address)
      expect(r1).to.equal(100)
      expect(r2).to.equal(250)
    })

    it('appends additional losses to the existing DRAFT round and keeps incident UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.setOrderMarket(2, ctx.marketIdA, 2000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      const tx = ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(2, ctx.marketIdA, 400n)])
      await expect(tx).to.emit(ctx.incidentManager, 'AssessmentLossesAdded').withArgs(1, 1, 1, 400)
      await expect(tx).to.not.emit(ctx.incidentManager, 'IncidentUnderEvaluation')
      await expect(tx).to.not.emit(ctx.incidentManager, 'AssessmentRoundOpened')

      const [round] = await ctx.incidentManager.getAssessmentRound(1, 1)
      expect(round.totalAssessmentLoss).to.equal(500)
      expect(round.status).to.equal(AssessmentRoundStatus.DRAFT)
      expect(await ctx.incidentManager.getAssessmentLossesLength(1, 1)).to.equal(2)
      const [r1] = await ctx.incidentManager.getPayoutRecipientAssessmentLoss(1, 1, ctx.payoutRecipient1.address)
      expect(r1).to.equal(500)
    })

    it('reverts when appending to a non-DRAFT round (UNDER_EVALUATION)', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.setOrderMarket(2, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      await ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(2, ctx.marketIdA, 100n)]))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidAssessmentRoundStatus')
    })

    it('opens a new round after the previous one was REJECTED', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      await ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1)
      await ctx.incidentManager.connect(ctx.assessmentRejecter).rejectCurrentAssessment(1)

      await ctx.setOrderMarket(2, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      const tx = ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(2, ctx.marketIdA, 200n)])
      await expect(tx)
        .to.emit(ctx.incidentManager, 'AssessmentRoundOpened').withArgs(1, 2)
        .and.to.emit(ctx.incidentManager, 'AssessmentLossesAdded').withArgs(1, 2, 1, 200)
      const [round1] = await ctx.incidentManager.getAssessmentRound(1, 1)
      const [round2] = await ctx.incidentManager.getAssessmentRound(1, 2)
      expect(round1.status).to.equal(AssessmentRoundStatus.REJECTED)
      expect(round2.status).to.equal(AssessmentRoundStatus.DRAFT)
      expect(round2.totalAssessmentLoss).to.equal(200)

      const [r1Loss] = await ctx.incidentManager.getPayoutRecipientAssessmentLoss(1, 1, ctx.payoutRecipient1.address)
      const [r2Loss] = await ctx.incidentManager.getPayoutRecipientAssessmentLoss(1, 2, ctx.payoutRecipient1.address)
      expect(r1Loss).to.equal(100)
      expect(r2Loss).to.equal(200)
    })

    it('opens a new round after the previous one was CANCELED', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      await ctx.incidentManager.connect(ctx.curator).cancelCurrentAssessment(1)

      await ctx.setOrderMarket(2, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await expect(ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(2, ctx.marketIdA, 200n)]))
        .to.emit(ctx.incidentManager, 'AssessmentRoundOpened').withArgs(1, 2)
      const [round2] = await ctx.incidentManager.getAssessmentRound(1, 2)
      expect(round2.status).to.equal(AssessmentRoundStatus.DRAFT)
    })

    it('sums losses across multiple markets for the same payout recipient', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.setOrderMarket(1, ctx.marketIdB, 1000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [
        ctx.lossOf(1, ctx.marketIdA, 100n),
        ctx.lossOf(1, ctx.marketIdB, 300n)
      ])
      const [total] = await ctx.incidentManager.getPayoutRecipientAssessmentLoss(1, 1, ctx.payoutRecipient1.address)
      expect(total).to.equal(400)
    })

    it('getCurrentPayoutRecipientAssessmentLoss returns the value for the latest round id', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withConfirmedIncident(ctx)
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      const [amount, exists] = await ctx.incidentManager.getCurrentPayoutRecipientAssessmentLoss(1, ctx.payoutRecipient1.address)
      expect(exists).to.equal(true)
      expect(amount).to.equal(100)
    })
  })

  describe('submitCurrentAssessment', () => {
    it('reverts if called by non-curator', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.stranger).submitCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when the incident is not UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await expect(ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidIncidentStatus')
    })

    it('moves the round DRAFT → UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1))
        .to.emit(ctx.incidentManager, 'AssessmentRoundSubmitted')
        .withArgs(1, 1, 100)
      const [round] = await ctx.incidentManager.getCurrentAssessmentRound(1)
      expect(round.status).to.equal(AssessmentRoundStatus.UNDER_EVALUATION)
    })

    it('reverts when called twice (status already UNDER_EVALUATION)', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1)
      await expect(ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidAssessmentRoundStatus')
    })
  })

  describe('cancelCurrentAssessment', () => {
    it('reverts if called by non-curator', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.stranger).cancelCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when the incident is not UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await expect(ctx.incidentManager.connect(ctx.curator).cancelCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidIncidentStatus')
    })

    it('cancels a DRAFT round', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.curator).cancelCurrentAssessment(1))
        .to.emit(ctx.incidentManager, 'AssessmentRoundCanceled')
        .withArgs(1, 1)
    })

    it('cancels an UNDER_EVALUATION round', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withSubmittedRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.curator).cancelCurrentAssessment(1))
        .to.emit(ctx.incidentManager, 'AssessmentRoundCanceled')
        .withArgs(1, 1)
    })

    it('reverts when the round is in a terminal state (already CANCELED)', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await ctx.incidentManager.connect(ctx.curator).cancelCurrentAssessment(1)
      await expect(ctx.incidentManager.connect(ctx.curator).cancelCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidAssessmentRoundStatus')
    })
  })

  describe('rejectCurrentAssessment', () => {
    it('reverts if called by non-rejecter', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withSubmittedRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.stranger).rejectCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when the incident is not UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await expect(ctx.incidentManager.connect(ctx.assessmentRejecter).rejectCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidIncidentStatus')
    })

    it('reverts when the round is still DRAFT (must be UNDER_EVALUATION to reject)', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.assessmentRejecter).rejectCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidAssessmentRoundStatus')
    })

    it('moves a submitted round UNDER_EVALUATION → REJECTED, leaving incident UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withSubmittedRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.assessmentRejecter).rejectCurrentAssessment(1))
        .to.emit(ctx.incidentManager, 'AssessmentRoundRejected')
        .withArgs(1, 1)
      const [incident] = await ctx.incidentManager.getIncident(1)
      expect(incident.status).to.equal(IncidentStatus.UNDER_EVALUATION)
    })
  })

  describe('approveCurrentAssessment', () => {
    it('reverts if called by non-approver', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withSubmittedRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.stranger).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when the incident is not UNDER_EVALUATION', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidIncidentStatus')
    })

    it('reverts when the round has not been submitted (still DRAFT)', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidAssessmentRoundStatus')
    })

    it('vault-only payout: zero first-loss buffer balance, full loss paid by the vault', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const total = e18(1000)
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      // No flb funding → flbPayerBalance is 0. price $1, vault asset 18-dec → vaultRequested == total.
      const tx = ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)
      await expect(tx)
        .to.emit(ctx.incidentManager, 'AssessmentRoundApproved')
        .withArgs(1, 1, total)
        .and.to.emit(ctx.incidentManager, 'IncidentPayoutExecuted')
        .withArgs(1, 1, ctx.INCIDENT_PERIOD, ctx.INCIDENT_PERIOD, ctx.payoutReceiver.address, ctx.firstLossBufferPayer.address,
          ctx.firstLossBufferToken.target, 0, total, total, total)
        .and.to.emit(ctx.incidentManager, 'IncidentClosed').withArgs(1, total, total)

      const [incident] = await ctx.incidentManager.getIncident(1)
      expect(incident.status).to.equal(IncidentStatus.CLOSED)
      expect(incident.vaultPaidAmount).to.equal(total)
      // Vault path only — no flb tokens moved.
      expect(await ctx.firstLossBufferToken.balanceOf(ctx.payoutReceiver.address)).to.equal(0)
    })

    it('emits the next period as executionPeriod when approved in the following period', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const total = e18(1000)
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      await ctx.vault.setCurrentPeriod(ctx.INCIDENT_PERIOD + 1)

      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.emit(ctx.incidentManager, 'IncidentPayoutExecuted')
        .withArgs(
          1,
          1,
          ctx.INCIDENT_PERIOD,
          ctx.INCIDENT_PERIOD + 1,
          ctx.payoutReceiver.address,
          ctx.firstLossBufferPayer.address,
          ctx.firstLossBufferToken.target,
          0,
          total,
          total,
          total
        )
    })

    it('first-loss-buffer-only payout: buffer covers the full loss, vault pays nothing', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const total = e18(1000)
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      await ctx.fundFlb(e6(2000)) // buffer holds 2000 USDC (6-dec), more than enough

      const tx = ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)
      // 1000 canonical → 1000e6 flb; remainder 0 → no vault payout.
      await expect(tx)
        .to.emit(ctx.incidentManager, 'IncidentPayoutExecuted')
        .withArgs(1, 1, ctx.INCIDENT_PERIOD, ctx.INCIDENT_PERIOD, ctx.payoutReceiver.address, ctx.firstLossBufferPayer.address,
          ctx.firstLossBufferToken.target, e6(1000), total, 0, 0)

      expect(await ctx.firstLossBufferToken.balanceOf(ctx.payoutReceiver.address)).to.equal(e6(1000))
      const [incident] = await ctx.incidentManager.getIncident(1)
      expect(incident.status).to.equal(IncidentStatus.CLOSED)
      expect(incident.vaultPaidAmount).to.equal(0)
    })

    it('mixed payout: buffer covers part, vault covers the remainder', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const total = e18(1000)
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      await ctx.fundFlb(e6(400)) // buffer covers 400, remainder 600 to the vault

      const tx = ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)
      await expect(tx)
        .to.emit(ctx.incidentManager, 'IncidentPayoutExecuted')
        .withArgs(1, 1, ctx.INCIDENT_PERIOD, ctx.INCIDENT_PERIOD, ctx.payoutReceiver.address, ctx.firstLossBufferPayer.address,
          ctx.firstLossBufferToken.target, e6(400), total, e18(600), e18(600))

      expect(await ctx.firstLossBufferToken.balanceOf(ctx.payoutReceiver.address)).to.equal(e6(400))
      const [incident] = await ctx.incidentManager.getIncident(1)
      expect(incident.vaultPaidAmount).to.equal(e18(600))
      expect(incident.status).to.equal(IncidentStatus.CLOSED)
    })

    it('records the actual vault-paid amount when the vault pays less than requested', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const total = e18(1000)
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      await ctx.vault.setPayoutReturn(e18(900)) // vault honours only 900 of the 1000 requested

      await ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)
      const [incident] = await ctx.incidentManager.getIncident(1)
      expect(incident.vaultPaidAmount).to.equal(e18(900))
      expect(incident.status).to.equal(IncidentStatus.CLOSED)
    })

    it('buffer balance positive but too small to convert: no flb transfer, vault pays everything', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const total = 1n // 1 wei canonical → converts to 0 flb (6-dec) units
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      await ctx.fundFlb(e6(1000)) // buffer has balance, but totalAssessmentLoss is too small to draw from it

      const tx = ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)
      // flbAmount 0, vault asset is 18-dec so vaultRequested == 1.
      await expect(tx)
        .to.emit(ctx.incidentManager, 'IncidentPayoutExecuted')
        .withArgs(1, 1, ctx.INCIDENT_PERIOD, ctx.INCIDENT_PERIOD, ctx.payoutReceiver.address, ctx.firstLossBufferPayer.address,
          ctx.firstLossBufferToken.target, 0, total, total, total)
      expect(await ctx.firstLossBufferToken.balanceOf(ctx.payoutReceiver.address)).to.equal(0)
    })

    it('reverts with IncidentPayoutWindowExpired when the covered period is more than one period old', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withSubmittedRound(ctx, { amount: e18(10), allocated: e18(10) })
      await ctx.vault.setCurrentPeriod(ctx.INCIDENT_PERIOD + 2) // currentPeriod > period + 1
      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'IncidentPayoutWindowExpired')
        .withArgs(1, ctx.INCIDENT_PERIOD)
    })

    it('reverts with PayoutRoundsToZero when the loss is too small to produce any transfer', async () => {
      // vault asset has 6 decimals: a 1-wei canonical loss rounds to 0 vault units and there is no buffer.
      // (deployIncidentManager called directly — loadFixture would ignore the decimals override.)
      const ctx = await deployIncidentManager({ vaultAssetDecimals: 6 })
      const total = 1n
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'PayoutRoundsToZero')
    })

    it('does not revert when the buffer paid something but the vault remainder rounds to zero', async () => {
      // vault asset 6-dec; buffer covers the bulk, leaving a 1-wei canonical remainder that rounds to 0 vault units.
      const ctx = await deployIncidentManager({ vaultAssetDecimals: 6 })
      const total = e18(1000) + 1n
      await withSubmittedRound(ctx, { amount: total, allocated: total })
      await ctx.fundFlb(e6(1000))

      const tx = ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)
      await expect(tx)
        .to.emit(ctx.incidentManager, 'IncidentPayoutExecuted')
        .withArgs(1, 1, ctx.INCIDENT_PERIOD, ctx.INCIDENT_PERIOD, ctx.payoutReceiver.address, ctx.firstLossBufferPayer.address,
          ctx.firstLossBufferToken.target, e6(1000), total, 0, 0)
      const [incident] = await ctx.incidentManager.getIncident(1)
      expect(incident.status).to.equal(IncidentStatus.CLOSED)
      expect(incident.vaultPaidAmount).to.equal(0)
    })

    it('reverts when the price feed answer is stale (older than maxPriceAge)', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withSubmittedRound(ctx, { amount: e18(1000), allocated: e18(1000) })
      // Stamp the round far in the past so block.timestamp - updatedAt > maxPriceAge.
      // PriceFeedTooOld is declared in the PriceFeed library, so match against its interface.
      const PriceFeedLib = await ethers.getContractFactory('PriceFeed')
      await ctx.priceFeed.setLatestRoundData(1, ctx.price, 1, 1, 1)
      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(PriceFeedLib, 'PriceFeedTooOld')
        .withArgs(1, ctx.maxPriceAge)
    })
  })

  describe('cancelPreAssessmentIncident', () => {
    it('reverts if called by non-curator', async () => {
      const { incidentManager, curator, stranger, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A title', refOf('a'))
      await expect(incidentManager.connect(stranger).cancelPreAssessmentIncident(1, ""))
        .to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('reverts when the incident does not exist', async () => {
      const { incidentManager, curator } = await loadFixture(deployIncidentManager)
      await expect(incidentManager.connect(curator).cancelPreAssessmentIncident(42, ""))
        .to.be.revertedWithCustomError(incidentManager, 'IncidentNotFound')
    })

    it('cancels an OPEN incident and emits the status transition', async () => {
      const cancelReason = "real reason"
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A title', refOf('a'))
      await expect(incidentManager.connect(curator).cancelPreAssessmentIncident(1, cancelReason))
        .to.emit(incidentManager, 'IncidentCanceledPreAssessment')
        .withArgs(1, cancelReason)
      const [incident] = await incidentManager.getIncident(1)
      expect(incident.status).to.equal(IncidentStatus.CANCELED)
      expect(incident.cancelReason).to.equal(cancelReason)
    })

    it('cancels a CONFIRMED incident and emits the status transition', async () => {
      const cancelReason = "real reason"
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A title', refOf('a'))
      await incidentManager.connect(curator).confirmIncident(1, 'ipfs://report')
      await expect(incidentManager.connect(curator).cancelPreAssessmentIncident(1, cancelReason))
        .to.emit(incidentManager, 'IncidentCanceledPreAssessment')
        .withArgs(1, cancelReason)
    })

    it('reverts if cancel reason is too long', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      const maxCancelReasonLength = await incidentManager.MAX_CANCEL_REASON_LENGTH()
      const longCancelReason = "A".repeat(Number(maxCancelReasonLength) + 1)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A title', refOf('a'))
      await incidentManager.connect(curator).confirmIncident(1, 'ipfs://report')
      await expect(incidentManager.connect(curator).cancelPreAssessmentIncident(1, longCancelReason))
        .to.be.revertedWithCustomError(incidentManager, 'CancelReasonTooLong')
        .withArgs(BigInt(longCancelReason.length), maxCancelReasonLength)
    })

    it('reverts when curator tries to cancel an UNDER_EVALUATION incident', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      await expect(ctx.incidentManager.connect(ctx.curator).cancelPreAssessmentIncident(1, ""))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidIncidentStatus')
    })

    it('reverts when canceling an already CANCELED incident', async () => {
      const { incidentManager, curator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await incidentManager.connect(curator).cancelPreAssessmentIncident(1, "")
      await expect(incidentManager.connect(curator).cancelPreAssessmentIncident(1, ""))
        .to.be.revertedWithCustomError(incidentManager, 'InvalidIncidentStatus')
    })
  })

  describe('cancelIncident', () => {
    it('reverts if not called by INCIDENT_INVALIDATOR_ROLE', async () => {
      const { incidentManager, curator, stranger, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await expect(incidentManager.connect(stranger).cancelIncident(1, ""))
        .to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('cancels an UNDER_EVALUATION incident', async () => {
      const cancelReason = "invalidator reason"
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      const tx = ctx.incidentManager.connect(ctx.incidentInvalidator).cancelIncident(1, cancelReason)
      await expect(tx)
        .to.emit(ctx.incidentManager, 'AssessmentRoundCanceled')
        .withArgs(1, 1)
      await expect(tx)
        .to.emit(ctx.incidentManager, 'IncidentInvalidated')
        .withArgs(1, cancelReason)
    })

    it('reverts when cancelIncident a non-UNDER_EVALUATION incident', async () => {
      const { incidentManager, curator, incidentInvalidator, DEFAULT_CAPTURE_TIMESTAMP, refOf } = await loadFixture(deployIncidentManager)
      await incidentManager.connect(curator).createIncident(DEFAULT_CAPTURE_TIMESTAMP, 'A', refOf('a'))
      await expect(incidentManager.connect(incidentInvalidator).cancelIncident(1, ""))
        .to.be.revertedWithCustomError(incidentManager, 'InvalidIncidentStatus')
    })
  })

  describe('admin setters', () => {
    describe('setPayoutReceiver', () => {
      it('reverts if called by non-payout-admin', async () => {
        const { incidentManager, stranger } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(stranger).setPayoutReceiver(stranger.address))
          .to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
      })

      it('reverts on zero address', async () => {
        const { incidentManager, payoutAdmin } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(payoutAdmin).setPayoutReceiver(ethers.ZeroAddress))
          .to.be.revertedWithCustomError(incidentManager, 'InvalidZeroAddress')
      })

      it('updates the receiver and emits the event with old/new values', async () => {
        const { incidentManager, payoutAdmin, payoutReceiver, stranger } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(payoutAdmin).setPayoutReceiver(stranger.address))
          .to.emit(incidentManager, 'PayoutReceiverUpdated')
          .withArgs(payoutReceiver.address, stranger.address)
        expect(await incidentManager.payoutReceiver()).to.equal(stranger.address)
      })
    })

    describe('setMaxPriceAge', () => {
      it('reverts if called by non-price-feed-admin (config admin is no longer authorized)', async () => {
        const { incidentManager, configAdmin } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(configAdmin).setMaxPriceAge(60))
          .to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
      })

      it('reverts on zero', async () => {
        const { incidentManager, priceFeedAdmin } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(priceFeedAdmin).setMaxPriceAge(0))
          .to.be.revertedWithCustomError(incidentManager, 'InvalidMaxPriceAge')
      })

      it('updates and emits', async () => {
        const { incidentManager, priceFeedAdmin, maxPriceAge } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(priceFeedAdmin).setMaxPriceAge(60))
          .to.emit(incidentManager, 'MaxPriceAgeUpdated').withArgs(maxPriceAge, 60)
        expect(await incidentManager.maxPriceAge()).to.equal(60)
      })
    })

    describe('setPriceFeedAdapter', () => {
      it('reverts if called by non-price-feed-admin', async () => {
        const { incidentManager, stranger, priceFeed } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(stranger).setPriceFeedAdapter(priceFeed.target))
          .to.be.revertedWithCustomError(incidentManager, 'AccessControlUnauthorizedAccount')
      })

      it('reverts on zero address', async () => {
        const { incidentManager, priceFeedAdmin } = await loadFixture(deployIncidentManager)
        await expect(incidentManager.connect(priceFeedAdmin).setPriceFeedAdapter(ethers.ZeroAddress))
          .to.be.revertedWithCustomError(incidentManager, 'InvalidZeroAddress')
      })

      it('reverts on price feed decimals out of [6, 18]', async () => {
        const { incidentManager, priceFeedAdmin } = await loadFixture(deployIncidentManager)
        const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
        const lowFeed = await MockPriceFeed.deploy(5, 10n ** 5n)
        const highFeed = await MockPriceFeed.deploy(19, 10n ** 19n)
        await expect(incidentManager.connect(priceFeedAdmin).setPriceFeedAdapter(lowFeed.target))
          .to.be.revertedWithCustomError(incidentManager, 'InvalidPriceFeedDecimals')
        await expect(incidentManager.connect(priceFeedAdmin).setPriceFeedAdapter(highFeed.target))
          .to.be.revertedWithCustomError(incidentManager, 'InvalidPriceFeedDecimals')
      })

      it('updates and emits the change (including new decimals)', async () => {
        const { incidentManager, priceFeedAdmin, priceFeed } = await loadFixture(deployIncidentManager)
        const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
        const newFeed = await MockPriceFeed.deploy(18, 10n ** 18n)
        await expect(incidentManager.connect(priceFeedAdmin).setPriceFeedAdapter(newFeed.target))
          .to.emit(incidentManager, 'PriceFeedAdapterUpdated').withArgs(priceFeed.target, 8, newFeed.target, 18)
        expect(await incidentManager.priceFeedAdapter()).to.equal(newFeed.target)
      })

      it('accepts the lower bound (6) and upper bound (18)', async () => {
        const { incidentManager, priceFeedAdmin } = await loadFixture(deployIncidentManager)
        const MockPriceFeed = await ethers.getContractFactory('MockPriceFeed')
        const lo = await MockPriceFeed.deploy(6, 10n ** 6n)
        const hi = await MockPriceFeed.deploy(18, 10n ** 18n)
        await expect(incidentManager.connect(priceFeedAdmin).setPriceFeedAdapter(lo.target))
          .to.emit(incidentManager, 'PriceFeedAdapterUpdated')
        await expect(incidentManager.connect(priceFeedAdmin).setPriceFeedAdapter(hi.target))
          .to.emit(incidentManager, 'PriceFeedAdapterUpdated')
      })
    })
  })

  describe('view consistency', () => {
    it('getCurrentAssessmentRound returns exists=false when the incident does not exist', async () => {
      const { incidentManager } = await loadFixture(deployIncidentManager)
      const [, exists] = await incidentManager.getCurrentAssessmentRound(99)
      expect(exists).to.equal(false)
    })

    it('getCurrentPayoutRecipientAssessmentLoss returns (0, false) when the incident does not exist', async () => {
      const { incidentManager, payoutRecipient1 } = await loadFixture(deployIncidentManager)
      const [amount, roundExists] = await incidentManager.getCurrentPayoutRecipientAssessmentLoss(
        99,
        payoutRecipient1.address
      )
      expect(amount).to.equal(0)
      expect(roundExists).to.equal(false)
    })

    it('getAssessmentRound returns exists=false for an unset round id', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      const [, exists] = await ctx.incidentManager.getAssessmentRound(1, 99)
      expect(exists).to.equal(false)
    })

    it('getPayoutRecipientAssessmentLoss returns (0, false) for a non-existent round', async () => {
      const { incidentManager, payoutRecipient1 } = await loadFixture(deployIncidentManager)
      const [amount, exists] = await incidentManager.getPayoutRecipientAssessmentLoss(1, 1, payoutRecipient1.address)
      expect(amount).to.equal(0)
      expect(exists).to.equal(false)
    })

    it('getAssessmentLosses returns the array and getAssessmentLoss(index) returns the entry', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await withDraftRound(ctx)
      const arr = await ctx.incidentManager.getAssessmentLosses(1, 1)
      expect(arr.length).to.equal(1)
      expect(arr[0].marketId).to.equal(ctx.marketIdA)
      expect(arr[0].amount).to.equal(100)

      const single = await ctx.incidentManager.getAssessmentLoss(1, 1, 0)
      expect(single.marketId).to.equal(ctx.marketIdA)
      expect(single.coverTokenId).to.equal(1)
      expect(single.amount).to.equal(100)
    })

    it('getIncident returns exists=false for an unknown incident', async () => {
      const { incidentManager } = await loadFixture(deployIncidentManager)
      const [, exists] = await incidentManager.getIncident(123)
      expect(exists).to.equal(false)
    })
  })

  describe('createIncident edge cases', () => {
    it('reverts when the capture timestamp is in the future', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const future = (await time.latest()) + 1000
      await ctx.vault.setPeriodAtTimestamp(future, ctx.INCIDENT_PERIOD)

      await expect(ctx.incidentManager.connect(ctx.curator).createIncident(future, 'Future', ctx.refOf('future')))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'InvalidCaptureTimestamp')
    })

    it('reverts when another incident already uses the same capture timestamp in the period', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))

      await expect(ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'B', ctx.refOf('b')))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'IncidentTimestampAlreadyExists')
    })
  })

  describe('capture-timestamp approval ordering', () => {
    it('orders approvals by capture timestamp even when incidents are created out of order', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const earlierTs = ctx.DEFAULT_CAPTURE_TIMESTAMP - 500
      await ctx.vault.setPeriodAtTimestamp(earlierTs, ctx.INCIDENT_PERIOD)

      // Incident 1 is created first but captured later; incident 2 is captured earlier,
      // exercising the sorted insertion of capture timestamps.
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'Late capture', ctx.refOf('late'))
      await ctx.incidentManager.connect(ctx.curator).createIncident(earlierTs, 'Early capture', ctx.refOf('early'))

      await submitRoundFor(ctx, 1)
      await submitRoundFor(ctx, 2)

      // Incident 2 (earliest capture) must be approved first
      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'IncidentApprovalOutOfOrder')
        .withArgs(1, 2)

      await ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(2)

      // With incident 2 closed, the ordering scan skips it and incident 1 becomes approvable
      await ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)

      const [incident1] = await ctx.incidentManager.getIncident(1)
      expect(incident1.status).to.equal(IncidentStatus.CLOSED)
    })

    it('reverts approveCurrentAssessment without ASSESSMENT_APPROVER_ROLE', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await expect(ctx.incidentManager.connect(ctx.stranger).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'AccessControlUnauthorizedAccount')
    })

    it('approves an incident of period zero when the vault is still in period zero', async () => {
      const ctx = await loadFixture(deployAtPeriodZero)
      const ts = 1_600_000_000
      await ctx.vault.setPeriodAtTimestamp(ts, 0)

      await ctx.incidentManager.connect(ctx.curator).createIncident(ts, 'Genesis', ctx.refOf('genesis'))
      await ctx.incidentManager.connect(ctx.curator).confirmIncident(1, 'ipfs://r')
      await ctx.setOrderMarket(1, ctx.marketIdA, 1000n, ctx.payoutRecipient1.address, 0)
      await ctx.incidentManager.connect(ctx.curator).addAssessmentLosses(1, [ctx.lossOf(1, ctx.marketIdA, 100n)])
      await ctx.incidentManager.connect(ctx.curator).submitCurrentAssessment(1)

      await ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1)

      const [incident] = await ctx.incidentManager.getIncident(1)
      expect(incident.status).to.equal(IncidentStatus.CLOSED)
    })
  })

  describe('cancelIncident with a terminal assessment round', () => {
    it('cancels the current round when it is still under evaluation', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await submitRoundFor(ctx, 1)

      const tx = ctx.incidentManager.connect(ctx.incidentInvalidator).cancelIncident(1, 'invalid data')
      await expect(tx).to.emit(ctx.incidentManager, 'AssessmentRoundCanceled').withArgs(1, 1)
      await expect(tx).to.emit(ctx.incidentManager, 'IncidentInvalidated').withArgs(1, 'invalid data')

      const [round] = await ctx.incidentManager.getAssessmentRound(1, 1)
      expect(round.status).to.equal(AssessmentRoundStatus.CANCELED)
    })

    it('does not re-cancel a round that was already rejected', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await submitRoundFor(ctx, 1)
      await ctx.incidentManager.connect(ctx.assessmentRejecter).rejectCurrentAssessment(1)

      const tx = ctx.incidentManager.connect(ctx.incidentInvalidator).cancelIncident(1, 'invalid data')
      await expect(tx).to.emit(ctx.incidentManager, 'IncidentInvalidated').withArgs(1, 'invalid data')
      await expect(tx).to.not.emit(ctx.incidentManager, 'AssessmentRoundCanceled')

      const [round] = await ctx.incidentManager.getAssessmentRound(1, 1)
      expect(round.status).to.equal(AssessmentRoundStatus.REJECTED)
    })
  })

  describe('idempotent admin setters', () => {
    it('setPayoutReceiver is a no-op when the receiver does not change', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await expect(ctx.incidentManager.connect(ctx.payoutAdmin).setPayoutReceiver(ctx.payoutReceiver.address))
        .to.not.emit(ctx.incidentManager, 'PayoutReceiverUpdated')
      expect(await ctx.incidentManager.payoutReceiver()).to.equal(ctx.payoutReceiver.address)
    })

    it('setMaxPriceAge is a no-op when the age does not change', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await expect(ctx.incidentManager.connect(ctx.priceFeedAdmin).setMaxPriceAge(ctx.maxPriceAge))
        .to.not.emit(ctx.incidentManager, 'MaxPriceAgeUpdated')
    })

    it('setPriceFeedAdapter is a no-op when the adapter does not change', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await expect(ctx.incidentManager.connect(ctx.priceFeedAdmin).setPriceFeedAdapter(ctx.priceFeed.target))
        .to.not.emit(ctx.incidentManager, 'PriceFeedAdapterUpdated')
    })

    it('updateIncidentReportURI is a no-op when the URI does not change', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await ctx.incidentManager.connect(ctx.curator).confirmIncident(1, 'ipfs://r')

      await expect(ctx.incidentManager.connect(ctx.configAdmin).updateIncidentReportURI(1, 'ipfs://r'))
        .to.not.emit(ctx.incidentManager, 'IncidentReportURIUpdated')
    })
  })

  describe('expired-period views', () => {
    it('reports an unresolved incident as EXPIRED once its payout window closes', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))

      await ctx.vault.setCurrentPeriod(5)

      const [incident, exists] = await ctx.incidentManager.getIncident(1)
      expect(exists).to.equal(true)
      expect(incident.status).to.equal(IncidentStatus.EXPIRED)
    })

    it('activeIncidentCount reflects active incidents and returns zero after expiry', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))

      expect(await ctx.incidentManager.activeIncidentCount(ctx.INCIDENT_PERIOD)).to.equal(1n)

      await ctx.vault.setCurrentPeriod(5)
      expect(await ctx.incidentManager.activeIncidentCount(ctx.INCIDENT_PERIOD)).to.equal(0n)
    })
  })

  describe('active incident counter transitions', () => {
    it('keeps the period flagged while other incidents remain active', async () => {
      const ctx = await loadFixture(deployIncidentManager)
      const otherTs = ctx.DEFAULT_CAPTURE_TIMESTAMP + 500
      await ctx.vault.setPeriodAtTimestamp(otherTs, ctx.INCIDENT_PERIOD)

      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await ctx.incidentManager.connect(ctx.curator).createIncident(otherTs, 'B', ctx.refOf('b'))
      expect(await ctx.incidentManager.activeIncidentCount(ctx.INCIDENT_PERIOD)).to.equal(2n)

      // 2 -> 1: the vault deposit block must not be lifted yet
      await ctx.incidentManager.connect(ctx.curator).cancelPreAssessmentIncident(1, 'duplicate')
      expect(await ctx.incidentManager.activeIncidentCount(ctx.INCIDENT_PERIOD)).to.equal(1n)

      // 1 -> 0: the block is lifted with the last active incident
      await ctx.incidentManager.connect(ctx.curator).cancelPreAssessmentIncident(2, 'duplicate')
      expect(await ctx.incidentManager.activeIncidentCount(ctx.INCIDENT_PERIOD)).to.equal(0n)
    })

    it('ignores decrements when the period has no active incidents (harness)', async () => {
      const harness = await (await ethers.getContractFactory('IncidentManagerHarness')).deploy()
      // Defensive early return: must not revert nor underflow
      await harness.exposedDecreaseIncident(42)
    })
  })

  describe('reentrancy protection', () => {
    it('blocks reentrant approvals through the first-loss buffer token', async () => {
      const ctx = await loadFixture(deployIncidentManager)

      // Malicious first-loss buffer token that re-enters the IncidentManager on transfers
      const reentrant = await (await ethers.getContractFactory('ReentrantVaultAsset')).deploy()
      await ctx.coverOrderAllocator.setMockCapacityConfig({
        minCAR: 10000,
        firstLossBufferToken: reentrant.target,
        firstLossBuffer: ctx.firstLossBufferPayer.address,
        effectiveLeverage: 20000,
        minOrderMarketCoverAmount: 1,
        divergenceToleranceBps: 0
      })

      await ctx.incidentManager.connect(ctx.curator).createIncident(ctx.DEFAULT_CAPTURE_TIMESTAMP, 'A', ctx.refOf('a'))
      await submitRoundFor(ctx, 1)

      // Fund and approve the buffer so the payout pulls from the reentrant token
      await reentrant.mint(ctx.firstLossBufferPayer.address, e18(1000))
      await reentrant.connect(ctx.firstLossBufferPayer).approve(ctx.incidentManager.target, e18(1000))

      // The token re-enters approveCurrentAssessment as a role holder, so the
      // reentrancy guard (and not the role check) is what stops it
      await ctx.incidentManager.connect(ctx.admin).grantRole(ROLES.ASSESSMENT_APPROVER_ROLE, reentrant.target)
      await reentrant.setVault(ctx.incidentManager.target)
      await reentrant.setReentrantCall(ctx.incidentManager.interface.encodeFunctionData('approveCurrentAssessment', [1]))

      await expect(ctx.incidentManager.connect(ctx.assessmentApprover).approveCurrentAssessment(1))
        .to.be.revertedWithCustomError(ctx.incidentManager, 'ReentrancyGuardReentrantCall')
    })
  })
})
