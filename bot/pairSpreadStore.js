// Persistence for the P1-16-bis pair-spread filter history.
// See docs/adr/0006-pair-spread-filter.md (D1, D6, D14). This module only
// reads and writes logs/pair_spreads.json; bot/index.js wires it per cycle.

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const {
  DEFAULT_WINDOW_SIZE,
  DEFAULT_MAX_AGE_MS,
  selectWindowSamples,
} = require("./pairSpread");

const LOG_DIR = path.resolve(__dirname, "..", "logs");
const DEFAULT_PAIR_SPREADS_PATH = path.join(LOG_DIR, "pair_spreads.json");
const PAIR_SPREAD_STORE_VERSION = 1;

const MIN_WINDOW_SIZE = 5;
const MAX_WINDOW_SIZE = 100;
const MAX_MAX_AGE_MS = 168 * 60 * 60 * 1000;
const DECIMAL_BPS_PATTERN = /^-?\d+$/;

const PAIR_SPREAD_STORE_CODES = Object.freeze({
  MISSING: "PAIR_SPREAD_STATE_MISSING",
  CORRUPT: "PAIR_SPREAD_STATE_CORRUPT",
  SCHEMA_INVALID: "PAIR_SPREAD_STATE_SCHEMA_INVALID",
  UNREADABLE: "PAIR_SPREAD_STATE_UNREADABLE",
  WRITE_FAILED: "PAIR_SPREAD_STATE_WRITE_FAILED",
});
const STORE_CODES = new Set(Object.values(PAIR_SPREAD_STORE_CODES));

class PairSpreadStoreError extends Error {
  constructor(code, filePath, detail, { cause = null, reason = null } = {}) {
    const suffix = detail ? `: ${detail}` : "";
    super(`${code}: ${filePath}${suffix}`);
    this.name = "PairSpreadStoreError";
    this.code = code;
    this.path = filePath;
    this.reason = reason;
    if (cause !== null) this.cause = cause;
  }
}

function isPairSpreadStoreError(err) {
  return err instanceof PairSpreadStoreError || STORE_CODES.has(err?.code);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function schemaError(filePath, detail, reason = "schema_invalid") {
  return new PairSpreadStoreError(
    PAIR_SPREAD_STORE_CODES.SCHEMA_INVALID,
    filePath,
    detail,
    { reason }
  );
}

/// D1: PAIR_SPREAD_PATH is the operator override, aligned with bot/config.js
/// (ADR 0006, "Intégration dans le bot"). The default stays anchored on the
/// module so the file lives next to the other bot states.
function resolvePairSpreadPath(env = process.env) {
  const override = env?.PAIR_SPREAD_PATH;
  if (typeof override === "string" && override.trim() !== "") {
    return path.resolve(override.trim());
  }
  return DEFAULT_PAIR_SPREADS_PATH;
}

function createEmptyPairSpreadState() {
  return { version: PAIR_SPREAD_STORE_VERSION, pairs: {} };
}

function validateFilePath(filePath) {
  if (typeof filePath !== "string" || filePath.trim() === "") {
    throw new TypeError("filePath must be a non-empty string");
  }
  return filePath;
}

function validateNow(now) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("now must be a non-negative safe integer");
  }
  return now;
}

function validateWindowSize(windowSize) {
  if (
    !Number.isInteger(windowSize) ||
    windowSize < MIN_WINDOW_SIZE ||
    windowSize > MAX_WINDOW_SIZE
  ) {
    throw new RangeError(
      `windowSize must be an integer between ${MIN_WINDOW_SIZE} and ${MAX_WINDOW_SIZE}`
    );
  }
  return windowSize;
}

function validateMaxAgeMs(maxAgeMs) {
  if (
    typeof maxAgeMs !== "number" ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    maxAgeMs > MAX_MAX_AGE_MS
  ) {
    throw new RangeError(`maxAgeMs must be a finite number in (0, ${MAX_MAX_AGE_MS}]`);
  }
  return maxAgeMs;
}

/// D1: logging is best-effort. A null/undefined/empty message is never passed
/// to the callback, and an exception thrown by the callback is swallowed so a
/// logging failure can never turn a successful load or write into a failure.
/// Callers must rely on the returned result, not on the callback, for control
/// flow.
function emitWarning(warn, message) {
  if (typeof warn !== "function") return;
  if (typeof message !== "string" || message.trim() === "") return;
  try {
    warn(message);
  } catch {
    // The warning is advisory; the persistence result remains authoritative.
  }
}

