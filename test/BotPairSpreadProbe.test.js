const { expect } = require("chai");
const {
  DEFAULT_PROBE_INTERVAL_MS,
  DEFAULT_PROBE_MAX_PER_CYCLE,
  validateProbeIntervalMs,
  validateProbeMaxPerCycle,
  initProbeHistoryFromState,
  selectProbeCandidates,
  recordProbeAttempt,
} = require("../bot/pairSpreadProbe");

const NOW = 1_760_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function candidate(key, label = key) {
  return { key, pair: { label } };
}

function baseContract(overrides = {}) {
  return {
    candidates: [],
    history: new Map(),
    pairSpreadNow: NOW,
    probeNow: NOW,
    intervalMs: MINUTE_MS,
    globalIntervalMs: 0,
    lastGlobalProbeAt: null,
    suspendedUntil: 0,
    maxPerCycle: 1,
    cursorKey: null,
    ...overrides,
  };
}

function select(overrides = {}) {
  return selectProbeCandidates(baseContract(overrides));
}

function selectedKeys(result) {
  return result.selected.map((entry) => entry.key);
}

function pending(key, at, overrides = {}) {
  return {
    key,
    at,
    outcome: "failure",
    source: "probe",
    ...overrides,
  };
}

describe("bot/pairSpreadProbe", function () {
  describe("configuration defaults and validators", function () {
    it("exports the disabled defaults", function () {
      expect(DEFAULT_PROBE_INTERVAL_MS).to.equal(0);
      expect(DEFAULT_PROBE_MAX_PER_CYCLE).to.equal(1);
    });

    it("validates intervalMs as a non-negative integer", function () {
      expect(validateProbeIntervalMs(0)).to.equal(0);
      expect(validateProbeIntervalMs(HOUR_MS)).to.equal(HOUR_MS);

      for (const value of [-1, 1.5, NaN, Infinity, "60000", null, undefined]) {
        expect(() => validateProbeIntervalMs(value)).to.throw(/non-negative integer/);
      }
    });

    it("bounds maxPerCycle to 1..10", function () {
      expect(validateProbeMaxPerCycle(1)).to.equal(1);
      expect(validateProbeMaxPerCycle(10)).to.equal(10);

      for (const value of [0, 11, -1, 1.5, NaN, Infinity, "1", null, undefined]) {
        expect(() => validateProbeMaxPerCycle(value)).to.throw(/integer >= 1/);
      }
    });
  });

  describe("contract validation", function () {
    it("rejects every missing required parameter", function () {
      const required = [
        "candidates",
        "history",
        "pairSpreadNow",
        "probeNow",
        "intervalMs",
        "globalIntervalMs",
        "lastGlobalProbeAt",
        "suspendedUntil",
        "maxPerCycle",
        "cursorKey",
      ];

      for (const name of required) {
        const contract = baseContract();
        delete contract[name];
        expect(() => selectProbeCandidates(contract), name).to.throw(
          new RegExp(name)
        );
      }
    });

    it("rejects invalid containers and optional collections", function () {
      expect(() => select({ candidates: null })).to.throw(/candidates/);
      expect(() => select({ candidates: {} })).to.throw(/candidates/);
      expect(() => select({ history: {} })).to.throw(/history must be a Map/);
      expect(() => select({ scannedKeys: [] })).to.throw(/scannedKeys must be a Set/);
      expect(() => select({ probedKeys: new Map() })).to.throw(/probedKeys must be a Set/);
      expect(() => select({ pendingAttempts: {} })).to.throw(
        /pendingAttempts must be a Map/
      );
    });

    it("rejects invalid clocks, intervals and sentinels", function () {
      const invalidNumbers = [-1, 1.5, NaN, Infinity, "60000", null];

      for (const value of invalidNumbers) {
        expect(() => select({ pairSpreadNow: value })).to.throw(/pairSpreadNow/);
        expect(() => select({ probeNow: value })).to.throw(/probeNow/);
        expect(() => select({ intervalMs: value })).to.throw(/intervalMs/);
        expect(() => select({ globalIntervalMs: value })).to.throw(/globalIntervalMs/);
        expect(() => select({ suspendedUntil: value })).to.throw(/suspendedUntil/);
      }

      for (const value of [-1, 1.5, NaN, Infinity, "0"]) {
        expect(() => select({ lastGlobalProbeAt: value })).to.throw(
          /lastGlobalProbeAt/
        );
      }
      expect(select({ lastGlobalProbeAt: null }).selected).to.deep.equal([]);
      expect(select({ lastGlobalProbeAt: 0 }).selected).to.deep.equal([]);

      for (const value of ["", 0, false, [], {}]) {
        expect(() => select({ cursorKey: value })).to.throw(/cursorKey/);
      }
      expect(select({ cursorKey: null }).selected).to.deep.equal([]);
      expect(select({ cursorKey: "a" }).selected).to.deep.equal([]);
    });

    it("rejects maxPerCycle outside 1..10 before the preamble", function () {
      for (const value of [0, 11, -1, 1.5, NaN, Infinity, "2", null]) {
        expect(() => select({ maxPerCycle: value })).to.throw(/maxPerCycle/);
      }

      expect(() =>
        select({ intervalMs: 0, maxPerCycle: 11 })
      ).to.throw(/maxPerCycle/);
      expect(() =>
        select({ suspendedUntil: NOW + 1, maxPerCycle: 11 })
      ).to.throw(/maxPerCycle/);
    });

    it("validates candidate elements but ignores unstable keys", function () {
      expect(() => select({ candidates: [null] })).to.throw(/candidates\[0\]/);
      expect(() => select({ candidates: [[]] })).to.throw(/candidates\[0\]/);
      expect(() => select({ candidates: [{ key: "a" }] })).to.throw(/pair/);
      expect(() => select({ candidates: [{ key: "a", pair: null }] })).to.throw(/pair/);
      expect(() => select({ candidates: [{ key: "a", pair: [] }] })).to.throw(/pair/);
      expect(() => select({ candidates: [{ key: "a", pair: "x" }] })).to.throw(/pair/);

      const result = select({
        candidates: [
          { key: "", pair: null },
          { key: 42, pair: null },
          candidate("a"),
        ],
        maxPerCycle: 1,
      });
      expect(selectedKeys(result)).to.deep.equal(["a"]);
      expect(result.nextCursorKey).to.equal("a");
    });

    it("rejects malformed history entries", function () {
      expect(() => select({ history: new Map([["a", -1]]) })).to.throw(/history/);
      expect(() => select({ history: new Map([["a", 1.5]]) })).to.throw(/history/);
      expect(() => select({ history: new Map([["", NOW]]) })).to.throw(/history/);
    });

    it("rejects malformed pending attempts and map-key mismatches", function () {
      const invalidMaps = [
        new Map([["a", null]]),
        new Map([["a", pending("b", NOW)]]),
        new Map([["a", pending("a", 0)]]),
        new Map([["a", pending("a", NOW, { outcome: "bogus" })]]),
        new Map([["a", pending("a", NOW, { source: "bogus" })]]),
        new Map([["a", pending("a", NOW, { reason: "lowercase" })]]),
        new Map([["a", pending("a", NOW, { reason: "" })]]),
        new Map([[42, { key: 42, at: NOW, outcome: "failure", source: "probe" }]]),
      ];

      for (const map of invalidMaps) {
        expect(() => select({ pendingAttempts: map })).to.throw(/pendingAttempts/);
      }

      expect(() =>
        select({
          pendingAttempts: new Map([["a", pending("a", NOW, { reason: "SCAN_ERROR" })]]),
        })
      ).to.not.throw();
    });

    it("rejects non-string entries in scannedKeys and probedKeys", function () {
      expect(() => select({ scannedKeys: new Set([""]) })).to.throw(/scannedKeys/);
      expect(() => select({ scannedKeys: new Set([1]) })).to.throw(/scannedKeys/);
      expect(() => select({ probedKeys: new Set([null]) })).to.throw(/probedKeys/);
    });
  });

  describe("initProbeHistoryFromState", function () {
    it("uses the latest sample timestamp per key", function () {
      const state = {
        version: 2,
        pairs: {
          a: {
            samples: [{ at: NOW - 10 * MINUTE_MS }, { at: NOW - 2 * MINUTE_MS }],
            attempts: [],
          },
          b: { samples: [{ at: NOW - 5 * MINUTE_MS }], attempts: [] },
          c: { samples: [], attempts: [] },
        },
      };

      const history = initProbeHistoryFromState(state);
      expect(history.get("a")).to.equal(NOW - 2 * MINUTE_MS);
      expect(history.get("b")).to.equal(NOW - 5 * MINUTE_MS);
      expect(history.has("c")).to.equal(false);
    });

    it("includes attempts-only pairs and the latest attempt", function () {
      const state = {
        pairs: {
          a: {
            samples: [],
            attempts: [
              { at: NOW - 10 * MINUTE_MS, outcome: "failure", source: "probe" },
              { at: NOW - 3 * MINUTE_MS, outcome: "empty", source: "probe" },
            ],
          },
          b: { samples: [], attempts: [] },
        },
      };

      const history = initProbeHistoryFromState(state);
      expect(history.get("a")).to.equal(NOW - 3 * MINUTE_MS);
      expect(history.has("b")).to.equal(false);
    });

    it("takes the maximum across samples and attempts", function () {
      const state = {
        pairs: {
          sampleWins: {
            samples: [{ at: NOW - MINUTE_MS }],
            attempts: [{ at: NOW - 5 * MINUTE_MS, outcome: "failure", source: "scan" }],
          },
          attemptWins: {
            samples: [{ at: NOW - 5 * MINUTE_MS }],
            attempts: [{ at: NOW - MINUTE_MS, outcome: "success", source: "probe" }],
          },
          tie: {
            samples: [{ at: NOW }],
            attempts: [{ at: NOW, outcome: "success", source: "probe" }],
          },
        },
      };

      const history = initProbeHistoryFromState(state);
      expect(history.get("sampleWins")).to.equal(NOW - MINUTE_MS);
      expect(history.get("attemptWins")).to.equal(NOW - MINUTE_MS);
      expect(history.get("tie")).to.equal(NOW);
    });

    it("treats absent and empty arrays as empty", function () {
      const history = initProbeHistoryFromState({
        pairs: {
          samplesOnly: { samples: [{ at: NOW }] },
          attemptsOnly: { attempts: [{ at: NOW, outcome: "failure", source: "probe" }] },
          empty: {},
          explicitEmpty: { samples: [], attempts: [] },
        },
      });

      expect(history.get("samplesOnly")).to.equal(NOW);
      expect(history.get("attemptsOnly")).to.equal(NOW);
      expect(history.has("empty")).to.equal(false);
      expect(history.has("explicitEmpty")).to.equal(false);
    });

    it("returns an empty history for a missing state or missing pairs", function () {
      expect(initProbeHistoryFromState().size).to.equal(0);
      expect(initProbeHistoryFromState({}).size).to.equal(0);
      expect(initProbeHistoryFromState({ pairs: {} }).size).to.equal(0);
    });

    it("does not mutate the state", function () {
      const state = {
        version: 2,
        pairs: {
          a: {
            samples: [{ netProfitBps: "1", at: NOW - 2 * MINUTE_MS }],
            attempts: [{ at: NOW, outcome: "failure", source: "probe" }],
          },
        },
      };
      const snapshot = JSON.parse(JSON.stringify(state));

      initProbeHistoryFromState(state);
      expect(state).to.deep.equal(snapshot);
    });

    it("keeps a future timestamp for the scheduler to exclude", function () {
      const history = initProbeHistoryFromState({
        pairs: {
          a: {
            samples: [{ at: NOW + 1 }],
            attempts: [],
          },
        },
      });

      expect(history.get("a")).to.equal(NOW + 1);

      const result = select({
        candidates: [candidate("a")],
        history,
        pairSpreadNow: NOW,
        maxPerCycle: 1,
      });
      expect(selectedKeys(result)).to.deep.equal([]);
      expect(result.nextCursorKey).to.equal("a");
    });

    it("does not read or apply a pendingAttempts field from the state", function () {
      const state = {
        pairs: { a: { samples: [], attempts: [] } },
        pendingAttempts: new Map([["a", pending("a", NOW)]]),
      };

      const history = initProbeHistoryFromState(state);
      expect(history.has("a")).to.equal(false);
    });

    it("rejects malformed state entries", function () {
      const invalidStates = [
        null,
        { pairs: [] },
        { pairs: { a: null } },
        { pairs: { a: { samples: {} } } },
        { pairs: { a: { samples: [null] } } },
        { pairs: { a: { samples: [{ at: -1 }] } } },
        { pairs: { a: { samples: [{ at: 1.5 }] } } },
        { pairs: { a: { attempts: {} } } },
        { pairs: { a: { attempts: [null] } } },
        { pairs: { a: { attempts: [{ at: 0 }] } } },
        { pairs: { a: { attempts: [{ at: 1.5 }] } } },
        { pairs: { "": { samples: [], attempts: [] } } },
      ];

      for (const state of invalidStates) {
        expect(() => initProbeHistoryFromState(state)).to.throw();
      }
    });
  });

  describe("selection eligibility", function () {
    it("accepts a never-observed pair with the -1 sentinel", function () {
      const result = select({
        candidates: [candidate("a")],
        pairSpreadNow: 0,
        probeNow: 0,
        maxPerCycle: 1,
      });

      expect(selectedKeys(result)).to.deep.equal(["a"]);
      expect(result.selected[0]).to.deep.equal({
        key: "a",
        pair: { label: "a" },
        lastAt: -1,
      });
    });

    it("applies the per-pair interval on pairSpreadNow, not probeNow", function () {
      const history = new Map([["a", NOW]]);

      const tooEarly = select({
        candidates: [candidate("a"), candidate("b")],
        history,
        pairSpreadNow: NOW,
        probeNow: NOW + HOUR_MS,
        intervalMs: MINUTE_MS,
        maxPerCycle: 2,
      });
      expect(selectedKeys(tooEarly)).to.deep.equal(["b"]);

      const onTime = select({
        candidates: [candidate("a"), candidate("b")],
        history,
        pairSpreadNow: NOW + MINUTE_MS,
        probeNow: NOW + HOUR_MS,
        intervalMs: MINUTE_MS,
        maxPerCycle: 2,
      });
      expect(selectedKeys(onTime)).to.deep.equal(["a", "b"]);
      expect(onTime.selected[0].lastAt).to.equal(NOW);
    });

    it("excludes a future persisted timestamp", function () {
      const result = select({
        candidates: [candidate("a"), candidate("b")],
        history: new Map([["a", NOW + 1]]),
        pairSpreadNow: NOW,
        maxPerCycle: 2,
      });

      expect(selectedKeys(result)).to.deep.equal(["b"]);
      expect(result.nextCursorKey).to.equal("b");
    });

    it("allows the first batch when lastGlobalProbeAt is null", function () {
      const result = select({
        candidates: [candidate("a")],
        globalIntervalMs: HOUR_MS,
        lastGlobalProbeAt: null,
        probeNow: NOW,
        maxPerCycle: 1,
      });

      expect(selectedKeys(result)).to.deep.equal(["a"]);
    });

    it("applies the global throttle to probeNow", function () {
      const candidates = [candidate("a")];

      const blocked = select({
        candidates,
        globalIntervalMs: MINUTE_MS,
        lastGlobalProbeAt: NOW,
        probeNow: NOW + MINUTE_MS - 1,
        cursorKey: "a",
      });
      expect(blocked).to.deep.equal({ selected: [], nextCursorKey: "a" });

      const allowed = select({
        candidates,
        globalIntervalMs: MINUTE_MS,
        lastGlobalProbeAt: NOW,
        probeNow: NOW + MINUTE_MS,
        cursorKey: "a",
      });
      expect(selectedKeys(allowed)).to.deep.equal(["a"]);
      expect(allowed.nextCursorKey).to.equal("a");
    });

    it("blocks the batch when the probe clock moves backwards", function () {
      const result = select({
        candidates: [candidate("a")],
        globalIntervalMs: MINUTE_MS,
        lastGlobalProbeAt: NOW,
        probeNow: NOW - 1,
      });

      expect(result).to.deep.equal({ selected: [], nextCursorKey: null });
    });

    it("treats globalIntervalMs=0 as no global throttle", function () {
      const result = select({
        candidates: [candidate("a")],
        globalIntervalMs: 0,
        lastGlobalProbeAt: NOW,
        probeNow: NOW,
        maxPerCycle: 1,
      });

      expect(selectedKeys(result)).to.deep.equal(["a"]);
    });

    it("checks suspension before selection", function () {
      const suspended = select({
        candidates: [candidate("a")],
        suspendedUntil: NOW + 1,
        probeNow: NOW,
        cursorKey: "a",
      });
      expect(suspended).to.deep.equal({ selected: [], nextCursorKey: "a" });

      const atBoundary = select({
        candidates: [candidate("a")],
        suspendedUntil: NOW,
        probeNow: NOW,
      });
      expect(selectedKeys(atBoundary)).to.deep.equal(["a"]);
    });

    it("returns an empty batch and preserves the cursor when intervalMs=0", function () {
      const result = select({
        candidates: [candidate("a")],
        intervalMs: 0,
        cursorKey: "a",
        maxPerCycle: 10,
      });

      expect(result).to.deep.equal({ selected: [], nextCursorKey: "a" });
    });

    it("excludes scanned and probed keys without consuming a slot", function () {
      const candidates = [candidate("a"), candidate("b"), candidate("c")];

      const scanned = select({
        candidates,
        scannedKeys: new Set(["a"]),
        maxPerCycle: 2,
      });
      expect(selectedKeys(scanned)).to.deep.equal(["b", "c"]);
      expect(scanned.nextCursorKey).to.equal("c");

      const probed = select({
        candidates,
        probedKeys: new Set(["b"]),
        maxPerCycle: 2,
      });
      expect(selectedKeys(probed)).to.deep.equal(["a", "c"]);
      expect(probed.nextCursorKey).to.equal("c");
    });

    it("examines a D5-excluded key and can advance the cursor past it", function () {
      const result = select({
        candidates: [candidate("a")],
        scannedKeys: new Set(["a"]),
        maxPerCycle: 1,
      });

      expect(result.selected).to.deep.equal([]);
      expect(result.nextCursorKey).to.equal("a");
    });

    it("deduplicates keys and keeps the first pair reference", function () {
      const firstPair = { label: "first" };
      const secondPair = { label: "second" };
      const result = select({
        candidates: [
          { key: "dup", pair: firstPair },
          candidate("other"),
          { key: "dup", pair: secondPair },
        ],
        maxPerCycle: 3,
      });

      expect(selectedKeys(result)).to.deep.equal(["dup", "other"]);
      expect(result.selected[0].pair).to.equal(firstPair);
      expect(result.selected[0].pair).to.not.equal(secondPair);
    });

    it("orders all candidates lexicographically regardless of input order", function () {
      const forward = select({
        candidates: [candidate("c"), candidate("a"), candidate("b")],
        maxPerCycle: 3,
      });
      const reverse = select({
        candidates: [candidate("b"), candidate("c"), candidate("a")],
        maxPerCycle: 3,
      });

      expect(selectedKeys(forward)).to.deep.equal(["a", "b", "c"]);
      expect(selectedKeys(reverse)).to.deep.equal(["a", "b", "c"]);
      expect(forward.nextCursorKey).to.equal("c");
      expect(reverse.nextCursorKey).to.equal("c");
    });

    it("applies the pendingAttempts overlay without modifying persisted history", function () {
      const history = new Map([["a", NOW - 2 * MINUTE_MS]]);
      const pendingAttempts = new Map([["a", pending("a", NOW - 30_000)]]);
      const beforeHistory = Array.from(history.entries());

      const result = select({
        candidates: [candidate("a"), candidate("b")],
        history,
        pendingAttempts,
        maxPerCycle: 2,
      });

      expect(selectedKeys(result)).to.deep.equal(["b"]);
      expect(Array.from(history.entries())).to.deep.equal(beforeHistory);
      expect(pendingAttempts.size).to.equal(1);
    });

    it("keeps the maximum when persisted history is newer than a pending attempt", function () {
      const result = select({
        candidates: [candidate("a"), candidate("b")],
        history: new Map([["a", NOW - 30_000]]),
        pendingAttempts: new Map([["a", pending("a", NOW - 2 * MINUTE_MS)]]),
        maxPerCycle: 2,
      });

      expect(selectedKeys(result)).to.deep.equal(["b"]);
    });

    it("does not create a candidate from a pending attempt alone", function () {
      const result = select({
        candidates: [candidate("a")],
        pendingAttempts: new Map([["z", pending("z", NOW)]]),
        maxPerCycle: 2,
      });

      expect(selectedKeys(result)).to.deep.equal(["a"]);
    });

    it("treats a pending attempt newer than pairSpreadNow as future", function () {
      const result = select({
        candidates: [candidate("a")],
        pendingAttempts: new Map([["a", pending("a", NOW + 1)]]),
        pairSpreadNow: NOW,
      });

      expect(result.selected).to.deep.equal([]);
      expect(result.nextCursorKey).to.equal("a");
    });
  });

  describe("cursor and circular traversal", function () {
    const candidates = [candidate("a"), candidate("b"), candidate("c")];

    it("starts at the first lexical key when cursorKey is null", function () {
      const result = select({ candidates, maxPerCycle: 1 });
      expect(selectedKeys(result)).to.deep.equal(["a"]);
      expect(result.nextCursorKey).to.equal("a");
    });

    it("starts at the key immediately after cursorKey", function () {
      const result = select({ candidates, cursorKey: "a", maxPerCycle: 1 });
      expect(selectedKeys(result)).to.deep.equal(["b"]);
      expect(result.nextCursorKey).to.equal("b");
    });

    it("wraps when cursorKey is the last key", function () {
      const result = select({ candidates, cursorKey: "c", maxPerCycle: 1 });
      expect(selectedKeys(result)).to.deep.equal(["a"]);
      expect(result.nextCursorKey).to.equal("a");
    });

    it("starts at the first lexical key when cursorKey is absent", function () {
      const missingBetween = select({
        candidates: [candidate("a"), candidate("c"), candidate("d")],
        cursorKey: "b",
        maxPerCycle: 1,
      });
      expect(selectedKeys(missingBetween)).to.deep.equal(["a"]);

      const missingAfter = select({
        candidates,
        cursorKey: "z",
        maxPerCycle: 1,
      });
      expect(selectedKeys(missingAfter)).to.deep.equal(["a"]);
    });

    it("examines a unique candidate once when cursorKey equals it", function () {
      const result = select({
        candidates: [candidate("only")],
        cursorKey: "only",
        maxPerCycle: 5,
      });

      expect(selectedKeys(result)).to.deep.equal(["only"]);
      expect(result.selected).to.have.length(1);
      expect(result.nextCursorKey).to.equal("only");
    });

    it("stops immediately after maxPerCycle selections", function () {
      const result = select({
        candidates: [candidate("a"), candidate("b"), candidate("c"), candidate("d")],
        maxPerCycle: 2,
      });

      expect(selectedKeys(result)).to.deep.equal(["a", "b"]);
      expect(result.nextCursorKey).to.equal("b");
    });

    it("examines every key and returns the last examined when none is eligible", function () {
      const history = new Map(candidates.map((entry) => [entry.key, NOW]));

      const fromNull = select({ candidates, history, maxPerCycle: 2 });
      expect(fromNull.selected).to.deep.equal([]);
      expect(fromNull.nextCursorKey).to.equal("c");

      const fromCursor = select({
        candidates,
        history,
        cursorKey: "b",
        maxPerCycle: 2,
      });
      expect(fromCursor.selected).to.deep.equal([]);
      expect(fromCursor.nextCursorKey).to.equal("b");
    });

    it("returns cursorKey when the candidate list is empty", function () {
      expect(select({ candidates: [], cursorKey: null })).to.deep.equal({
        selected: [],
        nextCursorKey: null,
      });
      expect(select({ candidates: [], cursorKey: "x" })).to.deep.equal({
        selected: [],
        nextCursorKey: "x",
      });
    });

    it("returns the last examined key when fewer than maxPerCycle are eligible", function () {
      const result = select({
        candidates,
        history: new Map([["a", NOW]]),
        maxPerCycle: 5,
      });

      expect(selectedKeys(result)).to.deep.equal(["b", "c"]);
      expect(result.nextCursorKey).to.equal("c");
    });

    it("does not skip a selected key that was not started after a cancellation", function () {
      const all = [candidate("a"), candidate("b"), candidate("c")];

      const first = select({ candidates: all, maxPerCycle: 2 });
      expect(selectedKeys(first)).to.deep.equal(["a", "b"]);
      expect(first.nextCursorKey).to.equal("b");

      // Only `a` was started; `b` was selected but cancelled before the
      // wrapper. The runtime cursor stays at the last resolved key `a`.
      const retry = select({ candidates: all, cursorKey: "a", maxPerCycle: 2 });
      expect(selectedKeys(retry)).to.deep.equal(["b", "c"]);

      // Advancing the runtime cursor to `nextCursorKey` would skip `b`; the
      // scheduler alone cannot decide this, the runtime rule must keep `a`.
      const advanced = select({ candidates: all, cursorKey: "b", maxPerCycle: 2 });
      expect(selectedKeys(advanced)).to.deep.equal(["c", "a"]);
    });
  });

  describe("fairness batches", function () {
    it("covers N=3, M=2 in every window of ceil(3/2)=2 batches", function () {
      const all = [candidate("a"), candidate("b"), candidate("c")];
      let cursor = null;
      const batches = [];

      for (let index = 0; index < 6; index += 1) {
        const result = select({ candidates: all, cursorKey: cursor, maxPerCycle: 2 });
        batches.push(selectedKeys(result));
        cursor = result.nextCursorKey;
      }

      expect(batches).to.deep.equal([
        ["a", "b"],
        ["c", "a"],
        ["b", "c"],
        ["a", "b"],
        ["c", "a"],
        ["b", "c"],
      ]);

      for (let index = 0; index + 1 < batches.length; index += 1) {
        const window = Array.from(
          new Set([...batches[index], ...batches[index + 1]])
        ).sort();
        expect(window).to.deep.equal(["a", "b", "c"]);
      }
    });

    it("covers N=5, M=2 in every window of ceil(5/2)=3 batches", function () {
      const keys = ["a", "b", "c", "d", "e"];
      const all = keys.map((key) => candidate(key));
      let cursor = null;
      const batches = [];

      for (let index = 0; index < 6; index += 1) {
        const result = select({ candidates: all, cursorKey: cursor, maxPerCycle: 2 });
        batches.push(selectedKeys(result));
        cursor = result.nextCursorKey;
      }

      expect(batches).to.deep.equal([
        ["a", "b"],
        ["c", "d"],
        ["e", "a"],
        ["b", "c"],
        ["d", "e"],
        ["a", "b"],
      ]);

      for (let index = 0; index + 2 < batches.length; index += 1) {
        const window = Array.from(
          new Set([
            ...batches[index],
            ...batches[index + 1],
            ...batches[index + 2],
          ])
        ).sort();
        expect(window).to.deep.equal(keys);
      }

      const positions = new Map(keys.map((key) => [key, []]));
      batches.forEach((batch, index) => {
        for (const key of batch) positions.get(key).push(index);
      });

      for (const [key, indexes] of positions) {
        expect(indexes.length, key).to.be.at.least(2);
        for (let index = 1; index < indexes.length; index += 1) {
          expect(indexes[index] - indexes[index - 1], key).to.be.oneOf([2, 3]);
        }
      }
    });
  });

  describe("input safety", function () {
    it("does not mutate candidates, history, pendingAttempts or key sets", function () {
      const candidates = [candidate("b"), candidate("a")];
      const history = new Map([["a", NOW - 2 * MINUTE_MS]]);
      const pendingAttempts = new Map([
        ["b", pending("b", NOW - 2 * MINUTE_MS)],
      ]);
      const scannedKeys = new Set(["c"]);
      const probedKeys = new Set(["d"]);
      const candidatesSnapshot = JSON.parse(JSON.stringify(candidates));
      const historyBefore = Array.from(history.entries());
      const pendingBefore = Array.from(pendingAttempts.entries());
      const scannedBefore = Array.from(scannedKeys);
      const probedBefore = Array.from(probedKeys);

      select({
        candidates,
        history,
        pendingAttempts,
        scannedKeys,
        probedKeys,
        maxPerCycle: 2,
      });

      expect(candidates).to.deep.equal(candidatesSnapshot);
      expect(Array.from(history.entries())).to.deep.equal(historyBefore);
      expect(Array.from(pendingAttempts.entries())).to.deep.equal(pendingBefore);
      expect(Array.from(scannedKeys)).to.deep.equal(scannedBefore);
      expect(Array.from(probedKeys)).to.deep.equal(probedBefore);
    });

    it("returns fresh arrays and entries while keeping pair references", function () {
      const pairA = { label: "a" };
      const candidates = [{ key: "a", pair: pairA }];

      const first = select({ candidates });
      expect(first.selected).to.be.an("array").with.length(1);
      expect(first.selected[0]).to.not.equal(candidates[0]);
      expect(first.selected[0]).to.deep.equal({
        key: "a",
        pair: pairA,
        lastAt: -1,
      });
      expect(first.selected[0].pair).to.equal(pairA);

      const second = select({ candidates });
      expect(second.selected).to.not.equal(first.selected);
      expect(second.selected[0]).to.not.equal(first.selected[0]);
      expect(second.selected[0]).to.deep.equal(first.selected[0]);
    });

    it("is deterministic for identical fixed inputs", function () {
      const contract = baseContract({
        candidates: [candidate("c"), candidate("a"), candidate("b")],
        maxPerCycle: 2,
      });

      const first = selectProbeCandidates(contract);
      const second = selectProbeCandidates(contract);
      expect(second).to.deep.equal(first);
      expect(second.selected).to.not.equal(first.selected);
    });
  });

  describe("recordProbeAttempt", function () {
    it("returns a new Map and never mutates the input", function () {
      const history = new Map([["a", NOW - MINUTE_MS]]);
      const next = recordProbeAttempt({ history, key: "a", at: NOW });

      expect(next).to.not.equal(history);
      expect(history.get("a")).to.equal(NOW - MINUTE_MS);
      expect(next.get("a")).to.equal(NOW);
    });

    it("adds a new key to a default empty history", function () {
      const next = recordProbeAttempt({ key: "a", at: NOW });
      expect(next.get("a")).to.equal(NOW);
    });

    it("never moves an attempt backwards", function () {
      const history = new Map([["a", NOW]]);
      const next = recordProbeAttempt({
        history,
        key: "a",
        at: NOW - MINUTE_MS,
      });

      expect(next).to.not.equal(history);
      expect(next.get("a")).to.equal(NOW);
    });

    it("rejects invalid keys, timestamps and history containers", function () {
      expect(() =>
        recordProbeAttempt({ history: new Map(), key: "", at: NOW })
      ).to.throw(/key/);
      expect(() =>
        recordProbeAttempt({ history: new Map(), key: "a", at: 0 })
      ).to.throw(/at/);
      expect(() =>
        recordProbeAttempt({ history: new Map(), key: "a", at: -1 })
      ).to.throw(/at/);
      expect(() =>
        recordProbeAttempt({ history: {}, key: "a", at: NOW })
      ).to.throw(/history must be a Map/);
    });
  });
});
