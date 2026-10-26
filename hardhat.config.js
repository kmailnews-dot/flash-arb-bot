require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

function readEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^(['"])(.*)\1$/, "$2");
  return trimmed === "" ? undefined : trimmed;
}

const PRIVATE_KEY = readEnv("PRIVATE_KEY");
const accounts = PRIVATE_KEY
  ? [PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`]
  : [];

if (accounts.length > 0 && !/^0x[0-9a-fA-F]{64}$/.test(accounts[0])) {
  throw new Error(
    "PRIVATE_KEY is set but is not a valid 32-byte hex private key (64 hex characters, optionally prefixed with 0x)."
  );
}

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    hardhat: {},
    arbitrum: {
      url: readEnv("ARBITRUM_RPC_URL") || "",
      accounts,
      chainId: 42161,
    },
    arbitrumSepolia: {
      url: readEnv("ARBITRUM_SEPOLIA_RPC_URL") || "",
      accounts,
      chainId: 421614,
    },
  },
};
