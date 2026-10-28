const { ethers } = require("ethers");
const { NETWORKS } = require("../bot/networks");

const POOL_ADDRESSES_PROVIDER_ABI = ["function getPool() view returns (address)"];

const AAVE_BY_CHAIN_ID = Object.fromEntries(
  Object.entries(NETWORKS).map(([chainId, { name, pool, provider }]) => [
    Number(chainId),
    { provider, pool, name },
  ])
);

function normalizedAddress(value, label) {
  try {
    return ethers.getAddress(value);
  } catch {
    throw new Error(`${label} is not a valid Ethereum address: ${value}`);
  }
}

async function validateAaveAddresses({ provider, addressesProvider, chainId }) {
  const expected = AAVE_BY_CHAIN_ID[chainId];
  if (!expected) {
    throw new Error(`Unsupported chainId ${chainId}: no Aave V3 addresses in bot/networks.js.`);
  }

  const normalizedProvider = normalizedAddress(addressesProvider, "AAVE_POOL_ADDRESSES_PROVIDER");
  const expectedProvider = ethers.getAddress(expected.provider);
  if (normalizedProvider !== expectedProvider) {
    throw new Error(
      `AAVE_POOL_ADDRESSES_PROVIDER mismatch for chainId ${chainId} (${expected.name}): ` +
        `got ${normalizedProvider}, expected ${expectedProvider}.`
    );
  }

  const providerCode = await provider.getCode(normalizedProvider);
  if (!providerCode || providerCode === "0x") {
    throw new Error(
      `No contract code at AAVE_POOL_ADDRESSES_PROVIDER ${normalizedProvider} on chainId ${chainId}.`
    );
  }

  let pool;
  try {
    pool = await new ethers.Contract(normalizedProvider, POOL_ADDRESSES_PROVIDER_ABI, provider).getPool();
  } catch (error) {
    throw new Error(
      `Could not read getPool() from AAVE_POOL_ADDRESSES_PROVIDER ${normalizedProvider}: ` +
        `${error.shortMessage || error.message}`
    );
  }

  const normalizedPool = ethers.getAddress(pool);
  const expectedPool = ethers.getAddress(expected.pool);
  if (normalizedPool !== expectedPool) {
    throw new Error(
      `Aave pool mismatch for chainId ${chainId} (${expected.name}): ` +
        `provider ${normalizedProvider} returns ${normalizedPool}, expected ${expectedPool}.`
    );
  }

  const poolCode = await provider.getCode(normalizedPool);
  if (!poolCode || poolCode === "0x") {
    throw new Error(`No contract code at Aave pool ${normalizedPool} on chainId ${chainId}.`);
  }

  return { ok: true, provider: normalizedProvider, pool: normalizedPool };
}

module.exports = { AAVE_BY_CHAIN_ID, validateAaveAddresses };
