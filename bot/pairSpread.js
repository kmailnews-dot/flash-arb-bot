// Pure pair-spread filter primitives for P1-16-bis.
// See docs/adr/0006-pair-spread-filter.md. This module performs no I/O and reads no environment.

const PAIR_SPREAD_MODES = Object.freeze(["off", "shadow", "enforce"]);
const MODE_SET = new Set(PAIR_SPREAD_MODES);
const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MIN_WINDOW_SIZE = 5;
const MAX_WINDOW_SIZE = 100;
const MAX_MAX_AGE_MS = 168 * 60 * 60 * 1000;
const MAX_FLOOR_BPS = 10000;
const DECIMAL_BPS_PATTERN = /^-?\d+$/;
const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;

class PairSpreadSamplesError extends Error {
  constructor(message) {
    super(`PAIR_SPREAD_SAMPLES_INVALID: ${message}`);
    this.name = "PairSpreadSamplesError";
    this.code = "PAIR_SPREAD_SAMPLES_INVALID";
  }
}

function isPairSpreadSamplesError(err) {
  return err instanceof PairSpreadSamplesError || err?.code === "PAIR_SPREAD_SAMPLES_INVALID";
}

function normalizeMode(mode = "off") {
  if (typeof mode !== "string") {
    throw new TypeError("pair spread filter mode must be a string");
  }
  const normalized = mode.trim().toLowerCase();
  if (!MODE_SET.has(normalized)) {
    throw new Error(
      `Invalid pair spread filter mode: ${mode}. Expected off, shadow or enforce.`
    );
  }
  return normalized;
}

function normalizeAddress(value, field) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`buildPairKey: ${field} must be a 20-byte hex address`);
  }
  return value.toLowerCase();
}

function tokenAddress(token, field) {
  if (!token || typeof token !== "object" || Array.isArray(token)) {
    throw new Error(`buildPairKey: ${field} must be an object with an address`);
  }
  return normalizeAddress(token.address, `${field}.address`);
}

function normalizeLeg(leg, field) {
  if (!leg || typeof leg !== "object" || Array.isArray(leg)) {
    throw new Error(`buildPairKey: ${field} must be an object`);
  }
  if (leg.kind !== "V2" && leg.kind !== "V3") {
    throw new Error(`buildPairKey: ${field}.kind must be "V2" or "V3"`);
  }
  const router = normalizeAddress(leg.router, `${field}.router`);
  if (leg.kind === "V2") {
    return { kind: "V2", router, v3Fee: "", quoter: "" };
  }
  if (!Number.isSafeInteger(leg.v3Fee) || leg.v3Fee <= 0) {
    throw new Error(
      `buildPairKey: ${field}.v3Fee must be a positive safe integer when kind is "V3"`
    );
  }
  return {
    kind: "V3",
    router,
    v3Fee: String(leg.v3Fee),
    quoter: normalizeAddress(leg.quoter, `${field}.quoter`),
  };
}

/// Builds the canonical D7 route key: version, chain, tokens, then both legs.
/// Presentation fields (label, profile, tradeSizes, minProfitBps, tokenOut) are excluded.
function buildPairKey({ chainId, pair } = {}) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("buildPairKey: chainId must be a positive safe integer");
  }
  if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
    throw new TypeError("buildPairKey: pair must be an object");
  }

  const borrowedToken = tokenAddress(pair.borrowedToken, "borrowedToken");
  const intermediateToken = tokenAddress(pair.intermediateToken, "intermediateToken");
  const legOut = normalizeLeg(pair.legOut, "legOut");
  const legBack = normalizeLeg(pair.legBack, "legBack");

  return [
    "v1",
    String(chainId),
    borrowedToken,
    intermediateToken,
    legOut.kind,
    legOut.router,
    legOut.v3Fee,
    legOut.quoter,
    legBack.kind,
    legBack.router,
    legBack.v3Fee,
    legBack.quoter,
  ].join("|");
}

