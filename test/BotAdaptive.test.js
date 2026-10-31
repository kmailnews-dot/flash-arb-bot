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
      effectiveMaxTradeSize: "1.00",
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
      effectiveMaxTradeSize: "1.50",
      history: [],
    });

    const tooHigh = await loadAdaptive({ filePath, config });
    expect(tooHigh.effectiveMaxTradeSize).to.equal("1.00");

    writeRawState(filePath, {
      effectiveMinProfitBps: 30,
      effectiveMaxTradeSize: "0.01",
      history: [],
    });

    const tooLow = await loadAdaptive({ filePath, config });
    expect(tooLow.effectiveMaxTradeSize).to.equal("0.10");
  });

  it("raises effectiveMinProfitBps by 5 after 3 FAILURE and caps it", async function () {
    const config = makeConfig();
    let state;

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", config, now: 1000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(35);

    writeRawState(filePath, {
      effectiveMinProfitBps: 59,
      effectiveMaxTradeSize: "1.00",
      history: [],
    });

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", config, now: 2000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(60);
  });

  it("lowers effectiveMinProfitBps by 5 after 3 SUCCESS, floored at config.minProfitBps", async function () {
    const config = makeConfig();
    let state;

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", config, now: 1000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(35);

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "SUCCESS", config, now: 2000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(30);

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "SUCCESS", config, now: 3000 + i });
    }
    expect(state.effectiveMinProfitBps).to.equal(30);
  });

  it("lowers effectiveMaxTradeSize by 0.10 after 3 FAILURE, floored at 0.10", async function () {
    const config = makeConfig();
    let state;

    for (let i = 0; i < 3; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", config, now: 1000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.equal("0.90");

    for (let i = 0; i < 9; i += 1) {
      state = await recordOutcome({ filePath, outcome: "FAILURE", config, now: 2000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.equal("0.10");

    state = await recordOutcome({ filePath, outcome: "FAILURE", config, now: 3000 });
    expect(state.effectiveMaxTradeSize).to.equal("0.10");
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
      state = await recordOutcome({ filePath, outcome: "SUCCESS", config, now: 1000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.equal("0.90");

    for (let i = 0; i < 2; i += 1) {
      state = await recordOutcome({ filePath, outcome: "SUCCESS", config, now: 2000 + i });
    }
    expect(state.effectiveMaxTradeSize).to.equal("1.00");

    state = await recordOutcome({ filePath, outcome: "SUCCESS", config, now: 3000 });
    expect(state.effectiveMaxTradeSize).to.equal("1.00");
  });

  it("truncates history to the last ADAPTIVE_WINDOW entries", async function () {
    const config = makeConfig();
    const start = 1000;

    let state;
    for (let i = 0; i < ADAPTIVE_WINDOW + 5; i += 1) {
      state = await recordOutcome({
        filePath,
        outcome: "UNKNOWN",
        config,
        now: start + i,
      });
    }

    expect(state.history).to.have.lengthOf(ADAPTIVE_WINDOW);
    expect(state.history[0].at).to.equal(start + 5);
    expect(state.history[ADAPTIVE_WINDOW - 1].at).to.equal(start + ADAPTIVE_WINDOW + 4);
  });

  it("applyAdaptive returns a distinct copy and never mutates config or state", function () {
    const config = makeConfig();
    const state = {
      effectiveMinProfitBps: 35,
      effectiveMaxTradeSize: "0.50",
      history: [{ outcome: "FAILURE", at: 1000 }],
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
      effectiveMaxTradeSize: "0.50",
      history: [],
    };

    const applied = applyAdaptive({ config, state });

    expect(applied.minProfitBps).to.equal(60);
    expect(applied.effectiveMinProfitBps).to.equal(60);
    expect(applied.effectiveMaxTradeSize).to.equal("0.50");
    expect(applied.tradeSizeFactor).to.equal(0.5);
    expect(applied.pairs[0].tradeSizes).to.deep.equal(["500.0000", "1000.0000"]);
    expect(config.minProfitBps).to.equal(30);
    expect(config.pairs[0].tradeSizes).to.deep.equal(["1000", "2000"]);

    const floored = applyAdaptive({
      config,
      state: { ...state, effectiveMinProfitBps: 1 },
    });
    expect(floored.minProfitBps).to.equal(30);
  });
});
