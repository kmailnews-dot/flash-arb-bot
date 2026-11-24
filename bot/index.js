const { ethers } = require("ethers");
const { getEthUsdPrice, scanPair } = require("./scanner");
const { maybeExecute } = require("./executor");
const { reconcilePendingExecutions } = require("./execute");
const { DEFAULT_SCAN_LOG_PATH, appendScanResult, logEvent, logFormat } = require("./persist");
const { NETWORKS } = require("./networks");
const { checkWalletBalanceLow, recordRpcCycle, DEFAULT_RPC_ERRORS_PATH, recordGasSample, DEFAULT_GAS_HISTORY_PATH } = require("./guards");
const {
  DEFAULT_ADAPTIVE_PATH,
  applyAdaptive,
  loadAdaptive,
  recordOutcome,
} = require("./adaptive");
const { createThrottle, withThrottle } = require("./throttle");
const { createJsonRpcProvider } = require("./netproxy");
const {
  DEFAULT_MAX_AGE_MS: DEFAULT_PAIR_SPREAD_MAX_AGE_MS,
  DEFAULT_MIN_SAMPLES: DEFAULT_PAIR_SPREAD_MIN_SAMPLES,
  DEFAULT_WINDOW_SIZE: DEFAULT_PAIR_SPREAD_WINDOW_SIZE,
  bestNetProfitBps,
  buildPairKey,
  decidePairSpread,
  normalizeMode: normalizePairSpreadMode,
} = require("./pairSpread");
const {
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_MAX_PER_CYCLE,
  initProbeHistoryFromState,
  recordProbeAttempt,
  selectProbeCandidates,
} = require("./pairSpreadProbe");
const {
  DEFAULT_PAIR_SPREADS_PATH,
  PAIR_SPREAD_STORE_CODES,
  appendPairSpreadCommit,
  loadPairSpreadState,
  recordPairSpreadCommit,
} = require("./pairSpreadStore");

const AAVE_POOL_PREMIUM_ABI = ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"];

let mainThrottle = null;

function getMainThrottle(config = {}) {
  if (!mainThrottle) {
    mainThrottle = createThrottle({
      minIntervalMs: config.throttleMinIntervalMs,
      name: "main",
    });
  }
  return mainThrottle;
}

async function persistResultSafely(logPath, result, chainId) {
  try {
    await appendScanResult(logPath, result, { chainId });
  } catch (err) {
    console.warn(`WARNING: could not persist scan result to ${logPath}: ${err.message}`);
  }
}

function describeError(error) {
  if (!error) return { code: null, shortMessage: "unknown error" };
  if (typeof error === "string") return { code: null, shortMessage: error };
  return {
    code: error.code ?? null,
    shortMessage: error.shortMessage ?? error.code ?? "unknown error",
  };
}

function hasNetProfit(result) {
  return typeof result.netProfitUsd === "number" && Number.isFinite(result.netProfitUsd);
}

function compareResults(a, b) {
  if (a.error && !b.error) return 1;
  if (!a.error && b.error) return -1;
  if (a.error && b.error) return 0;

  if (hasNetProfit(a) && hasNetProfit(b)) return b.netProfitUsd - a.netProfitUsd;
  if (a.grossProfit > b.grossProfit) return -1;
  if (a.grossProfit < b.grossProfit) return 1;
  return 0;
}

function selectBestResult(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return [...results].sort(compareResults)[0];
}

const PAIR_SPREAD_ATTEMPT_PRECEDENCE = Object.freeze({
  empty: 0,
  failure: 1,
  success: 2,
});

/// D6/D15: process-local probe runtime. It is never persisted and is lost on
/// restart. Tests inject a fresh object through `main({ probeRuntime })`.
function createProbeRuntime() {
  return {
    lastGlobalProbeAt: null,
    writeFailures: 0,
    suspendedUntil: 0,
    pendingAttempts: new Map(),
    cursorKey: null,
  };
}

const defaultProbeRuntime = createProbeRuntime();
const DEFAULT_PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS = 0;
const PROBE_BACKOFF_BASE_MS = 300_000;
const PROBE_BACKOFF_MAX_MS = 3_600_000;
// D15: only these stable `error.code` values classify a thrown commit refusal
// as deterministic. `instanceof`, the message and the error name are never
// used, because the same class can also signal an unexpected failure.
const PROBE_DETERMINISTIC_COMMIT_CODES = new Set([
  PAIR_SPREAD_STORE_CODES.VALIDATION_FAILED,
  PAIR_SPREAD_STORE_CODES.CONFLICT,
]);

function resolveProbeRuntime(runtime) {
  if (runtime === undefined || runtime === null) return defaultProbeRuntime;
  if (typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new TypeError("probeRuntime must be an object");
  }
  return runtime;
}

function isProbeCancelled(signal) {
  return signal !== undefined && signal !== null && signal.aborted === true;
}

function probeBackoffMs(writeFailures) {
  const exponent = Math.max(0, writeFailures - 1);
  return Math.min(PROBE_BACKOFF_BASE_MS * 2 ** exponent, PROBE_BACKOFF_MAX_MS);
}

function isDeterministicCommitCode(code) {
  return PROBE_DETERMINISTIC_COMMIT_CODES.has(code);
}

function classifyReturnedCommit(result) {
  if (result?.ok === true) {
    return result.written === true ? "success" : "no_op";
  }
  if (
    result?.ok === false &&
    result.written === false &&
    result.writable === true &&
    result.error?.code === PAIR_SPREAD_STORE_CODES.WRITE_FAILED
  ) {
    return "write_failed";
  }
  // D15: every other returned refusal is deterministic, including an
  // incoherent `ok:false, written:true`, a non-writable state and an unknown
  // or missing error code. No backoff and no attempt fusion.
  return "deterministic";
}