/// Returns the exact median as an unreduced fraction { numerator, denominator }.
/// The denominator is 1n for an odd count and 2n for an even count. No Number conversion
/// touches the values, so very large and negative BigInts stay exact.
function medianBigInt(values) {
  if (!Array.isArray(values)) {
    throw new TypeError("medianBigInt: values must be an array");
  }
  if (values.length === 0) {
    throw new RangeError("medianBigInt: values must not be empty");
  }

  const sorted = [];
  for (const value of values) {
    if (typeof value !== "bigint") {
      throw new TypeError("medianBigInt: values must contain only bigint");
    }
    sorted.push(value);
  }
  sorted.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return { numerator: sorted[mid], denominator: 1n };
  }
  return { numerator: sorted[mid - 1] + sorted[mid], denominator: 2n };
}

function doubledMedianFromExact(median) {
  return median.denominator === 1n ? median.numerator * 2n : median.numerator;
}

/// D5 comparison value: 2 * median, computed without division.
function doubledMedianBigInt(values) {
  return doubledMedianFromExact(medianBigInt(values));
}

/// D2: best valid netProfitBps across all trade sizes of one pair and one cycle.
/// A measured 0n is valid; errored results, null bps and non-positive amountIn are ignored.
function bestNetProfitBps(results) {
  if (!Array.isArray(results)) {
    throw new TypeError("bestNetProfitBps: results must be an array");
  }

  let best = null;
  for (const result of results) {
    if (!result || typeof result !== "object" || Array.isArray(result)) continue;
    if (result.error) continue;
    if (typeof result.netProfitBps !== "bigint") continue;
    if (typeof result.amountIn !== "bigint" || result.amountIn <= 0n) continue;
    if (best === null || result.netProfitBps > best) {
      best = result.netProfitBps;
    }
  }
  return best;
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

function validateMinSamples(minSamples, windowSize) {
  if (
    !Number.isInteger(minSamples) ||
    minSamples < DEFAULT_MIN_SAMPLES ||
    minSamples > windowSize
  ) {
    throw new RangeError(
      `minSamples must be an integer between ${DEFAULT_MIN_SAMPLES} and windowSize`
    );
  }
  return minSamples;
}

function validateMaxAgeMs(maxAgeMs) {
  if (
    typeof maxAgeMs !== "number" ||
    !Number.isFinite(maxAgeMs) ||
    maxAgeMs <= 0 ||
    maxAgeMs > MAX_MAX_AGE_MS
  ) {
    throw new RangeError(
      `maxAgeMs must be a finite number in (0, ${MAX_MAX_AGE_MS}]`
    );
  }
  return maxAgeMs;
}

function parseSample(entry, index) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new PairSpreadSamplesError(`sample[${index}] is not an object`);
  }
  if (typeof entry.netProfitBps !== "string" || !DECIMAL_BPS_PATTERN.test(entry.netProfitBps)) {
    throw new PairSpreadSamplesError(
      `sample[${index}].netProfitBps must be a signed decimal string`
    );
  }
  if (!Number.isSafeInteger(entry.at) || entry.at < 0) {
    throw new PairSpreadSamplesError(
      `sample[${index}].at must be a non-negative safe integer`
    );
  }
  return { netProfitBps: BigInt(entry.netProfitBps), at: entry.at, index };
}

/// Filters samples by age, ignores future timestamps, then keeps the last `windowSize`
/// entries ordered by `at` (ties keep their original order). The input array is not mutated.
function selectWindowSamples({
  samples,
  now = Date.now(),
  windowSize = DEFAULT_WINDOW_SIZE,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  if (!Array.isArray(samples)) {
    throw new PairSpreadSamplesError("samples must be an array");
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError("now must be a non-negative safe integer");
  }
  const validWindowSize = validateWindowSize(windowSize);
  const validMaxAgeMs = validateMaxAgeMs(maxAgeMs);
  const oldestAllowed = now - validMaxAgeMs;

  const recent = [];
  for (let index = 0; index < samples.length; index += 1) {
    const sample = parseSample(samples[index], index);
    if (sample.at > now) continue;
    if (sample.at < oldestAllowed) continue;
    recent.push(sample);
  }

  recent.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.index - b.index;
  });

  return recent.slice(-validWindowSize).map(({ netProfitBps, at }) => ({
    netProfitBps,
    at,
  }));
}

