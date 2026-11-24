const { expect } = require("chai");

const BORROWED = "0x1111111111111111111111111111111111111111";
const INTERMEDIATE = "0x2222222222222222222222222222222222222222";
const ROUTER_OUT = "0x3333333333333333333333333333333333333333";
const ROUTER_BACK = "0x4444444444444444444444444444444444444444";

const PAIRS_CONFIG_JSON = JSON.stringify([
  {
    profile: "majors",
    minProfitBps: 10,
    borrowedToken: { address: BORROWED, decimals: 18 },
    intermediateToken: { address: INTERMEDIATE, decimals: 18 },
    legOut: { kind: "V2", router: ROUTER_OUT, tokenOut: INTERMEDIATE },
    legBack: { kind: "V2", router: ROUTER_BACK, tokenOut: BORROWED },
    tradeSizes: ["0.1"],
  },
]);

const previousEnv = {
  ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL,
  PAIRS_CONFIG_JSON: process.env.PAIRS_CONFIG_JSON,
  ETH_USD_ROUTE_JSON: process.env.ETH_USD_ROUTE_JSON,
};

process.env.ARBITRUM_RPC_URL = previousEnv.ARBITRUM_RPC_URL || "http://127.0.0.1:8545";
process.env.PAIRS_CONFIG_JSON = PAIRS_CONFIG_JSON;
process.env.ETH_USD_ROUTE_JSON = "";

const {
  validatePairSpreadSettings,
  validateScannerConfig,
  optionalProbeInteger,
} = require("../bot/config");

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

const BASE_SETTINGS = {
  mode: "off",
  windowSize: 20,
  minSamples: 5,
  maxAgeMs: 24 * 60 * 60 * 1000,
};

const VALID_CONFIG = {
  minProfitUsd: 5,
  aaveFlashLoanPremiumBps: 5n,
  gasPriceBufferPct: 20,
  maxGasLimit: 1000000n,
  maxWalletBalanceEth: 0.1,
  maxDailyGasEth: 0.01,
};

const CONFIG_PATH = require.resolve("../bot/config");
const CONFIG_ENV_KEYS = [
  "ARBITRUM_RPC_URL",
  "PAIRS_CONFIG_JSON",
  "ETH_USD_ROUTE_JSON",
  "PAIR_SPREAD_MODE",
  "PAIR_SPREAD_WINDOW_SIZE",
  "PAIR_SPREAD_MIN_SAMPLES",
  "PAIR_SPREAD_MAX_AGE_MS",
  "PAIR_SPREAD_PROBE_INTERVAL_MS",
  "PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS",
  "PAIR_SPREAD_PROBE_MAX_PER_CYCLE",
];