/// D15: merge a cycle's complete attempts into the overlay, keeping the
/// attempt with the greatest `at` per key. On an equal timestamp the outcome
/// precedence prevents a failure from replacing a success. Inputs are copied;
/// neither the cycle attempts nor the existing overlay entries are mutated.
function mergeAttemptsIntoPending(pendingAttempts, attempts) {
  for (const attempt of attempts) {
    if (!attempt || typeof attempt.key !== "string") continue;
    const existing = pendingAttempts.get(attempt.key);
    if (
      existing === undefined ||
      attempt.at > existing.at ||
      (attempt.at === existing.at &&
        (PAIR_SPREAD_ATTEMPT_PRECEDENCE[attempt.outcome] ?? -1) >
          (PAIR_SPREAD_ATTEMPT_PRECEDENCE[existing.outcome] ?? -1))
    ) {
      pendingAttempts.set(attempt.key, { ...attempt });
    }
  }
}

function mergePairSpreadSample(samples, key, netProfitBps, at) {
  const existing = samples.get(key);
  if (!existing || netProfitBps > existing.netProfitBps) {
    samples.set(key, { key, netProfitBps, at });
  }
}

/// D10/D15 conflict guard: a pending non-success attempt is not re-emitted
/// when the current commit carries a sample that survives Store
/// normalization. `appendPairSpreadCommit` is the same pure authority the
/// Store uses; if that preflight unexpectedly throws, every key with a sample
/// is treated as surviving so the commit can never be built into a conflict.
function survivingSampleKeys({ state, samples, now, windowSize, maxAgeMs }) {
  const allSampleKeys = new Set(samples.map((sample) => sample.key));
  if (samples.length === 0) return allSampleKeys;
  try {
    const appended = appendPairSpreadCommit({
      state,
      samples,
      attempts: [],
      now,
      windowSize,
      maxAgeMs,
    });
    const surviving = new Set();
    for (const sample of samples) {
      const canonical = sample.netProfitBps.toString();
      const entry = appended.state.pairs[sample.key];
      if (
        entry &&
        entry.samples.some(
          (stored) =>
            stored.at === sample.at && stored.netProfitBps === canonical
        )
      ) {
        surviving.add(sample.key);
      }
    }
    return surviving;
  } catch {
    return allSampleKeys;
  }
}

function buildCommitAttempts({
  runtime,
  state,
  samples,
  cycleAttempts,
  now,
  windowSize,
  maxAgeMs,
}) {
  const attempts = [...cycleAttempts];
  const survivingKeys = survivingSampleKeys({
    state,
    samples,
    now,
    windowSize,
    maxAgeMs,
  });
  for (const [key, pending] of runtime.pendingAttempts) {
    // D15: a future attempt is not committable and must not make the state
    // unwritable. It stays in the overlay.
    if (!pending || pending.at > now) continue;
    // D10/D15: never emit a non-success attempt beside a surviving sample for
    // the same key. A success attempt is always safe.
    if (pending.outcome !== "success" && survivingKeys.has(key)) continue;
    attempts.push({ ...pending });
  }
  return attempts;
}

function applyWriteFailedBackoff(runtime, cycleAttempts, now) {
  runtime.writeFailures += 1;
  const backoffMs = probeBackoffMs(runtime.writeFailures);
  runtime.suspendedUntil = now + backoffMs;
  mergeAttemptsIntoPending(runtime.pendingAttempts, cycleAttempts);
  return backoffMs;
}

function applyCommitSucceeded(runtime, now) {
  const recovering =
    runtime.writeFailures > 0 ||
    runtime.suspendedUntil > 0 ||
    runtime.pendingAttempts.size > 0;
  runtime.writeFailures = 0;
  runtime.suspendedUntil = 0;
  // D15: only a real write resolves at-or-before-now entries, including a
  // non-success entry excluded by the conflict guard. Future entries stay.
  for (const [key, attempt] of runtime.pendingAttempts) {
    if (attempt.at <= now) runtime.pendingAttempts.delete(key);
  }
  return recovering;
}

/// Keeps exactly one final attempt per pair key and cycle. A valid observation
/// always wins over a failure or an empty result encountered for the same key.
function mergePairSpreadAttempt(attempts, attempt) {
  const existing = attempts.get(attempt.key);
  if (
    existing === undefined ||
    PAIR_SPREAD_ATTEMPT_PRECEDENCE[attempt.outcome] >
      PAIR_SPREAD_ATTEMPT_PRECEDENCE[existing.outcome]
  ) {
    attempts.set(attempt.key, attempt);
  }
}

/// Deterministic classification of a scan that produced no usable sample.
/// A quoted attempt is a non-error object with a usable amountIn. QUOTE_ERRORS
/// is reserved for results made only of errors or unusable entries; a quote
/// that came back without a calculable netProfitBps is UNPRICED.
function classifyEmptyScan(results) {
  if (results.length === 0) return "NO_RESULTS";
  const hasQuotedAttempt = results.some(
    (result) =>
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      !result.error &&
      typeof result.amountIn === "bigint" &&
      result.amountIn > 0n
  );
  return hasQuotedAttempt ? "UNPRICED" : "QUOTE_ERRORS";
}

function logPairSpreadEvent(event) {
  if (logFormat() === "json") {
    logEvent(event);
    return;
  }
  const message = event.message ?? JSON.stringify(event);
  if (event.level === "warn" || event.level === "error") {
    console.warn(message);
  } else {
    console.log(message);
  }
}

/// D9: probe logging is non-blocking. A logger exception is reported locally
/// and never changes the probe outcome, its sample or its attempt.
function logPairSpreadEventSafely(event) {
  try {
    logPairSpreadEvent(event);
    return true;
  } catch (err) {
    try {
      console.warn(
        `[PAIR SPREAD] probe logging failed: ${err?.message ?? String(err)}`
      );
    } catch {
      // Logging is advisory; the probe outcome remains authoritative.
    }
    return false;
  }
}

