const BigNumber = require('bignumber.js')

const deployContract = async (artifact_name, args = []) => {
  const factory = await ethers.getContractFactory(artifact_name),
        contract = await factory.deploy(...args)
  await contract.waitForDeployment()
  return { contract, factory, address: await contract.getAddress() }
}

const deployFAsset = async (args) => {
  const fasset = await deployContract('FAsset'),
        fasset_proxy = await deployContract('FAssetProxy', [fasset.address, ...args]),
        token_contract = fasset.factory.attach(fasset_proxy.address),
        mock = await deployContract('MockContract'),
        asset_manager = mock.address

  await token_contract.setAssetManager(asset_manager)

  token_contract.mintTo = async (receiver, amount) => {
    return await impersonateAndSend(asset_manager, {
      from: asset_manager,
      to: fasset_proxy.address,
      data: token_contract.interface.encodeFunctionData('mint', [receiver, amount])
    })
  }

  token_contract.burnFrom = async (address, amount) => {
    return await impersonateAndSend(asset_manager, {
      from: asset_manager,
      to: fasset_proxy.address,
      data: token_contract.interface.encodeFunctionData('burn', [address, amount])
    })
  }

  return { token_contract, asset_manager }
}

const impersonate = async (address, fn, fund_with_gas = true) => {
  if (fund_with_gas)
    await setBalance(address, '1e20')
  await hre.network.provider.request({ method: 'hardhat_impersonateAccount', params: [address] })
  const output = await fn()
  await hre.network.provider.request({ method: 'hardhat_stopImpersonatingAccount', params: [address] })
  return output
}

const impersonateAndSend = (address, tx, fund_with_gas) => impersonate(address, async () => {
  return await (await ethers.getImpersonatedSigner(address)).sendTransaction(tx)
}, fund_with_gas)

const setBalance = (address, amount) => hre.network.provider.send('hardhat_setBalance', [address, `0x${new BigNumber(amount).toString(16)}`])

module.exports = {
  deployFAsset,
  impersonate,
  impersonateAndSend,
  setBalance
}