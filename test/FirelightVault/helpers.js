const { time } = require('@nomicfoundation/hardhat-network-helpers')
const { deployVault } = require('../setup/fixtures.js')
const { ethers } = require('hardhat')

const DECIMALS = 6
const DEPOSIT_LIMIT = ethers.parseUnits('50000', DECIMALS)
const WEEK = 604800

const coder = ethers.AbiCoder.defaultAbiCoder()
const encodeInitParams = (p) => coder.encode(
  ['address', 'address', 'address', 'address', 'address', 'address', 'uint256', 'uint48'],
  [p.defaultAdmin, p.limitUpdater, p.blocklister, p.pauser, p.periodConfigurationUpdater, p.rescuer, p.depositLimit, p.periodConfigurationDuration]
)

// Own fixture identity so these suites never share snapshots with other test folders.
const vaultFixture = () => deployVault()

// Deterministic period advance: jumps to the first second of the vault's next period
// using an absolute timestamp, immune to pending evm_increaseTime offsets from other suites.
const advanceOnePeriod = async (vault) => {
  await time.increaseTo((await vault.currentPeriodEnd()) + 1n)
}

module.exports = { DECIMALS, DEPOSIT_LIMIT, WEEK, encodeInitParams, vaultFixture, advanceOnePeriod }