/// D6/D9/D10/D11: the single probe phase of a cycle. It runs after the main
/// scan loop and before the sole Store commit. It never writes scans.jsonl,
/// never changes counters, never calls maybeExecute and never throws into the
/// cycle: every failure is logged and the phase returns.
async function runPairSpreadProbePhase({
  pairSpread,
  pairSpreadLoaded,
  pairSpreadStateAvailable,
  probeCandidates,
  scannedKeys,
  pairSpreadNow,
  probeRuntime,
  signal,
  provider,
  executionConfig,
  gasPriceWei,
  ethUsdPrice,
  blockTag,
  scanPairImpl,
  pairSpreadSamples,
  pairSpreadAttempts,
}) {
  const phase = { ran: false, probeNow: null, selected: 0, started: 0 };
  // D1/D7: probes exist only for enforce and require an explicit interval.
  if (pairSpread.mode !== "enforce" || pairSpread.probeIntervalMs <= 0) {
    return phase;
  }
  if (isProbeCancelled(signal)) {
    logPairSpreadEventSafely({
      event: "pair_spread_probe_cancelled",
      level: "info",
      reason: "BEFORE_SELECTION",
      message: "[PAIR SPREAD] probes cancelled before selection",
    });
    return phase;
  }
  // D10/A7: an invalid, corrupt, unreadable or non-writable state forbids
  // probes. writable:true is only a load-time indication, never a proof that
  // the commit will succeed.
  if (
    !pairSpreadStateAvailable ||
    !pairSpreadLoaded ||
    pairSpreadLoaded.ok === false ||
    pairSpreadLoaded.writable !== true
  ) {
    logPairSpreadEventSafely({
      event: "pair_spread_probe_skipped",
      level: "warn",
      reason: "STATE_UNAVAILABLE",
      writable: pairSpreadLoaded?.writable ?? false,
      message:
        "[PAIR SPREAD] probes skipped: loaded state is unavailable or not writable",
    });
    return phase;
  }

  // D11: captured once at the start of the probe phase. It is the envelope
  // clock (suspension, global throttle) and is never used as an `at`.
  const probeNow = Date.now();
  phase.probeNow = probeNow;

  // D8: seeded from persisted samples and attempts only. pendingAttempts is
  // overlaid by the scheduler; the loaded state is never mutated.
  let probeHistory;
  try {
    probeHistory = initProbeHistoryFromState(pairSpreadLoaded.state);
  } catch (err) {
    logPairSpreadEventSafely({
      event: "pair_spread_probe_history_error",
      level: "warn",
      reason: "HISTORY_INVALID",
      message: `[PAIR SPREAD] could not rebuild probe history: ${err.message}. Probes disabled for this cycle.`,
    });
    return phase;
  }

  let selection;
  try {
    selection = selectProbeCandidates({
      candidates: probeCandidates,
      history: probeHistory,
      pairSpreadNow,
      probeNow,
      intervalMs: pairSpread.probeIntervalMs,
      globalIntervalMs: pairSpread.probeGlobalIntervalMs,
      lastGlobalProbeAt: probeRuntime.lastGlobalProbeAt,
      suspendedUntil: probeRuntime.suspendedUntil,
      maxPerCycle: pairSpread.probeMaxPerCycle,
      cursorKey: probeRuntime.cursorKey,
      scannedKeys,
      probedKeys: new Set(),
      pendingAttempts: probeRuntime.pendingAttempts,
    });
  } catch (err) {
    logPairSpreadEventSafely({
      event: "probe_scheduler_error",
      level: "warn",
      reason: "SCHEDULER_ERROR",
      message: `[PAIR SPREAD] probe scheduler error: ${err.message}. Probes disabled for this cycle.`,
    });
    return phase;
  }

  phase.ran = true;
  phase.selected = selection.selected.length;
  const probedKeys = new Set();
  let resolvedCount = 0;
  let lastResolvedKey = null;

  for (const candidate of selection.selected) {
    // D3: an aborted cycle starts no new probe. A selected key not entered in
    // the wrapper stays unresolved and blocks the runtime cursor.
    if (isProbeCancelled(signal)) break;
    const { key, pair } = candidate;

    // D5: defence in depth. A key already scanned or probed in this cycle is
    // resolved without being started and consumes no probe.
    if (scannedKeys.has(key) || probedKeys.has(key)) {
      resolvedCount += 1;
      lastResolvedKey = key;
      continue;
    }

    // Probe started: insert probedKeys before scanPair, then stamp this batch
    // start with the probeNow captured at the beginning of the phase. Every
    // started batch updates the global throttle, not only the first one.
    probedKeys.add(key);
    probeRuntime.lastGlobalProbeAt = probeNow;
    const startedAt = Date.now();
    let outcome = "failure";
    let reason = "SCAN_ERROR";
    let sampleBps = null;

    try {
      const results = await scanPairImpl({
        provider,
        pair,
        config: executionConfig,
        gasPriceWei,
        ethUsdPrice,
        blockTag,
      });
      if (!Array.isArray(results)) {
        throw new TypeError("scanPair must return an array of results");
      }
      try {
        const bps = bestNetProfitBps(results);
        if (bps === null) {
          outcome = "empty";
          reason = classifyEmptyScan(results);
        } else if (typeof bps === "bigint") {
          outcome = "success";
          reason = null;
          sampleBps = bps;
        } else {
          throw new TypeError("bestNetProfitBps must return a bigint or null");
        }
      } catch {
        // D9: a classification error is not a logging error. It produces no
        // sample and a non-success attempt, preserving the Store invariant.
        outcome = "failure";
        reason = "SCAN_ERROR";
        sampleBps = null;
      }
    } catch {
      outcome = "failure";
      reason = "SCAN_ERROR";
      sampleBps = null;
    }

    const durationMs = Math.max(0, Date.now() - startedAt);

    // D9/D10: record the sample and attempt before logging so a logger throw
    // can never alter the outcome. The attempt always uses pairSpreadNow.
    if (outcome === "success") {
      mergePairSpreadSample(
        pairSpreadSamples,
        key,
        sampleBps,
        pairSpreadNow
      );
    }
    mergePairSpreadAttempt(pairSpreadAttempts, {
      key,
      outcome,
      source: "probe",
      at: pairSpreadNow,
      ...(reason === null ? {} : { reason }),
    });
    try {
      probeHistory = recordProbeAttempt({
        history: probeHistory,
        key,
        at: pairSpreadNow,
      });
    } catch (err) {
      logPairSpreadEventSafely({
        event: "pair_spread_probe_history_error",
        level: "warn",
        reason: "HISTORY_UPDATE_FAILED",
        message: `[PAIR SPREAD] could not update in-memory probe history: ${err.message}`,
      });
    }

    resolvedCount += 1;
    lastResolvedKey = key;
    phase.started += 1;

    logPairSpreadEventSafely({
      event: "pair_spread_probe",
      level: outcome === "failure" ? "warn" : "debug",
      key,
      pair: pair?.label ?? null,
      outcome,
      reason,
      durationMs,
      message:
        `[PAIR SPREAD] probe pair=${pair?.label ?? key} outcome=${outcome} ` +
        `reason=${reason ?? "n/a"} durationMs=${durationMs}`,
    });
  }

  // D3/A17 runtime cursor rule: never move past a selected key that was not
  // resolved (started or explicitly excluded by D5). A key excluded by D5 is
  // resolved and may be passed; an empty batch may advance the selection
  // cursor because no probe is at risk.
  if (selection.selected.length === 0) {
    probeRuntime.cursorKey = selection.nextCursorKey;
  } else if (resolvedCount === 0) {
    // No selected key was resolved: keep the previous runtime cursor.
  } else if (resolvedCount === selection.selected.length) {
    probeRuntime.cursorKey = selection.nextCursorKey;
  } else {
    probeRuntime.cursorKey = lastResolvedKey;
  }

  return phase;
}

