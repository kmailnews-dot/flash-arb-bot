const fs = require("fs/promises");
const path = require("path");
const { ethers } = require("ethers");
const {
  listRecentTerminalExecutions,
  DEFAULT_EXECUTION_JOURNAL_PATH,
} = require("./persist");

const LOG_DIR = path.resolve(__dirname, "..", "logs");
const DEFAULT_GAS_SPENT_PATH = path.join(LOG_DIR, "gas_spent.json");
const DEFAULT_CIRCUIT_BREAKER_PATH = path.join(LOG_DIR, "circuit_breaker.json");
const DEFAULT_RPC_ERRORS_PATH = path.join(LOG_DIR, "rpc_errors.json");
const DEFAULT_GAS_HISTORY_PATH = path.join(LOG_DIR, "gas_history.json");

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

async function checkCircuitBreaker({
    filePath = DEFAULT_CIRCUIT_BREAKER_PATH,
    now = Date.now(),
    maxDailyGasEth = 0.01,
    gasSpentPath = DEFAULT_GAS_SPENT_PATH,
    gasDrawdownMultiplier = 1.2,
    rpcErrorsPath = DEFAULT_RPC_ERRORS_PATH,
    rpcErrorRateWindowSize = 10,
    rpcErrorRateThreshold = 0.5,
    gasHistoryPath = DEFAULT_GAS_HISTORY_PATH,
    gasAnomalyWindowSize = 20,
    gasAnomalyMultiplier = 3,
    gasAnomalyMinSamples = 5,
  } = {}) {
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

  const revertRateWindowSize = arguments[0]?.revertRateWindowSize ?? 20;
  const revertRateThreshold = arguments[0]?.revertRateThreshold ?? 0.6;
  const unknownRateWindowSize = arguments[0]?.unknownRateWindowSize ?? 20;
  const unknownRateThreshold = arguments[0]?.unknownRateThreshold ?? 0.3;
  const cooldownMinutes = arguments[0]?.cooldownMinutes ?? 60;
  const executionJournalPath =
    arguments[0]?.executionJournalPath || DEFAULT_EXECUTION_JOURNAL_PATH;

  if (
    !Number.isInteger(revertRateWindowSize) ||
    revertRateWindowSize < 1 ||
    !Number.isInteger(unknownRateWindowSize) ||
    unknownRateWindowSize < 1 ||
    !Number.isFinite(revertRateThreshold) ||
    revertRateThreshold < 0 ||
    revertRateThreshold > 1 ||
    !Number.isFinite(unknownRateThreshold) ||
    unknownRateThreshold < 0 ||
    unknownRateThreshold > 1
  ) {
    throw new Error(
      `INVALID_CIRCUIT_BREAKER_CONFIG: revertRateWindowSize=${revertRateWindowSize}, ` +
        `revertRateThreshold=${revertRateThreshold}, ` +
        `unknownRateWindowSize=${unknownRateWindowSize}, ` +
        `unknownRateThreshold=${unknownRateThreshold}`
    );
  }

  const windowRecords = await listRecentTerminalExecutions(
    Math.max(revertRateWindowSize, unknownRateWindowSize),
    executionJournalPath
  ).catch(() => []);
  const revertRecords = windowRecords.slice(0, revertRateWindowSize);
  const unknownRecords = windowRecords.slice(0, unknownRateWindowSize);
  const revertWindowFull = revertRecords.length >= revertRateWindowSize;
  const unknownWindowFull = unknownRecords.length >= unknownRateWindowSize;
  const revertRate =
    revertRecords.length === 0
      ? 0
      : revertRecords.filter((r) => r.status === "REVERTED").length / revertRecords.length;
  const unknownRate =
    unknownRecords.length === 0
      ? 0
      : unknownRecords.filter((r) => r.status === "UNKNOWN" || r.status === "DROPPED").length /
        unknownRecords.length;

  if (revertWindowFull && revertRate > revertRateThreshold) {
    const openUntil = now + cooldownMinutes * 60_000;
    await writeState(filePath, { consecutiveFailures: state.consecutiveFailures, openUntil });
    return {
      ok: false,
      ...state,
      openUntil,
      revertRate,
      unknownRate,
      error: `CIRCUIT_BREAKER_OPEN: revert rate ${(revertRate * 100).toFixed(0)}% over last ${revertRateWindowSize} (threshold ${(revertRateThreshold * 100).toFixed(0)}%)`,
    };
  }
  if (unknownWindowFull && unknownRate > unknownRateThreshold) {
    const openUntil = now + cooldownMinutes * 60_000;
    await writeState(filePath, { consecutiveFailures: state.consecutiveFailures, openUntil });
    return {
      ok: false,
      ...state,
      openUntil,
      revertRate,
      unknownRate,
      error: `CIRCUIT_BREAKER_OPEN: unknown rate ${(unknownRate * 100).toFixed(0)}% over last ${unknownRateWindowSize} (threshold ${(unknownRateThreshold * 100).toFixed(0)}%)`,
    };
  }
  if (maxDailyGasEth > 0 && gasSpentPath) {
    try {
      const { gasSpentWei } = await readGasSpent({ filePath: gasSpentPath });
      const drawdownLimitWei = ethers.parseEther(
        String(maxDailyGasEth * gasDrawdownMultiplier)
      );
      if (gasSpentWei > drawdownLimitWei) {
        const openUntil = now + cooldownMinutes * 60_000;
        await writeState(filePath, { consecutiveFailures: state.consecutiveFailures, openUntil });
        return {
          ok: false,
          ...state,
          openUntil,
          gasSpentWei: gasSpentWei.toString(),
          gasDrawdownLimitWei: drawdownLimitWei.toString(),
          error: `CIRCUIT_BREAKER_OPEN: gas drawdown ${ethers.formatEther(gasSpentWei)} ETH > ${ethers.formatEther(drawdownLimitWei)} ETH (maxDailyGasEth * gasDrawdownMultiplier)`,
        };
      }
    } catch (err) {
      console.warn(`[GUARD WARNING] gas drawdown check failed: ${err.message}`);
    }
  }
  if (rpcErrorsPath && rpcErrorRateWindowSize && rpcErrorRateThreshold) {
    try {
      const rpcCheck = await checkRpcErrorRate({
        filePath: rpcErrorsPath,
        windowSize: rpcErrorRateWindowSize,
        threshold: rpcErrorRateThreshold,
        now,
      });
      if (!rpcCheck.ok) {
        const openUntil = now + cooldownMinutes * 60_000;
        await writeState(filePath, { consecutiveFailures: state.consecutiveFailures, openUntil });
        return {
          ok: false,
          ...state,
          openUntil,
          rpcErrorRate: rpcCheck.rate,
          rpcErrorSamples: rpcCheck.samples,
          error: rpcCheck.error,
        };
      }
    } catch (err) {
      console.warn(`[GUARD WARNING] rpc error rate check failed: ${err.message}`);
    }
  }
  if (gasHistoryPath && gasAnomalyWindowSize && gasAnomalyMultiplier) {
    try {
      const gasCheck = await checkGasAnomaly({
        filePath: gasHistoryPath,
        windowSize: gasAnomalyWindowSize,
        multiplier: gasAnomalyMultiplier,
        minSamples: gasAnomalyMinSamples ?? 5,
        now,
      });
      if (!gasCheck.ok) {
        const openUntil = now + cooldownMinutes * 60_000;
        await writeState(filePath, { consecutiveFailures: state.consecutiveFailures, openUntil });
        return {
          ok: false,
          ...state,
          openUntil,
          gasMedian: gasCheck.median,
          gasLast: gasCheck.last,
          gasRatio: gasCheck.ratio,
          error: `CIRCUIT_BREAKER_OPEN: gas price anomaly ${gasCheck.last} wei > ${gasCheck.median} wei x ${gasAnomalyMultiplier} (median x multiplier)`,
        };
      }
    } catch (err) {
      console.warn(`[GUARD WARNING] gas anomaly check failed: ${err.message}`);
    }
  }
  return { ok: true, ...state, revertRate, unknownRate };
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

async function readRpcErrors({ filePath = DEFAULT_RPC_ERRORS_PATH } = {}) {
  const state = await readState(filePath, null);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { version: 1, cycles: [] };
  }
  if (state.version !== 1 || !Array.isArray(state.cycles)) {
    return { version: 1, cycles: [] };
  }
  return { version: 1, cycles: state.cycles };
}