function parseStoredSample(entry, index, { filePath, label }) {
  if (!isPlainObject(entry)) {
    throw schemaError(filePath, `${label}[${index}] must be an object`);
  }
  if (
    typeof entry.netProfitBps !== "string" ||
    !DECIMAL_BPS_PATTERN.test(entry.netProfitBps)
  ) {
    throw schemaError(
      filePath,
      `${label}[${index}].netProfitBps must be a signed decimal string`
    );
  }
  if (!Number.isSafeInteger(entry.at) || entry.at < 0) {
    throw schemaError(
      filePath,
      `${label}[${index}].at must be a non-negative safe integer`
    );
  }
  return {
    netProfitBps: entry.netProfitBps,
    at: entry.at,
    value: BigInt(entry.netProfitBps),
  };
}

/// Validates every stored sample, drops expired and future entries, dedupes
/// samples sharing the same `at` (D8: one sample per cycle), then applies the
/// D1/D3 window. The returned samples are canonical signed decimal strings.
function normalizeSamples(
  samples,
  { filePath, now, windowSize, maxAgeMs, label = "samples" }
) {
  if (!Array.isArray(samples)) {
    throw schemaError(filePath, `${label} must be an array`);
  }

  const oldestAllowed = now - maxAgeMs;
  const byAt = new Map();
  let expiredPruned = 0;
  let futurePruned = 0;

  for (let index = 0; index < samples.length; index += 1) {
    const parsed = parseStoredSample(samples[index], index, { filePath, label });
    if (parsed.at < oldestAllowed) {
      expiredPruned += 1;
      continue;
    }
    if (parsed.at > now) {
      futurePruned += 1;
      continue;
    }
    const existing = byAt.get(parsed.at);
    if (!existing || parsed.value > existing.value) {
      byAt.set(parsed.at, parsed);
    }
  }

  const validCount = samples.length - expiredPruned - futurePruned;
  const duplicatesRemoved = validCount - byAt.size;
  const deduped = Array.from(byAt.values())
    .sort((a, b) => a.at - b.at)
    .map(({ netProfitBps, at }) => ({ netProfitBps, at }));

  const selected = selectWindowSamples({
    samples: deduped,
    now,
    windowSize,
    maxAgeMs,
  });

  return {
    samples: selected.map((sample) => ({
      netProfitBps: sample.netProfitBps.toString(),
      at: sample.at,
    })),
    expiredPruned,
    futurePruned,
    duplicatesRemoved,
    truncated: deduped.length - selected.length,
  };
}

/// D1 schema validation. Unknown fields are ignored; any structural violation
/// throws a PairSpreadStoreError so the caller can fail open without writing.
function parsePairSpreadDocument(parsed, { filePath, now, windowSize, maxAgeMs }) {
  if (!isPlainObject(parsed)) {
    throw schemaError(filePath, "root must be an object");
  }
  if (parsed.version !== PAIR_SPREAD_STORE_VERSION) {
    throw schemaError(
      filePath,
      `unsupported version: ${String(parsed.version)}`,
      "unsupported_version"
    );
  }
  if (!isPlainObject(parsed.pairs)) {
    throw schemaError(filePath, "pairs must be an object");
  }

  const pairs = new Map();
  const counts = {
    expiredPruned: 0,
    futurePruned: 0,
    duplicatesRemoved: 0,
    truncated: 0,
    emptyEntries: 0,
  };

  for (const key of Object.keys(parsed.pairs)) {
    const entry = parsed.pairs[key];
    if (!isPlainObject(entry)) {
      throw schemaError(filePath, `pairs[${JSON.stringify(key)}] must be an object`);
    }
    if (!Array.isArray(entry.samples)) {
      throw schemaError(
        filePath,
        `pairs[${JSON.stringify(key)}].samples must be an array`
      );
    }
    const normalized = normalizeSamples(entry.samples, {
      filePath,
      now,
      windowSize,
      maxAgeMs,
      label: `pairs[${JSON.stringify(key)}].samples`,
    });
    counts.expiredPruned += normalized.expiredPruned;
    counts.futurePruned += normalized.futurePruned;
    counts.duplicatesRemoved += normalized.duplicatesRemoved;
    counts.truncated += normalized.truncated;
    if (normalized.samples.length === 0) {
      counts.emptyEntries += 1;
      continue;
    }
    pairs.set(key, { samples: normalized.samples });
  }

  return {
    state: {
      version: PAIR_SPREAD_STORE_VERSION,
      pairs: Object.fromEntries(pairs),
    },
    ...counts,
  };
}