function resolvePairSpreadSettings(config) {
  let mode;
  try {
    mode = normalizePairSpreadMode(config.pairSpreadMode ?? "off");
  } catch (err) {
    throw new Error(`PAIR_SPREAD_MODE is invalid: ${err.message}`);
  }
  return {
    mode,
    filePath: config.pairSpreadPath ?? DEFAULT_PAIR_SPREADS_PATH,
    windowSize: config.pairSpreadWindowSize ?? DEFAULT_PAIR_SPREAD_WINDOW_SIZE,
    minSamples: config.pairSpreadMinSamples ?? DEFAULT_PAIR_SPREAD_MIN_SAMPLES,
    maxAgeMs: config.pairSpreadMaxAgeMs ?? DEFAULT_PAIR_SPREAD_MAX_AGE_MS,
    // D12: probes stay disabled by default; an explicit interval is required.
    probeIntervalMs: config.pairSpreadProbeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS,
    probeGlobalIntervalMs:
      config.pairSpreadProbeGlobalIntervalMs ??
      DEFAULT_PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS,
    probeMaxPerCycle:
      config.pairSpreadProbeMaxPerCycle ?? DEFAULT_PROBE_MAX_PER_CYCLE,
  };
}

/// Reads the real chain id with one raw `eth_chainId` call. Ethers providers configured with a
/// static network intentionally skip their per-call chain-id check, so this is the single
/// authoritative check that the RPC endpoint serves the expected network.
async function readChainId(provider) {
  if (typeof provider.send === "function") {
    return Number(BigInt(await provider.send("eth_chainId", [])));
  }
  const network = await provider.getNetwork();
  return Number(network.chainId);
}

async function readAaveFlashLoanPremium({ provider, chainId, config }) {
  const network = NETWORKS[chainId];
  if (!network) return config.aaveFlashLoanPremiumBps;

  try {
    const pool = new ethers.Contract(network.pool, AAVE_POOL_PREMIUM_ABI, provider);
    const onChainPremiumBps = BigInt(await pool.FLASHLOAN_PREMIUM_TOTAL());
    const configuredPremiumBps =
      config.aaveFlashLoanPremiumBps === undefined
        ? onChainPremiumBps
        : BigInt(config.aaveFlashLoanPremiumBps);
    const divergence =
      onChainPremiumBps > configuredPremiumBps
        ? onChainPremiumBps - configuredPremiumBps
        : configuredPremiumBps - onChainPremiumBps;

    if (divergence > 1n) {
      console.warn(
        `WARNING: Aave flash loan premium on ${network.name} (${chainId}) is ${onChainPremiumBps} bps on-chain, ` +
          `but AAVE_FLASH_LOAN_PREMIUM_BPS is ${configuredPremiumBps} bps. ` +
          "Using the on-chain value for execution estimates."
      );
    }

    return onChainPremiumBps;
  } catch (err) {
    const message = err?.shortMessage || err?.message || String(err);
    console.warn(
      `WARNING: could not read Aave flash loan premium from ${network.name} (${chainId}) pool ${network.pool}: ` +
        `${message}. Using configured ${config.aaveFlashLoanPremiumBps} bps.`
    );
    return config.aaveFlashLoanPremiumBps;
  }
}

