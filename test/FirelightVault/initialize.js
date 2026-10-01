const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')
const { DECIMALS, DEPOSIT_LIMIT, WEEK, encodeInitParams, vaultFixture } = require('./helpers.js')

describe('FirelightVault initialization', function () {

  describe('initialize validation', () => {
    let vault, asset, baseParams

    before(async () => {
      const [deployer] = await ethers.getSigners()
      asset = await (await ethers.getContractFactory('MockERC20')).deploy('Mock', 'MCK', DECIMALS)
      const VaultFactory = await ethers.getContractFactory('FirelightVault')
      vault = await upgrades.deployProxy(VaultFactory, [], { initializer: false })
      baseParams = {
        defaultAdmin: deployer.address,
        limitUpdater: ethers.ZeroAddress,
        blocklister: ethers.ZeroAddress,
        pauser: ethers.ZeroAddress,
        periodConfigurationUpdater: ethers.ZeroAddress,
        rescuer: ethers.ZeroAddress,
        depositLimit: DEPOSIT_LIMIT,
        periodConfigurationDuration: WEEK
      }
    })

    it('reverts period queries while the vault has no period configurations', async () => {
      await expect(vault.periodConfigurationAtTimestamp(await time.latest())).to.be.revertedWithCustomError(vault, 'InvalidPeriod')
      await expect(vault.periodConfigurationAtNumber(0)).to.be.revertedWithCustomError(vault, 'InvalidPeriod')
    })

    it('reverts when the asset is the zero address', async () => {
      await expect(vault.initialize(ethers.ZeroAddress, 'v', 'v', encodeInitParams(baseParams)))
        .to.be.revertedWithCustomError(vault, 'InvalidAssetAddress')
    })

    it('reverts when the deposit limit is zero', async () => {
      const params = encodeInitParams({ ...baseParams, depositLimit: 0n })
      await expect(vault.initialize(asset.target, 'v', 'v', params))
        .to.be.revertedWithCustomError(vault, 'InvalidDepositLimit')
    })

    it('reverts when the period configuration duration is zero', async () => {
      const params = encodeInitParams({ ...baseParams, periodConfigurationDuration: 0 })
      await expect(vault.initialize(asset.target, 'v', 'v', params))
        .to.be.revertedWithCustomError(vault, 'InvalidPeriodConfigurationDuration')
    })

    it('reverts when the default admin is the zero address', async () => {
      const params = encodeInitParams({ ...baseParams, defaultAdmin: ethers.ZeroAddress })
      await expect(vault.initialize(asset.target, 'v', 'v', params))
        .to.be.revertedWithCustomError(vault, 'InvalidAdminAddress')
    })

    it('emits the initial deposit limit and skips optional role grants when their addresses are zero', async () => {
      await expect(vault.initialize(asset.target, 'v', 'v', encodeInitParams(baseParams)))
        .to.emit(vault, 'DepositLimitUpdated')
        .withArgs(DEPOSIT_LIMIT)

      expect(await vault.contractVersion()).to.equal(2n)
      for (const role of ['DEPOSIT_LIMIT_UPDATE_ROLE', 'BLOCKLIST_ROLE', 'PAUSE_ROLE', 'PERIOD_CONFIGURATION_UPDATE_ROLE', 'RESCUER_ROLE']) {
        expect(await vault.hasRole(await vault[role](), ethers.ZeroAddress)).to.equal(false)
      }
    })

    it('reverts when initializing twice', async () => {
      await expect(vault.initialize(asset.target, 'v', 'v', encodeInitParams(baseParams)))
        .to.be.revertedWithCustomError(vault, 'InvalidInitialization')
    })

    it('reverts a period query with a timestamp earlier than the first epoch', async () => {
      await expect(vault.periodConfigurationAtTimestamp(1)).to.be.revertedWithCustomError(vault, 'InvalidPeriod')
    })
  })

  describe('initializeV2', () => {
    it('can be called once after a v1 initialization and reverts afterwards', async () => {
      const { firelight_vault } = await loadFixture(vaultFixture)

      await firelight_vault.initializeV2()
      expect(await firelight_vault.contractVersion()).to.equal(2n)

      await expect(firelight_vault.initializeV2()).to.be.revertedWithCustomError(firelight_vault, 'InvalidInitialization')
    })
  })
})