async function writeRpcErrors({ filePath = DEFAULT_RPC_ERRORS_PATH, state } = {}) {
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

async function recordRpcCycle({
  filePath = DEFAULT_RPC_ERRORS_PATH,
  errors,
  total,
  at = Date.now(),
  windowSize = 10,
} = {}) {
  if (!Number.isInteger(errors) || errors < 0) {
    throw new Error("recordRpcCycle: errors must be a non-negative integer");
  }
  if (!Number.isInteger(total) || total < 0) {
    throw new Error("recordRpcCycle: total must be a non-negative integer");
  }
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error("recordRpcCycle: windowSize must be a positive integer");
  }
  const state = await readRpcErrors({ filePath });
  const cycles = [...state.cycles, { errors, total, at }].slice(-windowSize);
  await writeRpcErrors({ filePath, state: { version: 1, cycles } });
  return { version: 1, cycles };
}

async function checkRpcErrorRate({
  filePath = DEFAULT_RPC_ERRORS_PATH,
  windowSize = 10,
  threshold = 0.5,
  now = Date.now(),
} = {}) {
  const state = await readRpcErrors({ filePath });
  const recent = state.cycles
    .filter((c) => typeof c.at === "number" && c.at <= now)
    .slice(-windowSize);
  if (recent.length === 0) {
    return { ok: true, rate: 0, samples: 0 };
  }
  const sumErrors = recent.reduce((acc, c) => acc + Number(c.errors || 0), 0);
  const sumTotal = recent.reduce((acc, c) => acc + Number(c.total || 0), 0);
  if (sumTotal === 0) {
    return { ok: true, rate: 0, samples: recent.length };
  }
  const rate = sumErrors / sumTotal;
  if (rate > threshold) {
    return {
      ok: false,
      rate,
      samples: recent.length,
      error: `CIRCUIT_BREAKER_OPEN: RPC error rate ${(rate * 100).toFixed(0)}% over last ${recent.length} cycles (threshold ${(threshold * 100).toFixed(0)}%)`,
    };
  }
  return { ok: true, rate, samples: recent.length };
}

