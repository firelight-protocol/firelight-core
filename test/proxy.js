const { loadFixture } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('./setup/fixtures.js')
const { upgrades } = require('hardhat')
const { expect } = require('chai')

describe('Proxy test', function() {
  before(async () => {
    ({ firelight_vault } = await loadFixture(
      deployVault.bind()
    ))
  })

  it('upgrades contract and calls new function to update state variable', async () => {
    const FirelightVaultUpgradeTest = await ethers.getContractFactory('FirelightVaultUpgradeTest')
    const upgraded = await upgrades.upgradeProxy(await firelight_vault.getAddress(), FirelightVaultUpgradeTest)

    await upgraded.updateVersion(2)

    const version = await upgraded.contractVersion()
    expect(version.toString()).to.equal('2')
  })
})