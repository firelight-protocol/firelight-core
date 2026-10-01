const { loadFixture, time } = require('@nomicfoundation/hardhat-network-helpers')
const { expect } = require('chai')
const { ethers, upgrades } = require('hardhat')
const { WEEK, encodeInitParams, advanceOnePeriod } = require('./helpers.js')

describe('FirelightVault reentrancy protection', function () {
  const AMOUNT = ethers.parseUnits('100', 18)

  const deployReentrantVault = async () => {
    const [deployer, receiver] = await ethers.getSigners()
    const asset = await (await ethers.getContractFactory('ReentrantVaultAsset')).deploy()

    const VaultFactory = await ethers.getContractFactory('FirelightVault')
    const initParams = encodeInitParams({
      defaultAdmin: deployer.address,
      limitUpdater: deployer.address,
      blocklister: deployer.address,
      pauser: deployer.address,
      periodConfigurationUpdater: deployer.address,
      rescuer: deployer.address,
      depositLimit: ethers.parseUnits('1000000', 18),
      periodConfigurationDuration: WEEK
    })
    const vault = await upgrades.deployProxy(VaultFactory, [asset.target, 'rVLT', 'rVLT', initParams])
    await asset.setVault(vault.target)

    await vault.grantRole(await vault.PAYOUT_ROLE(), deployer.address)
    await vault.grantRole(await vault.PAYOUT_ROLE(), asset.target)
    await vault.grantRole(await vault.PAYOUT_ALLOWLIST_ROLE(), deployer.address)
    await vault.addToPayoutAllowlist(receiver.address)

    await asset.mint(deployer.address, AMOUNT * 10n)
    await asset.connect(deployer).approve(vault.target, ethers.MaxUint256)

    return { vault, asset, deployer, receiver }
  }

  it('blocks reentrant deposits', async () => {
    const { vault, asset, deployer } = await loadFixture(deployReentrantVault)
    await asset.setReentrantCall(vault.interface.encodeFunctionData('deposit', [1n, asset.target]))

    await expect(vault.connect(deployer).deposit(AMOUNT, deployer.address))
      .to.be.revertedWithCustomError(vault, 'ReentrancyGuardReentrantCall')
  })

  it('blocks reentrant mints', async () => {
    const { vault, asset, deployer } = await loadFixture(deployReentrantVault)
    await asset.setReentrantCall(vault.interface.encodeFunctionData('mint', [1n, asset.target]))

    await expect(vault.connect(deployer).mint(AMOUNT, deployer.address))
      .to.be.revertedWithCustomError(vault, 'ReentrancyGuardReentrantCall')
  })

  it('blocks reentrant withdrawal claims', async () => {
    const { vault, asset, deployer } = await loadFixture(deployReentrantVault)

    await vault.connect(deployer).deposit(AMOUNT, deployer.address)
    await vault.connect(deployer).withdraw(AMOUNT / 2n, deployer.address, deployer.address)
    const period = await vault.currentPeriod() + 1n
    await advanceOnePeriod(vault)
    await advanceOnePeriod(vault)

    await asset.setReentrantCall(vault.interface.encodeFunctionData('claimWithdraw', [period]))
    await expect(vault.connect(deployer).claimWithdraw(period))
      .to.be.revertedWithCustomError(vault, 'ReentrancyGuardReentrantCall')
  })

  it('blocks reentrant payouts', async () => {
    const { vault, asset, deployer, receiver } = await loadFixture(deployReentrantVault)

    await vault.connect(deployer).deposit(AMOUNT, deployer.address)
    await advanceOnePeriod(vault)
    const captureTs = await time.latest()

    await asset.setReentrantCall(vault.interface.encodeFunctionData('payout', [receiver.address, 1n, captureTs]))
    await expect(vault.connect(deployer).payout(receiver.address, AMOUNT / 2n, captureTs))
      .to.be.revertedWithCustomError(vault, 'ReentrancyGuardReentrantCall')
  })
})
