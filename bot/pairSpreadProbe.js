// Pure Pair Spread probe scheduler.
// Implements decisions D3, D8 and D13 of docs/adr/0007-pair-spread-probes.md.
// A probe refreshes the spread history of a pair without changing the main scan
// loop. This module performs no I/O, reads no environment, uses no clock and
// never calls scanPair or a provider. The filter that consumes the samples is
// bot/pairSpread.js.

const DEFAULT_PROBE_INTERVAL_MS = 0;
const DEFAULT_PROBE_MAX_PER_CYCLE = 1;
const MAX_PROBE_PER_CYCLE = 10;
const PROBE_OUTCOMES = new Set(["success", "empty", "failure"]);
const PROBE_SOURCES = new Set(["scan", "probe"]);
// Attempt reasons are stable codes, as in bot/pairSpreadStore.js; free-form
// text is rejected so a pending attempt can be committed unchanged.
const PROBE_REASON_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireDefined(value, label) {
  if (value === undefined) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function validateNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function validateProbeIntervalMs(intervalMs, label = "intervalMs") {
  return validateNonNegativeInteger(intervalMs, label);
}

function validateProbeMaxPerCycle(maxPerCycle, label = "maxPerCycle") {
  if (
    !Number.isSafeInteger(maxPerCycle) ||
    maxPerCycle < 1 ||
    maxPerCycle > MAX_PROBE_PER_CYCLE
  ) {
    throw new RangeError(
      `${label} must be an integer >= 1 and <= ${MAX_PROBE_PER_CYCLE}`
    );
  }
  return maxPerCycle;
}

function validateKey(key, label = "key") {
  if (typeof key !== "string" || key.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return key;
}

function validateSampleAt(at, label = "at") {
  return validateNonNegativeInteger(at, label);
}

function validateAttemptAt(at, label = "at") {
  if (!Number.isSafeInteger(at) || at < 1) {
    throw new RangeError(`${label} must be a positive integer`);
  }
  return at;
}

function validateClock(value, label) {
  return validateNonNegativeInteger(value, label);
}

function validateCursorKey(cursorKey) {
  if (cursorKey === null) return null;
  if (typeof cursorKey !== "string" || cursorKey.length === 0) {
    throw new TypeError("cursorKey must be a non-empty string or null");
  }
  return cursorKey;
}

function validateLastGlobalProbeAt(lastGlobalProbeAt) {
  if (lastGlobalProbeAt === null) return null;
  return validateNonNegativeInteger(lastGlobalProbeAt, "lastGlobalProbeAt");
}

function validateKeySet(value, label) {
  if (value === undefined) return new Set();
  if (!(value instanceof Set)) {
    throw new TypeError(`${label} must be a Set`);
  }
  for (const key of value) {
    validateKey(key, `${label} entries`);
  }
  return value;
}

function validatePendingAttempts(pendingAttempts) {
  if (pendingAttempts === undefined) return new Map();
  if (!(pendingAttempts instanceof Map)) {
    throw new TypeError("pendingAttempts must be a Map");
  }
  for (const [mapKey, entry] of pendingAttempts) {
    const label = `pendingAttempts[${JSON.stringify(mapKey)}]`;
    validateKey(mapKey, "pendingAttempts key");
    if (!isPlainObject(entry)) {
      throw new TypeError(`${label} must be an object`);
    }
    if (entry.key !== mapKey) {
      throw new TypeError(`${label}.key must equal the map key`);
    }
    validateAttemptAt(entry.at, `${label}.at`);
    if (!PROBE_OUTCOMES.has(entry.outcome)) {
      throw new TypeError(
        `${label}.outcome must be one of ${Array.from(PROBE_OUTCOMES).join(", ")}`
      );
    }
    if (!PROBE_SOURCES.has(entry.source)) {
      throw new TypeError(
        `${label}.source must be one of ${Array.from(PROBE_SOURCES).join(", ")}`
      );
    }
    if (entry.reason !== undefined) {
      if (
        typeof entry.reason !== "string" ||
        !PROBE_REASON_PATTERN.test(entry.reason)
      ) {
        throw new TypeError(`${label}.reason must be a short uppercase code`);
      }
    }
  }
  return pendingAttempts;
}

function validateHistory(history) {
  requireDefined(history, "history");
  if (!(history instanceof Map)) {
    throw new TypeError("history must be a Map");
  }
  for (const [key, at] of history) {
    validateKey(key, "history key");
    validateNonNegativeInteger(at, `history[${JSON.stringify(key)}]`);
  }
  return history;
}

/// D3 steps 3-4: ignores entries without a stable non-empty key, validates the
/// pair of every retained key, then deduplicates by key keeping the first
/// occurrence.
function collectCandidates(candidates) {
  requireDefined(candidates, "candidates");
  if (!Array.isArray(candidates)) {
    throw new TypeError("candidates must be an array");
  }
  const unique = new Map();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!isPlainObject(candidate)) {
      throw new TypeError(`candidates[${index}] must be an object`);
    }
    const key = candidate.key;
    if (typeof key !== "string" || key.length === 0) continue;
    if (!isPlainObject(candidate.pair)) {
      throw new TypeError(`candidates[${index}].pair must be an object`);
    }
    if (!unique.has(key)) unique.set(key, candidate);
  }
  return unique;
}

