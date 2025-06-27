const { deployFAsset } = require('../../lib/utils_test')
const { upgrades } = require('hardhat')

const DEFAULT_CONFIG = {
  decimals: 6,
  underlying: 'fXRP',
  lst: 'stfXRP',
  initial_deposit_limit: '50000000000',    // 50k tokens
  period_configuration_duration: 604800             // 1 week
}

const deployVault = async (config = {}) => {
  config = Object.assign(DEFAULT_CONFIG, config)
  const abi_coder = ethers.AbiCoder.defaultAbiCoder()
  let token_contract, firelight_vault

  ({ token_contract, asset_manager } = await deployFAsset([config.underlying, config.underlying, 'Ripple', 'XRP', config.decimals]))
  let [deployer, rescuer, blacklister, pauser, limit_updater, period_configuration_updater, user1, user2, user3] = await ethers.getSigners()

  const FirelightVaultFactory = await ethers.getContractFactory('FirelightVault')

  const InitParams = {
    defaultAdmin: deployer.address,
    limitUpdater: limit_updater.address,
    blacklister: blacklister.address,
    pauser: pauser.address,
    periodConfigurationUpdater: period_configuration_updater.address,
    depositLimit: config.initial_deposit_limit,
    periodConfigurationDuration: config.period_configuration_duration
  }
  const init_params = abi_coder.encode(['address','address','address','address','address','uint256','uint48'], Object.values(InitParams))

  // Deploy vault using proxy
  firelight_vault = await upgrades.deployProxy(FirelightVaultFactory, [await token_contract.getAddress(), config.lst, config.lst, init_params])

  await firelight_vault.grantRole(await firelight_vault.RESCUER_ROLE(), rescuer.address)

  const utils = {
    mintAndApprove: async (amount, user) => {
      await token_contract.mintTo(user.address, amount)
      await token_contract.connect(user).approve(firelight_vault.target, amount)
    }
  }
  
  return {
    token_contract,
    asset_manager,
    firelight_vault,
    deployer,
    rescuer,
    blacklister,
    pauser,
    limit_updater,
    period_configuration_updater,
    users: [ user1, user2, user3 ],
    utils,
    config
  }
}

module.exports = {
  deployVault,
}