const { EXECUTION_KEYS, DEPLOYMENT_ACCOUNT_KEY, NODE_RPC_URL, MAINNET_RPC_HEADERS, MAINNET_NETWORK_ID, HARDHAT_CHAIN_ID, EXTRA_KEYS, ETHERSCAN_API_KEY } = require('./lib/env')
require('@openzeppelin/hardhat-upgrades')
require('@nomicfoundation/hardhat-chai-matchers')
require('@nomicfoundation/hardhat-verify')
require('hardhat-contract-sizer')
require('solidity-coverage')
const { removeConsoleLog } = require('hardhat-preprocessor')

const accounts = [DEPLOYMENT_ACCOUNT_KEY, ...EXECUTION_KEYS, ...EXTRA_KEYS].map(k => `0x${ k }`)

const forking = {
  url: NODE_RPC_URL || 'No url'
}
if (process.env.BN)
  forking.blockNumber = parseInt(process.env.BN)

module.exports = {
  defaultNetwork: 'hardhat',
  preprocess: {
     eachLine: removeConsoleLog(_ => !process.env.SHOW_LOGS)
  },
  networks: {
    hardhat: {
      chainId: HARDHAT_CHAIN_ID,
      accounts: accounts.map(a => ({
        privateKey: a,
        balance: '1000000000000000000000000000'
      })),
      forking,
      chains: {
        14: {
          hardforkHistory: {
            london: 0
          }
        }
      }
    },
    mainnet: {
      url: NODE_RPC_URL || 'No url',
      gas: 'auto',
      gasPrice: 1000000000,
      gasMultiplier: 1.2,
      blockGasLimit: 8000000,
      network_id: MAINNET_NETWORK_ID,
      accounts,
      httpHeaders: MAINNET_RPC_HEADERS ? JSON.parse(MAINNET_RPC_HEADERS) : undefined
    },
    coston: {
      url: 'https://coston-api.flare.network/ext/bc/C/rpc',
      chainId: 16,
      accounts
    }
  },
  etherscan: {
    apiKey: ETHERSCAN_API_KEY
  },
  solidity: {
    compilers: [
      {
        version: '0.8.23',
        settings: {
          optimizer: {
            enabled: true,
            runs: 10000
          },
          evmVersion: 'london'
        }
      },
      {
        version: '0.8.28',
        settings: {
          optimizer: {
            enabled: true,
            runs: 10000
          },
          evmVersion: 'london'
        }
      }
    ]
  },
  paths: {
    sources: './contracts'
  }
}