function pairFloor(pair) {
  const value = pair?.minProfitBps;
  if (!Number.isInteger(value) || value < 0 || value > MAX_FLOOR_BPS) return null;
  return BigInt(value);
}

function buildDecision({
  mode,
  skip = false,
  wouldFilter = false,
  reason,
  sampleCount = 0,
  median = null,
  doubledMedian = null,
  last = null,
  floor = null,
  medianBelowFloor = false,
  lastBelowFloor = false,
}) {
  return {
    mode,
    skip,
    wouldFilter,
    reason,
    sampleCount,
    median,
    doubledMedian,
    last,
    floor,
    medianBelowFloor,
    lastBelowFloor,
  };
}

/// D5 decision for one pair. `off` never evaluates state; `shadow` reports wouldFilter but
/// never skips; `enforce` skips only when both the median and the last sample are strictly
/// below pair.minProfitBps. Missing or invalid data fails open (scan).
function decidePairSpread({
  pair = null,
  samples = [],
  mode = "off",
  now,
  windowSize = DEFAULT_WINDOW_SIZE,
  minSamples = DEFAULT_MIN_SAMPLES,
  maxAgeMs = DEFAULT_MAX_AGE_MS,
} = {}) {
  const normalizedMode = normalizeMode(mode);
  if (normalizedMode === "off") {
    return buildDecision({ mode: normalizedMode, reason: "MODE_OFF" });
  }

  const validWindowSize = validateWindowSize(windowSize);
  const validMinSamples = validateMinSamples(minSamples, validWindowSize);
  const validMaxAgeMs = validateMaxAgeMs(maxAgeMs);
  const cycleNow = now === undefined ? Date.now() : now;
  if (!Number.isSafeInteger(cycleNow) || cycleNow < 0) {
    throw new RangeError("now must be a non-negative safe integer");
  }

  const floor = pairFloor(pair);
  if (floor === null) {
    return buildDecision({ mode: normalizedMode, reason: "INVALID_FLOOR" });
  }

  let selected;
  try {
    selected = selectWindowSamples({
      samples,
      now: cycleNow,
      windowSize: validWindowSize,
      maxAgeMs: validMaxAgeMs,
    });
  } catch (err) {
    if (isPairSpreadSamplesError(err)) {
      return buildDecision({ mode: normalizedMode, reason: "INVALID_SAMPLES", floor });
    }
    throw err;
  }

  if (selected.length < validMinSamples) {
    return buildDecision({
      mode: normalizedMode,
      reason: "INSUFFICIENT_SAMPLES",
      sampleCount: selected.length,
      floor,
    });
  }

  const values = selected.map((sample) => sample.netProfitBps);
  const median = medianBigInt(values);
  const doubledMedian = doubledMedianFromExact(median);
  const last = selected[selected.length - 1].netProfitBps;
  const medianBelowFloor = doubledMedian < 2n * floor;
  const lastBelowFloor = last < floor;
  const wouldFilter = medianBelowFloor && lastBelowFloor;
  const skip = normalizedMode === "enforce" && wouldFilter;

  let reason = "MEDIAN_AT_OR_ABOVE_FLOOR";
  if (wouldFilter) reason = "PAIR_SPREAD_BELOW_FLOOR";
  else if (medianBelowFloor) reason = "LAST_AT_OR_ABOVE_FLOOR";

  return buildDecision({
    mode: normalizedMode,
    skip,
    wouldFilter,
    reason,
    sampleCount: selected.length,
    median,
    doubledMedian,
    last,
    floor,
    medianBelowFloor,
    lastBelowFloor,
  });
}

module.exports = {
  PAIR_SPREAD_MODES,
  DEFAULT_WINDOW_SIZE,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_MAX_AGE_MS,
  normalizeMode,
  buildPairKey,
  medianBigInt,
  doubledMedianBigInt,
  bestNetProfitBps,
  selectWindowSamples,
  decidePairSpread,
};
