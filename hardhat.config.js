const {
  EXECUTION_KEYS,
  DEPLOYMENT_ACCOUNT_KEY,
  NODE_RPC_URL,
  MAINNET_RPC_HEADERS,
  MAINNET_NETWORK_ID,
  HARDHAT_CHAIN_ID,
  EXTRA_KEYS,
  ETHERSCAN_API_KEY,
} = require("./lib/env");
require("@openzeppelin/hardhat-upgrades");
require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-verify");
require("hardhat-contract-sizer");
require("solidity-coverage");
const { removeConsoleLog } = require("hardhat-preprocessor");

const rawKeys = [DEPLOYMENT_ACCOUNT_KEY, ...EXECUTION_KEYS, ...EXTRA_KEYS].filter(Boolean);
const accounts = rawKeys.map((k) => `0x${k}`);

const forking = NODE_RPC_URL ? { url: NODE_RPC_URL } : undefined;
if (forking && process.env.BN) forking.blockNumber = parseInt(process.env.BN);

module.exports = {
  defaultNetwork: "hardhat",
  preprocess: {
    eachLine: removeConsoleLog((_) => !process.env.SHOW_LOGS),
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: true,
      ...(Number.isNaN(HARDHAT_CHAIN_ID) ? {} : { chainId: HARDHAT_CHAIN_ID }),
      ...(accounts.length > 0
        ? {
            accounts: accounts.map((a) => ({
              privateKey: a,
              balance: "1000000000000000000000000000",
            })),
          }
        : {}),
      ...(process.env.FORK === "1" && forking ? { forking } : {}),
      chains: {
        14: {
          hardforkHistory: {
            london: 0,
            cancun: 51541706,
          },
        },
      },
    },
    mainnet: {
      url: NODE_RPC_URL || "No url",
      gas: "auto",
      gasPrice: 1000000000,
      gasMultiplier: 1.2,
      blockGasLimit: 8000000,
      network_id: MAINNET_NETWORK_ID,
      accounts,
      httpHeaders: MAINNET_RPC_HEADERS ? JSON.parse(MAINNET_RPC_HEADERS) : undefined,
    },
    coston: {
      url: "https://coston-api.flare.network/ext/bc/C/rpc",
      chainId: 16,
      accounts,
    },
    coston2: {
      url: process.env.COSTON2_RPC_URL || "https://coston2-api.flare.network/ext/C/rpc",
      chainId: 114,
      accounts,
      // The public Coston2 RPC occasionally lets a request hang indefinitely. Without a
      // timeout the whole deploy stalls forever; with one, a stalled request errors out so
      // index.ts saves partial state and the run can be resumed via runStep.ts.
      timeout: 120000,
    },
  },
  etherscan: {
    apiKey: {
      coston2: "no-key-needed",
    },
    customChains: [
      {
        network: "coston2",
        chainId: 114,
        urls: {
          apiURL: "https://coston2-explorer.flare.network/api",
          browserURL: "https://coston2-explorer.flare.network",
        },
      },
    ],
  },
  solidity: {
    compilers: [
      {
        version: "0.8.23",
        settings: {
          optimizer: {
            enabled: true,
            runs: 10000,
          },
          evmVersion: "london",
        },
      },
      {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 10000,
          },
          evmVersion: "london",
          viaIR: true,
        },
      },
      {
        version: "0.8.29",
        settings: {
          optimizer: {
            enabled: true,
            runs: 1000,
          },
          evmVersion: "london",
        },
      },
    ],
    overrides: {
      "contracts/core/CoverOrderAllocator.sol": {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 100,
          },
          evmVersion: "london",
          viaIR: true,
        },
      },
      "contracts/core/FirelightVault.sol": {
        version: "0.8.28",
        settings: {
          optimizer: {
            enabled: true,
            runs: 800,
          },
          evmVersion: "london",
          viaIR: true,
        },
      },
    },
  },
  paths: {
    sources: "./contracts",
  },
};
