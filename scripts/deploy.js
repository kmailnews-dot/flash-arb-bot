const { ethers, network } = require("hardhat");
const { AAVE_BY_CHAIN_ID, validateAaveAddresses } = require("./validateAave");

const RPC_ENV_BY_NETWORK = {
  arbitrum: "ARBITRUM_RPC_URL",
  arbitrumSepolia: "ARBITRUM_SEPOLIA_RPC_URL",
};

function readRequiredEnv(name, help) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `Missing required environment variable ${name} for network "${network.name}".\n` +
        `${help}\n` +
        "In GitHub Actions, add it under Settings > Secrets and variables > Actions > " +
        "Secrets (repository secrets). Values stored in the Variables tab or in an " +
        "environment are not exposed as secrets unless the job declares that environment."
    );
  }
  return value.trim();
}

function readRpcUrl(name) {
  const value = readRequiredEnv(name, "Set it to an Arbitrum RPC endpoint from Alchemy, Infura, or the public RPC.");
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL.`);
  }
  return url;
}

async function main() {
  const rpcEnvName = RPC_ENV_BY_NETWORK[network.name];
  if (rpcEnvName) {
    const rpcUrl = readRpcUrl(rpcEnvName);
    console.log(`Network: ${network.name} (chainId ${network.config.chainId})`);
    console.log(`RPC endpoint host: ${rpcUrl.host}`);

    const privateKey = readRequiredEnv(
      "PRIVATE_KEY",
      "Set it to the private key of a burner wallet funded with a small amount of ETH for gas."
    );
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new Error(
        "PRIVATE_KEY is not a valid 32-byte hex private key (64 hex characters, optionally prefixed with 0x)."
      );
    }
  }

  const chainId = Number(network.config.chainId);
  let addressesProvider = process.env.AAVE_POOL_ADDRESSES_PROVIDER?.trim();
  if (!addressesProvider) {
    const fallback = AAVE_BY_CHAIN_ID[chainId];
    if (!fallback) {
      throw new Error(
        `Missing AAVE_POOL_ADDRESSES_PROVIDER and no Aave V3 default for chainId ${chainId} in bot/networks.js.`
      );
    }
    addressesProvider = fallback.provider;
    console.log(`AAVE_POOL_ADDRESSES_PROVIDER is not set - using bot/networks.js default for chainId ${chainId}.`);
  }

  try {
    const validated = await validateAaveAddresses({
      provider: ethers.provider,
      addressesProvider,
      chainId,
    });
    addressesProvider = validated.provider;
    console.log(`Aave addresses validated: provider=${validated.provider}, pool=${validated.pool}`);
  } catch (error) {
    console.error(`Aave address validation failed: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const [deployer] = await ethers.getSigners();
  if (!deployer) {
    throw new Error(
      `No deployer account is configured for network "${network.name}". Set PRIVATE_KEY to the burner wallet key.`
    );
  }

  console.log("Deploying FlashArbExecutor with account:", deployer.address);

  const FlashArbExecutor = await ethers.getContractFactory("FlashArbExecutor");
  const executor = await FlashArbExecutor.deploy(addressesProvider, deployer.address);
  await executor.waitForDeployment();

  const address = await executor.getAddress();
  console.log("FlashArbExecutor deployed to:", address);
  console.log("Owner set to:", deployer.address);
  console.log("Save this address as CONTRACT_ADDRESS in your bot secrets/.env.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
