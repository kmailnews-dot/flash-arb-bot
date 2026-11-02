const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  loadAdaptive,
  recordOutcome,
  applyAdaptive,
  ADAPTIVE_WINDOW,
} = require("../bot/adaptive");

function makeConfig(overrides = {}) {
  return {
    minProfitBps: 30,
    pairs: [
      {
        label: "BOR/MID",
        borrowedToken: { address: "0x0000000000000000000000000000000000000001", decimals: 18 },
        intermediateToken: { address: "0x0000000000000000000000000000000000000002", decimals: 18 },
        legOut: {
          kind: "V2",
          router: "0x0000000000000000000000000000000000000003",
          tokenOut: "0x0000000000000000000000000000000000000002",
        },
        legBack: {
          kind: "V2",
          router: "0x0000000000000000000000000000000000000004",
          tokenOut: "0x0000000000000000000000000000000000000001",
        },
        tradeSizes: ["1000", "2000"],
      },
    ],
    ...overrides,
  };
}

function writeRawState(filePath, state) {
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

describe("bot/adaptive", function () {
  let dir;
  let filePath;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-adaptive-"));
    filePath = path.join(dir, "adaptive.json");
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns the config-derived defaults when the state file is absent", async function () {
    const state = await loadAdaptive({ filePath, config: makeConfig() });

    expect(state).to.deep.equal({
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: { majors: "1.00", longtail: "1.00" },
      history: [],
    });
  });

  it("clamps effectiveMinProfitBps to the configured bounds", async function () {
    const config = makeConfig();
    writeRawState(filePath, {
      effectiveMinProfitBps: 999999,
      effectiveMaxTradeSize: "1.00",
      history: [],
    });

    const tooHigh = await loadAdaptive({ filePath, config });
    expect(tooHigh.effectiveMinProfitBps).to.equal(60);

    writeRawState(filePath, {
      effectiveMinProfitBps: -5,
      effectiveMaxTradeSize: "1.00",
      history: [],
    });

    const tooLow = await loadAdaptive({ filePath, config });
    expect(tooLow.effectiveMinProfitBps).to.equal(30);
  });

  it("clamps effectiveMaxTradeSize to [0.10, 1.00]", async function () {
    const config = makeConfig();
    writeRawState(filePath, {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: { majors: "1.50", longtail: "1.50" },
      history: [],
    });

    const tooHigh = await loadAdaptive({ filePath, config });
    expect(tooHigh.effectiveMaxTradeSize).to.deep.equal({ majors: "1.00", longtail: "1.00" });

    writeRawState(filePath, {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: { majors: "0.01", longtail: "0.01" },
      history: [],
    });

    const tooLow = await loadAdaptive({ filePath, config });
    expect(tooLow.effectiveMaxTradeSize).to.deep.equal({ majors: "0.10", longtail: "0.10" });
  });

  it("raises effectiveMinProfitBps by 5 after 3 FAILURE and caps it", async function () {
    const config = makeConfig();
    let state;

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", profile: "majors", config, now: 1000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(35);

    writeRawState(filePath, {
      effectiveMinProfitBps: 59,
      effectiveMaxTradeSize: "1.00",
      history: [],
    });

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", profile: "majors", config, now: 2000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(60);
  });

  it("lowers effectiveMinProfitBps by 5 after 3 SUCCESS, floored at config.minProfitBps", async function () {
    const config = makeConfig();
    let state;

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", profile: "majors", config, now: 1000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(35);

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "SUCCESS", profile: "majors", config, now: 2000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(30);

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "SUCCESS", profile: "majors", config, now: 3000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(30);
  });

  it("lowers effectiveMaxTradeSize by 0.10 after 3 FAILURE, floored at 0.10", async function () {
    const config = makeConfig();
    let state;

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", profile: "majors", config, now: 1000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.deep.equal({ majors: "0.90", longtail: "1.00" });

    for (let i = 0; i < 9; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", profile: "majors", config, now: 2000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.deep.equal({ majors: "0.10", longtail: "1.00" });

    state = await recordOutcome({ filePath, outcome: "FAILURE", profile: "majors", config, now: 3000 });
    expect(state.effectiveMaxTradeSize).to.deep.equal({ majors: "0.10", longtail: "1.00" });
  });

  it("raises effectiveMaxTradeSize by 0.10 after 3 SUCCESS, capped at 1.00", async function () {
    const config = makeConfig();
    writeRawState(filePath, {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: "0.80",
      history: [],
    });

    let state;
    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "SUCCESS", profile: "majors", config, now: 1000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.deep.equal({ majors: "0.90", longtail: "0.80" });

    for (let i = 0; i < 2; i += 1) {
      state = await recordOutcome({ filePath, outcome: "SUCCESS", profile: "majors", config, now: 2000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.deep.equal({ majors: "1.00", longtail: "0.80" });

    state = await recordOutcome({ filePath, outcome: "SUCCESS", profile: "majors", config, now: 3000 });
    expect(state.effectiveMaxTradeSize).to.deep.equal({ majors: "1.00", longtail: "0.80" });
  });

  it("truncates history to the last ADAPTIVE_WINDOW entries", async function () {
    const config = makeConfig();
    const start = 1000;

    let state;
    for (let i = 0; i < ADAPTIVE_WINDOW + 5; i += 1) {
      state = await recordOutcome({
        filePath,
        outcome: "UNKNOWN",
        profile: "majors",
        config,
        now: start + i,
      });
    }

    expect(state.history).to.have.lengthOf(ADAPTIVE_WINDOW);
    expect(state.history[0].at).to.equal(start + 5);
    expect(state.history[ADAPTIVE_WINDOW - 1].at).to.equal(start + ADAPTIVE_WINDOW + 4);
    expect(state.history.every((entry) => entry.profile === "majors")).to.equal(true);
  });

  it("applyAdaptive returns a distinct copy and never mutates config or state", function () {
    const config = makeConfig();
    const state = {
      effectiveMinProfitBps: 35,
      effectiveMaxTradeSize: { majors: "0.50", longtail: "0.50" },
      history: [{ outcome: "FAILURE", profile: "majors", at: 1000 }],
    };
    const configBefore = JSON.stringify(config);
    const stateBefore = JSON.stringify(state);

    const applied = applyAdaptive({ config, state });

    expect(applied).to.not.equal(config);
    expect(applied.pairs).to.not.equal(config.pairs);
    expect(applied.pairs[0]).to.not.equal(config.pairs[0]);
    expect(applied.pairs[0].tradeSizes).to.not.equal(config.pairs[0].tradeSizes);
    expect(applied.minProfitBps).to.equal(35);
    expect(JSON.stringify(config)).to.equal(configBefore);
    expect(JSON.stringify(state)).to.equal(stateBefore);
  });

  it("applyAdaptive scales trade sizes by the factor and bounds minProfitBps", function () {
    const config = makeConfig();
    const state = {
      effectiveMinProfitBps: 99999,
      effectiveMaxTradeSize: { majors: "0.50", longtail: "0.50" },
      history: [],
    };

    const applied = applyAdaptive({ config, state });

    expect(applied.minProfitBps).to.equal(60);
    expect(applied.effectiveMinProfitBps).to.equal(60);
    expect(applied.effectiveMaxTradeSize).to.deep.equal({ majors: "0.50", longtail: "0.50" });
    expect(applied.tradeSizeFactor).to.deep.equal({ majors: 0.5, longtail: 0.5 });
    expect(applied.pairs[0].tradeSizes).to.deep.equal(["0.1000", "0.1000"]);
    expect(config.minProfitBps).to.equal(30);
    expect(config.pairs[0].tradeSizes).to.deep.equal(["1000", "2000"]);

    const floored = applyAdaptive({
      config,
      state: { ...state, effectiveMinProfitBps: 1 },
    });
    expect(floored.minProfitBps).to.equal(30);
  });

  it("applies per-profile factor to tradeSizes without hitting the cap", function () {
    const config = makeConfig({
      pairs: [
        { label: "MAJORS", profile: "majors", tradeSizes: ["0.08", "0.09"] },
        { label: "LONGTAIL", profile: "longtail", tradeSizes: ["0.80", "0.90"] },
      ],
    });
    const state = {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: { majors: "0.50", longtail: "0.20" },
      history: [],
    };

    const applied = applyAdaptive({ config, state });

    expect(applied.pairs[0].tradeSizes).to.deep.equal(["0.0400", "0.0450"]);
    expect(applied.pairs[1].tradeSizes).to.deep.equal(["0.1600", "0.1800"]);
  });

  it("clamps scaled tradeSizes to the profile cap", function () {
    const config = makeConfig({
      pairs: [
        { label: "MAJORS", profile: "majors", tradeSizes: ["0.08", "0.09"] },
        { label: "LONGTAIL", profile: "longtail", tradeSizes: ["0.80", "0.90"] },
      ],
    });
    const state = {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: { majors: "1.00", longtail: "1.00" },
      history: [],
    };

    const applied = applyAdaptive({ config, state });
    expect(applied.pairs[0].tradeSizes).to.deep.equal(["0.0800", "0.0900"]);
    expect(applied.pairs[1].tradeSizes).to.deep.equal(["0.8000", "0.9000"]);

    const bigState = {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: { majors: "1.00", longtail: "1.00" },
      history: [],
    };
    const bigConfig = makeConfig({
      pairs: [
        { label: "MAJORS", profile: "majors", tradeSizes: ["1", "2"] },
      ],
    });
    const clamped = applyAdaptive({ config: bigConfig, state: bigState });
    expect(clamped.pairs[0].tradeSizes).to.deep.equal(["0.1000", "0.1000"]);
  });

  it("applies per-profile factor to logSweep without hitting the cap", function () {
    const config = makeConfig({
      pairs: [
        { label: "MAJORS", profile: "majors", logSweep: { min: "0.04", max: "0.08", steps: 5 } },
      ],
    });
    const state = {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: { majors: "0.50", longtail: "1.00" },
      history: [],
    };

    const applied = applyAdaptive({ config, state });

    expect(applied.pairs[0].logSweep.min).to.equal("0.0200");
    expect(applied.pairs[0].logSweep.max).to.equal("0.0400");
    expect(applied.pairs[0].logSweep.steps).to.equal(5);
  });

  it("recordOutcome adjusts factor only for the matching profile", async function () {
    const config = makeConfig();
    let state;

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", profile: "majors", config, now: 1000 + i });
    }

    expect(state.effectiveMaxTradeSize).to.deep.equal({ majors: "0.90", longtail: "1.00" });
  });
});