// Reloads bot/config in isolation. Console output is captured so a deliberate
// configuration warning does not pollute the test run.
function loadFreshConfig(overrides = {}) {
  const previous = {};
  for (const key of CONFIG_ENV_KEYS) previous[key] = process.env[key];
  const cached = require.cache[CONFIG_PATH];
  const warnings = [];
  const logs = [];
  const originalWarn = console.warn;
  const originalLog = console.log;

  process.env.ARBITRUM_RPC_URL = previous.ARBITRUM_RPC_URL || "http://127.0.0.1:8545";
  process.env.PAIRS_CONFIG_JSON = PAIRS_CONFIG_JSON;
  process.env.ETH_USD_ROUTE_JSON = "";
  for (const key of CONFIG_ENV_KEYS) {
    if (["ARBITRUM_RPC_URL", "PAIRS_CONFIG_JSON", "ETH_USD_ROUTE_JSON"].includes(key)) {
      continue;
    }
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  console.warn = (message) => warnings.push(String(message));
  console.log = (message) => logs.push(String(message));
  delete require.cache[CONFIG_PATH];

  try {
    const config = require("../bot/config");
    return { config, warnings, logs };
  } finally {
    console.warn = originalWarn;
    console.log = originalLog;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (cached) require.cache[CONFIG_PATH] = cached;
    else delete require.cache[CONFIG_PATH];
  }
}

const ACTIVE_SETTINGS = {
  ...BASE_SETTINGS,
  mode: "enforce",
  probeIntervalMs: 3600000,
  probeGlobalIntervalMs: 300000,
  probeMaxPerCycle: 1,
  pairCount: 1,
};

function collectWarnings(options) {
  const warnings = [];
  validatePairSpreadSettings({
    ...options,
    warn: (message) => warnings.push(String(message)),
  });
  return warnings;
}

describe("bot/config pair spread probe settings", function () {
  it("accepts the disabled-by-default interval and default capacity", function () {
    expect(() => validatePairSpreadSettings(BASE_SETTINGS)).to.not.throw();
    expect(() => validateScannerConfig(VALID_CONFIG)).to.not.throw();
  });

  it("loads PAIR_SPREAD_PROBE_INTERVAL_MS=0, GLOBAL_INTERVAL_MS=0 and MAX_PER_CYCLE=1 by default", function () {
    const configPath = require.resolve("../bot/config");
    const cachedConfig = require.cache[configPath];
    const previous = {
      PAIR_SPREAD_PROBE_INTERVAL_MS: process.env.PAIR_SPREAD_PROBE_INTERVAL_MS,
      PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS:
        process.env.PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS,
      PAIR_SPREAD_PROBE_MAX_PER_CYCLE: process.env.PAIR_SPREAD_PROBE_MAX_PER_CYCLE,
      ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL,
      PAIRS_CONFIG_JSON: process.env.PAIRS_CONFIG_JSON,
      ETH_USD_ROUTE_JSON: process.env.ETH_USD_ROUTE_JSON,
    };

    process.env.PAIR_SPREAD_PROBE_INTERVAL_MS = "";
    process.env.PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS = "";
    process.env.PAIR_SPREAD_PROBE_MAX_PER_CYCLE = "";
    process.env.ARBITRUM_RPC_URL = previous.ARBITRUM_RPC_URL || "http://127.0.0.1:8545";
    process.env.PAIRS_CONFIG_JSON = PAIRS_CONFIG_JSON;
    process.env.ETH_USD_ROUTE_JSON = "";
    delete require.cache[configPath];

    try {
      const config = require("../bot/config");
      expect(config.pairSpreadProbeIntervalMs).to.equal(0);
      expect(config.pairSpreadProbeGlobalIntervalMs).to.equal(0);
      expect(config.pairSpreadProbeMaxPerCycle).to.equal(1);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      if (cachedConfig) require.cache[configPath] = cachedConfig;
      else delete require.cache[configPath];
    }
  });

  it("rejects malformed probe intervals", function () {
    for (const value of [-1, 1.5, NaN, Infinity, "60000", null]) {
      expect(() =>
        validatePairSpreadSettings({ ...BASE_SETTINGS, probeIntervalMs: value })
      ).to.throw(/PAIR_SPREAD_PROBE_INTERVAL_MS must be a non-negative integer/);
    }
  });

  it("rejects malformed probe capacities", function () {
    for (const value of [0, -1, 1.5, NaN, Infinity, "1", null]) {
      expect(() =>
        validatePairSpreadSettings({ ...BASE_SETTINGS, probeMaxPerCycle: value })
      ).to.throw(/PAIR_SPREAD_PROBE_MAX_PER_CYCLE must be an integer >= 1/);
    }
  });

  it("accepts a positive interval within the conservative sample margin", function () {
    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        probeIntervalMs: 4 * 60 * 60 * 1000,
        probeGlobalIntervalMs: 5 * 60 * 1000,
        probeMaxPerCycle: 3,
      })
    ).to.not.throw();
  });

  it("rejects an interval whose minimum sample span exceeds maxAgeMs", function () {
    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        probeIntervalMs: 5 * 60 * 60 * 1000,
      })
    ).to.throw(/conservative operational margin/);
  });

  it("does not apply the sample margin when probes are disabled", function () {
    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        maxAgeMs: 1,
        probeIntervalMs: 0,
      })
    ).to.not.throw();
  });

  it("validates the probe settings through validateScannerConfig", function () {
    expect(() =>
      validateScannerConfig({ ...VALID_CONFIG, pairSpreadProbeIntervalMs: -1 })
    ).to.throw(/PAIR_SPREAD_PROBE_INTERVAL_MS/);
    expect(() =>
      validateScannerConfig({ ...VALID_CONFIG, pairSpreadProbeMaxPerCycle: 0 })
    ).to.throw(/PAIR_SPREAD_PROBE_MAX_PER_CYCLE/);
  });

  describe("optionalProbeInteger", function () {
    const NAME = "PAIR_SPREAD_TEST_PROBE_INTEGER";

    afterEach(function () {
      delete process.env[NAME];
    });

    it("uses the fallback when absent or empty", function () {
      delete process.env[NAME];
      expect(optionalProbeInteger(NAME, 7)).to.equal(7);
      process.env[NAME] = "";
      expect(optionalProbeInteger(NAME, 7)).to.equal(7);
    });

    it("parses decimal digits, trims surrounding spaces and accepts 0", function () {
      process.env[NAME] = "0";
      expect(optionalProbeInteger(NAME, 7)).to.equal(0);
      process.env[NAME] = " 42 ";
      expect(optionalProbeInteger(NAME, 7)).to.equal(42);
      process.env[NAME] = "007";
      expect(optionalProbeInteger(NAME, 7)).to.equal(7);
    });

    it("rejects whitespace-only values instead of converting them to 0", function () {
      for (const value of ["   ", "\t", "\n", " \t\n "]) {
        process.env[NAME] = value;
        expect(() => optionalProbeInteger(NAME, 7)).to.throw(/whitespace-only/);
      }
    });

    it("rejects partially numeric and non-decimal values", function () {
      for (const value of [
        "1.5",
        "1e3",
        "+1",
        "-1",
        "0x10",
        "NaN",
        "Infinity",
        "null",
        "true",
        "1 2",
        "12abc",
        "--1",
      ]) {
        process.env[NAME] = value;
        expect(() => optionalProbeInteger(NAME, 7)).to.throw(
          /decimal digits only/
        );
      }
    });

    it("rejects values above Number.MAX_SAFE_INTEGER", function () {
      process.env[NAME] = String(Number.MAX_SAFE_INTEGER + 1);
      expect(() => optionalProbeInteger(NAME, 7)).to.throw(/safe integer/);
      process.env[NAME] = "9".repeat(30);
      expect(() => optionalProbeInteger(NAME, 7)).to.throw(/safe integer/);
    });
  });

  it("loads the three probe settings from the environment", function () {
    const { config, warnings } = loadFreshConfig({
      PAIR_SPREAD_PROBE_INTERVAL_MS: "3600000",
      PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS: "300000",
      PAIR_SPREAD_PROBE_MAX_PER_CYCLE: "3",
    });

    expect(config.pairSpreadProbeIntervalMs).to.equal(3600000);
    expect(config.pairSpreadProbeGlobalIntervalMs).to.equal(300000);
    expect(config.pairSpreadProbeMaxPerCycle).to.equal(3);
    // off mode validates the settings but probes stay inert.
    expect(
      warnings.some((message) => message.includes("PROBE_SETTINGS_INERT"))
    ).to.equal(true);
  });

  it("rejects malformed probe environment values at startup", function () {
    const cases = [
      ["PAIR_SPREAD_PROBE_INTERVAL_MS", "   "],
      ["PAIR_SPREAD_PROBE_INTERVAL_MS", "1.5"],
      ["PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS", "1e3"],
      ["PAIR_SPREAD_PROBE_MAX_PER_CYCLE", "11"],
      ["PAIR_SPREAD_PROBE_MAX_PER_CYCLE", "abc"],
    ];

    for (const [name, value] of cases) {
      expect(() => loadFreshConfig({ [name]: value })).to.throw();
    }
  });

  it("accepts the exact defaults without warning", function () {
    expect(collectWarnings(BASE_SETTINGS)).to.deep.equal([]);
    expect(validatePairSpreadSettings(BASE_SETTINGS)).to.equal("off");
  });

  it("accepts the inclusive bounds of every probe setting", function () {
    const maxIntervalMs = (24 * 60 * 60 * 1000) / 5;

    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        mode: "enforce",
        probeIntervalMs: maxIntervalMs,
        probeGlobalIntervalMs: maxIntervalMs,
        probeMaxPerCycle: 10,
        pairCount: 1,
        warn: () => {},
      })
    ).to.not.throw();

    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        probeIntervalMs: 1,
        probeGlobalIntervalMs: 1,
        probeMaxPerCycle: 10,
        warn: () => {},
      })
    ).to.not.throw();
  });

  it("rejects non-integer, negative, NaN, infinite, null and string intervals", function () {
    for (const value of [
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "60000",
      null,
      true,
      {},
      [],
    ]) {
      expect(() =>
        validatePairSpreadSettings({ ...BASE_SETTINGS, probeIntervalMs: value })
      ).to.throw(/PAIR_SPREAD_PROBE_INTERVAL_MS must be a non-negative integer/);
      expect(() =>
        validatePairSpreadSettings({
          ...BASE_SETTINGS,
          probeGlobalIntervalMs: value,
        })
      ).to.throw(
        /PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS must be a non-negative integer/
      );
    }
  });

  it("rejects malformed probe capacities", function () {
    for (const value of [
      0,
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "1",
      null,
      true,
      {},
      [],
    ]) {
      expect(() =>
        validatePairSpreadSettings({ ...BASE_SETTINGS, probeMaxPerCycle: value })
      ).to.throw(/PAIR_SPREAD_PROBE_MAX_PER_CYCLE must be an integer >= 1/);
    }
  });

  it("rejects interval and global interval beyond maxAgeMs / minSamples", function () {
    const tooLargeMs = (24 * 60 * 60 * 1000) / 5 + 1;

    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        probeIntervalMs: tooLargeMs,
        probeGlobalIntervalMs: 1,
        warn: () => {},
      })
    ).to.throw(/PAIR_SPREAD_PROBE_INTERVAL_MS is too large/);

    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        probeGlobalIntervalMs: tooLargeMs,
        warn: () => {},
      })
    ).to.throw(/PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS is too large/);
  });

  it("rejects a positive interval with a zero global interval", function () {
    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        probeIntervalMs: 3600000,
        probeGlobalIntervalMs: 0,
        warn: () => {},
      })
    ).to.throw(/PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS must be > 0/);
  });

  it("accepts a zero global interval while probes are disabled", function () {
    expect(() =>
      validatePairSpreadSettings({
        ...BASE_SETTINGS,
        probeIntervalMs: 0,
        probeGlobalIntervalMs: 0,
        warn: () => {},
      })
    ).to.not.throw();
  });

  it("applies the same validation and coupling in off, shadow and enforce", function () {
    for (const mode of ["off", "shadow", "enforce"]) {
      expect(() =>
        validatePairSpreadSettings({
          ...BASE_SETTINGS,
          mode,
          probeIntervalMs: -1,
        })
      ).to.throw(/PAIR_SPREAD_PROBE_INTERVAL_MS/);

      expect(() =>
        validatePairSpreadSettings({
          ...BASE_SETTINGS,
          mode,
          probeIntervalMs: 3600000,
          probeGlobalIntervalMs: 0,
        })
      ).to.throw(/PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS must be > 0/);

      expect(() =>
        validatePairSpreadSettings({
          ...BASE_SETTINGS,
          mode,
          probeIntervalMs: 3600000,
          probeGlobalIntervalMs: 300000,
          warn: () => {},
        })
      ).to.not.throw();
    }
  });

  it("accepts pairCount sentinels while probes are disabled", function () {
    for (const pairCount of [undefined, null, 0, 1, 58]) {
      expect(() =>
        validatePairSpreadSettings({
          ...BASE_SETTINGS,
          pairCount,
          warn: () => {},
        })
      ).to.not.throw();
    }
  });

  it("rejects an invalid pairCount in every mode", function () {
    for (const mode of ["off", "shadow", "enforce"]) {
      for (const pairCount of [
        -1,
        1.5,
        NaN,
        Infinity,
        Number.MAX_SAFE_INTEGER + 1,
        "3",
        true,
        {},
        [],
      ]) {
        expect(() =>
          validatePairSpreadSettings({
            ...BASE_SETTINGS,
            mode,
            pairCount,
          })
        ).to.throw(/pairCount must be a non-negative safe integer/);
      }
    }
  });

  it("emits PROBE_CAPACITY_INDETERMINATE for an absent, null or zero pairCount", function () {
    for (const pairCount of [undefined, null, 0]) {
      const warnings = collectWarnings({ ...ACTIVE_SETTINGS, pairCount });
      expect(warnings).to.have.lengthOf(1);
      expect(warnings[0]).to.include("PROBE_CAPACITY_INDETERMINATE");
    }
  });

  it("emits PROBE_CAPACITY_MARGIN only above the nominal sample margin", function () {
    const below = collectWarnings({ ...ACTIVE_SETTINGS, pairCount: 57 });
    expect(below).to.deep.equal([]);

    const above = collectWarnings({ ...ACTIVE_SETTINGS, pairCount: 58 });
    expect(above).to.have.lengthOf(1);
    expect(above[0]).to.include("PROBE_CAPACITY_MARGIN");

    // Increasing maxPerCycle shortens the nominal batch rotation.
    const largerBatch = collectWarnings({
      ...ACTIVE_SETTINGS,
      pairCount: 58,
      probeMaxPerCycle: 2,
    });
    expect(largerBatch).to.deep.equal([]);
  });

  it("emits PROBE_CAPACITY_INDETERMINATE instead of an unsafe overflow", function () {
    const warnings = collectWarnings({
      ...ACTIVE_SETTINGS,
      pairCount: Number.MAX_SAFE_INTEGER,
      probeGlobalIntervalMs: 2,
    });

    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include("PROBE_CAPACITY_INDETERMINATE");
  });

  it("emits no capacity warning when interval is 0 or mode is not enforce", function () {
    const disabled = collectWarnings({
      ...ACTIVE_SETTINGS,
      probeIntervalMs: 0,
      probeGlobalIntervalMs: 0,
      pairCount: 58,
    });
    expect(disabled).to.deep.equal([]);

    for (const mode of ["off", "shadow"]) {
      const warnings = collectWarnings({
        ...ACTIVE_SETTINGS,
        mode,
        pairCount: 58,
      });
      expect(
        warnings.some((message) => message.includes("PROBE_CAPACITY"))
      ).to.equal(false);
      expect(
        warnings.some((message) => message.includes("PROBE_SETTINGS_INERT"))
      ).to.equal(true);
    }
  });

  it("warns when non-default probe settings are inert", function () {
    const offWarnings = collectWarnings({
      ...BASE_SETTINGS,
      mode: "off",
      probeIntervalMs: 3600000,
      probeGlobalIntervalMs: 300000,
    });
    expect(offWarnings[0]).to.include("PROBE_SETTINGS_INERT");

    const disabledCapacityWarnings = collectWarnings({
      ...BASE_SETTINGS,
      mode: "enforce",
      probeMaxPerCycle: 3,
    });
    expect(disabledCapacityWarnings[0]).to.include("PROBE_SETTINGS_INERT");

    const disabledGlobalWarnings = collectWarnings({
      ...BASE_SETTINGS,
      mode: "enforce",
      probeGlobalIntervalMs: 300000,
    });
    expect(disabledGlobalWarnings[0]).to.include("PROBE_SETTINGS_INERT");
  });

  it("uses console.warn by default", function () {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => warnings.push(String(message));

    try {
      validatePairSpreadSettings({ ...ACTIVE_SETTINGS, pairCount: undefined });
    } finally {
      console.warn = originalWarn;
    }

    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include("PROBE_CAPACITY_INDETERMINATE");
  });

  it("logs the probe status once at startup", function () {
    const disabled = loadFreshConfig();
    const disabledLines = disabled.logs.filter((line) =>
      line.startsWith("[PAIR SPREAD] probe ")
    );
    expect(disabledLines).to.have.lengthOf(1);
    expect(disabledLines[0]).to.include("probe disabled interval=0");

    const enabled = loadFreshConfig({
      PAIR_SPREAD_MODE: "enforce",
      PAIR_SPREAD_PROBE_INTERVAL_MS: "3600000",
      PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS: "300000",
    });
    const enabledLines = enabled.logs.filter((line) =>
      line.startsWith("[PAIR SPREAD] probe ")
    );
    expect(enabledLines).to.have.lengthOf(1);
    expect(enabledLines[0]).to.equal(
      "[PAIR SPREAD] probe enabled interval=3600000 maxPerCycle=1 globalInterval=300000"
    );
  });

  it("propagates the global interval and pairCount through validateScannerConfig", function () {
    const warnings = [];
    expect(() =>
      validateScannerConfig({
        ...VALID_CONFIG,
        pairSpreadMode: "enforce",
        pairSpreadProbeIntervalMs: 3600000,
        pairSpreadProbeGlobalIntervalMs: 300000,
        pairSpreadProbeMaxPerCycle: 1,
        pairCount: 58,
        warn: (message) => warnings.push(message),
      })
    ).to.not.throw();

    expect(warnings).to.have.lengthOf(1);
    expect(warnings[0]).to.include("PROBE_CAPACITY_MARGIN");

    expect(() =>
      validateScannerConfig({
        ...VALID_CONFIG,
        pairSpreadProbeGlobalIntervalMs: -1,
      })
    ).to.throw(/PAIR_SPREAD_PROBE_GLOBAL_INTERVAL_MS/);

    expect(() =>
      validateScannerConfig({ ...VALID_CONFIG, pairCount: -1 })
    ).to.throw(/pairCount must be a non-negative safe integer/);
  });
});
