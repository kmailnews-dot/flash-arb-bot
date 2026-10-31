const DEFAULT_MIN_INTERVAL_MS = 250;
const DEFAULT_NAME = "rpc";

const THROTTLE_STATE = new WeakMap();

function readClock(now) {
  try {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  } catch (err) {
    return Date.now();
  }
}

function effectiveInterval(throttle) {
  const value = Number(throttle.minIntervalMs);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function createThrottle({
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
  name = DEFAULT_NAME,
  now = () => Date.now(),
} = {}) {
  const throttle = {
    name,
    minIntervalMs,
    stats: {
      calls: 0,
      totalWaitMs: 0,
      lastCallAt: null,
    },
  };

  THROTTLE_STATE.set(throttle, {
    chain: Promise.resolve(),
    lastStartAt: null,
    now: typeof now === "function" ? now : () => Date.now(),
  });

  return throttle;
}

async function withThrottle(throttle, fn) {
  const internal = THROTTLE_STATE.get(throttle);

  const run = async () => {
    const startedAt = readClock(internal.now);
    let waitMs = 0;

    if (internal.lastStartAt !== null) {
      waitMs = Math.max(
        0,
        internal.lastStartAt + effectiveInterval(throttle) - startedAt
      );
    }

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const actualStart = readClock(internal.now);
    internal.lastStartAt = actualStart;
    throttle.stats.calls += 1;
    throttle.stats.totalWaitMs += Math.max(0, actualStart - startedAt);
    throttle.stats.lastCallAt = actualStart;

    const result = await fn();
    return { result, stats: getStats(throttle) };
  };

  const pending = internal.chain.then(run);
  internal.chain = pending.then(
    () => undefined,
    () => undefined
  );
  return pending;
}

function getStats(throttle) {
  return Object.freeze({ ...throttle.stats });
}

module.exports = {
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_NAME,
  createThrottle,
  withThrottle,
  getStats,
};
