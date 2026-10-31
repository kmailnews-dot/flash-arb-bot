const fs = require("fs/promises");
const path = require("path");

const ADAPTIVE_MIN_BPS = 0;
const ADAPTIVE_MAX_BPS = 10000;
const ADAPTIVE_MIN_SIZE_FACTOR = 0.10;
const ADAPTIVE_MAX_SIZE_FACTOR = 1.00;
const ADAPTIVE_WINDOW = 20;
const ADAPTIVE_STEP_BPS = 5;
const ADAPTIVE_STEP_SIZE = 0.10;
const DEFAULT_ADAPTIVE_PATH = "./logs/adaptive.json";

const ADAPTIVE_OUTCOMES = new Set(["SUCCESS", "FAILURE", "UNKNOWN"]);
const STREAK_LENGTH = 3;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function bpsBounds(config) {
  const min = Math.max(Number(config?.minProfitBps) || 0, ADAPTIVE_MIN_BPS);
  const max = Math.min(min * 2, ADAPTIVE_MAX_BPS);
  return { min, max };
}

function normalizeBps(value, bounds, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  const bps = Number.isFinite(parsed) ? parsed : fallback;
  return clamp(Math.round(bps), bounds.min, bounds.max);
}

function normalizeFactor(value) {
  const parsed = typeof value === "number" ? value : parseFloat(value);
  const factor = Number.isFinite(parsed) ? parsed : ADAPTIVE_MAX_SIZE_FACTOR;
  return clamp(
    Math.round(factor * 100) / 100,
    ADAPTIVE_MIN_SIZE_FACTOR,
    ADAPTIVE_MAX_SIZE_FACTOR
  );
}

function factorToSizeString(factor) {
  return normalizeFactor(factor).toFixed(2);
}

function defaultState(config) {
  const bounds = bpsBounds(config);
  return {
    effectiveMinProfitBps: normalizeBps(config?.minProfitBps, bounds, bounds.min),
    effectiveMaxTradeSize: factorToSizeString(ADAPTIVE_MAX_SIZE_FACTOR),
    history: [],
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  return history
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        ADAPTIVE_OUTCOMES.has(entry.outcome) &&
        Number.isFinite(entry.at)
    )
    .map((entry) => ({ outcome: entry.outcome, at: entry.at }))
    .slice(-ADAPTIVE_WINDOW);
}

async function readAdaptiveFile(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function normalizeState(parsed, config) {
  const fallback = defaultState(config);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;

  const bounds = bpsBounds(config);
  return {
    effectiveMinProfitBps: normalizeBps(
      parsed.effectiveMinProfitBps,
      bounds,
      fallback.effectiveMinProfitBps
    ),
    effectiveMaxTradeSize: factorToSizeString(parsed.effectiveMaxTradeSize),
    history: normalizeHistory(parsed.history),
  };
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function loadAdaptive({ filePath = DEFAULT_ADAPTIVE_PATH, config } = {}) {
  const parsed = await readAdaptiveFile(filePath);
  return normalizeState(parsed, config);
}

function adjustState(state, config) {
  const bounds = bpsBounds(config);
  const currentBps = normalizeBps(state.effectiveMinProfitBps, bounds, bounds.min);
  const currentFactor = normalizeFactor(state.effectiveMaxTradeSize);
  const tail = state.history.slice(-STREAK_LENGTH);

  let nextBps = currentBps;
  let nextFactor = currentFactor;

  if (tail.length === STREAK_LENGTH && tail.every((entry) => entry.outcome === "FAILURE")) {
    nextBps = Math.min(currentBps + ADAPTIVE_STEP_BPS, bounds.max);
    nextFactor = Math.max(currentFactor - ADAPTIVE_STEP_SIZE, ADAPTIVE_MIN_SIZE_FACTOR);
  } else if (tail.length === STREAK_LENGTH && tail.every((entry) => entry.outcome === "SUCCESS")) {
    nextBps = Math.max(currentBps - ADAPTIVE_STEP_BPS, bounds.min);
    nextFactor = Math.min(currentFactor + ADAPTIVE_STEP_SIZE, ADAPTIVE_MAX_SIZE_FACTOR);
  }

  return {
    effectiveMinProfitBps: normalizeBps(nextBps, bounds, bounds.min),
    effectiveMaxTradeSize: factorToSizeString(nextFactor),
    history: state.history,
  };
}

async function recordOutcome({
  filePath = DEFAULT_ADAPTIVE_PATH,
  outcome,
  config,
  now = Date.now(),
} = {}) {
  if (!ADAPTIVE_OUTCOMES.has(outcome)) {
    throw new TypeError(`Invalid adaptive outcome: ${outcome}`);
  }

  const state = await loadAdaptive({ filePath, config });
  const history = [...state.history, { outcome, at: now }].slice(-ADAPTIVE_WINDOW);
  const nextState = adjustState({ ...state, history }, config);

  await writeState(filePath, nextState);
  return nextState;
}

function applyAdaptive({ config, state } = {}) {
  const bounds = bpsBounds(config);
  const source = state && typeof state === "object" ? state : {};
  const effectiveMinProfitBps = normalizeBps(
    source.effectiveMinProfitBps,
    bounds,
    normalizeBps(config?.minProfitBps, bounds, bounds.min)
  );
  const tradeSizeFactor = normalizeFactor(source.effectiveMaxTradeSize);
  const effectiveMaxTradeSize = factorToSizeString(tradeSizeFactor);

  const pairs = Array.isArray(config?.pairs)
    ? config.pairs.map((pair) => ({
        ...pair,
        tradeSizes: Array.isArray(pair.tradeSizes)
          ? pair.tradeSizes.map((size) => (parseFloat(size) * tradeSizeFactor).toFixed(4))
          : pair.tradeSizes,
      }))
    : config?.pairs;

  return {
    ...config,
    minProfitBps: effectiveMinProfitBps,
    pairs,
    effectiveMinProfitBps,
    effectiveMaxTradeSize,
    tradeSizeFactor,
  };
}

module.exports = {
  ADAPTIVE_MIN_BPS,
  ADAPTIVE_MAX_BPS,
  ADAPTIVE_MIN_SIZE_FACTOR,
  ADAPTIVE_MAX_SIZE_FACTOR,
  ADAPTIVE_WINDOW,
  ADAPTIVE_STEP_BPS,
  ADAPTIVE_STEP_SIZE,
  DEFAULT_ADAPTIVE_PATH,
  loadAdaptive,
  recordOutcome,
  applyAdaptive,
};
