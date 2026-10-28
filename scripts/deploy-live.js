const { artifacts, ethers, network } = require("hardhat");
const { NETWORKS } = require("../bot/networks");

const CONTRACT_NAME = "FlashArbExecutor";
const CONTRACT_FQN = "contracts/FlashArbExecutor.sol:FlashArbExecutor";
const EXECUTOR_INVARIANTS_ABI = [
  "function POOL() view returns (address)",
  "function ADDRESSES_PROVIDER() view returns (address)",
  "function owner() view returns (address)",
];
const RPC_ENV_BY_NETWORK = {
  arbitrum: "ARBITRUM_RPC_URL",
  arbitrumSepolia: "ARBITRUM_SEPOLIA_RPC_URL",
};

function readContractAddress() {
  const value = process.env.CONTRACT_ADDRESS;
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      "Missing required environment variable CONTRACT_ADDRESS. Set it to the deployed FlashArbExecutor address for the target network."
    );
  }
  try {
    return ethers.getAddress(value.trim());
  } catch {
    throw new Error(`CONTRACT_ADDRESS is not a valid Ethereum address: ${value}`);
  }
}

function readRpcUrl() {
  const envName = RPC_ENV_BY_NETWORK[network.name];
  if (!envName) return;
  const value = process.env[envName];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment variable ${envName} for network "${network.name}".`);
  }
}

async function readImmutableRanges() {
  const buildInfo = await artifacts.getBuildInfo(CONTRACT_FQN);
  if (!buildInfo) {
    throw new Error(`No build info found for ${CONTRACT_FQN}. Run "npx hardhat compile" first.`);
  }
  const contractOutput = buildInfo.output.contracts?.["contracts/FlashArbExecutor.sol"]?.[CONTRACT_NAME];
  const references = contractOutput?.evm?.deployedBytecode?.immutableReferences;
  if (!references) {
    throw new Error(`No immutable references found for ${CONTRACT_FQN}. Run "npx hardhat compile" first.`);
  }
  return Object.values(references).flat();
}

function maskRanges(hexCode, ranges) {
  const bytes = ethers.getBytes(hexCode);
  for (const { start, length } of ranges) {
    bytes.fill(0, start, start + length);
  }
  return ethers.hexlify(bytes);
}

async function main() {
  readRpcUrl();
  const address = readContractAddress();

  const expectedChainId = network.config.chainId;
  const { chainId } = await ethers.provider.getNetwork();
  if (expectedChainId !== undefined && chainId !== BigInt(expectedChainId)) {
    throw new Error(
      `Connected chainId ${chainId} does not match network "${network.name}" (expected ${expectedChainId}).`
    );
  }

  const onChainCode = await ethers.provider.getCode(address);
  if (onChainCode === "0x") {
    throw new Error(`No contract code found at ${address} on ${network.name}.`);
  }

  const artifact = await artifacts.readArtifact(CONTRACT_NAME);
  if (!artifact.deployedBytecode || artifact.deployedBytecode === "0x") {
    throw new Error(`Artifact for ${CONTRACT_NAME} has no deployed bytecode. Run "npx hardhat compile" first.`);
  }

  const immutableRanges = await readImmutableRanges();
  const expectedCode = maskRanges(artifact.deployedBytecode, immutableRanges);
  const actualCode = maskRanges(onChainCode, immutableRanges);

  if (actualCode !== expectedCode) {
    throw new Error(
      `Contract at ${address} on ${network.name} bytecode differs from the current compiled ${CONTRACT_NAME} ` +
        "version (may be an older deployment or a different source). " +
        "Redeploy from the current main branch and update CONTRACT_ADDRESS before live execution."
    );
  }

  const verifiedNetwork = await ethers.provider.getNetwork();
  const chainKey = Number(verifiedNetwork.chainId);
  const expectedNetwork = NETWORKS[chainKey];
  if (!expectedNetwork) {
    throw new Error(
      `Unsupported chainId ${verifiedNetwork.chainId}: no Aave pool/provider entry in bot/networks.js.`
    );
  }

  const executor = new ethers.Contract(address, EXECUTOR_INVARIANTS_ABI, ethers.provider);
  const [pool, addressesProvider, owner] = await Promise.all([
    executor.POOL(),
    executor.ADDRESSES_PROVIDER(),
    executor.owner(),
  ]);

  if (ethers.getAddress(pool) !== ethers.getAddress(expectedNetwork.pool)) {
    throw new Error(`POOL() mismatch: got ${pool}, expected ${expectedNetwork.pool}`);
  }
  if (ethers.getAddress(addressesProvider) !== ethers.getAddress(expectedNetwork.provider)) {
    throw new Error(
      `ADDRESSES_PROVIDER() mismatch: got ${addressesProvider}, expected ${expectedNetwork.provider}`
    );
  }

  const expectedOwner = process.env.EXPECTED_OWNER;
  if (typeof expectedOwner === "string" && expectedOwner.trim() !== "") {
    if (ethers.getAddress(owner) !== ethers.getAddress(expectedOwner.trim())) {
      throw new Error(`owner() mismatch: got ${owner}, expected ${expectedOwner.trim()}`);
    }
  } else {
    console.warn("WARNING: EXPECTED_OWNER is not set - skipping owner() check.");
  }

  console.log(`Verified ${CONTRACT_NAME} at ${address} on ${network.name}: runtime bytecode matches the current source.`);
  console.log(
    `Immutables match bot/networks.js: POOL=${expectedNetwork.pool}, ADDRESSES_PROVIDER=${expectedNetwork.provider}.`
  );
  if (typeof expectedOwner === "string" && expectedOwner.trim() !== "") {
    console.log(`owner() matches EXPECTED_OWNER: ${owner}`);
  }
  console.log("Verification only - no transaction was sent.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
