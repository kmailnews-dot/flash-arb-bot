const { expect } = require("chai");
const {
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
} = require("../bot/pairSpread");

const NOW = 1_760_000_000_000;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

const BORROWED = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const INTERMEDIATE = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const V3_QUOTER = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
const V2_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";

function addr(n) {
  return `0x${String(n).padStart(40, "0")}`;
}

function makeKeyPair() {
  return {
    label: "USDC/WETH",
    profile: "majors",
    minProfitBps: 30,
    borrowedToken: { address: BORROWED, decimals: 6, symbol: "USDC", isStable: true },
    intermediateToken: {
      address: INTERMEDIATE,
      decimals: 18,
      symbol: "WETH",
      isWeth: true,
    },
    legOut: {
      kind: "V3",
      router: V3_ROUTER,
      tokenOut: INTERMEDIATE,
      v3Fee: 500,
      quoter: V3_QUOTER,
    },
    legBack: {
      kind: "V2",
      router: V2_ROUTER,
      tokenOut: BORROWED,
    },
    tradeSizes: ["10", "20"],
  };
}

function makeBothV3Pair() {
  const pair = makeKeyPair();
  pair.legBack = {
    kind: "V3",
    router: V3_ROUTER,
    tokenOut: BORROWED,
    v3Fee: 3000,
    quoter: V3_QUOTER,
  };
  return pair;
}

function makeSamples(values, { now = NOW, stepMs = MINUTE_MS } = {}) {
  return values.map((value, index) => ({
    netProfitBps: String(value),
    at: now - (values.length - 1 - index) * stepMs,
  }));
}

function decide(values, overrides = {}) {
  return decidePairSpread({
    pair: { minProfitBps: 30 },
    samples: makeSamples(values),
    now: NOW,
    mode: "enforce",
    ...overrides,
  });
}

function makeResult(overrides = {}) {
  return {
    amountIn: 1_000_000n,
    netProfitBps: 10n,
    netProfitUsd: 0,
    grossProfit: 0n,
    ...overrides,
  };
}