async function readGasHistory({ filePath = DEFAULT_GAS_HISTORY_PATH } = {}) {
  const state = await readState(filePath, null);
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { version: 1, samples: [] };
  }
  if (state.version !== 1 || !Array.isArray(state.samples)) {
    return { version: 1, samples: [] };
  }
  return { version: 1, samples: state.samples };
}

async function writeGasHistory({ filePath = DEFAULT_GAS_HISTORY_PATH, state } = {}) {
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

async function recordGasSample({
  filePath = DEFAULT_GAS_HISTORY_PATH,
  gasPriceWei,
  at = Date.now(),
  windowSize = 20,
} = {}) {
  if (typeof gasPriceWei !== "bigint" || gasPriceWei <= 0n) {
    throw new Error("recordGasSample: gasPriceWei must be a positive bigint");
  }
  if (!Number.isInteger(windowSize) || windowSize < 1) {
    throw new Error("recordGasSample: windowSize must be a positive integer");
  }
  const state = await readGasHistory({ filePath });
  const samples = [
    ...state.samples,
    { gasPriceWei: gasPriceWei.toString(), at },
  ].slice(-windowSize);
  await writeGasHistory({ filePath, state: { version: 1, samples } });
  return { version: 1, samples };
}

async function checkGasAnomaly({
  filePath = DEFAULT_GAS_HISTORY_PATH,
  windowSize = 20,
  multiplier = 3,
  minSamples = 5,
  now = Date.now(),
} = {}) {
  const state = await readGasHistory({ filePath });
  const recent = state.samples
    .filter((s) => typeof s.at === "number" && s.at <= now)
    .slice(-windowSize);
  if (recent.length < minSamples) {
    return { ok: true, reason: "insufficient samples", samples: recent.length };
  }
  const values = recent
    .map((s) => BigInt(s.gasPriceWei))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(values.length / 2);
  const median = values.length % 2 === 0 ? (values[mid - 1] + values[mid]) / 2n : values[mid];
  const last = values[values.length - 1];
  if (last > median * BigInt(multiplier)) {
    return {
      ok: false,
      median: median.toString(),
      last: last.toString(),
      ratio: Number(last) / Number(median),
      samples: recent.length,
    };
  }
  return {
    ok: true,
    median: median.toString(),
    last: last.toString(),
    ratio: Number(last) / Number(median),
    samples: recent.length,
  };
}

module.exports = {
  DEFAULT_GAS_SPENT_PATH,
  DEFAULT_CIRCUIT_BREAKER_PATH,
  DEFAULT_RPC_ERRORS_PATH,
  DEFAULT_GAS_HISTORY_PATH,
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
  readRpcErrors,
  writeRpcErrors,
  recordRpcCycle,
  checkRpcErrorRate,
  readGasHistory,
  writeGasHistory,
  recordGasSample,
  checkGasAnomaly,
};
