const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main: mainImpl } = require("../bot/index");
const { createThrottle } = require("../bot/throttle");
const { buildPairKey } = require("../bot/pairSpread");
const {
  PAIR_SPREAD_STORE_CODES,
  loadPairSpreadState,
  recordPairSpreadCommit,
} = require("../bot/pairSpreadStore");

// Every cycle gets a fresh, non-waiting throttle. Otherwise the module-level
// singleton created by other test files would wait between RPC calls when a
// clock-controlled test moves Date.now.
function main(options = {}) {
  return mainImpl({
    throttle: createThrottle({ minIntervalMs: 0 }),
    ...options,
  });
}

describe("bot/index pair-spread probes integration", function () {
  const tmpDirs = [];

  function makeTmpDir(prefix = "flash-arb-probe-") {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(function () {
    while (tmpDirs.length > 0) {
      fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
    }
  });

  function addressFromByte(byte) {
    // Keep the helper usable for byte values above 255 while still producing
    // exactly 40 hex characters (20 bytes).
    return `0x${(byte % 256).toString(16).padStart(2, "0").repeat(20)}`;
  }

  function makePair(byte, overrides = {}) {
    const borrowed = addressFromByte(byte);
    const intermediate = addressFromByte(byte + 1);
    return {
      label: `PROBE pair ${byte}`,
      profile: "majors",
      minProfitBps: 30,
      borrowedToken: { address: borrowed, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: intermediate, decimals: 18, symbol: "MID" },
      legOut: {
        kind: "V2",
        router: addressFromByte(byte + 2),
        tokenOut: intermediate,
      },
      legBack: {
        kind: "V2",
        router: addressFromByte(byte + 3),
        tokenOut: borrowed,
      },
      tradeSizes: ["1000"],
      ...overrides,
    };
  }

  function makeProvider({ chainId = "0x7a69", blockNumber = 777 } = {}) {
    const calls = [];
    return {
      calls,
      async send(method) {
        calls.push(method);
        if (method === "eth_chainId") return chainId;
        throw new Error(`unexpected method ${method}`);
      },
      async getFeeData() {
        calls.push("getFeeData");
        return { gasPrice: 1n, maxFeePerGas: null };
      },
      async getBlockNumber() {
        calls.push("getBlockNumber");
        return blockNumber;
      },
    };
  }

  function makeConfig(tmpDir, overrides = {}) {
    return {
      dryRun: true,
      pairs: [],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 0,
      expectedChainId: 31337,
      scanLogPath: path.join(tmpDir, "scans.jsonl"),
      adaptivePath: path.join(tmpDir, "adaptive.json"),
      rpcErrorsPath: path.join(tmpDir, "rpc_errors.json"),
      gasHistoryPath: path.join(tmpDir, "gas_history.json"),
      executionJournalPath: path.join(tmpDir, "executions.json"),
      pairSpreadMode: "enforce",
      pairSpreadPath: path.join(tmpDir, "pair_spreads.json"),
      // Integration tests use a 1 ms interval so a just-written sample does not
      // delay eligibility. Real activations use much larger values (D12).
      pairSpreadProbeIntervalMs: 1,
      pairSpreadProbeGlobalIntervalMs: 1,
      pairSpreadProbeMaxPerCycle: 1,
      ...overrides,
    };
  }

  function freshRuntime() {
    return {
      lastGlobalProbeAt: null,
      writeFailures: 0,
      suspendedUntil: 0,
      pendingAttempts: new Map(),
      cursorKey: null,
    };
  }

  function pairSpreadSamplesAt(keys, values) {
    return values.map((value, index) => ({
      netProfitBps: String(value),
      at: keys - (values.length - 1 - index) * 60_000,
    }));
  }

  function lowSamples(now = Date.now()) {
    // End one minute in the past so a 1 ms probe interval is always due,
    // regardless of how quickly the test starts the cycle.
    return pairSpreadSamplesAt(now - 60_000, [-80, -60, -40, -20, -10]);
  }

  function writePairSpreadFile(filePath, pairs) {
    const normalized = {};
    for (const [key, entry] of Object.entries(pairs)) {
      normalized[key] = {
        samples: entry.samples ?? [],
        attempts: entry.attempts ?? [],
      };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ version: 2, pairs: normalized }, null, 2)}\n`,
      "utf8"
    );
  }

  function readPairSpreadFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }

  function scanResult(overrides = {}) {
    return {
      tradeSizeHuman: "1000",
      grossProfit: 1n,
      netProfitUsd: null,
      isOpportunity: false,
      amountIn: 1_000_000n,
      netProfitBps: 0n,
      ...overrides,
    };
  }

  function commitOk(overrides = {}) {
    return {
      ok: true,
      written: true,
      writable: true,
      status: "ok",
      added: 0,
      attemptsAdded: 0,
      expiredPruned: 0,
      warning: null,
      error: null,
      ...overrides,
    };
  }

  function commitWriteFailed(overrides = {}) {
    return {
      ok: false,
      written: false,
      writable: true,
      status: "ok",
      added: 0,
      attemptsAdded: 0,
      expiredPruned: 0,
      warning: "write failed",
      error: { code: PAIR_SPREAD_STORE_CODES.WRITE_FAILED },
      ...overrides,
    };
  }

  async function captureConsole(fn) {
    const logs = [];
    const warnings = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args) => logs.push(args.map(String).join(" "));
    console.warn = (...args) => warnings.push(args.map(String).join(" "));
    try {
      const result = await fn();
      return { result, logs, warnings };
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }
  }

  async function captureJson(fn) {
    const previous = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = "json";
    try {
      const captured = await captureConsole(fn);
      const events = [];
      for (const line of [...captured.logs, ...captured.warnings]) {
        try {
          events.push(JSON.parse(line));
        } catch {
          // Plain-text lines are not structured pair-spread events.
        }
      }
      return { ...captured, events };
    } finally {
      if (previous === undefined) delete process.env.LOG_FORMAT;
      else process.env.LOG_FORMAT = previous;
    }
  }

  function eventsNamed(captured, name) {
    return captured.events.filter((event) => event.event === name);
  }

  async function withMutableClock(initial, fn) {
    const original = Date.now;
    const clock = { now: initial };
    Date.now = () => clock.now;
    try {
      return await fn(clock);
    } finally {
      Date.now = original;
    }
  }

  function probeEvents(captured) {
    return eventsNamed(captured, "pair_spread_probe");
  }

  function lastAttempt(stored, key) {
    return stored.pairs[key].attempts[stored.pairs[key].attempts.length - 1];
  }

  it("scans active pairs and probes filtered pairs with a single real commit", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const activePair = makePair(1, { label: "ACTIVE" });
    const filteredPair = makePair(11, { label: "FILTERED" });
    const activeKey = buildPairKey({ chainId: 31337, pair: activePair });
    const filteredKey = buildPairKey({ chainId: 31337, pair: filteredPair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, {
      [filteredKey]: { samples: lowSamples(now) },
    });

    const scanCalls = [];
    let commits = 0;
    const runtime = freshRuntime();
    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [activePair, filteredPair],
          pairSpreadProbeMaxPerCycle: 1,
        }),
        probeRuntime: runtime,
        scanPair: async ({ pair }) => {
          scanCalls.push(pair.label);
          return [
            scanResult({
              netProfitBps: pair.label === "ACTIVE" ? 5n : 100n,
            }),
          ];
        },
        recordPairSpreadCommit: async (options) => {
          commits += 1;
          return recordPairSpreadCommit(options);
        },
      })
    );

    expect(scanCalls).to.deep.equal(["ACTIVE", "FILTERED"]);
    expect(commits).to.equal(1);
    expect(summary.scanned).to.equal(1);
    expect(summary.opportunities).to.equal(0);
    expect(summary.executed).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    expect(runtime.lastGlobalProbeAt).to.be.a("number");

    const stored = readPairSpreadFile(statePath);
    expect(stored.pairs[activeKey].samples).to.have.length(1);
    expect(stored.pairs[activeKey].samples[0].netProfitBps).to.equal("5");
    expect(stored.pairs[filteredKey].samples.at(-1).netProfitBps).to.equal(
      "100"
    );
    const filteredAttempt = lastAttempt(stored, filteredKey);
    expect(filteredAttempt.outcome).to.equal("success");
    expect(filteredAttempt.source).to.equal("probe");
    expect(filteredAttempt.at).to.equal(
      stored.pairs[filteredKey].samples.at(-1).at
    );

    // D2/D9: a probe never writes to scans.jsonl. Only the active scan did.
    const scanLines = fs
      .readFileSync(path.join(tmpDir, "scans.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(scanLines).to.have.length(1);
    expect(scanLines[0].netProfitBps).to.equal("5");

    const probeLogs = probeEvents({ events });
    expect(probeLogs).to.have.length(1);
    expect(probeLogs[0].level).to.equal("debug");
    expect(probeLogs[0].key).to.equal(filteredKey);
    expect(probeLogs[0].outcome).to.equal("success");
    expect(probeLogs[0].durationMs).to.be.a("number");
  });

  it("records a probe failure without a sample and keeps exitCode 0 when all pairs are filtered", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(21, { label: "FAILING" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, { [key]: { samples: lowSamples(now) } });
    const runtime = freshRuntime();

    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        scanPair: async () => {
          throw new Error("quote backend down");
        },
      })
    );

    expect(summary.scanned).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    expect(runtime.lastGlobalProbeAt).to.be.a("number");

    const stored = readPairSpreadFile(statePath);
    expect(stored.pairs[key].samples).to.have.length(5);
    const attempt = lastAttempt(stored, key);
    expect(attempt.outcome).to.equal("failure");
    expect(attempt.source).to.equal("probe");
    expect(attempt.reason).to.equal("SCAN_ERROR");

    const probeLogs = probeEvents({ events });
    expect(probeLogs).to.have.length(1);
    expect(probeLogs[0].level).to.equal("warn");
    expect(probeLogs[0].outcome).to.equal("failure");
    expect(probeLogs[0].reason).to.equal("SCAN_ERROR");
  });

  it("classifies empty probes as NO_RESULTS, QUOTE_ERRORS and UNPRICED", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const noResults = makePair(31, { label: "NO_RESULTS" });
    const quoteErrors = makePair(33, { label: "QUOTE_ERRORS" });
    const unpriced = makePair(35, { label: "UNPRICED" });
    const pairs = [noResults, quoteErrors, unpriced];
    const keys = Object.fromEntries(
      pairs.map((pair) => [
        pair.label,
        buildPairKey({ chainId: 31337, pair }),
      ])
    );
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(
      statePath,
      Object.fromEntries(
        pairs.map((pair) => [keys[pair.label], { samples: lowSamples(now) }])
      )
    );

    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs,
          pairSpreadProbeMaxPerCycle: 3,
        }),
        probeRuntime: freshRuntime(),
        scanPair: async ({ pair }) => {
          if (pair.label === "NO_RESULTS") return [];
          if (pair.label === "QUOTE_ERRORS") {
            return [scanResult({ error: "QUOTE_STALE", netProfitBps: undefined })];
          }
          return [
            scanResult({
              netProfitBps: undefined,
              amountIn: 2_000_000n,
            }),
          ];
        },
      })
    );

    expect(summary.scanned).to.equal(0);
    expect(summary.filteredPairs).to.equal(3);
    expect(summary.exitCode).to.equal(0);

    const stored = readPairSpreadFile(statePath);
    expect(lastAttempt(stored, keys.NO_RESULTS).reason).to.equal("NO_RESULTS");
    expect(lastAttempt(stored, keys.QUOTE_ERRORS).reason).to.equal(
      "QUOTE_ERRORS"
    );
    expect(lastAttempt(stored, keys.UNPRICED).reason).to.equal("UNPRICED");
    for (const key of Object.values(keys)) {
      expect(stored.pairs[key].samples).to.have.length(5);
    }
    const probeLogs = probeEvents({ events });
    expect(probeLogs).to.have.length(3);
    expect(probeLogs.every((event) => event.level === "debug")).to.equal(true);
  });

  it("reactivates a filtered pair on the next cycle with LAST_AT_OR_ABOVE_FLOOR", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(41, { label: "LAST_REACTIVATION" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, { [key]: { samples: lowSamples(now) } });

    const firstRuntime = freshRuntime();
    await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: firstRuntime,
        scanPair: async () => [scanResult({ netProfitBps: 100n })],
      })
    );
    expect(firstRuntime.lastGlobalProbeAt).to.be.a("number");

    const scans = [];
    const { events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [pair],
          pairSpreadProbeIntervalMs: 0,
        }),
        probeRuntime: freshRuntime(),
        scanPair: async () => {
          scans.push(pair.label);
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.deep.equal(["LAST_REACTIVATION"]);
    const decisions = eventsNamed({ events }, "pair_spread_decision");
    expect(decisions).to.have.length(1);
    expect(decisions[0].skip).to.equal(false);
    expect(decisions[0].reason).to.equal("LAST_AT_OR_ABOVE_FLOOR");
  });

  it("reactivates a filtered pair on the next cycle with MEDIAN_AT_OR_ABOVE_FLOOR", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(51, { label: "MEDIAN_REACTIVATION" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, {
      [key]: { samples: pairSpreadSamplesAt(now - 60_000, [-100, -80, 40, 40, -10]) },
    });

    const firstRuntime = freshRuntime();
    await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [pair],
          pairSpreadWindowSize: 5,
          pairSpreadMinSamples: 5,
        }),
        probeRuntime: firstRuntime,
        scanPair: async () => [scanResult({ netProfitBps: 1000n })],
      })
    );
    expect(firstRuntime.lastGlobalProbeAt).to.be.a("number");

    const scans = [];
    const { events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [pair],
          pairSpreadWindowSize: 5,
          pairSpreadMinSamples: 5,
          pairSpreadProbeIntervalMs: 0,
        }),
        probeRuntime: freshRuntime(),
        scanPair: async () => {
          scans.push(pair.label);
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.deep.equal(["MEDIAN_REACTIVATION"]);
    const decisions = eventsNamed({ events }, "pair_spread_decision");
    expect(decisions).to.have.length(1);
    expect(decisions[0].skip).to.equal(false);
    expect(decisions[0].reason).to.equal("MEDIAN_AT_OR_ABOVE_FLOOR");
  });

  it("keeps a pair filtered when the probe bps stays below the floor", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(61, { label: "STILL_BELOW" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, { [key]: { samples: lowSamples(now) } });

    await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: freshRuntime(),
        scanPair: async () => [scanResult({ netProfitBps: 0n })],
      })
    );

    let scans = 0;
    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [pair],
          pairSpreadProbeIntervalMs: 0,
        }),
        probeRuntime: freshRuntime(),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    const decisions = eventsNamed({ events }, "pair_spread_decision");
    expect(decisions).to.have.length(1);
    expect(decisions[0].skip).to.equal(true);
    expect(decisions[0].reason).to.equal("PAIR_SPREAD_BELOW_FLOOR");
  });

  it("deduplicates two configuration entries sharing a route into one probe", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const first = makePair(71, { label: "DUP A", tradeSizes: ["1000"] });
    const second = makePair(71, { label: "DUP B", tradeSizes: ["2000"] });
    const key = buildPairKey({ chainId: 31337, pair: first });
    expect(buildPairKey({ chainId: 31337, pair: second })).to.equal(key);
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, { [key]: { samples: lowSamples(now) } });

    const scans = [];
    await main({
      provider: makeProvider(),
      config: makeConfig(tmpDir, {
        pairs: [first, second],
        pairSpreadProbeMaxPerCycle: 2,
      }),
      probeRuntime: freshRuntime(),
      scanPair: async ({ pair }) => {
        scans.push(pair.label);
        return [scanResult({ netProfitBps: 100n })];
      },
    });

    expect(scans).to.deep.equal(["DUP A"]);
  });

  it("treats two routes with different routers as two distinct probe candidates", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const first = makePair(81, { label: "ROUTE A" });
    const second = makePair(91, { label: "ROUTE B" });
    const firstKey = buildPairKey({ chainId: 31337, pair: first });
    const secondKey = buildPairKey({ chainId: 31337, pair: second });
    expect(firstKey).to.not.equal(secondKey);
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, {
      [firstKey]: { samples: lowSamples(now) },
      [secondKey]: { samples: lowSamples(now) },
    });

    const scans = [];
    await main({
      provider: makeProvider(),
      config: makeConfig(tmpDir, {
        pairs: [first, second],
        pairSpreadProbeMaxPerCycle: 2,
      }),
      probeRuntime: freshRuntime(),
      scanPair: async ({ pair }) => {
        scans.push(pair.label);
        return [scanResult({ netProfitBps: 100n })];
      },
    });

    expect(scans.sort()).to.deep.equal(["ROUTE A", "ROUTE B"]);
  });

  it("does not probe a candidate key that was already scanned in the cycle", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const active = makePair(101, {
      label: "SAME ROUTE ACTIVE",
      minProfitBps: -1000,
    });
    const filtered = makePair(101, {
      label: "SAME ROUTE FILTERED",
      minProfitBps: 30,
    });
    const key = buildPairKey({ chainId: 31337, pair: active });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, { [key]: { samples: lowSamples(now) } });

    const scans = [];
    const runtime = freshRuntime();
    const { events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [active, filtered] }),
        probeRuntime: runtime,
        scanPair: async ({ pair }) => {
          scans.push(pair.label);
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.deep.equal(["SAME ROUTE ACTIVE"]);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
    const probeLogs = probeEvents({ events });
    expect(probeLogs).to.have.length(0);
  });

  it("performs no probe when the state loaded is not writable", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(111, { label: "NOT WRITABLE" });
    const key = buildPairKey({ chainId: 31337, pair });
    const runtime = freshRuntime();
    let scans = 0;
    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        loadPairSpreadState: async () => ({
          status: "corrupt",
          writable: false,
          state: {
            version: 2,
            pairs: { [key]: { samples: lowSamples(now), attempts: [] } },
          },
          expiredPruned: 0,
          warning: "corrupt state",
          error: { code: PAIR_SPREAD_STORE_CODES.CORRUPT },
        }),
        recordPairSpreadCommit: async () => ({
          ok: false,
          written: false,
          writable: false,
          status: "corrupt",
          added: 0,
          attemptsAdded: 0,
          expiredPruned: 0,
          warning: "corrupt state",
          error: { code: PAIR_SPREAD_STORE_CODES.CORRUPT },
        }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
    expect(probeEvents({ events })).to.have.length(0);
    const skipped = eventsNamed({ events }, "pair_spread_probe_skipped");
    expect(skipped).to.have.length(1);
    expect(skipped[0].reason).to.equal("STATE_UNAVAILABLE");
  });

  it("performs no probe when loading the state throws, but keeps scanning", async function () {
    const tmpDir = makeTmpDir();
    const pair = makePair(121, { label: "LOAD THROWS" });
    const scans = [];
    const runtime = freshRuntime();
    const { events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        loadPairSpreadState: async () => {
          throw new Error("permission denied");
        },
        scanPair: async ({ pair: scannedPair }) => {
          scans.push(scannedPair.label);
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.deep.equal(["LOAD THROWS"]);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
    expect(probeEvents({ events })).to.have.length(0);
    expect(eventsNamed({ events }, "pair_spread_probe_history_error")).to.have
      .length(0);
  });

  it("performs no probe when the interval is zero", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(131, { label: "DISABLED" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, { [key]: { samples: lowSamples(now) } });
    let scans = 0;
    const runtime = freshRuntime();

    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [pair],
          pairSpreadProbeIntervalMs: 0,
        }),
        probeRuntime: runtime,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
    expect(probeEvents({ events })).to.have.length(0);
  });

  it("performs no probe in off or shadow mode", async function () {
    for (const mode of ["off", "shadow"]) {
      const tmpDir = makeTmpDir();
      const now = Date.now();
      const pair = makePair(141, { label: `MODE ${mode}` });
      const key = buildPairKey({ chainId: 31337, pair });
      writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
        [key]: { samples: lowSamples(now) },
      });
      const scans = [];
      const runtime = freshRuntime();
      const { events } = await captureJson(() =>
        main({
          provider: makeProvider(),
          config: makeConfig(tmpDir, {
            pairs: [pair],
            pairSpreadMode: mode,
          }),
          probeRuntime: runtime,
          scanPair: async ({ pair: scannedPair }) => {
            scans.push(scannedPair.label);
            return [scanResult({ netProfitBps: 5n })];
          },
        })
      );

      expect(scans).to.deep.equal([`MODE ${mode}`]);
      expect(runtime.lastGlobalProbeAt).to.equal(null);
      expect(probeEvents({ events })).to.have.length(0);
    }
  });

  it("disables probes for the cycle when the scheduler throws", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const activePair = makePair(151, { label: "SCHEDULER ACTIVE" });
    const filteredPair = makePair(161, { label: "SCHEDULER FILTERED" });
    const filteredKey = buildPairKey({ chainId: 31337, pair: filteredPair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [filteredKey]: { samples: lowSamples(now) },
    });
    const scans = [];
    const runtime = freshRuntime();
    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [activePair, filteredPair],
          // Bypasses config validation on purpose: the integration boundary
          // must catch the scheduler contract error and keep the cycle alive.
          pairSpreadProbeMaxPerCycle: 11,
        }),
        probeRuntime: runtime,
        scanPair: async ({ pair }) => {
          scans.push(pair.label);
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.deep.equal(["SCHEDULER ACTIVE"]);
    expect(summary.exitCode).to.equal(0);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
    expect(runtime.cursorKey).to.equal(null);
    const schedulerErrors = eventsNamed({ events }, "probe_scheduler_error");
    expect(schedulerErrors).to.have.length(1);
    expect(schedulerErrors[0].level).to.equal("warn");
  });

  it("disables probes for the cycle when the probe history cannot be rebuilt", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const activePair = makePair(171, { label: "HISTORY ACTIVE" });
    const filteredPair = makePair(181, { label: "HISTORY FILTERED" });
    const filteredKey = buildPairKey({ chainId: 31337, pair: filteredPair });
    const activeKey = buildPairKey({ chainId: 31337, pair: activePair });
    const runtime = freshRuntime();
    const commits = [];
    const scans = [];
    const { result: summary, events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [activePair, filteredPair] }),
        probeRuntime: runtime,
        loadPairSpreadState: async () => ({
          status: "ok",
          writable: true,
          state: {
            version: 2,
            pairs: {
              [filteredKey]: { samples: lowSamples(now), attempts: [] },
              broken: { samples: "not-an-array", attempts: [] },
            },
          },
          expiredPruned: 0,
          warning: null,
        }),
        recordPairSpreadCommit: async (options) => {
          commits.push(options);
          return commitOk();
        },
        scanPair: async ({ pair }) => {
          scans.push(pair.label);
          return [scanResult({ netProfitBps: 5n })];
        },
      })
    );

    expect(scans).to.deep.equal(["HISTORY ACTIVE"]);
    expect(summary.exitCode).to.equal(0);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
    expect(runtime.cursorKey).to.equal(null);
    expect(eventsNamed({ events }, "pair_spread_probe_history_error")).to.have
      .length(1);
    expect(commits).to.have.length(1);
    // The normal scan still reaches the commit with its sample and attempt.
    expect(
      commits[0].samples.some((sample) => sample.key === activeKey)
    ).to.equal(true);
    expect(
      commits[0].attempts.some(
        (attempt) => attempt.key === activeKey && attempt.source === "scan"
      )
    ).to.equal(true);
    expect(
      commits[0].attempts.some((attempt) => attempt.source === "probe")
    ).to.equal(false);
  });

  it("uses pairSpreadNow for eligibility even when probeNow is much later", async function () {
    const tmpDir = makeTmpDir();
    const base = Date.now();
    const pair = makePair(191, { label: "ELIGIBILITY CLOCK" });
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [key]: { samples: pairSpreadSamplesAt(base - 500, [-80, -60, -40, -20, -10]) },
    });
    let scans = 0;
    const runtime = freshRuntime();
    await withMutableClock(base, async (clock) => {
      await main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs: [pair],
          pairSpreadProbeIntervalMs: 1000,
          pairSpreadProbeGlobalIntervalMs: 1000,
        }),
        probeRuntime: runtime,
        loadPairSpreadState: async (options) => {
          const loaded = await loadPairSpreadState(options);
          // pairSpreadNow was already captured. Move the clock forward so the
          // probe phase sees a much later probeNow.
          clock.now = base + 86_400_000;
          return loaded;
        },
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 100n })];
        },
      });
    });

    expect(scans).to.equal(0);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
  });

  it("stamps samples and attempts with pairSpreadNow while lastGlobalProbeAt receives probeNow", async function () {
    const tmpDir = makeTmpDir();
    const base = Date.now();
    const pair = makePair(201, { label: "CLOCK STAMP" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, {
      [key]: { samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]) },
    });
    const runtime = freshRuntime();
    let scanEntryNow = null;
    await withMutableClock(base, async (clock) => {
      await main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        loadPairSpreadState: async (options) => {
          const loaded = await loadPairSpreadState(options);
          // pairSpreadNow is already fixed at `base`. Advance the clock so the
          // probe phase must use a later probeNow for its envelope clock.
          clock.now = base + 5000;
          return loaded;
        },
        scanPair: async () => {
          scanEntryNow = Date.now();
          return [scanResult({ netProfitBps: 0n })];
        },
      });
    });

    const stored = readPairSpreadFile(statePath);
    const sample = stored.pairs[key].samples.at(-1);
    const attempt = lastAttempt(stored, key);
    expect(sample.netProfitBps).to.equal("0");
    expect(sample.at).to.equal(base);
    expect(attempt.at).to.equal(base);
    expect(runtime.lastGlobalProbeAt).to.equal(base + 5000);
    expect(scanEntryNow).to.equal(runtime.lastGlobalProbeAt);
  });

  it("keeps the runtime across cycles and throttles the next batch on probeNow", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(211, { label: "GLOBAL THROTTLE" });
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [key]: { samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]) },
    });
    const runtime = freshRuntime();
    let scans = 0;
    const config = makeConfig(tmpDir, {
      pairs: [pair],
      pairSpreadProbeGlobalIntervalMs: 100_000,
    });

    await withMutableClock(base, async (clock) => {
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(scans).to.equal(1);
      expect(runtime.lastGlobalProbeAt).to.equal(base);

      clock.now = base + 1000;
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(scans).to.equal(1);
      expect(runtime.lastGlobalProbeAt).to.equal(base);

      // Once the global interval has elapsed, the next started batch must move
      // the throttle forward; otherwise it could never throttle again.
      clock.now = base + 100_000;
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(scans).to.equal(2);
      expect(runtime.lastGlobalProbeAt).to.equal(base + 100_000);

      clock.now = base + 100_100;
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(scans).to.equal(2);
      expect(runtime.lastGlobalProbeAt).to.equal(base + 100_000);

      // A fresh runtime simulates a restart: no persisted global throttle.
      clock.now = base + 200_000;
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: freshRuntime(),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(scans).to.equal(3);
    });
  });

  it("rotates N=3, M=2 across cycles and restarts at the first key with a fresh runtime", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pairs = [makePair(221, { label: "N3 A" }), makePair(223, { label: "N3 B" }), makePair(225, { label: "N3 C" })];
    const keys = pairs.map((pair) => buildPairKey({ chainId: 31337, pair }));
    writePairSpreadFile(
      path.join(tmpDir, "pair_spreads.json"),
      Object.fromEntries(
        keys.map((key) => [
          key,
          { samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]) },
        ])
      )
    );
    const runtime = freshRuntime();
    const config = makeConfig(tmpDir, {
      pairs,
      pairSpreadProbeMaxPerCycle: 2,
    });
    const batches = [];

    await withMutableClock(base, async (clock) => {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        const batch = [];
        await main({
          provider: makeProvider(),
          config,
          probeRuntime: runtime,
          scanPair: async ({ pair }) => {
            batch.push(pair.label);
            return [scanResult({ netProfitBps: 0n })];
          },
        });
        batches.push(batch);
        clock.now += 10;
      }

      expect(batches[0]).to.deep.equal(["N3 A", "N3 B"]);
      expect(batches[1]).to.deep.equal(["N3 C", "N3 A"]);
      expect(runtime.cursorKey).to.equal(keys[0]);

      const restartBatch = [];
      clock.now += 10;
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: freshRuntime(),
        scanPair: async ({ pair }) => {
          restartBatch.push(pair.label);
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(restartBatch[0]).to.equal("N3 A");
    });
  });

  it("rotates N=5, M=2 so every key is probed within ceil(5/2)=3 batches", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pairs = [
      makePair(231, { label: "N5 A" }),
      makePair(233, { label: "N5 B" }),
      makePair(235, { label: "N5 C" }),
      makePair(237, { label: "N5 D" }),
      makePair(239, { label: "N5 E" }),
    ];
    writePairSpreadFile(
      path.join(tmpDir, "pair_spreads.json"),
      Object.fromEntries(
        pairs.map((pair) => [
          buildPairKey({ chainId: 31337, pair }),
          {
            samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
          },
        ])
      )
    );
    const runtime = freshRuntime();
    const config = makeConfig(tmpDir, {
      pairs,
      pairSpreadProbeMaxPerCycle: 2,
    });
    const probed = new Set();

    await withMutableClock(base, async (clock) => {
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const batch = [];
        await main({
          provider: makeProvider(),
          config,
          probeRuntime: runtime,
          scanPair: async ({ pair }) => {
            batch.push(pair.label);
            return [scanResult({ netProfitBps: 0n })];
          },
        });
        expect(new Set(batch).size).to.equal(batch.length);
        expect(batch.length).to.be.at.most(2);
        for (const label of batch) probed.add(label);
        clock.now += 10;
      }
    });

    expect([...probed].sort()).to.deep.equal([
      "N5 A",
      "N5 B",
      "N5 C",
      "N5 D",
      "N5 E",
    ]);
  });

  it("cancels before selection without moving the cursor or the global clock", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(241, { label: "CANCELLED EARLY" });
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [key]: { samples: lowSamples(now) },
    });
    const runtime = freshRuntime();
    const signal = { aborted: true };
    let scans = 0;
    const { events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        signal,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
      })
    );

    expect(scans).to.equal(0);
    expect(runtime.cursorKey).to.equal(null);
    expect(runtime.lastGlobalProbeAt).to.equal(null);
    expect(eventsNamed({ events }, "pair_spread_probe_cancelled")).to.have
      .length(1);
  });

  it("cancels after the first probe and leaves the unstarted key before the cursor", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const first = makePair(251, { label: "CANCEL A" });
    const second = makePair(253, { label: "CANCEL B" });
    const firstKey = buildPairKey({ chainId: 31337, pair: first });
    const secondKey = buildPairKey({ chainId: 31337, pair: second });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [firstKey]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
      [secondKey]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const runtime = freshRuntime();
    const compound = { aborted: false };
    const config = makeConfig(tmpDir, {
      pairs: [first, second],
      pairSpreadProbeMaxPerCycle: 2,
    });

    await withMutableClock(base, async (clock) => {
      const firstBatch = [];
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        signal: compound,
        scanPair: async ({ pair }) => {
          firstBatch.push(pair.label);
          compound.aborted = true;
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(firstBatch).to.deep.equal(["CANCEL A"]);
      expect(runtime.cursorKey).to.equal(firstKey);

      clock.now += 10;
      compound.aborted = false;
      const secondBatch = [];
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        signal: compound,
        scanPair: async ({ pair }) => {
          secondBatch.push(pair.label);
          return [scanResult({ netProfitBps: 0n })];
        },
      });
      expect(secondBatch[0]).to.equal("CANCEL B");
    });
  });

  it("advances the cursor after WRITE_FAILED because started probes are resolved", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const first = makePair(261, { label: "WRITE A" });
    const second = makePair(263, { label: "WRITE B" });
    const firstKey = buildPairKey({ chainId: 31337, pair: first });
    const secondKey = buildPairKey({ chainId: 31337, pair: second });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [firstKey]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
      [secondKey]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const runtime = freshRuntime();
    const config = makeConfig(tmpDir, {
      pairs: [first, second],
      pairSpreadProbeMaxPerCycle: 1,
    });

    await withMutableClock(base, async (clock) => {
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async () => [scanResult({ netProfitBps: 0n })],
        recordPairSpreadCommit: async () => commitWriteFailed(),
      });
      expect(runtime.writeFailures).to.equal(1);
      expect(runtime.pendingAttempts.has(firstKey)).to.equal(true);
      expect(runtime.cursorKey).to.equal(firstKey);

      clock.now = base + 301_000;
      const secondBatch = [];
      const commitArgs = [];
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async ({ pair }) => {
          secondBatch.push(pair.label);
          return [scanResult({ netProfitBps: 0n })];
        },
        recordPairSpreadCommit: async (options) => {
          commitArgs.push(options);
          return commitOk();
        },
      });
      expect(secondBatch[0]).to.equal("WRITE B");
      expect(
        commitArgs[0].attempts.some((attempt) => attempt.key === firstKey)
      ).to.equal(true);
      expect(runtime.pendingAttempts.size).to.equal(0);
    });
  });

  it("applies the 5/10/20/40/60/60 minute backoff caps and does not probe while suspended", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(271, { label: "BACKOFF" });
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [key]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const runtime = freshRuntime();
    const config = makeConfig(tmpDir, { pairs: [pair] });
    const runTimes = [base, base + 100_000, base + 200_000, base + 300_000, base + 400_000, base + 500_000];
    const expectedBackoff = [
      300_000,
      600_000,
      1_200_000,
      2_400_000,
      3_600_000,
      3_600_000,
    ];
    let scans = 0;

    await withMutableClock(base, async (clock) => {
      for (let index = 0; index < runTimes.length; index += 1) {
        clock.now = runTimes[index];
        const captured = await captureJson(() =>
          main({
            provider: makeProvider(),
            config,
            probeRuntime: runtime,
            scanPair: async () => {
              scans += 1;
              return [scanResult({ netProfitBps: 0n })];
            },
            recordPairSpreadCommit: async () => commitWriteFailed(),
          })
        );
        expect(runtime.writeFailures).to.equal(index + 1);
        expect(runtime.suspendedUntil - runTimes[index]).to.equal(
          expectedBackoff[index]
        );
        const failureEvents = eventsNamed(
          { events: captured.events },
          "pair_spread_probe_write_failed"
        );
        expect(failureEvents).to.have.length(1);
        expect(failureEvents[0].level).to.equal("warn");
        expect(failureEvents[0].backoffMs).to.equal(expectedBackoff[index]);
        expect(failureEvents[0].suspendedUntil).to.equal(
          runtime.suspendedUntil
        );
        expect(failureEvents[0].code).to.equal(
          PAIR_SPREAD_STORE_CODES.WRITE_FAILED
        );
      }
      // Only the first cycle actually started a probe.
      expect(scans).to.equal(1);
      expect(runtime.lastGlobalProbeAt).to.equal(base);

      clock.now = runtime.suspendedUntil;
      const recovered = await captureJson(() =>
        main({
          provider: makeProvider(),
          config,
          probeRuntime: runtime,
          scanPair: async () => {
            scans += 1;
            return [scanResult({ netProfitBps: 0n })];
          },
          recordPairSpreadCommit: async () => commitOk(),
        })
      );
      expect(scans).to.equal(2);
      expect(runtime.writeFailures).to.equal(0);
      expect(runtime.suspendedUntil).to.equal(0);
      expect(runtime.pendingAttempts.size).to.equal(0);
      const recoveredEvents = eventsNamed(
        { events: recovered.events },
        "pair_spread_probe_recovered"
      );
      expect(recoveredEvents).to.have.length(1);
      expect(recoveredEvents[0].level).to.equal("info");
    });
  });

  it("recovers early from suspension only after a real write", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(281, { label: "EARLY RECOVERY" });
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [key]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const runtime = freshRuntime();
    runtime.writeFailures = 2;
    runtime.suspendedUntil = base + 300_000;
    runtime.pendingAttempts.set(key, {
      key,
      at: base - 1000,
      outcome: "failure",
      source: "probe",
      reason: "SCAN_ERROR",
    });
    let scans = 0;

    await withMutableClock(base, async (clock) => {
      await main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
        recordPairSpreadCommit: async () => commitOk(),
      });
      expect(scans).to.equal(0);
      expect(runtime.writeFailures).to.equal(0);
      expect(runtime.suspendedUntil).to.equal(0);
      expect(runtime.pendingAttempts.size).to.equal(0);

      clock.now += 10;
      await main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 0n })];
        },
        recordPairSpreadCommit: async () => commitOk(),
      });
      expect(scans).to.equal(1);
    });
  });

  it("keeps pending attempts and suspension on ok:true, written:false no-ops", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const runtime = freshRuntime();
    runtime.writeFailures = 2;
    runtime.suspendedUntil = base + 300_000;
    const pending = {
      key: "v1|31337|pending",
      at: base - 1000,
      outcome: "failure",
      source: "probe",
      reason: "SCAN_ERROR",
    };
    runtime.pendingAttempts.set(pending.key, pending);
    let commits = 0;

    await withMutableClock(base, async (clock) => {
      for (let index = 0; index < 2; index += 1) {
        await main({
          provider: makeProvider(),
          config: makeConfig(tmpDir, { pairs: [] }),
          probeRuntime: runtime,
          recordPairSpreadCommit: async () => {
            commits += 1;
            return commitOk({ written: false });
          },
        });
        expect(runtime.writeFailures).to.equal(2);
        expect(runtime.suspendedUntil).to.equal(base + 300_000);
        expect(runtime.pendingAttempts.has(pending.key)).to.equal(true);
        clock.now += 10;
      }
      expect(commits).to.equal(2);

      await main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [] }),
        probeRuntime: runtime,
        recordPairSpreadCommit: async () => commitOk(),
      });
      expect(runtime.writeFailures).to.equal(0);
      expect(runtime.suspendedUntil).to.equal(0);
      expect(runtime.pendingAttempts.size).to.equal(0);
    });
  });

  it("does not re-emit a pending non-success attempt beside a surviving sample", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(291, { label: "CONFLICT GUARD" });
    const key = buildPairKey({ chainId: 31337, pair });
    const runtime = freshRuntime();
    const pending = {
      key,
      at: base - 1000,
      outcome: "failure",
      source: "probe",
      reason: "SCAN_ERROR",
    };
    runtime.pendingAttempts.set(key, pending);
    const config = makeConfig(tmpDir, { pairs: [pair] });

    await withMutableClock(base, async (clock) => {
      const noOpArgs = [];
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async () => [scanResult({ netProfitBps: 5n })],
        recordPairSpreadCommit: async (options) => {
          noOpArgs.push(options);
          return commitOk({ written: false });
        },
      });
      expect(noOpArgs[0].samples.some((sample) => sample.key === key)).to.equal(
        true
      );
      expect(
        noOpArgs[0].attempts.some(
          (attempt) => attempt.key === key && attempt.outcome !== "success"
        )
      ).to.equal(false);
      expect(runtime.pendingAttempts.has(key)).to.equal(true);

      clock.now += 10;
      await main({
        provider: makeProvider(),
        config,
        probeRuntime: runtime,
        scanPair: async () => [scanResult({ netProfitBps: 10n })],
        recordPairSpreadCommit: async () => commitOk(),
      });
      expect(runtime.pendingAttempts.has(key)).to.equal(false);
    });
  });

  it("re-emits due pending attempts, keeps future ones and removes at-or-before-now entries", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const runtime = freshRuntime();
    const committable = {
      key: "v1|31337|past",
      at: base - 1000,
      outcome: "empty",
      source: "probe",
      reason: "NO_RESULTS",
    };
    const future = {
      key: "v1|31337|future",
      at: base + 100_000,
      outcome: "success",
      source: "probe",
    };
    runtime.pendingAttempts.set(committable.key, committable);
    runtime.pendingAttempts.set(future.key, future);
    let commitArgs = null;

    await withMutableClock(base, async () => {
      await main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [] }),
        probeRuntime: runtime,
        recordPairSpreadCommit: async (options) => {
          commitArgs = options;
          return commitOk();
        },
      });
    });

    expect(commitArgs.attempts.some((attempt) => attempt.key === committable.key)).to.equal(true);
    expect(commitArgs.attempts.some((attempt) => attempt.key === future.key)).to.equal(false);
    expect(commitArgs.samples.some((sample) => sample.key === committable.key)).to.equal(false);
    expect(runtime.pendingAttempts.has(committable.key)).to.equal(false);
    expect(runtime.pendingAttempts.has(future.key)).to.equal(true);
  });

  it("does not arm backoff or fuse attempts on a returned non-WRITE_FAILED refusal", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(301, { label: "DETERMINISTIC RETURNED" });
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [key]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const runtime = freshRuntime();
    runtime.pendingAttempts.set("v1|31337|seed", {
      key: "v1|31337|seed",
      at: base - 1000,
      outcome: "failure",
      source: "probe",
      reason: "SCAN_ERROR",
    });
    const { events } = await captureJson(() =>
      withMutableClock(base, () =>
        main({
          provider: makeProvider(),
          config: makeConfig(tmpDir, { pairs: [pair] }),
          probeRuntime: runtime,
          scanPair: async () => [scanResult({ netProfitBps: 0n })],
          recordPairSpreadCommit: async () => ({
            ok: false,
            written: false,
            writable: true,
            status: "corrupt",
            added: 0,
            attemptsAdded: 0,
            expiredPruned: 0,
            warning: "corrupt",
            error: { code: PAIR_SPREAD_STORE_CODES.CORRUPT },
          }),
        })
      )
    );

    expect(runtime.writeFailures).to.equal(0);
    expect(runtime.suspendedUntil).to.equal(0);
    expect(runtime.pendingAttempts.size).to.equal(1);
    expect(runtime.pendingAttempts.has(key)).to.equal(false);
    const refused = eventsNamed({ events }, "pair_spread_probe_commit_refused");
    expect(refused).to.have.length(1);
    expect(refused[0].level).to.equal("warn");
    expect(refused[0].code).to.equal(PAIR_SPREAD_STORE_CODES.CORRUPT);
  });

  it("treats ok:false with written:true as a deterministic refusal", async function () {
    const tmpDir = makeTmpDir();
    const runtime = freshRuntime();
    await withMutableClock(1_700_000_000_000, () =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [] }),
        probeRuntime: runtime,
        recordPairSpreadCommit: async () => ({
          ok: false,
          written: true,
          writable: true,
          status: "ok",
          added: 0,
          attemptsAdded: 0,
          expiredPruned: 0,
          warning: null,
          error: null,
        }),
      })
    );
    expect(runtime.writeFailures).to.equal(0);
    expect(runtime.suspendedUntil).to.equal(0);
  });

  it("classifies thrown VALIDATION_FAILED and CONFLICT codes as deterministic", async function () {
    for (const code of [
      PAIR_SPREAD_STORE_CODES.VALIDATION_FAILED,
      PAIR_SPREAD_STORE_CODES.CONFLICT,
    ]) {
      const tmpDir = makeTmpDir();
      const base = 1_700_000_000_000;
      const pair = makePair(311, { label: `THROWN ${code}` });
      const key = buildPairKey({ chainId: 31337, pair });
      writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
        [key]: {
          samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
        },
      });
      const runtime = freshRuntime();
      runtime.pendingAttempts.set("v1|31337|seed", {
        key: "v1|31337|seed",
        at: base - 1000,
        outcome: "failure",
        source: "probe",
        reason: "SCAN_ERROR",
      });
      await withMutableClock(base, () =>
        main({
          provider: makeProvider(),
          config: makeConfig(tmpDir, { pairs: [pair] }),
          probeRuntime: runtime,
          scanPair: async () => [scanResult({ netProfitBps: 0n })],
          recordPairSpreadCommit: async () => {
            const error = new TypeError(`refused ${code}`);
            error.code = code;
            throw error;
          },
        })
      );

      expect(runtime.writeFailures).to.equal(0);
      expect(runtime.suspendedUntil).to.equal(0);
      expect(runtime.pendingAttempts.size).to.equal(1);
      expect(runtime.pendingAttempts.has(key)).to.equal(false);
    }
  });

  it("classifies a TypeError without a stable code as unexpected and fuses cycle attempts", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(321, { label: "UNEXPECTED EXCEPTION" });
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(path.join(tmpDir, "pair_spreads.json"), {
      [key]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const runtime = freshRuntime();
    const seedKey = "v1|31337|seed";
    runtime.pendingAttempts.set(seedKey, {
      key: seedKey,
      at: base - 2000,
      outcome: "failure",
      source: "probe",
      reason: "SCAN_ERROR",
    });
    const { events } = await captureJson(() =>
      withMutableClock(base, () =>
        main({
          provider: makeProvider(),
          config: makeConfig(tmpDir, { pairs: [pair] }),
          probeRuntime: runtime,
          scanPair: async () => [scanResult({ netProfitBps: 0n })],
          recordPairSpreadCommit: async () => {
            throw new TypeError("unexpected io failure");
          },
        })
      )
    );

    expect(runtime.writeFailures).to.equal(0);
    expect(runtime.suspendedUntil).to.equal(0);
    expect(runtime.pendingAttempts.has(seedKey)).to.equal(true);
    expect(runtime.pendingAttempts.has(key)).to.equal(true);
    expect(runtime.pendingAttempts.get(key).source).to.equal("probe");
    const errorEvents = eventsNamed(
      { events },
      "pair_spread_probe_commit_error"
    );
    expect(errorEvents).to.have.length(1);
    expect(errorEvents[0].level).to.equal("warn");
  });

  it("keeps a pending failure on a no-op even when the conflict guard excluded it", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(331, { label: "GUARD NOOP" });
    const key = buildPairKey({ chainId: 31337, pair });
    const runtime = freshRuntime();
    runtime.pendingAttempts.set(key, {
      key,
      at: base - 1000,
      outcome: "empty",
      source: "probe",
      reason: "NO_RESULTS",
    });
    const commitArgs = [];
    await withMutableClock(base, () =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: runtime,
        scanPair: async () => [scanResult({ netProfitBps: 5n })],
        recordPairSpreadCommit: async (options) => {
          commitArgs.push(options);
          return commitOk({ written: false });
        },
      })
    );

    expect(commitArgs[0].attempts).to.have.length(1);
    expect(commitArgs[0].attempts[0].outcome).to.equal("success");
    expect(commitArgs[0].attempts[0].source).to.equal("scan");
    expect(runtime.pendingAttempts.has(key)).to.equal(true);
    expect(runtime.writeFailures).to.equal(0);
  });

  it("keeps a successful probe when the logger throws, without altering its attempt", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(341, { label: "LOGGER THROWS SUCCESS" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, {
      [key]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const originalLog = console.log;
    let thrown = false;
    console.log = (...args) => {
      const line = args.map(String).join(" ");
      if (!thrown && line.includes("[PAIR SPREAD] probe")) {
        thrown = true;
        throw new Error("logger exploded");
      }
      return originalLog(...args);
    };
    try {
      await withMutableClock(base, () =>
        main({
          provider: makeProvider(),
          config: makeConfig(tmpDir, { pairs: [pair] }),
          probeRuntime: freshRuntime(),
          scanPair: async () => [scanResult({ netProfitBps: 100n })],
        })
      );
    } finally {
      console.log = originalLog;
    }

    expect(thrown).to.equal(true);
    const stored = readPairSpreadFile(statePath);
    expect(stored.pairs[key].samples.at(-1).netProfitBps).to.equal("100");
    expect(lastAttempt(stored, key).outcome).to.equal("success");
    expect(lastAttempt(stored, key).source).to.equal("probe");
  });

  it("keeps a written commit successful when the post-commit logger throws", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(381, { label: "POST COMMIT LOGGER THROWS" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, {
      [key]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const runtime = freshRuntime();
    // A previous failure left a non-zero recovery state. The suspension is
    // already expired (base - 1) but still present, and one failure attempt for
    // the probed pair is waiting to be resolved by the next real write.
    runtime.writeFailures = 2;
    runtime.suspendedUntil = base - 1;
    runtime.pendingAttempts.set(key, {
      key,
      at: base - 1000,
      outcome: "failure",
      source: "probe",
      reason: "SCAN_ERROR",
    });
    const commitResults = [];
    let commits = 0;
    let loggerThrew = false;
    const originalLog = console.log;
    const originalWarn = console.warn;
    const throwOnPersistLog = (...args) => {
      const line = args.map(String).join(" ");
      if (
        !loggerThrew &&
        (line.includes("[PAIR SPREAD] persist") ||
          line.includes('"event":"pair_spread_persist"'))
      ) {
        loggerThrew = true;
        throw new Error("post-commit logger exploded");
      }
      return originalLog(...args);
    };
    console.log = throwOnPersistLog;
    console.warn = throwOnPersistLog;
    try {
      await withMutableClock(base, () =>
        main({
          provider: makeProvider(),
          config: makeConfig(tmpDir, { pairs: [pair] }),
          probeRuntime: runtime,
          scanPair: async () => [scanResult({ netProfitBps: 100n })],
          recordPairSpreadCommit: async (options) => {
            commits += 1;
            const result = await recordPairSpreadCommit(options);
            commitResults.push(result);
            return result;
          },
        })
      );
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    expect(loggerThrew).to.equal(true);
    expect(commits).to.equal(1);
    expect(commitResults).to.have.length(1);
    expect(commitResults[0].ok).to.equal(true);
    expect(commitResults[0].written).to.equal(true);

    // The successful write stays authoritative: no backoff, no re-injection.
    expect(runtime.writeFailures).to.equal(0);
    expect(runtime.suspendedUntil).to.equal(0);
    expect(runtime.pendingAttempts.size).to.equal(0);

    const stored = readPairSpreadFile(statePath);
    expect(stored.pairs[key].samples.at(-1).netProfitBps).to.equal("100");
    // The seeded pending failure is resolved, not duplicated beside the
    // surviving sample: only the real success attempt is persisted.
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "success",
      source: "probe",
    });
    expect(stored.pairs[key].attempts[0].at).to.equal(base);
    expect(lastAttempt(stored, key).outcome).to.equal("success");
    expect(lastAttempt(stored, key).source).to.equal("probe");
  });

  it("records a failure attempt when classification throws and never writes a sample", async function () {
    const tmpDir = makeTmpDir();
    const base = 1_700_000_000_000;
    const pair = makePair(351, { label: "CLASSIFICATION THROWS" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, {
      [key]: {
        samples: pairSpreadSamplesAt(base - 600_000, [-80, -60, -40, -20, -10]),
      },
    });
    const throwingResults = [];
    Object.defineProperty(throwingResults, 0, {
      enumerable: true,
      get() {
        throw new Error("iterator exploded");
      },
    });
    throwingResults.length = 1;

    await withMutableClock(base, () =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, { pairs: [pair] }),
        probeRuntime: freshRuntime(),
        scanPair: async () => throwingResults,
      })
    );

    const stored = readPairSpreadFile(statePath);
    expect(stored.pairs[key].samples).to.have.length(5);
    const attempt = lastAttempt(stored, key);
    expect(attempt.outcome).to.equal("failure");
    expect(attempt.reason).to.equal("SCAN_ERROR");
    expect(attempt.source).to.equal("probe");
  });

  it("classifies a probe scan returning a non-array as failure/SCAN_ERROR", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pair = makePair(361, { label: "NON ARRAY" });
    const key = buildPairKey({ chainId: 31337, pair });
    const statePath = path.join(tmpDir, "pair_spreads.json");
    writePairSpreadFile(statePath, { [key]: { samples: lowSamples(now) } });

    await main({
      provider: makeProvider(),
      config: makeConfig(tmpDir, { pairs: [pair] }),
      probeRuntime: freshRuntime(),
      scanPair: async () => ({ not: "an array" }),
    });

    const stored = readPairSpreadFile(statePath);
    expect(stored.pairs[key].samples).to.have.length(5);
    expect(lastAttempt(stored, key).outcome).to.equal("failure");
    expect(lastAttempt(stored, key).reason).to.equal("SCAN_ERROR");
  });

  it("bounds probe events by maxPerCycle", async function () {
    const tmpDir = makeTmpDir();
    const now = Date.now();
    const pairs = [
      makePair(371, { label: "EVENT A" }),
      makePair(373, { label: "EVENT B" }),
      makePair(375, { label: "EVENT C" }),
    ];
    writePairSpreadFile(
      path.join(tmpDir, "pair_spreads.json"),
      Object.fromEntries(
        pairs.map((pair) => [
          buildPairKey({ chainId: 31337, pair }),
          { samples: lowSamples(now) },
        ])
      )
    );
    const { events } = await captureJson(() =>
      main({
        provider: makeProvider(),
        config: makeConfig(tmpDir, {
          pairs,
          pairSpreadProbeMaxPerCycle: 1,
        }),
        probeRuntime: freshRuntime(),
        scanPair: async () => [scanResult({ netProfitBps: 0n })],
      })
    );

    const probeLogs = probeEvents({ events });
    expect(probeLogs).to.have.length(1);
    expect(probeLogs[0].outcome).to.equal("success");
    expect(probeLogs[0].level).to.equal("debug");
  });
});