/// Runs one scan cycle. Config and provider are injectable so tests can run against the Hardhat
/// network without depending on environment variables; production callers pass nothing.
async function main({
  provider: injectedProvider,
  config: injectedConfig,
  scanPair: scanPairImpl = scanPair,
  maybeExecute: maybeExecuteImpl = maybeExecute,
  probeRuntime: injectedProbeRuntime,
  signal,
  throttle: injectedThrottle,
  loadPairSpreadState: loadPairSpreadStateImpl = loadPairSpreadState,
  recordPairSpreadCommit: recordPairSpreadCommitImpl = recordPairSpreadCommit,
} = {}) {
  const config = injectedConfig || require("./config");
  const pairSpread = resolvePairSpreadSettings(config);
  const probeRuntime = resolveProbeRuntime(injectedProbeRuntime);
  const mainThrottle = injectedThrottle || getMainThrottle(config);
  const adaptivePath = config.adaptivePath ?? DEFAULT_ADAPTIVE_PATH;
  let cycleConfig = config;
  try {
    const adaptiveState = await loadAdaptive({ filePath: adaptivePath, config });
    cycleConfig = applyAdaptive({ config, state: adaptiveState });
    const adaptiveMessage =
      `[ADAPTIVE] state=loaded bps=${adaptiveState.effectiveMinProfitBps} ` +
      `factorMajor=${adaptiveState.effectiveMaxTradeSize.majors} factorLongtail=${adaptiveState.effectiveMaxTradeSize.longtail}`;
    if (logFormat() === "json") {
      logEvent({
        event: "adaptive_state",
        level: "info",
        effectiveMinProfitBps: adaptiveState.effectiveMinProfitBps,
        effectiveMaxTradeSize: { majors: adaptiveState.effectiveMaxTradeSize.majors, longtail: adaptiveState.effectiveMaxTradeSize.longtail },
        message: adaptiveMessage,
      });
    } else {
      console.log(adaptiveMessage);
    }
  } catch (err) {
    const adaptiveMessage =
      `WARNING: could not load adaptive state from ${adaptivePath}: ${err.message}. ` +
      "Continuing with base config.";
    if (logFormat() === "json") {
      logEvent({ event: "adaptive_state_error", level: "warn", message: adaptiveMessage });
    } else {
      console.warn(adaptiveMessage);
    }
  }
  const provider =
    injectedProvider ||
    createJsonRpcProvider({
      rpcUrl: config.rpcUrl,
      proxyUrl: config.rpcProxyUrl,
      chainId: config.expectedChainId,
    });
  const scanLogPath = config.scanLogPath || DEFAULT_SCAN_LOG_PATH;
  const walletAddress = config.privateKey ? new ethers.Wallet(config.privateKey).address : null;

  // Verify the real chain id before touching any journal or scanning: a provider pinned to a
  // static network would otherwise answer from its configuration, and reconciliation on the
  // wrong chain could mark valid pending executions as dropped.
  const chainIdOutcome = await withThrottle(mainThrottle, () => readChainId(provider));
  const chainId = chainIdOutcome.result;
  if (config.expectedChainId !== undefined && chainId !== Number(config.expectedChainId)) {
    const reason =
      `CHAIN_ID_MISMATCH: expected ${config.expectedChainId}, RPC reports ${chainId}. ` +
      "Refusing to scan or execute on the wrong network.";
    console.error(`[CHAIN ID MISMATCH] ${reason}`);
    return { refused: true, reason, exitCode: 1 };
  }

  // P1-16-bis: load the pair-spread history once per cycle, after the chain id is verified.
  // Mode off performs no state I/O at all.
  const pairSpreadNow = Date.now();
  let pairSpreadLoaded = null;
  let pairSpreadStateAvailable = false;
  if (pairSpread.mode !== "off") {
    logPairSpreadEvent({
      event: "pair_spread_mode",
      level: "info",
      mode: pairSpread.mode,
      path: pairSpread.filePath,
      message: `[PAIR SPREAD] mode=${pairSpread.mode} path=${pairSpread.filePath}`,
    });
    try {
      pairSpreadLoaded = await loadPairSpreadStateImpl({
        filePath: pairSpread.filePath,
        now: pairSpreadNow,
        windowSize: pairSpread.windowSize,
        maxAgeMs: pairSpread.maxAgeMs,
      });
      pairSpreadStateAvailable = true;
      const stateMessage =
        `[PAIR SPREAD] state=${pairSpreadLoaded.status} writable=${pairSpreadLoaded.writable} ` +
        `pairs=${Object.keys(pairSpreadLoaded.state?.pairs ?? {}).length} ` +
        `expiredPruned=${pairSpreadLoaded.expiredPruned}`;
      logPairSpreadEvent({
        event: "pair_spread_state",
        level: pairSpreadLoaded.warning ? "warn" : "info",
        status: pairSpreadLoaded.status,
        writable: pairSpreadLoaded.writable,
        expiredPruned: pairSpreadLoaded.expiredPruned,
        warning: pairSpreadLoaded.warning,
        message: pairSpreadLoaded.warning
          ? `${stateMessage} warning=${pairSpreadLoaded.warning}`
          : stateMessage,
      });
    } catch (err) {
      logPairSpreadEvent({
        event: "pair_spread_state",
        level: "warn",
        status: "error",
        writable: false,
        warning: err.message,
        message: `[PAIR SPREAD] state=unavailable warning=${err.message}. Continuing with an empty history.`,
      });
    }
  }

  await reconcilePendingExecutions({
    provider,
    config,
    walletAddress,
  }).catch((err) => {
    console.warn(`[RECONCILE] startup reconciliation failed: ${err.message}`);
  });

  console.log(`flash-arb-bot scan starting - DRY_RUN=${config.dryRun} - ${new Date().toISOString()}`);
  if (config.dryRun) {
    console.log("Running in SIMULATION mode: opportunities are logged, no transaction is sent.");
  }

  const [feeDataOutcome, ethUsdPrice, blockTagOutcome] = await Promise.all([
    withThrottle(mainThrottle, () => provider.getFeeData()),
    getEthUsdPrice(provider, config.ethUsdRoute, config),
    typeof provider.getBlockNumber === "function"
      ? withThrottle(mainThrottle, () => provider.getBlockNumber())
      : Promise.resolve({ result: "latest" }),
  ]);
  const feeData = feeDataOutcome.result;
  const blockTag = blockTagOutcome.result;

  if (walletAddress) {
    const balanceCheck = await checkWalletBalanceLow({
      provider,
      address: walletAddress,
      minWalletBalanceEth: config.minWalletBalanceEth,
    });
    if (!balanceCheck.ok) {
      console.warn(
        `[BALANCE LOW] ${walletAddress} holds ${ethers.formatEther(balanceCheck.balanceWei)} ETH, ` +
          `below MIN_WALLET_BALANCE_ETH=${config.minWalletBalanceEth}`
      );
    }
  }

  if (config.dryRun === false && ethUsdPrice === null) {
    const reason =
      "ETH_USD_ROUTE_JSON required for live execution, but quote failed. Set DRY_RUN=true or fix the route.";
    console.error(`[LIVE REFUSED] ${reason}`);
    return { refused: true, reason };
  }

  const aaveFlashLoanPremiumBps = await readAaveFlashLoanPremium({ provider, chainId, config });
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPriceWei || gasPriceWei === 0n) {
    console.warn(
      "WARNING: gasPrice is 0 or unavailable - gas cost is not estimated for this run; " +
        "opportunities will be ranked on raw gross profit only."
    );
  }

  if (ethUsdPrice !== null) {
    console.log(`Reference price: 1 WETH ~= $${ethUsdPrice.toFixed(2)} (from ETH_USD_ROUTE_JSON)`);
  } else {
    console.log("No ETH/USD reference available - USD filtering is disabled, using raw on-chain profit only.");
  }

  let scanned = 0;
  let opportunities = 0;
  let executed = 0;
  let rpcErrors = 0;
  let filteredPairs = 0;
  let wouldFilterPairs = 0;
  let pairErrors = 0;
  const pairSpreadSamples = new Map();
  const pairSpreadAttempts = new Map();
  // D5: keys scanned in this cycle. It is filled immediately before every
  // scanPair call so a scan that throws still excludes a probe.
  const scannedKeys = new Set();
  // D1: only pairs skipped by enforce are probe candidates.
  const probeCandidates = [];
  const executionConfig = { ...cycleConfig, ethUsdPrice, aaveFlashLoanPremiumBps };
  const configuredPairs = Array.isArray(cycleConfig.pairs) ? cycleConfig.pairs : [];

  for (const pair of configuredPairs) {
    let pairKey = null;
    let pairDecision = null;

    if (pairSpread.mode !== "off") {
      try {
        pairKey = buildPairKey({ chainId, pair });
        const samples = pairSpreadLoaded?.state?.pairs?.[pairKey]?.samples ?? [];
        pairDecision = decidePairSpread({
          pair,
          samples,
          mode: pairSpread.mode,
          now: pairSpreadNow,
          windowSize: pairSpread.windowSize,
          minSamples: pairSpread.minSamples,
          maxAgeMs: pairSpread.maxAgeMs,
        });
      } catch (err) {
        logPairSpreadEvent({
          event: "pair_spread_decision_error",
          level: "warn",
          pair: pair.label,
          message: `[PAIR SPREAD] could not evaluate pair=${pair.label}: ${err.message}. Scanning anyway.`,
        });
        pairDecision = null;
      }

      if (pairDecision) {
        const decisionLabel = pairDecision.skip
          ? "filter"
          : pairDecision.wouldFilter
            ? "would-filter"
            : "scan";
        logPairSpreadEvent({
          event: "pair_spread_decision",
          level: "info",
          pair: pair.label,
          mode: pairDecision.mode,
          skip: pairDecision.skip,
          wouldFilter: pairDecision.wouldFilter,
          reason: pairDecision.reason,
          sampleCount: pairDecision.sampleCount,
          doubledMedian: pairDecision.doubledMedian,
          floor: pairDecision.floor,
          last: pairDecision.last,
          message:
            `[PAIR SPREAD] pair=${pair.label} decision=${decisionLabel} reason=${pairDecision.reason} ` +
            `samples=${pairDecision.sampleCount} floor=${pairDecision.floor ?? "n/a"} ` +
            `doubledMedian=${pairDecision.doubledMedian ?? "n/a"} last=${pairDecision.last ?? "n/a"}`,
        });

        if (pairSpread.mode === "shadow" && pairDecision.wouldFilter) {
          wouldFilterPairs += 1;
        }

        if (pairDecision.skip) {
          filteredPairs += 1;
          logPairSpreadEvent({
            event: "pair_spread_filtered",
            level: "warn",
            pair: pair.label,
            reason: pairDecision.reason,
            message: `[PAIR SPREAD] SKIP pair=${pair.label} reason=${pairDecision.reason}`,
          });
          // D1: the blackout is the only source of probe candidates.
          if (pairKey !== null && pairSpread.mode === "enforce") {
            probeCandidates.push({ key: pairKey, pair });
          }
          continue;
        }
      }
    }

    try {
      console.log(`\nScanning ${pair.label} ...`);
      let results;
      try {
        if (pairKey !== null) scannedKeys.add(pairKey);
        results = await scanPairImpl({
          provider,
          pair,
          config: executionConfig,
          gasPriceWei,
          ethUsdPrice,
          blockTag,
        });
        if (!Array.isArray(results)) {
          throw new TypeError("scanPair must return an array of results");
        }
      } catch (err) {
        // Only a throw from scanPair itself is a scan failure. Logging,
        // scans.jsonl and maybeExecute errors happen outside this boundary.
        if (pairKey !== null) {
          mergePairSpreadAttempt(pairSpreadAttempts, {
            key: pairKey,
            outcome: "failure",
            source: "scan",
            at: pairSpreadNow,
            reason: "SCAN_ERROR",
          });
        }
        throw err;
      }

      if (pairKey !== null) {
        const sampleBps = bestNetProfitBps(results);
        if (sampleBps !== null) {
          const existing = pairSpreadSamples.get(pairKey);
          if (!existing || sampleBps > existing.netProfitBps) {
            pairSpreadSamples.set(pairKey, {
              key: pairKey,
              netProfitBps: sampleBps,
              at: pairSpreadNow,
            });
          }
          mergePairSpreadAttempt(pairSpreadAttempts, {
            key: pairKey,
            outcome: "success",
            source: "scan",
            at: pairSpreadNow,
          });
        } else {
          mergePairSpreadAttempt(pairSpreadAttempts, {
            key: pairKey,
            outcome: "empty",
            source: "scan",
            at: pairSpreadNow,
            reason: classifyEmptyScan(results),
          });
        }
      }

      for (const result of results) {
        scanned += 1;
        await persistResultSafely(scanLogPath, result, chainId);

        if (result.error) {
          const errorInfo = describeError(result.error);
          const isQualityFilter = typeof result.error === "string";
          if (!isQualityFilter) {
            rpcErrors += 1;
          }
          logEvent({
            event: "scan_result",
            level: isQualityFilter ? "info" : "error",
            pair: pair.label,
            tradeSize: result.tradeSizeHuman,
            borrowedToken: pair.borrowedToken.symbol,
            error: errorInfo,
            message: `  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: ${
              isQualityFilter ? "FILTERED" : "ERROR"
            } - ${errorInfo.shortMessage}`,
          });
          continue;
        }

        const profitStr = ethers.formatUnits(result.grossProfit, pair.borrowedToken.decimals);
        const usdStr = result.netProfitUsd !== null ? ` (~$${result.netProfitUsd.toFixed(2)} net)` : "";
        logEvent({
          event: "scan_result",
          level: "info",
          pair: pair.label,
          tradeSize: result.tradeSizeHuman,
          borrowedToken: pair.borrowedToken.symbol,
          grossProfit: profitStr,
          netProfitUsd: result.netProfitUsd,
          isOpportunity: result.isOpportunity,
          message:
            `  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: gross profit ${profitStr} ` +
            `${pair.borrowedToken.symbol}${usdStr}${result.isOpportunity ? " -> OPPORTUNITY" : ""}`,
        });

        if (result.isOpportunity) opportunities += 1;
      }

      const best = selectBestResult(results);
      if (best && !best.error) {
        const bestGross = ethers.formatUnits(best.grossProfit, pair.borrowedToken.decimals);
        const bestNet = hasNetProfit(best) ? best.netProfitUsd.toFixed(2) : "n/a";
        logEvent({
          event: "best_result",
          pair: pair.label,
          tradeSize: best.tradeSizeHuman,
          gross: bestGross,
          net: bestNet,
          isOpportunity: best.isOpportunity,
          message: `  [BEST] pair=${pair.label}, size=${best.tradeSizeHuman}, gross=${bestGross}, net=${bestNet}`,
        });

        if (best.isOpportunity) {
          const outcome = await maybeExecuteImpl({ opportunity: best, provider, config: executionConfig });
          if (outcome.submitted) executed += 1;

          if (config.dryRun !== true) {
            let adaptiveOutcome = "FAILURE";
            if (outcome.submitted && outcome.receipt && outcome.receipt.status === 1) {
              adaptiveOutcome = "SUCCESS";
            }
            if (outcome.error && String(outcome.error).includes("TRANSACTION_IN_FLIGHT")) {
              adaptiveOutcome = "UNKNOWN";
            }
            try {
              await recordOutcome({ filePath: adaptivePath, outcome: adaptiveOutcome, profile: pair.profile, config });
            } catch (err) {
              console.warn(
                `WARNING: could not record adaptive outcome to ${adaptivePath}: ${err.message}`
              );
            }
          }
        }
      }
    } catch (err) {
      pairErrors += 1;
      console.warn(`[PAIR ERROR] ${pair.label}: ${err.message} - continuing to next pair.`);
    }
  }

  await runPairSpreadProbePhase({
    pairSpread,
    pairSpreadLoaded,
    pairSpreadStateAvailable,
    probeCandidates,
    scannedKeys,
    pairSpreadNow,
    probeRuntime,
    signal,
    provider,
    executionConfig,
    gasPriceWei,
    ethUsdPrice,
    blockTag,
    scanPairImpl,
    pairSpreadSamples,
    pairSpreadAttempts,
  });

  if (pairSpread.mode !== "off" && pairSpreadStateAvailable && pairSpreadLoaded) {
    const commitSamples = Array.from(pairSpreadSamples.values());
    const cycleAttempts = Array.from(pairSpreadAttempts.values());
    const commitAttempts = buildCommitAttempts({
      runtime: probeRuntime,
      state: pairSpreadLoaded.state,
      samples: commitSamples,
      cycleAttempts,
      now: pairSpreadNow,
      windowSize: pairSpread.windowSize,
      maxAgeMs: pairSpread.maxAgeMs,
    });
    // D15: only the Store call is a persistence boundary. Logging is
    // advisory and must never turn a successful write into a commit failure,
    // arm the backoff or fuse the cycle attempts.
    let recordResult;
    let commitFailed = false;
    let commitError = null;
    try {
      recordResult = await recordPairSpreadCommitImpl({
        filePath: pairSpread.filePath,
        loaded: pairSpreadLoaded,
        samples: commitSamples,
        attempts: commitAttempts,
        now: pairSpreadNow,
        windowSize: pairSpread.windowSize,
        maxAgeMs: pairSpread.maxAgeMs,
      });
    } catch (err) {
      commitFailed = true;
      commitError = err;
    }
    if (commitFailed) {
      logPairSpreadEventSafely({
        event: "pair_spread_persist",
        level: "warn",
        status: "error",
        written: false,
        message: `[PAIR SPREAD] could not persist state: ${
          commitError?.message ?? String(commitError)
        }`,
      });
      if (isDeterministicCommitCode(commitError?.code)) {
        // D15: deterministic Store refusal. No backoff, no attempt fusion;
        // the existing overlay is preserved.
        logPairSpreadEventSafely({
          event: "pair_spread_probe_commit_refused",
          level: "warn",
          status: "error",
          code: commitError.code,
          message:
            `[PAIR SPREAD] deterministic commit refusal code=${commitError.code}. ` +
            "Cycle attempts are not retained.",
        });
      } else {
        // D15: unexpected exception. The write outcome is unknown, so the
        // cycle attempts are retained for the next commit; no backoff is armed.
        mergeAttemptsIntoPending(probeRuntime.pendingAttempts, cycleAttempts);
        logPairSpreadEventSafely({
          event: "pair_spread_probe_commit_error",
          level: "warn",
          status: "error",
          pendingAttempts: probeRuntime.pendingAttempts.size,
          message:
            `[PAIR SPREAD] unexpected commit error: ${
              commitError?.message ?? String(commitError)
            }. ` +
            `Retaining ${cycleAttempts.length} cycle attempt(s) for the next commit.`,
        });
      }
    } else {
      const warningIsNew =
        typeof recordResult.warning === "string" &&
        recordResult.warning !== pairSpreadLoaded.warning;
      logPairSpreadEventSafely({
        event: "pair_spread_persist",
        level: recordResult.ok ? "info" : "warn",
        status: recordResult.status,
        writable: recordResult.writable,
        written: recordResult.written,
        added: recordResult.added,
        attemptsAdded: recordResult.attemptsAdded,
        expiredPruned: recordResult.expiredPruned,
        warning: warningIsNew ? recordResult.warning : null,
        message:
          `[PAIR SPREAD] persist status=${recordResult.status} written=${recordResult.written} ` +
          `added=${recordResult.added} attemptsAdded=${recordResult.attemptsAdded} ` +
          `expiredPruned=${recordResult.expiredPruned}` +
          (warningIsNew ? ` warning=${recordResult.warning}` : ""),
      });

      const commitOutcome = classifyReturnedCommit(recordResult);
      if (commitOutcome === "success") {
        if (applyCommitSucceeded(probeRuntime, pairSpreadNow)) {
          logPairSpreadEventSafely({
            event: "pair_spread_probe_recovered",
            level: "info",
            writeFailures: probeRuntime.writeFailures,
            pendingAttempts: probeRuntime.pendingAttempts.size,
            message: "[PAIR SPREAD] probe persistence recovered",
          });
        }
      } else if (commitOutcome === "write_failed") {
        const backoffMs = applyWriteFailedBackoff(
          probeRuntime,
          cycleAttempts,
          Date.now()
        );
        logPairSpreadEventSafely({
          event: "pair_spread_probe_write_failed",
          level: "warn",
          code: PAIR_SPREAD_STORE_CODES.WRITE_FAILED,
          writeFailures: probeRuntime.writeFailures,
          backoffMs,
          suspendedUntil: probeRuntime.suspendedUntil,
          pendingAttempts: probeRuntime.pendingAttempts.size,
          message:
            `[PAIR SPREAD] probe write failed: failures=${probeRuntime.writeFailures} ` +
            `backoffMs=${backoffMs} suspendedUntil=${probeRuntime.suspendedUntil} ` +
            `pendingAttempts=${probeRuntime.pendingAttempts.size}`,
        });
      } else if (commitOutcome === "deterministic") {
        // D15: a returned refusal other than WRITE_FAILED is deterministic.
        // It arms no backoff and never fuses the cycle attempts.
        logPairSpreadEventSafely({
          event: "pair_spread_probe_commit_refused",
          level: "warn",
          status: recordResult.status,
          writable: recordResult.writable,
          written: recordResult.written,
          code: recordResult.error?.code ?? null,
          message:
            `[PAIR SPREAD] probe commit refused status=${recordResult.status} ` +
            `code=${recordResult.error?.code ?? "n/a"}. Probes keep their current state.`,
        });
      }
    }
  }

  if (pairSpread.mode !== "off") {
    logPairSpreadEvent({
      event: "pair_spread_summary",
      level: "info",
      mode: pairSpread.mode,
      configuredPairs: configuredPairs.length,
      filteredPairs,
      wouldFilterPairs,
      message:
        `[PAIR SPREAD] summary mode=${pairSpread.mode} configured=${configuredPairs.length} ` +
        `filtered=${filteredPairs} wouldFilter=${wouldFilterPairs}`,
    });
  }

  if (rpcErrors > config.maxRpcErrorsPerScan) {
    console.warn(`[RPC ERRORS] ${rpcErrors} erreurs sur ce cycle.`);
  }

  // D13: a cycle where every configured pair was deliberately filtered by enforce is a
  // successful no-op, not a failed scan. Any independent pair error keeps exit code 1.
  const allPairsFiltered =
    pairSpread.mode === "enforce" &&
    configuredPairs.length > 0 &&
    filteredPairs === configuredPairs.length &&
    pairErrors === 0;
  const exitCode =
    rpcErrors > config.maxRpcErrorsPerScan || (scanned === 0 && !allPairsFiltered) ? 1 : 0;

  const filteredSuffix =
    pairSpread.mode !== "off" ? `, ${filteredPairs} pair(s) filtered by pair spread` : "";
  console.log(
    `\nDone: ${scanned} quotes checked, ${opportunities} opportunit${opportunities === 1 ? "y" : "ies"} found, ` +
      `${executed} transaction attempt(s)${filteredSuffix}.`
  );

  try {
    await recordRpcCycle({
      filePath: config.rpcErrorsPath || DEFAULT_RPC_ERRORS_PATH,
      errors: rpcErrors,
      total: scanned,
      windowSize: config.rpcErrorRateWindowSize ?? 10,
    });
  } catch (err) {
    console.warn(`[RPC ERRORS] could not persist RPC cycle: ${err.message}`);
  }

  try {
    const latestGasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
    if (latestGasPriceWei && latestGasPriceWei > 0n) {
      await recordGasSample({
        filePath: config.gasHistoryPath || DEFAULT_GAS_HISTORY_PATH,
        gasPriceWei: latestGasPriceWei,
        windowSize: config.gasAnomalyWindowSize ?? 20,
      });
    }
  } catch (err) {
    console.warn(`[GAS ANOMALY] could not persist gas sample: ${err.message}`);
  }

  return {
    ethUsdPrice,
    aaveFlashLoanPremiumBps,
    scanned,
    opportunities,
    executed,
    filteredPairs,
    wouldFilterPairs,
    exitCode,
  };
}

if (require.main === module) {
  main()
    .then((summary) => process.exit(summary.exitCode ?? (summary.refused ? 1 : 0)))
    .catch((err) => {
      console.error("flash-arb-bot scan failed:", err);
      process.exit(1);
    });
}

module.exports = { main, readAaveFlashLoanPremium };
