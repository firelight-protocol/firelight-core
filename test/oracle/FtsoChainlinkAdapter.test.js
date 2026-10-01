const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers } = require('hardhat')

const {
  REGISTRY_ADDR,
  FEED_ID,
  FEED_ID_ALT,
  FEED_ID_ZERO,
  DESCRIPTION,
  DESCRIPTION_ALT,
  ADMIN_TRANSFER_DELAY,
  DEFAULT_ADMIN_ROLE,
  FEED_ADMIN_ROLE,
  deployAdapterFixture,
} = require('./fixtures')

describe('FtsoChainlinkAdapter', function () {
  // ------------------------------------------------------------------
  // Constructor & role wiring
  // ------------------------------------------------------------------

  describe('constructor', function () {
    it('initializes feedId, description, and the two roles', async function () {
      const { adapter, admin, feedAdmin } = await loadFixture(deployAdapterFixture)

      expect(await adapter.feedId()).to.equal(FEED_ID)
      expect(await adapter.description()).to.equal(DESCRIPTION)

      expect(await adapter.defaultAdmin()).to.equal(admin.address)
      expect(await adapter.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(true)
      expect(await adapter.hasRole(FEED_ADMIN_ROLE, feedAdmin.address)).to.equal(true)
      expect(await adapter.defaultAdminDelay()).to.equal(ADMIN_TRANSFER_DELAY)
    })

    it('exposes Chainlink constants', async function () {
      const { adapter } = await loadFixture(deployAdapterFixture)
      expect(await adapter.decimals()).to.equal(18)
      expect(await adapter.version()).to.equal(1)
      expect(await adapter.REGISTRY()).to.equal(REGISTRY_ADDR)
    })

    it('emits FeedConfigUpdated(0, feedId, "", description) at construction', async function () {
      const [admin, feedAdmin] = await ethers.getSigners()
      const Factory = await ethers.getContractFactory('FtsoChainlinkAdapter')
      const adapter = await Factory.deploy(
        admin.address,
        ADMIN_TRANSFER_DELAY,
        feedAdmin.address,
        FEED_ID,
        DESCRIPTION,
      )
      await adapter.waitForDeployment()
      await expect(adapter.deploymentTransaction())
        .to.emit(adapter, 'FeedConfigUpdated')
        .withArgs(FEED_ID_ZERO, FEED_ID, '', DESCRIPTION)
    })

    it('reverts FeedIdEmpty when initialFeedId is zero', async function () {
      const [admin, feedAdmin] = await ethers.getSigners()
      const Factory = await ethers.getContractFactory('FtsoChainlinkAdapter')
      await expect(
        Factory.deploy(
          admin.address,
          ADMIN_TRANSFER_DELAY,
          feedAdmin.address,
          FEED_ID_ZERO,
          DESCRIPTION,
        ),
      ).to.be.revertedWithCustomError(Factory, 'FeedIdEmpty')
    })

    it('reverts AccessControlInvalidDefaultAdmin when admin is zero', async function () {
      const [, feedAdmin] = await ethers.getSigners()
      const Factory = await ethers.getContractFactory('FtsoChainlinkAdapter')
      await expect(
        Factory.deploy(
          ethers.ZeroAddress,
          ADMIN_TRANSFER_DELAY,
          feedAdmin.address,
          FEED_ID,
          DESCRIPTION,
        ),
      ).to.be.revertedWithCustomError(Factory, 'AccessControlInvalidDefaultAdmin')
    })

    it('accepts a zero feedAdmin (no holder until admin appoints one)', async function () {
      const [admin] = await ethers.getSigners()
      const Factory = await ethers.getContractFactory('FtsoChainlinkAdapter')
      const adapter = await Factory.deploy(
        admin.address,
        ADMIN_TRANSFER_DELAY,
        ethers.ZeroAddress,
        FEED_ID,
        DESCRIPTION,
      )
      await adapter.waitForDeployment()
      // No accidental grant to address(0) — the constructor skips it.
      expect(await adapter.hasRole(FEED_ADMIN_ROLE, ethers.ZeroAddress)).to.equal(false)
    })
  })

  // ------------------------------------------------------------------
  // setFeedConfig — gated on FEED_ADMIN_ROLE
  // ------------------------------------------------------------------

  describe('setFeedConfig', function () {
    it('feedAdmin atomically rotates feedId and description', async function () {
      const { adapter, feedAdmin } = await loadFixture(deployAdapterFixture)

      await expect(
        adapter.connect(feedAdmin).setFeedConfig(FEED_ID_ALT, DESCRIPTION_ALT),
      )
        .to.emit(adapter, 'FeedConfigUpdated')
        .withArgs(FEED_ID, FEED_ID_ALT, DESCRIPTION, DESCRIPTION_ALT)

      expect(await adapter.feedId()).to.equal(FEED_ID_ALT)
      expect(await adapter.description()).to.equal(DESCRIPTION_ALT)
    })

    it('reverts AccessControlUnauthorizedAccount for non-FEED_ADMIN callers', async function () {
      const { adapter, admin, alice } = await loadFixture(deployAdapterFixture)
      for (const caller of [admin, alice]) {
        await expect(adapter.connect(caller).setFeedConfig(FEED_ID_ALT, DESCRIPTION_ALT))
          .to.be.revertedWithCustomError(adapter, 'AccessControlUnauthorizedAccount')
          .withArgs(caller.address, FEED_ADMIN_ROLE)
      }
    })

    it('reverts FeedIdEmpty when newFeedId is zero', async function () {
      const { adapter, feedAdmin } = await loadFixture(deployAdapterFixture)
      await expect(adapter.connect(feedAdmin).setFeedConfig(FEED_ID_ZERO, DESCRIPTION_ALT))
        .to.be.revertedWithCustomError(adapter, 'FeedIdEmpty')
    })

    it('reverts FeedIdUnchanged when newFeedId equals current feedId', async function () {
      const { adapter, feedAdmin } = await loadFixture(deployAdapterFixture)
      await expect(adapter.connect(feedAdmin).setFeedConfig(FEED_ID, DESCRIPTION_ALT))
        .to.be.revertedWithCustomError(adapter, 'FeedIdUnchanged')
    })
  })

  // ------------------------------------------------------------------
  // Role management — admin grants/revokes FEED_ADMIN_ROLE
  // ------------------------------------------------------------------

  describe('FEED_ADMIN_ROLE management', function () {
    it('admin can grant FEED_ADMIN_ROLE to additional holders', async function () {
      const { adapter, admin, alice } = await loadFixture(deployAdapterFixture)
      await adapter.connect(admin).grantRole(FEED_ADMIN_ROLE, alice.address)
      expect(await adapter.hasRole(FEED_ADMIN_ROLE, alice.address)).to.equal(true)
      await adapter.connect(alice).setFeedConfig(FEED_ID_ALT, DESCRIPTION_ALT)
      expect(await adapter.feedId()).to.equal(FEED_ID_ALT)
    })

    it('admin can revoke FEED_ADMIN_ROLE from a holder', async function () {
      const { adapter, admin, feedAdmin } = await loadFixture(deployAdapterFixture)
      await adapter.connect(admin).revokeRole(FEED_ADMIN_ROLE, feedAdmin.address)
      expect(await adapter.hasRole(FEED_ADMIN_ROLE, feedAdmin.address)).to.equal(false)
      await expect(adapter.connect(feedAdmin).setFeedConfig(FEED_ID_ALT, DESCRIPTION_ALT))
        .to.be.revertedWithCustomError(adapter, 'AccessControlUnauthorizedAccount')
        .withArgs(feedAdmin.address, FEED_ADMIN_ROLE)
    })

    it('non-admin cannot grant FEED_ADMIN_ROLE', async function () {
      const { adapter, feedAdmin, alice } = await loadFixture(deployAdapterFixture)
      await expect(adapter.connect(feedAdmin).grantRole(FEED_ADMIN_ROLE, alice.address))
        .to.be.revertedWithCustomError(adapter, 'AccessControlUnauthorizedAccount')
        .withArgs(feedAdmin.address, DEFAULT_ADMIN_ROLE)
    })

    it('a holder can renounce its own FEED_ADMIN_ROLE', async function () {
      const { adapter, feedAdmin } = await loadFixture(deployAdapterFixture)
      await adapter.connect(feedAdmin).renounceRole(FEED_ADMIN_ROLE, feedAdmin.address)
      expect(await adapter.hasRole(FEED_ADMIN_ROLE, feedAdmin.address)).to.equal(false)
    })
  })

  // ------------------------------------------------------------------
  // AccessControlDefaultAdminRules — delayed two-step admin transfer
  // ------------------------------------------------------------------

  describe('DEFAULT_ADMIN_ROLE transfer (ACDAR)', function () {
    it('begin → wait delay → accept hands DEFAULT_ADMIN_ROLE to the new admin', async function () {
      const { adapter, admin, alice } = await loadFixture(deployAdapterFixture)

      await adapter.connect(admin).beginDefaultAdminTransfer(alice.address)

      // Early accept reverts — the schedule has not elapsed.
      await expect(adapter.connect(alice).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(adapter, 'AccessControlEnforcedDefaultAdminDelay')

      await time.increase(ADMIN_TRANSFER_DELAY)

      await adapter.connect(alice).acceptDefaultAdminTransfer()
      expect(await adapter.defaultAdmin()).to.equal(alice.address)
      expect(await adapter.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.equal(false)
      expect(await adapter.hasRole(DEFAULT_ADMIN_ROLE, alice.address)).to.equal(true)
    })

    it('current admin can cancel a pending transfer before it is accepted', async function () {
      const { adapter, admin, alice } = await loadFixture(deployAdapterFixture)
      await adapter.connect(admin).beginDefaultAdminTransfer(alice.address)
      await adapter.connect(admin).cancelDefaultAdminTransfer()
      await time.increase(ADMIN_TRANSFER_DELAY)
      await expect(adapter.connect(alice).acceptDefaultAdminTransfer())
        .to.be.revertedWithCustomError(adapter, 'AccessControlInvalidDefaultAdmin')
        .withArgs(alice.address)
      expect(await adapter.defaultAdmin()).to.equal(admin.address)
    })

    it('DEFAULT_ADMIN_ROLE cannot be granted directly (ACDAR single-admin invariant)', async function () {
      const { adapter, admin, alice } = await loadFixture(deployAdapterFixture)
      await expect(adapter.connect(admin).grantRole(DEFAULT_ADMIN_ROLE, alice.address))
        .to.be.revertedWithCustomError(adapter, 'AccessControlEnforcedDefaultAdminRules')
    })
  })

  // ------------------------------------------------------------------
  // Compromised feedAdmin scenario
  // ------------------------------------------------------------------

  describe('compromised feedAdmin scenario', function () {
    it('admin revokes the compromised role and appoints a fresh key', async function () {
      const { adapter, admin, feedAdmin, alice, bob } = await loadFixture(
        deployAdapterFixture,
      )

      // 1. Admin observes a compromise and revokes the role immediately.
      await adapter.connect(admin).revokeRole(FEED_ADMIN_ROLE, feedAdmin.address)
      await expect(adapter.connect(feedAdmin).setFeedConfig(FEED_ID_ALT, DESCRIPTION_ALT))
        .to.be.revertedWithCustomError(adapter, 'AccessControlUnauthorizedAccount')
        .withArgs(feedAdmin.address, FEED_ADMIN_ROLE)

      // 2. Admin grants the role to a fresh key; operations resume.
      await adapter.connect(admin).grantRole(FEED_ADMIN_ROLE, alice.address)
      await adapter.connect(alice).setFeedConfig(FEED_ID_ALT, DESCRIPTION_ALT)
      expect(await adapter.feedId()).to.equal(FEED_ID_ALT)
      expect(await adapter.description()).to.equal(DESCRIPTION_ALT)

      // 3. Bob (no role) remains unable to act.
      await expect(adapter.connect(bob).setFeedConfig(FEED_ID, DESCRIPTION))
        .to.be.revertedWithCustomError(adapter, 'AccessControlUnauthorizedAccount')
        .withArgs(bob.address, FEED_ADMIN_ROLE)
    })
  })

  // ------------------------------------------------------------------
  // IAggregatorV3 — getRoundData & latestRoundData
  // ------------------------------------------------------------------

  describe('getRoundData', function () {
    it('reverts NotImplemented for any round id', async function () {
      const { adapter } = await loadFixture(deployAdapterFixture)
      for (const id of [0n, 1n, (1n << 80n) - 1n]) {
        await expect(adapter.getRoundData(id)).to.be.revertedWithCustomError(
          adapter,
          'NotImplemented',
        )
      }
    })
  })

  describe('latestRoundData', function () {
    it('returns the FTSO quote with roundId = uint80(timestamp)', async function () {
      const { adapter, ftso } = await loadFixture(deployAdapterFixture)
      const priceWei = ethers.parseUnits('0.52', 18)
      const ftsoTs = 1_700_000_123n
      await ftso.setPrice(FEED_ID, priceWei, ftsoTs)

      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await adapter.latestRoundData()

      expect(roundId).to.equal(ftsoTs)
      expect(answer).to.equal(priceWei)
      expect(startedAt).to.equal(ftsoTs)
      expect(updatedAt).to.equal(ftsoTs)
      expect(answeredInRound).to.equal(ftsoTs)
    })

    it('accepts a zero price (publishable, just not useful)', async function () {
      const { adapter, ftso } = await loadFixture(deployAdapterFixture)
      await ftso.setPrice(FEED_ID, 0n, 42n)
      const [, answer] = await adapter.latestRoundData()
      expect(answer).to.equal(0n)
    })

    it('accepts int256.max as the boundary value', async function () {
      const { adapter, ftso } = await loadFixture(deployAdapterFixture)
      const maxInt = (1n << 255n) - 1n
      await ftso.setPrice(FEED_ID, maxInt, 7n)
      const [, answer] = await adapter.latestRoundData()
      expect(answer).to.equal(maxInt)
    })

    it('reverts FeedValueExceedsInt256 when FTSO returns a value above int256.max', async function () {
      const { adapter, ftso } = await loadFixture(deployAdapterFixture)
      const overflowing = 1n << 255n
      await ftso.setPrice(FEED_ID, overflowing, 7n)
      await expect(adapter.latestRoundData())
        .to.be.revertedWithCustomError(adapter, 'FeedValueExceedsInt256')
        .withArgs(overflowing)
    })

    it('reverts when FTSO turns "mutating" on — STATICCALL refuses the storage write', async function () {
      const { adapter, ftso } = await loadFixture(deployAdapterFixture)
      await ftso.setPrice(FEED_ID, 1n, 1n)
      await ftso.setMutating(true)
      await expect(adapter.latestRoundData()).to.be.reverted
    })

    it('follows the wrapped feed after a rotation, with description atomically rotated', async function () {
      const { adapter, ftso, feedAdmin } = await loadFixture(deployAdapterFixture)
      await ftso.setPrice(FEED_ID, ethers.parseUnits('0.52', 18), 100n)
      await ftso.setPrice(FEED_ID_ALT, ethers.parseUnits('1.10', 18), 200n)

      const [, ans1] = await adapter.latestRoundData()
      expect(ans1).to.equal(ethers.parseUnits('0.52', 18))
      expect(await adapter.description()).to.equal(DESCRIPTION)

      await adapter.connect(feedAdmin).setFeedConfig(FEED_ID_ALT, DESCRIPTION_ALT)

      const [roundId2, ans2] = await adapter.latestRoundData()
      expect(ans2).to.equal(ethers.parseUnits('1.10', 18))
      expect(roundId2).to.equal(200n)
      expect(await adapter.description()).to.equal(DESCRIPTION_ALT)
    })
  })

  // ------------------------------------------------------------------
  // Registry integration
  // ------------------------------------------------------------------

  describe('registry integration', function () {
    it('reverts if registry returns address(0) for FtsoV2', async function () {
      const { adapter, registry } = await loadFixture(deployAdapterFixture)
      await registry.setFtsoV2(ethers.ZeroAddress)
      await expect(adapter.latestRoundData()).to.be.reverted
    })
  })
})