function failedLoadResult(status, error) {
  return {
    ok: false,
    status,
    writable: false,
    state: createEmptyPairSpreadState(),
    expiredPruned: 0,
    futurePruned: 0,
    duplicatesRemoved: 0,
    truncated: 0,
    emptyEntries: 0,
    warning: error.message,
    error,
  };
}

/// Reads the state once per cycle. A missing file is a valid empty history.
/// Corrupt, unreadable and unknown-version files fail open with writable:false
/// so callers can never overwrite the evidence (D6).
async function loadPairSpreadState({
  filePath = resolvePairSpreadPath(),
  now = Date.now(),
  windowSize = DEFAULT_WINDOW_SIZE,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  warn,
} = {}) {
  validateFilePath(filePath);
  validateNow(now);
  validateWindowSize(windowSize);
  validateMaxAgeMs(maxAgeMs);

  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      const warning = `${PAIR_SPREAD_STORE_CODES.MISSING}: ${filePath}`;
      emitWarning(warn, warning);
      return {
        ok: true,
        status: "absent",
        writable: true,
        state: createEmptyPairSpreadState(),
        expiredPruned: 0,
        futurePruned: 0,
        duplicatesRemoved: 0,
        truncated: 0,
        emptyEntries: 0,
        warning,
        error: null,
      };
    }
    const error = new PairSpreadStoreError(
      PAIR_SPREAD_STORE_CODES.UNREADABLE,
      filePath,
      err.message,
      { cause: err, reason: "unreadable" }
    );
    emitWarning(warn, error.message);
    return failedLoadResult("unreadable", error);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const error = new PairSpreadStoreError(
      PAIR_SPREAD_STORE_CODES.CORRUPT,
      filePath,
      "invalid JSON",
      { cause: err, reason: "corrupt" }
    );
    emitWarning(warn, error.message);
    return failedLoadResult("corrupt", error);
  }

  try {
    const normalized = parsePairSpreadDocument(parsed, {
      filePath,
      now,
      windowSize,
      maxAgeMs,
    });
    return {
      ok: true,
      status: "ok",
      writable: true,
      state: normalized.state,
      expiredPruned: normalized.expiredPruned,
      futurePruned: normalized.futurePruned,
      duplicatesRemoved: normalized.duplicatesRemoved,
      truncated: normalized.truncated,
      emptyEntries: normalized.emptyEntries,
      warning: null,
      error: null,
    };
  } catch (err) {
    if (!isPairSpreadStoreError(err)) throw err;
    const status = err.reason || "schema_invalid";
    emitWarning(warn, err.message);
    return failedLoadResult(status, err);
  }
}

function samplesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index].at !== b[index].at) return false;
    if (a[index].netProfitBps !== b[index].netProfitBps) return false;
  }
  return true;
}

function statesEqual(a, b) {
  const aKeys = Object.keys(a.pairs);
  const bKeys = Object.keys(b.pairs);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b.pairs, key)) return false;
    if (!samplesEqual(a.pairs[key].samples, b.pairs[key].samples)) return false;
  }
  return true;
}

function parseIncomingSample(sample, index, now) {
  if (!isPlainObject(sample)) {
    throw new TypeError(`samples[${index}] must be an object`);
  }
  if (typeof sample.key !== "string" || sample.key.length === 0) {
    throw new TypeError(`samples[${index}].key must be a non-empty string`);
  }

  let value;
  let netProfitBps;
  if (typeof sample.netProfitBps === "bigint") {
    value = sample.netProfitBps;
    netProfitBps = sample.netProfitBps.toString();
  } else if (
    typeof sample.netProfitBps === "string" &&
    DECIMAL_BPS_PATTERN.test(sample.netProfitBps)
  ) {
    value = BigInt(sample.netProfitBps);
    netProfitBps = sample.netProfitBps;
  } else {
    throw new TypeError(
      `samples[${index}].netProfitBps must be a bigint or a signed decimal string`
    );
  }

  const at = sample.at === undefined ? now : sample.at;
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new RangeError(`samples[${index}].at must be a non-negative safe integer`);
  }
  if (at > now) {
    throw new RangeError(`samples[${index}].at must not be in the future`);
  }

  return { key: sample.key, netProfitBps, at, value };
}

