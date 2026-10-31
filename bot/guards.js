const fs = require("fs/promises");
const path = require("path");
const { ethers } = require("ethers");

const LOG_DIR = path.resolve(__dirname, "..", "logs");
const DEFAULT_GAS_SPENT_PATH = path.join(LOG_DIR, "gas_spent.json");
const DEFAULT_CIRCUIT_BREAKER_PATH = path.join(LOG_DIR, "circuit_breaker.json");

function utcDay(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

async function readState(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    if (err instanceof SyntaxError) {
      throw new Error(`STATE_FILE_CORRUPT: ${filePath}`);
    }
    throw err;
  }
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, filePath);
}

/// Guards are split from the executor so each rule can be unit-tested with a temp file and a fake
/// clock. All checks return { ok: true } or { ok: false, error: "..." }.
async function checkChainId({ provider, expectedChainId }) {
  if (expectedChainId === undefined || expectedChainId === null || expectedChainId === "") {
    return { ok: true };
  }

  const network = await provider.getNetwork();
  if (BigInt(network.chainId) !== BigInt(expectedChainId)) {
    return {
      ok: false,
      chainId: Number(network.chainId),
      error: `CHAIN_ID_MISMATCH: expected ${expectedChainId}, RPC reports ${network.chainId}`,
    };
  }
  return { ok: true, chainId: Number(network.chainId) };
}

async function checkContractOwner({ contract, walletAddress }) {
  const owner = await contract.owner();
  if (owner.toLowerCase() !== walletAddress.toLowerCase()) {
    return {
      ok: false,
      owner,
      walletAddress,
      error: `CONTRACT_OWNER_MISMATCH: contract owner is ${owner}, wallet is ${walletAddress}`,
    };
  }
  return { ok: true, owner };
}

async function checkWalletBalance({ provider, address, maxWalletBalanceEth = 0.1 }) {
  const balanceWei = await provider.getBalance(address);
  const maxWei = ethers.parseEther(String(maxWalletBalanceEth));
  if (balanceWei > maxWei) {
    return {
      ok: false,
      balanceWei,
      maxWei,
      error:
        `WALLET_BALANCE_ABOVE_MAX: ${ethers.formatEther(balanceWei)} ETH exceeds ` +
        `${maxWalletBalanceEth} ETH (MAX_WALLET_BALANCE_ETH)`,
    };
  }
  return { ok: true, balanceWei, maxWei };
}

async function checkWalletBalanceLow({ provider, address, minWalletBalanceEth = 0 }) {
  const balanceWei = await provider.getBalance(address);
  const minWei = ethers.parseEther(String(minWalletBalanceEth));
  if (balanceWei < minWei) {
    return {
      ok: false,
      balanceWei,
      minWei,
      error:
        `WALLET_BALANCE_BELOW_MIN: ${ethers.formatEther(balanceWei)} ETH is below ` +
        `${minWalletBalanceEth} ETH (MIN_WALLET_BALANCE_ETH)`,
    };
  }
  return { ok: true, balanceWei, minWei };
}

async function readGasSpent({ filePath = DEFAULT_GAS_SPENT_PATH, now = Date.now() } = {}) {
  const today = utcDay(now);
  const state = await readState(filePath, null);
  if (!state || state.date !== today) return { date: today, gasSpentWei: 0n };
  return { date: today, gasSpentWei: BigInt(state.gasSpentWei || "0") };
}

async function checkDailyGas({
  filePath = DEFAULT_GAS_SPENT_PATH,
  estimatedGasCostWei,
  maxDailyGasEth = 0.01,
  now = Date.now(),
} = {}) {
  const { date, gasSpentWei } = await readGasSpent({ filePath, now });
  const maxWei = ethers.parseEther(String(maxDailyGasEth));
  const projectedWei = gasSpentWei + estimatedGasCostWei;

  if (projectedWei > maxWei) {
    return {
      ok: false,
      date,
      gasSpentWei,
      projectedWei,
      maxWei,
      error:
        `DAILY_GAS_LIMIT: projected ${ethers.formatEther(projectedWei)} ETH exceeds ` +
        `${maxDailyGasEth} ETH (MAX_DAILY_GAS_ETH, spent today ${ethers.formatEther(gasSpentWei)} ETH)`,
    };
  }
  return { ok: true, date, gasSpentWei, projectedWei, maxWei };
}

/// Adds a signed delta to today's gas counter. A negative delta is used to release/reconcile the
/// conservative estimate reserved before sending a transaction. The stored value never goes below 0.
async function addGasSpent({ filePath = DEFAULT_GAS_SPENT_PATH, deltaWei, now = Date.now() } = {}) {
  const { date, gasSpentWei } = await readGasSpent({ filePath, now });
  const nextWei = gasSpentWei + deltaWei > 0n ? gasSpentWei + deltaWei : 0n;
  await writeState(filePath, { date, gasSpentWei: nextWei.toString() });
  return { ok: true, date, gasSpentWei: nextWei };
}

async function readCircuitBreaker({ filePath = DEFAULT_CIRCUIT_BREAKER_PATH } = {}) {
  const state = await readState(filePath, null);
  return {
    consecutiveFailures: Number(state?.consecutiveFailures || 0),
    openUntil: state?.openUntil ?? null,
  };
}

async function checkCircuitBreaker({ filePath = DEFAULT_CIRCUIT_BREAKER_PATH, now = Date.now() } = {}) {
  const state = await readCircuitBreaker({ filePath });
  if (state.openUntil !== null && now < state.openUntil) {
    return {
      ok: false,
      ...state,
      error:
        `CIRCUIT_BREAKER_OPEN: ${state.consecutiveFailures} consecutive failures, ` +
        `cooling down until ${new Date(state.openUntil).toISOString()}`,
    };
  }

  if (state.openUntil !== null && now >= state.openUntil) {
    await writeState(filePath, { consecutiveFailures: 0, openUntil: null });
    return { ok: true, consecutiveFailures: 0, openUntil: null };
  }
  return { ok: true, ...state };
}

async function recordSuccess({ filePath = DEFAULT_CIRCUIT_BREAKER_PATH } = {}) {
  await writeState(filePath, { consecutiveFailures: 0, openUntil: null });
}

async function recordFailure({
  filePath = DEFAULT_CIRCUIT_BREAKER_PATH,
  maxConsecutiveFailures = 5,
  cooldownMinutes = 60,
  now = Date.now(),
} = {}) {
  const failureLimit =
    Number.isFinite(maxConsecutiveFailures) && maxConsecutiveFailures >= 1 ? maxConsecutiveFailures : 5;
  const cooldown =
    Number.isFinite(cooldownMinutes) && cooldownMinutes > 0 ? cooldownMinutes : 60;

  const state = await readCircuitBreaker({ filePath });
  const expired = state.openUntil !== null && now >= state.openUntil;
  const consecutiveFailures = (expired ? 0 : state.consecutiveFailures) + 1;
  const openUntil = consecutiveFailures >= failureLimit ? now + cooldown * 60_000 : null;

  await writeState(filePath, { consecutiveFailures, openUntil });
  return { consecutiveFailures, openUntil, opened: openUntil !== null };
}

module.exports = {
  DEFAULT_GAS_SPENT_PATH,
  DEFAULT_CIRCUIT_BREAKER_PATH,
  utcDay,
  checkChainId,
  checkContractOwner,
  checkWalletBalance,
  checkWalletBalanceLow,
  readGasSpent,
  checkDailyGas,
  addGasSpent,
  readCircuitBreaker,
  checkCircuitBreaker,
  recordSuccess,
  recordFailure,
};