describe("bot/pairSpread", function () {
  describe("buildPairKey", function () {
    it("builds the canonical D7 key with lowercase addresses", function () {
      const key = buildPairKey({ chainId: 42161, pair: makeKeyPair() });
      const expected = [
        "v1",
        "42161",
        BORROWED.toLowerCase(),
        INTERMEDIATE.toLowerCase(),
        "V3",
        V3_ROUTER.toLowerCase(),
        "500",
        V3_QUOTER.toLowerCase(),
        "V2",
        V2_ROUTER.toLowerCase(),
        "",
        "",
      ].join("|");

      expect(key).to.equal(expected);
      expect(key).to.include(BORROWED.toLowerCase());
      expect(key).to.not.include(BORROWED);
      expect(key).to.include(INTERMEDIATE.toLowerCase());
      expect(key).to.not.include(INTERMEDIATE);
    });

    it("returns the same key for equivalent pair representations", function () {
      const checksummed = makeKeyPair();
      const lowercaseWithExtras = {
        borrowedToken: { address: BORROWED.toLowerCase(), decimals: 6 },
        intermediateToken: { address: INTERMEDIATE.toLowerCase(), decimals: 18 },
        legOut: {
          kind: "V3",
          router: V3_ROUTER.toLowerCase(),
          tokenOut: INTERMEDIATE.toLowerCase(),
          v3Fee: 500,
          quoter: V3_QUOTER.toLowerCase(),
        },
        legBack: {
          kind: "V2",
          router: V2_ROUTER.toLowerCase(),
          tokenOut: BORROWED.toLowerCase(),
          v3Fee: 3000,
          quoter: addr(99),
        },
        label: "different presentation",
        profile: "longtail",
        minProfitBps: 99,
        tradeSizes: ["1"],
      };

      const first = buildPairKey({ chainId: 42161, pair: checksummed });
      const second = buildPairKey({ chainId: 42161, pair: lowercaseWithExtras });

      expect(second).to.equal(first);
    });

    it("changes the key when a structural route field changes", function () {
      const base = makeBothV3Pair();
      const baseKey = buildPairKey({ chainId: 42161, pair: base });
      const variants = [
        { chainId: 421614, pair: base },
        {
          chainId: 42161,
          pair: {
            ...base,
            borrowedToken: { ...base.borrowedToken, address: addr(1) },
          },
        },
        {
          chainId: 42161,
          pair: {
            ...base,
            intermediateToken: { ...base.intermediateToken, address: addr(2) },
          },
        },
        {
          chainId: 42161,
          pair: { ...base, legOut: { ...base.legOut, kind: "V2" } },
        },
        {
          chainId: 42161,
          pair: { ...base, legOut: { ...base.legOut, router: addr(3) } },
        },
        {
          chainId: 42161,
          pair: { ...base, legOut: { ...base.legOut, v3Fee: 3000 } },
        },
        {
          chainId: 42161,
          pair: { ...base, legOut: { ...base.legOut, quoter: addr(4) } },
        },
        {
          chainId: 42161,
          pair: { ...base, legBack: { ...base.legBack, kind: "V2" } },
        },
        {
          chainId: 42161,
          pair: { ...base, legBack: { ...base.legBack, router: addr(5) } },
        },
        {
          chainId: 42161,
          pair: { ...base, legBack: { ...base.legBack, v3Fee: 500 } },
        },
        {
          chainId: 42161,
          pair: { ...base, legBack: { ...base.legBack, quoter: addr(6) } },
        },
      ];

      const keys = variants.map((variant) => buildPairKey(variant));
      for (const key of keys) {
        expect(key).to.not.equal(baseKey);
      }
      expect(new Set(keys).size).to.equal(variants.length);
    });

    it("rejects malformed key inputs", function () {
      const base = makeKeyPair();

      expect(() => buildPairKey({ chainId: 0, pair: base })).to.throw(/chainId/);
      expect(() =>
        buildPairKey({
          chainId: 42161,
          pair: {
            ...base,
            borrowedToken: { ...base.borrowedToken, address: "0x123" },
          },
        })
      ).to.throw(/borrowedToken\.address/);
      expect(() =>
        buildPairKey({
          chainId: 42161,
          pair: { ...base, legOut: { ...base.legOut, kind: "V4" } },
        })
      ).to.throw(/legOut\.kind/);
      expect(() =>
        buildPairKey({
          chainId: 42161,
          pair: { ...base, legOut: { ...base.legOut, v3Fee: undefined } },
        })
      ).to.throw(/legOut\.v3Fee/);
      expect(() =>
        buildPairKey({
          chainId: 42161,
          pair: { ...base, legOut: { ...base.legOut, quoter: undefined } },
        })
      ).to.throw(/legOut\.quoter/);
    });
  });

  describe("medianBigInt", function () {
    it("returns the exact odd median", function () {
      const input = [3n, 1n, 2n];
      const median = medianBigInt(input);

      expect(median.numerator).to.equal(2n);
      expect(median.denominator).to.equal(1n);
      expect(doubledMedianBigInt(input)).to.equal(4n);
      expect(input[0]).to.equal(3n);
      expect(input[1]).to.equal(1n);
      expect(input[2]).to.equal(2n);
    });

    it("returns the exact even median without division", function () {
      const half = medianBigInt([2n, 1n]);
      expect(half.numerator).to.equal(3n);
      expect(half.denominator).to.equal(2n);
      expect(doubledMedianBigInt([2n, 1n])).to.equal(3n);

      const exact = medianBigInt([40n, 20n]);
      expect(exact.numerator).to.equal(60n);
      expect(exact.denominator).to.equal(2n);
      expect(doubledMedianBigInt([40n, 20n])).to.equal(60n);
    });

    it("handles negative values", function () {
      const even = medianBigInt([-20n, -80n, -40n, -60n]);
      expect(even.numerator).to.equal(-100n);
      expect(even.denominator).to.equal(2n);
      expect(doubledMedianBigInt([-20n, -80n, -40n, -60n])).to.equal(-100n);

      const odd = medianBigInt([-10n, -30n, -20n]);
      expect(odd.numerator).to.equal(-20n);
      expect(odd.denominator).to.equal(1n);
      expect(doubledMedianBigInt([-10n, -30n, -20n])).to.equal(-40n);
    });

    it("handles very large BigInt values", function () {
      const huge = 10n ** 40n;
      const huge2 = 10n ** 50n;
      const veryNegative = -(10n ** 60n);
      const input = [huge2, huge, veryNegative];
      const median = medianBigInt(input);

      expect(median.numerator).to.equal(huge);
      expect(median.denominator).to.equal(1n);
      expect(doubledMedianBigInt(input)).to.equal(2n * huge);
    });

    it("rejects empty or non-BigInt input", function () {
      expect(() => medianBigInt([])).to.throw(/must not be empty/);
      expect(() => medianBigInt([1])).to.throw(/bigint/);
      expect(() => medianBigInt("not-an-array")).to.throw(/array/);
    });
  });

  describe("bestNetProfitBps", function () {
    it("selects the maximum valid bps across trade sizes", function () {
      const results = [
        makeResult({ netProfitBps: 12n, netProfitUsd: 1000, grossProfit: 9999n }),
        makeResult({ netProfitBps: 35n, netProfitUsd: 1, grossProfit: 1n }),
        makeResult({ netProfitBps: 20n, netProfitUsd: 500, grossProfit: 5000n }),
      ];

      expect(bestNetProfitBps(results)).to.equal(35n);
    });

    it("ignores errored results and null bps", function () {
      const results = [
        makeResult({ netProfitBps: 999n, error: "DEPTH_EXCEEDED" }),
        makeResult({ netProfitBps: null }),
        makeResult({ netProfitBps: 5n }),
        makeResult({ netProfitBps: 0n }),
      ];

      expect(bestNetProfitBps(results)).to.equal(5n);
    });

    it("accepts a measured 0n sample", function () {
      expect(bestNetProfitBps([makeResult({ netProfitBps: 0n })])).to.equal(0n);
    });

    it("returns null when no result is valid", function () {
      const results = [
        makeResult({ error: "QUOTE_STALE" }),
        makeResult({ netProfitBps: null }),
        makeResult({ amountIn: 0n, netProfitBps: 100n }),
        makeResult({ amountIn: -1n, netProfitBps: 100n }),
      ];

      expect(bestNetProfitBps(results)).to.equal(null);
      expect(() => bestNetProfitBps(null)).to.throw(/array/);
    });
  });

  describe("selectWindowSamples", function () {
    it("keeps recent samples by at and ignores expired or future ones", function () {
      const samples = [
        { netProfitBps: "-1", at: NOW - 20_000 },
        { netProfitBps: "5", at: NOW - 10_000 },
        { netProfitBps: "6", at: NOW + 1 },
        { netProfitBps: "7", at: NOW - 5_000 },
        { netProfitBps: "8", at: NOW - 1_000 },
      ];

      const selected = selectWindowSamples({
        samples,
        now: NOW,
        windowSize: 5,
        maxAgeMs: 10_000,
      });

      expect(selected.length).to.equal(3);
      expect(selected[0].netProfitBps).to.equal(5n);
      expect(selected[0].at).to.equal(NOW - 10_000);
      expect(selected[1].netProfitBps).to.equal(7n);
      expect(selected[2].netProfitBps).to.equal(8n);
      expect(selected[2].at).to.equal(NOW - 1_000);
    });

    it("keeps only the last windowSize samples ordered by at", function () {
      const samples = makeSamples([1, 2, 3, 4, 5, 6, 7]);
      const selected = selectWindowSamples({
        samples,
        now: NOW,
        windowSize: 5,
        maxAgeMs: DAY_MS,
      });

      expect(selected.length).to.equal(5);
      expect(selected[0].netProfitBps).to.equal(3n);
      expect(selected[4].netProfitBps).to.equal(7n);
    });

    it("rejects malformed sample entries", function () {
      expect(() =>
        selectWindowSamples({
          samples: [{ netProfitBps: "1.5", at: NOW }],
          now: NOW,
        })
      ).to.throw(/netProfitBps/);
      expect(() =>
        selectWindowSamples({
          samples: [{ netProfitBps: "1", at: 1.5 }],
          now: NOW,
        })
      ).to.throw(/at/);
      expect(() => selectWindowSamples({ samples: null, now: NOW })).to.throw(/samples/);
    });
  });

  describe("decidePairSpread", function () {
    it("exposes the ADR defaults and normalizes modes", function () {
      expect(DEFAULT_WINDOW_SIZE).to.equal(20);
      expect(DEFAULT_MIN_SAMPLES).to.equal(5);
      expect(DEFAULT_MAX_AGE_MS).to.equal(DAY_MS);
      expect(PAIR_SPREAD_MODES).to.deep.equal(["off", "shadow", "enforce"]);
      expect(normalizeMode("OFF")).to.equal("off");
      expect(normalizeMode("Shadow")).to.equal("shadow");
      expect(normalizeMode("enforce")).to.equal("enforce");
    });

    it("fails open below five samples", function () {
      const decision = decide([-100, -90, -80, -70]);

      expect(decision.skip).to.equal(false);
      expect(decision.wouldFilter).to.equal(false);
      expect(decision.reason).to.equal("INSUFFICIENT_SAMPLES");
      expect(decision.sampleCount).to.equal(4);
      expect(decision.floor).to.equal(30n);
      expect(decision.median).to.equal(null);
      expect(decision.doubledMedian).to.equal(null);
      expect(decision.last).to.equal(null);

      const empty = decide([]);
      expect(empty.skip).to.equal(false);
      expect(empty.reason).to.equal("INSUFFICIENT_SAMPLES");
      expect(empty.sampleCount).to.equal(0);
    });

    it("rejects when median and last are strictly below the floor", function () {
      const decision = decide([-80, -60, -40, -20, -10]);

      expect(decision.skip).to.equal(true);
      expect(decision.wouldFilter).to.equal(true);
      expect(decision.reason).to.equal("PAIR_SPREAD_BELOW_FLOOR");
      expect(decision.sampleCount).to.equal(5);
      expect(decision.floor).to.equal(30n);
      expect(decision.median.numerator).to.equal(-40n);
      expect(decision.median.denominator).to.equal(1n);
      expect(decision.doubledMedian).to.equal(-80n);
      expect(decision.last).to.equal(-10n);
      expect(decision.medianBelowFloor).to.equal(true);
      expect(decision.lastBelowFloor).to.equal(true);
    });

    it("scans when the median is below the floor but the last is not", function () {
      const equal = decide([-80, -60, -40, -20, 30]);
      expect(equal.skip).to.equal(false);
      expect(equal.wouldFilter).to.equal(false);
      expect(equal.reason).to.equal("LAST_AT_OR_ABOVE_FLOOR");
      expect(equal.medianBelowFloor).to.equal(true);
      expect(equal.lastBelowFloor).to.equal(false);
      expect(equal.last).to.equal(30n);

      const above = decide([-80, -60, -40, -20, 35]);
      expect(above.skip).to.equal(false);
      expect(above.wouldFilter).to.equal(false);
      expect(above.reason).to.equal("LAST_AT_OR_ABOVE_FLOOR");
      expect(above.medianBelowFloor).to.equal(true);
      expect(above.lastBelowFloor).to.equal(false);
      expect(above.last).to.equal(35n);
    });

    it("scans when the median equals the floor", function () {
      const odd = decide([-80, -60, 30, 40, 50]);
      expect(odd.skip).to.equal(false);
      expect(odd.medianBelowFloor).to.equal(false);
      expect(odd.doubledMedian).to.equal(60n);
      expect(odd.reason).to.equal("MEDIAN_AT_OR_ABOVE_FLOOR");

      const even = decide([-100, -100, 20, 40, 50, 50]);
      expect(even.skip).to.equal(false);
      expect(even.medianBelowFloor).to.equal(false);
      expect(even.doubledMedian).to.equal(60n);
      expect(even.last).to.equal(50n);
    });

    it("compares exactly without division", function () {
      const samples = [
        { netProfitBps: "-10", at: NOW - 5 * MINUTE_MS },
        { netProfitBps: "-5", at: NOW - 4 * MINUTE_MS },
        { netProfitBps: "0", at: NOW - 3 * MINUTE_MS },
        { netProfitBps: "1", at: NOW - 2 * MINUTE_MS },
        { netProfitBps: "2", at: NOW - MINUTE_MS },
        { netProfitBps: "-1", at: NOW },
      ];

      const decision = decidePairSpread({
        pair: { minProfitBps: 0 },
        samples,
        now: NOW,
        mode: "enforce",
      });

      expect(decision.skip).to.equal(true);
      expect(decision.reason).to.equal("PAIR_SPREAD_BELOW_FLOOR");
      expect(decision.median.numerator).to.equal(-1n);
      expect(decision.median.denominator).to.equal(2n);
      expect(decision.doubledMedian).to.equal(-1n);
      expect(decision.medianBelowFloor).to.equal(true);
      expect(decision.last).to.equal(-1n);
      expect(decision.lastBelowFloor).to.equal(true);
    });

    it("ignores expired samples and keeps the inclusive age boundary", function () {
      const expiredSamples = makeSamples([-100, -90, -80, -70, -60], {
        now: NOW - 9,
        stepMs: 1,
      });
      const expired = decidePairSpread({
        pair: { minProfitBps: 30 },
        samples: expiredSamples,
        now: NOW,
        maxAgeMs: 8,
        mode: "enforce",
      });

      expect(expired.skip).to.equal(false);
      expect(expired.reason).to.equal("INSUFFICIENT_SAMPLES");
      expect(expired.sampleCount).to.equal(0);

      const boundarySamples = makeSamples([-100, -90, -80, -70, -60], {
        now: NOW - 4,
        stepMs: 1,
      });
      const boundary = decidePairSpread({
        pair: { minProfitBps: 30 },
        samples: boundarySamples,
        now: NOW,
        maxAgeMs: 8,
        mode: "enforce",
      });

      expect(boundary.sampleCount).to.equal(5);
      expect(boundary.skip).to.equal(true);
    });

    it("uses at rather than array order for the last sample", function () {
      const samples = [
        ...makeSamples([-100, -90, -80, -70, -60], { now: NOW - 6 * MINUTE_MS }),
        { netProfitBps: "100", at: NOW - 11 * MINUTE_MS },
      ];

      const decision = decidePairSpread({
        pair: { minProfitBps: 30 },
        samples,
        now: NOW,
        mode: "enforce",
      });

      expect(decision.sampleCount).to.equal(6);
      expect(decision.last).to.equal(-60n);
      expect(decision.skip).to.equal(true);
    });

    it("ignores future samples", function () {
      const samples = [
        ...makeSamples([-100, -90, -80, -70, -60], { now: NOW - 10 * MINUTE_MS }),
        ...makeSamples([100, 100, 100, 100, 100], { now: NOW + 10 * MINUTE_MS }),
      ];

      const decision = decidePairSpread({
        pair: { minProfitBps: 30 },
        samples,
        now: NOW,
        mode: "enforce",
      });

      expect(decision.sampleCount).to.equal(5);
      expect(decision.last).to.equal(-60n);
      expect(decision.skip).to.equal(true);
    });

    it("applies the sample window by at", function () {
      const old = makeSamples([100, 100, 100, 100, 100], { now: NOW - 20 * MINUTE_MS });
      const recent = makeSamples([-10, -10, -10, -10, -10], { now: NOW - 5 * MINUTE_MS });

      const decision = decidePairSpread({
        pair: { minProfitBps: 30 },
        samples: [...old, ...recent],
        now: NOW,
        windowSize: 5,
        mode: "enforce",
      });

      expect(decision.sampleCount).to.equal(5);
      expect(decision.doubledMedian).to.equal(-20n);
      expect(decision.last).to.equal(-10n);
      expect(decision.skip).to.equal(true);
    });

    it("does not filter or validate anything in mode off", function () {
      const decision = decidePairSpread({
        pair: {},
        samples: [{ netProfitBps: "not-a-number", at: -1 }],
        mode: "OFF",
        now: NOW,
      });

      expect(decision.mode).to.equal("off");
      expect(decision.skip).to.equal(false);
      expect(decision.wouldFilter).to.equal(false);
      expect(decision.reason).to.equal("MODE_OFF");
      expect(decision.sampleCount).to.equal(0);
      expect(decision.median).to.equal(null);
      expect(decision.floor).to.equal(null);
    });

    it("evaluates in shadow without requesting a skip", function () {
      const rejected = decide([-80, -60, -40, -20, -10], { mode: "shadow" });
      expect(rejected.mode).to.equal("shadow");
      expect(rejected.skip).to.equal(false);
      expect(rejected.wouldFilter).to.equal(true);
      expect(rejected.reason).to.equal("PAIR_SPREAD_BELOW_FLOOR");
      expect(rejected.sampleCount).to.equal(5);
      expect(rejected.doubledMedian).to.equal(-80n);

      const allowed = decide([-80, -60, -40, -20, 35], { mode: "shadow" });
      expect(allowed.skip).to.equal(false);
      expect(allowed.wouldFilter).to.equal(false);
    });

    it("skips in enforce only when the rejection rule holds", function () {
      const rejected = decide([-80, -60, -40, -20, -10], { mode: "enforce" });
      expect(rejected.skip).to.equal(true);
      expect(rejected.wouldFilter).to.equal(true);

      const recovered = decide([-80, -60, -40, -20, 35], { mode: "enforce" });
      expect(recovered.skip).to.equal(false);
      expect(recovered.wouldFilter).to.equal(false);

      const equal = decide([-80, -60, 30, 40, 50], { mode: "enforce" });
      expect(equal.skip).to.equal(false);
      expect(equal.wouldFilter).to.equal(false);
    });

    it("fails open when the floor is absent or invalid", function () {
      const invalidFloors = [undefined, null, -1, 1.5, "30", 10001];

      for (const minProfitBps of invalidFloors) {
        const pair = minProfitBps === undefined ? {} : { minProfitBps };
        const decision = decide([-80, -60, -40, -20, -10], { pair });

        expect(decision.skip).to.equal(false);
        expect(decision.wouldFilter).to.equal(false);
        expect(decision.reason).to.equal("INVALID_FLOOR");
        expect(decision.floor).to.equal(null);
        expect(decision.sampleCount).to.equal(0);
      }
    });

    it("fails open on invalid sample data", function () {
      const invalidBps = decide([], {
        samples: [{ netProfitBps: "abc", at: NOW }],
      });
      expect(invalidBps.skip).to.equal(false);
      expect(invalidBps.reason).to.equal("INVALID_SAMPLES");
      expect(invalidBps.floor).to.equal(30n);

      const invalidAt = decide([], {
        samples: [{ netProfitBps: "-1", at: 1.5 }],
      });
      expect(invalidAt.reason).to.equal("INVALID_SAMPLES");

      const nonArray = decide([], { samples: null });
      expect(nonArray.reason).to.equal("INVALID_SAMPLES");
    });

    it("rejects an unknown mode", function () {
      expect(() =>
        decidePairSpread({
          pair: { minProfitBps: 30 },
          samples: [],
          mode: "bogus",
          now: NOW,
        })
      ).to.throw(/Invalid pair spread filter mode/);
    });

    it("does not mutate the samples array", function () {
      const samples = makeSamples([-80, -60, -40, -20, -10]);
      const before = samples.map((sample) => ({ ...sample }));

      const decision = decidePairSpread({
        pair: { minProfitBps: 30 },
        samples,
        now: NOW,
        mode: "enforce",
      });

      expect(decision.skip).to.equal(true);
      expect(samples.length).to.equal(before.length);
      for (let i = 0; i < samples.length; i += 1) {
        expect(samples[i].netProfitBps).to.equal(before[i].netProfitBps);
        expect(samples[i].at).to.equal(before[i].at);
      }
    });
  });
});