/// D8: seeds the persisted rotation history from a Store v2 state. For each
/// key, the latest timestamp across `samples[].at` and `attempts[].at` wins.
/// Pairs with only attempts or only samples are included; pairs with neither
/// are omitted. Missing arrays are treated as empty (v1 and v2 tolerance).
/// Future timestamps are kept here and excluded later by the scheduler.
/// `pendingAttempts` is not accepted and not applied: the scheduler overlays
/// it. The input state is never mutated.
function initProbeHistoryFromState(state = {}) {
  if (!isPlainObject(state)) {
    throw new TypeError("state must be an object");
  }
  const pairs = state.pairs === undefined ? {} : state.pairs;
  if (!isPlainObject(pairs)) {
    throw new TypeError("state.pairs must be an object");
  }

  const history = new Map();
  for (const key of Object.keys(pairs)) {
    validateKey(key, "state.pairs key");
    const entry = pairs[key];
    const label = `state.pairs[${JSON.stringify(key)}]`;
    if (!isPlainObject(entry)) {
      throw new TypeError(`${label} must be an object`);
    }

    const samples = entry.samples === undefined ? [] : entry.samples;
    if (!Array.isArray(samples)) {
      throw new TypeError(`${label}.samples must be an array`);
    }
    const attempts = entry.attempts === undefined ? [] : entry.attempts;
    if (!Array.isArray(attempts)) {
      throw new TypeError(`${label}.attempts must be an array`);
    }

    let lastAt = null;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!isPlainObject(sample)) {
        throw new TypeError(`${label}.samples[${index}] must be an object`);
      }
      const at = validateSampleAt(sample.at, `${label}.samples[${index}].at`);
      if (lastAt === null || at > lastAt) lastAt = at;
    }
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index];
      if (!isPlainObject(attempt)) {
        throw new TypeError(`${label}.attempts[${index}] must be an object`);
      }
      const at = validateAttemptAt(attempt.at, `${label}.attempts[${index}].at`);
      if (lastAt === null || at > lastAt) lastAt = at;
    }
    if (lastAt !== null) history.set(key, lastAt);
  }
  return history;
}

