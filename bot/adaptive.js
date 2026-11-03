const fs = require("fs/promises");
const path = require("path");

const ADAPTIVE_MIN_BPS = 0;
const ADAPTIVE_MAX_BPS = 10000;
const ADAPTIVE_MIN_SIZE_FACTOR = 0.10;
const ADAPTIVE_MAX_SIZE_FACTOR = 1.00;
const VALID_PROFILES = new Set(["majors", "longtail"]);
const DEFAULT_PROFILE = "majors";
const ADAPTIVE_WINDOW = 20;
const ADAPTIVE_STEP_BPS = 5;
const ADAPTIVE_STEP_SIZE = 0.10;
const LOG_DIR = path.resolve(__dirname, "..", "logs");
const DEFAULT_ADAPTIVE_PATH = path.join(LOG_DIR, "adaptive.json");

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

function normalizeProfile(profile) {
  return VALID_PROFILES.has(profile) ? profile : null;
}

function defaultState(config) {
  const bounds = bpsBounds(config);
  return {
    effectiveMinProfitBps: normalizeBps(config?.minProfitBps, bounds, bounds.min),
    effectiveMaxTradeSize: {
      majors: factorToSizeString(ADAPTIVE_MAX_SIZE_FACTOR),
      longtail: factorToSizeString(ADAPTIVE_MAX_SIZE_FACTOR),
    },
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
        (entry.profile === undefined || VALID_PROFILES.has(entry.profile)) &&
        Number.isFinite(entry.at)
    )
    .map((entry) => ({
      outcome: entry.outcome,
      profile: VALID_PROFILES.has(entry.profile) ? entry.profile : DEFAULT_PROFILE,
      at: entry.at,
    }))
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
  const rawMax = parsed.effectiveMaxTradeSize;
  let perProfile;
  if (rawMax && typeof rawMax === "object" && !Array.isArray(rawMax)) {
    perProfile = {
      majors: factorToSizeString(rawMax.majors ?? ADAPTIVE_MAX_SIZE_FACTOR),
      longtail: factorToSizeString(rawMax.longtail ?? ADAPTIVE_MAX_SIZE_FACTOR),
    };
  } else {
    const legacy = factorToSizeString(rawMax ?? ADAPTIVE_MAX_SIZE_FACTOR);
    perProfile = { majors: legacy, longtail: legacy };
  }

  return {
    effectiveMinProfitBps: normalizeBps(
      parsed.effectiveMinProfitBps,
      bounds,
      fallback.effectiveMinProfitBps
    ),
    effectiveMaxTradeSize: perProfile,
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
  const currentFactors = {
    majors: normalizeFactor(state.effectiveMaxTradeSize?.majors),
    longtail: normalizeFactor(state.effectiveMaxTradeSize?.longtail),
  };

  const nextBps = (() => {
    const tail = state.history.slice(-STREAK_LENGTH);
    if (tail.length !== STREAK_LENGTH) return currentBps;
    if (tail.every((e) => e.outcome === "FAILURE")) {
      return Math.min(currentBps + ADAPTIVE_STEP_BPS, bounds.max);
    }
    if (tail.every((e) => e.outcome === "SUCCESS")) {
      return Math.max(currentBps - ADAPTIVE_STEP_BPS, bounds.min);
    }
    return currentBps;
  })();

  const nextFactors = {};
  for (const profile of VALID_PROFILES) {
    const tailForProfile = state.history
      .filter((e) => e.profile === profile)
      .slice(-STREAK_LENGTH);
    let factor = currentFactors[profile];
    if (tailForProfile.length === STREAK_LENGTH && tailForProfile.every((e) => e.outcome === "FAILURE")) {
      factor = Math.max(factor - ADAPTIVE_STEP_SIZE, ADAPTIVE_MIN_SIZE_FACTOR);
    } else if (tailForProfile.length === STREAK_LENGTH && tailForProfile.every((e) => e.outcome === "SUCCESS")) {
      factor = Math.min(factor + ADAPTIVE_STEP_SIZE, ADAPTIVE_MAX_SIZE_FACTOR);
    }
    nextFactors[profile] = factorToSizeString(factor);
  }

  return {
    effectiveMinProfitBps: normalizeBps(nextBps, bounds, bounds.min),
    effectiveMaxTradeSize: nextFactors,
    history: state.history,
  };
}

async function recordOutcome({
  filePath = DEFAULT_ADAPTIVE_PATH,
  outcome,
  profile,
  config,
  now = Date.now(),
} = {}) {
  if (!ADAPTIVE_OUTCOMES.has(outcome)) {
    throw new TypeError(`Invalid adaptive outcome: ${outcome}`);
  }
  const normalizedProfile = normalizeProfile(profile);
  if (!normalizedProfile) {
    throw new TypeError(`Invalid adaptive profile: ${profile}. Must be "majors" or "longtail".`);
  }

  const state = await loadAdaptive({ filePath, config });
  const history = [...state.history, { outcome, profile: normalizedProfile, at: now }].slice(-ADAPTIVE_WINDOW);
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
  const rawMax = source.effectiveMaxTradeSize;
  const factors = {};
  if (rawMax && typeof rawMax === "object" && !Array.isArray(rawMax)) {
    factors.majors = normalizeFactor(rawMax.majors);
    factors.longtail = normalizeFactor(rawMax.longtail);
  } else {
    const legacy = normalizeFactor(rawMax);
    factors.majors = legacy;
    factors.longtail = legacy;
  }

  const pairs = Array.isArray(config?.pairs)
    ? config.pairs.map((pair) => {
        const profile = VALID_PROFILES.has(pair.profile) ? pair.profile : DEFAULT_PROFILE;
        const factor = factors[profile];
        const scaled = (value) => {
          const n = parseFloat(value);
          if (!Number.isFinite(n)) return value;
          return (n * factor).toFixed(4);
        };
        if (Array.isArray(pair.tradeSizes)) {
          return {
            ...pair,
            profile,
            tradeSizes: pair.tradeSizes.map(scaled),
          };
        }
        if (pair.logSweep && typeof pair.logSweep === "object") {
          return {
            ...pair,
            profile,
            logSweep: {
              ...pair.logSweep,
              min: scaled(pair.logSweep.min),
              max: scaled(pair.logSweep.max),
            },
          };
        }
        return { ...pair, profile };
      })
    : config?.pairs;

  return {
    ...config,
    minProfitBps: effectiveMinProfitBps,
    pairs,
    effectiveMinProfitBps,
    effectiveMaxTradeSize: {
      majors: factorToSizeString(factors.majors),
      longtail: factorToSizeString(factors.longtail),
    },
    tradeSizeFactor: factors,
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
  VALID_PROFILES,
  DEFAULT_PROFILE,
  DEFAULT_ADAPTIVE_PATH,
  loadAdaptive,
  recordOutcome,
  applyAdaptive,
};