/// D8: one sample per stable key per cycle (`at`). Duplicate (key, at) pairs
/// keep the best netProfitBps, while distinct timestamps for the same key are
/// all retained. The input state is never mutated.
function appendPairSpreadSamples({
  state,
  samples,
  now = Date.now(),
  windowSize = DEFAULT_WINDOW_SIZE,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  validateNow(now);
  validateWindowSize(windowSize);
  validateMaxAgeMs(maxAgeMs);
  if (!Array.isArray(samples)) {
    throw new TypeError("samples must be an array");
  }

  const before = parsePairSpreadDocument(state, {
    filePath: "<memory>",
    now,
    windowSize,
    maxAgeMs,
  }).state;
  const pairs = new Map();
  for (const key of Object.keys(before.pairs)) {
    pairs.set(key, {
      samples: before.pairs[key].samples.map((sample) => ({ ...sample })),
    });
  }

  const incomingByKey = new Map();
  for (let index = 0; index < samples.length; index += 1) {
    const parsed = parseIncomingSample(samples[index], index, now);
    let byAt = incomingByKey.get(parsed.key);
    if (!byAt) {
      byAt = new Map();
      incomingByKey.set(parsed.key, byAt);
    }
    const existing = byAt.get(parsed.at);
    if (!existing || parsed.value > existing.value) {
      byAt.set(parsed.at, parsed);
    }
  }

  let added = 0;
  for (const [key, byAt] of incomingByKey) {
    const beforeSamples = pairs.get(key)?.samples ?? [];
    const beforeAts = new Set(beforeSamples.map((entry) => entry.at));
    const merged = [...beforeSamples];
    for (const sample of byAt.values()) {
      merged.push({ netProfitBps: sample.netProfitBps, at: sample.at });
    }
    const normalized = normalizeSamples(merged, {
      filePath: "<memory>",
      now,
      windowSize,
      maxAgeMs,
      label: `pairs[${JSON.stringify(key)}].samples`,
    });
    // D8/D4: `added` counts only a genuinely new timestamp that survives the
    // window. A best-value replacement at an existing `at` is a change, not an
    // addition, and is reported by `changed` below.
    for (const entry of normalized.samples) {
      if (byAt.has(entry.at) && !beforeAts.has(entry.at)) {
        added += 1;
      }
    }
    if (normalized.samples.length > 0) {
      pairs.set(key, { samples: normalized.samples });
    } else {
      pairs.delete(key);
    }
  }

  const after = {
    version: PAIR_SPREAD_STORE_VERSION,
    pairs: Object.fromEntries(pairs),
  };
  return {
    state: after,
    added,
    // D4: compare with the caller's state, not with the already-normalized
    // `before` snapshot, so pruning an expired or empty pair is a change.
    changed: !statesEqual(state, after),
  };
}

function sortPairs(state) {
  const pairs = new Map();
  for (const key of Object.keys(state.pairs).sort()) {
    pairs.set(key, { samples: state.pairs[key].samples });
  }
  return {
    version: PAIR_SPREAD_STORE_VERSION,
    pairs: Object.fromEntries(pairs),
  };
}

/// D14 atomic write: mkdir, `${filePath}.${pid}.${uuid}.tmp`, write, fsync,
/// close, rename. The unique suffix lets concurrent writes in the same process
/// use distinct temp files; the temp file stays in the target directory so the
/// rename remains atomic. A failure is returned as a warning, never thrown, and
/// only the temp file created by this call is removed.
///
/// D6 guard: an existing corrupt, unreadable, invalid or unknown-version file
/// is never replaced. The check is a read-before-write; it does not make two
/// concurrent read-modify-write cycles merge their updates (last writer wins,
/// see ADR 0006 D14).
async function writePairSpreadState({
  filePath = resolvePairSpreadPath(),
  state,
  now = Date.now(),
  windowSize = DEFAULT_WINDOW_SIZE,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  warn,
} = {}) {
  validateFilePath(filePath);
  validateNow(now);
  validateWindowSize(windowSize);
  validateMaxAgeMs(maxAgeMs);

  const normalized = parsePairSpreadDocument(state, {
    filePath,
    now,
    windowSize,
    maxAgeMs,
  });
  const canonicalState = sortPairs(normalized.state);
  const payload = `${JSON.stringify(canonicalState, null, 2)}\n`;

  // D6: never silently overwrite evidence of a corrupt or incompatible state.
  const existing = await loadPairSpreadState({
    filePath,
    now,
    windowSize,
    maxAgeMs,
  });
  if (!existing.writable) {
    emitWarning(warn, existing.warning);
    return {
      ok: false,
      status: existing.status,
      writable: false,
      written: false,
      state: canonicalState,
      warning: existing.warning,
      error: existing.error,
    };
  }

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let ownsTmp = false;

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    // "wx" guarantees we only own a temp file we created; an existing file at
    // this path is never truncated or removed by this call.
    const fh = await fs.open(tmpPath, "wx");
    ownsTmp = true;
    try {
      await fh.writeFile(payload, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmpPath, filePath);
    ownsTmp = false;
    return {
      ok: true,
      status: existing.status,
      writable: true,
      written: true,
      state: canonicalState,
      warning: null,
      error: null,
    };
  } catch (err) {
    if (ownsTmp) {
      try {
        await fs.rm(tmpPath, { force: true });
      } catch {
        // Best effort: the original failure is the one worth reporting.
      }
    }
    const error = new PairSpreadStoreError(
      PAIR_SPREAD_STORE_CODES.WRITE_FAILED,
      filePath,
      err.message,
      { cause: err, reason: "write_failed" }
    );
    emitWarning(warn, error.message);
    return {
      ok: false,
      status: existing.status,
      writable: true,
      written: false,
      state: canonicalState,
      warning: error.message,
      error,
    };
  }
}

/// Safe write path for a cycle. It loads once (or reuses a prior load), refuses
/// to write when the state is corrupt/unreadable/unknown-version, and writes
/// only when the appended state differs or an expired sample was pruned (D14).
async function recordPairSpreadSamples({
  filePath = resolvePairSpreadPath(),
  loaded = null,
  samples = [],
  now = Date.now(),
  windowSize = DEFAULT_WINDOW_SIZE,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  warn,
} = {}) {
  validateFilePath(filePath);
  validateNow(now);
  validateWindowSize(windowSize);
  validateMaxAgeMs(maxAgeMs);

  const ownsLoad = loaded === null;
  const loadResult =
    loaded ??
    (await loadPairSpreadState({ filePath, now, windowSize, maxAgeMs }));

  if (!loadResult.writable) {
    if (ownsLoad) emitWarning(warn, loadResult.warning);
    return {
      ok: false,
      status: loadResult.status,
      writable: false,
      state: loadResult.state,
      written: false,
      added: 0,
      expiredPruned: loadResult.expiredPruned,
      warning: loadResult.warning,
      error: loadResult.error,
    };
  }

  const appended = appendPairSpreadSamples({
    state: loadResult.state,
    samples,
    now,
    windowSize,
    maxAgeMs,
  });

  if (!appended.changed && loadResult.expiredPruned === 0) {
    if (ownsLoad) emitWarning(warn, loadResult.warning);
    return {
      ok: true,
      status: loadResult.status,
      writable: true,
      state: appended.state,
      written: false,
      added: 0,
      expiredPruned: 0,
      warning: loadResult.warning,
      error: null,
    };
  }

  const writeResult = await writePairSpreadState({
    filePath,
    state: appended.state,
    now,
    windowSize,
    maxAgeMs,
    warn,
  });

  // writePairSpreadState already emitted its warning on failure. On success,
  // emit the load warning (for example PAIR_SPREAD_STATE_MISSING) at most once.
  if (ownsLoad && writeResult.ok) emitWarning(warn, loadResult.warning);

  return {
    ok: writeResult.ok,
    status: writeResult.status ?? loadResult.status,
    writable: writeResult.writable,
    state: writeResult.state,
    written: writeResult.written,
    added: appended.added,
    expiredPruned: loadResult.expiredPruned,
    warning: writeResult.warning ?? loadResult.warning,
    error: writeResult.error,
  };
}

module.exports = {
  DEFAULT_PAIR_SPREADS_PATH,
  PAIR_SPREAD_STORE_VERSION,
  PAIR_SPREAD_STORE_CODES,
  PairSpreadStoreError,
  isPairSpreadStoreError,
  resolvePairSpreadPath,
  createEmptyPairSpreadState,
  loadPairSpreadState,
  appendPairSpreadSamples,
  writePairSpreadState,
  recordPairSpreadSamples,
};