/// D3/D7/D8: selects at most `maxPerCycle` probe candidates.
///
/// Required parameters: candidates, history, pairSpreadNow, probeNow,
/// intervalMs, globalIntervalMs, lastGlobalProbeAt, suspendedUntil,
/// maxPerCycle, cursorKey. Optional parameters: scannedKeys, probedKeys,
/// pendingAttempts.
///
/// Order (D3): suspension, probes-disabled, global throttle, candidate key
/// filter/dedup, eligibility on `pairSpreadNow`, lexicographic sort, circular
/// traversal from the key after `cursorKey` (or the first key), stop after
/// `maxPerCycle` selections. `nextCursorKey` is the last examined key.
///
/// Return: `{ selected: [{ key, pair, lastAt }], nextCursorKey }`. The array
/// and its entries are new; `pair` keeps the first candidate's reference. No
/// input is mutated.
function selectProbeCandidates(contract = {}) {
  if (!isPlainObject(contract)) {
    throw new TypeError("contract must be an object");
  }

  const unique = collectCandidates(contract.candidates);
  const history = validateHistory(contract.history);
  const pairSpreadNow = validateClock(
    requireDefined(contract.pairSpreadNow, "pairSpreadNow"),
    "pairSpreadNow"
  );
  const probeNow = validateClock(
    requireDefined(contract.probeNow, "probeNow"),
    "probeNow"
  );
  const intervalMs = validateProbeIntervalMs(
    requireDefined(contract.intervalMs, "intervalMs")
  );
  const globalIntervalMs = validateNonNegativeInteger(
    requireDefined(contract.globalIntervalMs, "globalIntervalMs"),
    "globalIntervalMs"
  );
  const lastGlobalProbeAt = validateLastGlobalProbeAt(
    requireDefined(contract.lastGlobalProbeAt, "lastGlobalProbeAt")
  );
  const suspendedUntil = validateNonNegativeInteger(
    requireDefined(contract.suspendedUntil, "suspendedUntil"),
    "suspendedUntil"
  );
  const maxPerCycle = validateProbeMaxPerCycle(
    requireDefined(contract.maxPerCycle, "maxPerCycle")
  );
  const cursorKey = validateCursorKey(
    requireDefined(contract.cursorKey, "cursorKey")
  );
  const scannedKeys = validateKeySet(contract.scannedKeys, "scannedKeys");
  const probedKeys = validateKeySet(contract.probedKeys, "probedKeys");
  const pendingAttempts = validatePendingAttempts(contract.pendingAttempts);

  const emptyResult = () => ({ selected: [], nextCursorKey: cursorKey });

  // D15: suspension is checked before the global throttle and the per-pair
  // interval. It consumes no slot and does not move the cursor.
  if (probeNow < suspendedUntil) return emptyResult();
  // D7: intervalMs = 0 disables probes; the other settings stay validated but
  // are inert at execution time.
  if (intervalMs === 0) return emptyResult();
  // D7: the global throttle measures real process time, never pairSpreadNow.
  if (
    globalIntervalMs > 0 &&
    lastGlobalProbeAt !== null &&
    probeNow - lastGlobalProbeAt < globalIntervalMs
  ) {
    return emptyResult();
  }

  const keys = Array.from(unique.keys()).sort();
  if (keys.length === 0) return emptyResult();

  const lastAtByKey = new Map();
  const eligibleByKey = new Map();
  for (const key of keys) {
    const persistedAt = history.has(key) ? history.get(key) : -1;
    const pending = pendingAttempts.get(key);
    const pendingAt = pending === undefined ? -1 : pending.at;
    // D8 overlay: the maximum wins; -1 means "never observed".
    const lastAt = Math.max(persistedAt, pendingAt);
    lastAtByKey.set(key, lastAt);

    let eligible = true;
    if (lastAt !== -1) {
      // D3 step 5: future timestamps and the per-pair interval use the
      // persisted timeline (pairSpreadNow), not the process clock (probeNow).
      if (lastAt > pairSpreadNow) eligible = false;
      else if (pairSpreadNow - lastAt < intervalMs) eligible = false;
    }
    // D5: a key already scanned or started in this cycle is examined but
    // cannot be selected.
    if (scannedKeys.has(key) || probedKeys.has(key)) eligible = false;
    eligibleByKey.set(key, eligible);
  }

  let startIndex = 0;
  if (cursorKey !== null) {
    const cursorIndex = keys.indexOf(cursorKey);
    if (cursorIndex !== -1) startIndex = (cursorIndex + 1) % keys.length;
  }

  const selected = [];
  let nextCursorKey = cursorKey;
  for (let offset = 0; offset < keys.length; offset += 1) {
    const key = keys[(startIndex + offset) % keys.length];
    nextCursorKey = key;
    if (!eligibleByKey.get(key)) continue;
    selected.push({
      key,
      pair: unique.get(key).pair,
      lastAt: lastAtByKey.get(key),
    });
    if (selected.length === maxPerCycle) break;
  }

  return { selected, nextCursorKey };
}

/// Records one probe attempt, successful or failed, at `at`. The returned Map
/// is new; the input history is not mutated. The caller must invoke this in a
/// `finally` block after each attempt so a failure still advances the rotation.
/// An attempt timestamp is a positive safe integer (Store v2 rule). An older
/// timestamp never moves an existing attempt backwards.
function recordProbeAttempt({ history = new Map(), key, at } = {}) {
  if (!(history instanceof Map)) {
    throw new TypeError("history must be a Map");
  }
  const validKey = validateKey(key);
  const validAt = validateAttemptAt(at);
  const existing = history.get(validKey);
  if (existing !== undefined) {
    validateNonNegativeInteger(existing, `history[${JSON.stringify(validKey)}]`);
  }
  const next = new Map(history);
  if (existing === undefined || validAt > existing) {
    next.set(validKey, validAt);
  }
  return next;
}

module.exports = {
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_MAX_PER_CYCLE,
  validateProbeIntervalMs,
  validateProbeMaxPerCycle,
  initProbeHistoryFromState,
  selectProbeCandidates,
  recordProbeAttempt,
};
