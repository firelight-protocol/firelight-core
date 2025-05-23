const { getPath } = require('./utils')
const argv = require('yargs').argv
const dotenv = require('dotenv')

dotenv.config({ path: getPath(argv.envFile || '.env') })

module.exports = {
  DEPLOYMENT_ACCOUNT_KEY: process.env.DEPLOYMENT_ACCOUNT_KEY,
  EXECUTION_KEYS: (process.env.EXECUTION_KEYS || '').split(',').filter(k => k),
  EXTRA_KEYS: (process.env.EXTRA_KEYS || '').split(',').filter(k => k),
  NODE_RPC_URL: process.env.NODE_RPC_URL,
  MAINNET_RPC_HEADERS: process.env.MAINNET_RPC_HEADERS,
  HARDHAT_CHAIN_ID: parseInt(process.env.HARDHAT_CHAIN_ID)
}