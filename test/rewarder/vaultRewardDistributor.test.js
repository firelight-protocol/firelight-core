const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')

describe('VaultRewardDistributor', function () {
  async function deployFixture () {
    const [admin, distributor, sweeper, user, recipient] = await ethers.getSigners()

    const MockERC20 = await ethers.getContractFactory('MockERC20')
    const vaultAsset = await MockERC20.deploy('Vault Asset', 'VAULT', 6)
    const premiumToken = await MockERC20.deploy('Premium Token', 'PREMIUM', 6)

    const MockVault = await ethers.getContractFactory('MockCoverOrderAllocatorVault')
    const vault = await MockVault.deploy()
    await vault.setAsset(await vaultAsset.getAddress())
    await vault.setCurrentPeriod(7)

    const Factory = await ethers.getContractFactory('VaultRewardDistributor')
    const vaultRewardDistributor = await upgrades.deployProxy(Factory, [
      await vault.getAddress(),
      admin.address,
      distributor.address,
      sweeper.address,
    ])

    return {
      admin,
      distributor,
      sweeper,
      user,
      recipient,
      vaultAsset,
      premiumToken,
      vault,
      Factory,
      vaultRewardDistributor,
    }
  }

  describe('initialize()', function () {
    it('stores the vault and vault asset and grants the configured roles', async function () {
      const { admin, distributor, sweeper, vaultAsset, vault, vaultRewardDistributor } =
        await loadFixture(deployFixture)

      expect(await vaultRewardDistributor.vault()).to.equal(await vault.getAddress())
      expect(await vaultRewardDistributor.vaultAsset()).to.equal(await vaultAsset.getAddress())
      expect(
        await vaultRewardDistributor.hasRole(await vaultRewardDistributor.DEFAULT_ADMIN_ROLE(), admin.address)
      ).to.equal(true)
      expect(
        await vaultRewardDistributor.hasRole(await vaultRewardDistributor.DISTRIBUTOR_ROLE(), distributor.address)
      ).to.equal(true)
      expect(
        await vaultRewardDistributor.hasRole(await vaultRewardDistributor.SWEEPER_ROLE(), sweeper.address)
      ).to.equal(true)
    })

    it('allows the optional sweeper to be zero', async function () {
      const { admin, distributor, vault, Factory } = await loadFixture(deployFixture)
      const instance = await upgrades.deployProxy(Factory, [
        await vault.getAddress(),
        admin.address,
        distributor.address,
        ethers.ZeroAddress,
      ])

      expect(await instance.hasRole(await instance.SWEEPER_ROLE(), ethers.ZeroAddress)).to.equal(false)
    })

    it('rejects zero vault, admin, and distributor addresses', async function () {
      const { admin, distributor, sweeper, vault, Factory } = await loadFixture(deployFixture)
      const instance = await upgrades.deployProxy(Factory, [], { initializer: false })

      await expect(
        instance.initialize(ethers.ZeroAddress, admin.address, distributor.address, sweeper.address)
      ).to.be.revertedWithCustomError(instance, 'InvalidZeroAddress')
      await expect(
        instance.initialize(await vault.getAddress(), ethers.ZeroAddress, distributor.address, sweeper.address)
      ).to.be.revertedWithCustomError(instance, 'InvalidZeroAddress')
      await expect(
        instance.initialize(await vault.getAddress(), admin.address, ethers.ZeroAddress, sweeper.address)
      ).to.be.revertedWithCustomError(instance, 'InvalidZeroAddress')
    })

    it('cannot be initialized twice', async function () {
      const { admin, distributor, sweeper, vault, vaultRewardDistributor } = await loadFixture(deployFixture)

      await expect(
        vaultRewardDistributor.initialize(
          await vault.getAddress(),
          admin.address,
          distributor.address,
          sweeper.address
        )
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidInitialization')
    })
  })

  describe('distributeRewards()', function () {
    it('forwards vault assets and emits the swap metadata for the current period', async function () {
      const { distributor, vaultAsset, premiumToken, vault, vaultRewardDistributor } =
        await loadFixture(deployFixture)
      const vaultAssetAmount = 100_000n
      const premiumTokenAmount = 250_000n
      const premiumSwapTimestamp = BigInt((await time.latest()) - 1)

      await vaultAsset.mint(distributor.address, vaultAssetAmount)
      await vaultAsset.connect(distributor).approve(await vaultRewardDistributor.getAddress(), vaultAssetAmount)

      await expect(
        vaultRewardDistributor
          .connect(distributor)
          .distributeRewards(vaultAssetAmount, await premiumToken.getAddress(), premiumTokenAmount, premiumSwapTimestamp)
      )
        .to.emit(vaultRewardDistributor, 'RewardsDistributed')
        .withArgs(7, await premiumToken.getAddress(), vaultAssetAmount, premiumTokenAmount, premiumSwapTimestamp)

      expect(await vaultAsset.balanceOf(await vault.getAddress())).to.equal(vaultAssetAmount)
      expect(await vaultAsset.balanceOf(distributor.address)).to.equal(0)
    })

    it('rejects unauthorized callers', async function () {
      const { user, premiumToken, vaultRewardDistributor } = await loadFixture(deployFixture)

      await expect(
        vaultRewardDistributor.connect(user).distributeRewards(1, await premiumToken.getAddress(), 1, 1)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'AccessControlUnauthorizedAccount')
    })

    it('rejects invalid metadata and zero amounts', async function () {
      const { distributor, premiumToken, vaultRewardDistributor } = await loadFixture(deployFixture)
      const premiumTokenAddress = await premiumToken.getAddress()
      const futureTimestamp = BigInt((await time.latest()) + 3_600)

      await expect(
        vaultRewardDistributor.connect(distributor).distributeRewards(1, ethers.ZeroAddress, 1, 1)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidZeroAddress')
      await expect(
        vaultRewardDistributor.connect(distributor).distributeRewards(0, premiumTokenAddress, 1, 1)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidAmount')
      await expect(
        vaultRewardDistributor.connect(distributor).distributeRewards(1, premiumTokenAddress, 0, 1)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidAmount')
      await expect(
        vaultRewardDistributor.connect(distributor).distributeRewards(1, premiumTokenAddress, 1, 0)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidSwapTimestamp')
      await expect(
        vaultRewardDistributor.connect(distributor).distributeRewards(1, premiumTokenAddress, 1, futureTimestamp)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidSwapTimestamp')
    })

    it('reverts when the distributor has not approved the vault asset', async function () {
      const { distributor, vaultAsset, premiumToken, vaultRewardDistributor } = await loadFixture(deployFixture)
      await vaultAsset.mint(distributor.address, 1)

      await expect(
        vaultRewardDistributor.connect(distributor).distributeRewards(1, await premiumToken.getAddress(), 1, 1)
      ).to.be.reverted
    })
  })

  describe('distributeIncentive()', function () {
    it('forwards vault assets and emits the incentive reference for the current period', async function () {
      const { distributor, vaultAsset, vault, vaultRewardDistributor } = await loadFixture(deployFixture)
      const vaultAssetAmount = 75_000n
      const incentiveRef = ethers.id('incentive-1')

      await vaultAsset.mint(distributor.address, vaultAssetAmount)
      await vaultAsset.connect(distributor).approve(await vaultRewardDistributor.getAddress(), vaultAssetAmount)

      await expect(
        vaultRewardDistributor.connect(distributor).distributeIncentive(vaultAssetAmount, incentiveRef)
      )
        .to.emit(vaultRewardDistributor, 'IncentiveDistributed')
        .withArgs(7, incentiveRef, vaultAssetAmount)

      expect(await vaultAsset.balanceOf(await vault.getAddress())).to.equal(vaultAssetAmount)
    })

    it('rejects zero amounts and unauthorized callers', async function () {
      const { distributor, user, vaultRewardDistributor } = await loadFixture(deployFixture)

      await expect(
        vaultRewardDistributor.connect(distributor).distributeIncentive(0, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidAmount')
      await expect(
        vaultRewardDistributor.connect(user).distributeIncentive(1, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'AccessControlUnauthorizedAccount')
    })
  })

  describe('sweep()', function () {
    it('allows the sweeper to recover accidentally sent tokens', async function () {
      const { sweeper, recipient, premiumToken, vaultRewardDistributor } = await loadFixture(deployFixture)
      const amount = 50_000n
      const contractAddress = await vaultRewardDistributor.getAddress()
      const tokenAddress = await premiumToken.getAddress()

      await premiumToken.mint(contractAddress, amount)

      await expect(vaultRewardDistributor.connect(sweeper).sweep(tokenAddress, recipient.address, amount))
        .to.emit(vaultRewardDistributor, 'TokenSwept')
        .withArgs(tokenAddress, recipient.address, amount)

      expect(await premiumToken.balanceOf(recipient.address)).to.equal(amount)
      expect(await premiumToken.balanceOf(contractAddress)).to.equal(0)
    })

    it('rejects unauthorized callers and invalid arguments', async function () {
      const { sweeper, user, recipient, premiumToken, vaultRewardDistributor } = await loadFixture(deployFixture)
      const tokenAddress = await premiumToken.getAddress()

      await expect(
        vaultRewardDistributor.connect(user).sweep(tokenAddress, recipient.address, 1)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'AccessControlUnauthorizedAccount')
      await expect(
        vaultRewardDistributor.connect(sweeper).sweep(ethers.ZeroAddress, recipient.address, 1)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidZeroAddress')
      await expect(
        vaultRewardDistributor.connect(sweeper).sweep(tokenAddress, ethers.ZeroAddress, 1)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidZeroAddress')
      await expect(
        vaultRewardDistributor.connect(sweeper).sweep(tokenAddress, recipient.address, 0)
      ).to.be.revertedWithCustomError(vaultRewardDistributor, 'InvalidAmount')
    })
  })
})
