const { expect } = require("chai");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const {
  DEFAULT_PAIR_SPREADS_PATH,
  PAIR_SPREAD_STORE_VERSION,
  PAIR_SPREAD_STORE_CODES,
  PairSpreadStoreError,
  isPairSpreadStoreError,
  resolvePairSpreadPath,
  createEmptyPairSpreadState,
  loadPairSpreadState,
  appendPairSpreadSamples,
  writePairSpreadState,
  recordPairSpreadSamples,
} = require("../bot/pairSpreadStore");

const NOW = 1_760_000_000_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const KEY_A =
  "v1|42161|0xaf88d065e77c8cc2239327c5edb3a432268e5831|0x82af49447d8a07e3bd95bd0d56f35241523fbab1|V3|0xe592427a0aece92de3edee1f18e0157c05861564|500|0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6|V2|0x1b02da8cb0d097eb8d57a175b88c7d8b47997506||";
const KEY_B =
  "v1|42161|0xaf88d065e77c8cc2239327c5edb3a432268e5831|0x82af49447d8a07e3bd95bd0d56f35241523fbab1|V3|0xe592427a0aece92de3edee1f18e0157c05861564|3000|0xb27308f9f90d607463bb33ea1bebb41c27ce5ab6|V2|0x1b02da8cb0d097eb8d57a175b88c7d8b47997506||";

function sample(value, at = NOW) {
  return { netProfitBps: String(value), at };
}

function documentWith(pairs) {
  return { version: PAIR_SPREAD_STORE_VERSION, pairs };
}

function pairEntry(samples) {
  return { samples };
}

function writeRaw(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function writeJson(filePath, value) {
  writeRaw(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readRaw(filePath) {
  return fs.readFileSync(filePath, "utf8");
}

function readJson(filePath) {
  return JSON.parse(readRaw(filePath));
}

function tmpFilesFor(filePath) {
  const dir = path.dirname(filePath);
  const prefix = `${path.basename(filePath)}.`;
  return fs
    .readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".tmp"))
    .sort();
}

async function rejection(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

describe("bot/pairSpreadStore", function () {
  let storeDir;
  let filePath;
  let realFileBefore;

  before(function () {
    realFileBefore = fs.existsSync(DEFAULT_PAIR_SPREADS_PATH)
      ? fs.statSync(DEFAULT_PAIR_SPREADS_PATH).mtimeMs
      : null;
  });

  after(function () {
    const exists = fs.existsSync(DEFAULT_PAIR_SPREADS_PATH);
    if (realFileBefore === null) {
      expect(exists, "tests must not create the real logs/pair_spreads.json").to.equal(false);
    } else {
      expect(fs.statSync(DEFAULT_PAIR_SPREADS_PATH).mtimeMs).to.equal(realFileBefore);
    }
  });

  beforeEach(function () {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-pair-spread-store-"));
    filePath = path.join(storeDir, "pair_spreads.json");
  });

  afterEach(function () {
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  describe("constants and empty state", function () {
    it("anchors the default path on the module logs directory", function () {
      expect(path.isAbsolute(DEFAULT_PAIR_SPREADS_PATH)).to.equal(true);
      expect(DEFAULT_PAIR_SPREADS_PATH).to.equal(
        path.resolve(__dirname, "..", "logs", "pair_spreads.json")
      );
    });

    it("honours PAIR_SPREAD_PATH with a custom path", function () {
      expect(resolvePairSpreadPath({ PAIR_SPREAD_PATH: "/tmp/custom.json" })).to.equal(
        path.resolve("/tmp/custom.json")
      );
    });

    it("falls back to the default path when PAIR_SPREAD_PATH is absent", function () {
      expect(resolvePairSpreadPath({})).to.equal(DEFAULT_PAIR_SPREADS_PATH);
    });

    it("falls back to the default path when PAIR_SPREAD_PATH is empty or whitespace", function () {
      expect(resolvePairSpreadPath({ PAIR_SPREAD_PATH: "" })).to.equal(
        DEFAULT_PAIR_SPREADS_PATH
      );
      expect(resolvePairSpreadPath({ PAIR_SPREAD_PATH: "   " })).to.equal(
        DEFAULT_PAIR_SPREADS_PATH
      );
    });

    it("ignores the legacy PAIR_SPREADS_PATH variable", function () {
      expect(
        resolvePairSpreadPath({ PAIR_SPREADS_PATH: "/tmp/legacy.json" })
      ).to.equal(DEFAULT_PAIR_SPREADS_PATH);
      expect(
        resolvePairSpreadPath({
          PAIR_SPREAD_PATH: "/tmp/current.json",
          PAIR_SPREADS_PATH: "/tmp/legacy.json",
        })
      ).to.equal(path.resolve("/tmp/current.json"));
    });

    it("resolves PAIR_SPREAD_PATH lazily, not from the environment at module load", function () {
      const before = process.env.PAIR_SPREAD_PATH;
      try {
        delete process.env.PAIR_SPREAD_PATH;
        expect(resolvePairSpreadPath()).to.equal(DEFAULT_PAIR_SPREADS_PATH);

        process.env.PAIR_SPREAD_PATH = "/tmp/late-env.json";
        expect(resolvePairSpreadPath()).to.equal(path.resolve("/tmp/late-env.json"));
      } finally {
        if (before === undefined) delete process.env.PAIR_SPREAD_PATH;
        else process.env.PAIR_SPREAD_PATH = before;
      }
    });

    it("creates a fresh empty state", function () {
      const first = createEmptyPairSpreadState();
      const second = createEmptyPairSpreadState();
      expect(first).to.deep.equal({ version: 1, pairs: {} });
      expect(second).to.deep.equal({ version: 1, pairs: {} });
      expect(first).to.not.equal(second);
      expect(first.pairs).to.not.equal(second.pairs);
    });

    it("uses prefixed store codes", function () {
      for (const code of Object.values(PAIR_SPREAD_STORE_CODES)) {
        expect(code.startsWith("PAIR_SPREAD_")).to.equal(true);
      }
    });
  });

  describe("load: absent file", function () {
    it("treats a missing file as an empty history and does not create it", async function () {
      const warnings = [];
      const result = await loadPairSpreadState({
        filePath,
        now: NOW,
        warn: (message) => warnings.push(message),
      });

      expect(result.ok).to.equal(true);
      expect(result.status).to.equal("absent");
      expect(result.writable).to.equal(true);
      expect(result.state).to.deep.equal({ version: 1, pairs: {} });
      expect(result.warning).to.include(PAIR_SPREAD_STORE_CODES.MISSING);
      expect(result.warning).to.include(filePath);
      expect(warnings).to.deep.equal([result.warning]);
      expect(fs.existsSync(filePath)).to.equal(false);
    });

    it("does not create a file when recording no samples", async function () {
      const result = await recordPairSpreadSamples({
        filePath,
        samples: [],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(false);
      expect(fs.existsSync(filePath)).to.equal(false);
    });

    it("creates the file on the first recorded sample", async function () {
      const result = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: -42n, at: NOW }],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      expect(result.added).to.equal(1);
      expect(fs.existsSync(filePath)).to.equal(true);

      const stored = readJson(filePath);
      expect(stored.version).to.equal(1);
      expect(stored.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "-42", at: NOW },
      ]);
    });
  });

  describe("warning callback", function () {
    it("does not warn on a nominal load", async function () {
      writeJson(filePath, documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }));
      const warnings = [];

      const result = await loadPairSpreadState({
        filePath,
        now: NOW,
        warn: (message) => warnings.push(message),
      });

      expect(result.status).to.equal("ok");
      expect(result.warning).to.equal(null);
      expect(warnings).to.deep.equal([]);
    });

    it("does not warn on a nominal write", async function () {
      const warnings = [];

      const result = await writePairSpreadState({
        filePath,
        state: createEmptyPairSpreadState(),
        now: NOW,
        warn: (message) => warnings.push(message),
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      expect(warnings).to.deep.equal([]);
    });

    it("does not warn on a nominal record over a valid state", async function () {
      writeJson(
        filePath,
        documentWith({ [KEY_A]: pairEntry([sample(10, NOW - MINUTE_MS)]) })
      );
      const warnings = [];

      const result = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: 20n, at: NOW }],
        now: NOW,
        warn: (message) => warnings.push(message),
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      expect(warnings).to.deep.equal([]);
    });

    it("does not warn on a no-op record over a valid state", async function () {
      writeJson(filePath, documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }));
      const warnings = [];

      const result = await recordPairSpreadSamples({
        filePath,
        samples: [],
        now: NOW,
        warn: (message) => warnings.push(message),
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(false);
      expect(warnings).to.deep.equal([]);
    });

    it("emits the absent-state warning exactly once and never null", async function () {
      const warnings = [];

      const result = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
        now: NOW,
        warn: (message) => warnings.push(message),
      });

      expect(result.written).to.equal(true);
      expect(result.warning).to.include(PAIR_SPREAD_STORE_CODES.MISSING);
      expect(warnings).to.deep.equal([result.warning]);
      expect(
        warnings.every(
          (message) => typeof message === "string" && message.length > 0
        )
      ).to.equal(true);
    });

    it("keeps a successful write when the warning callback throws", async function () {
      const result = await writePairSpreadState({
        filePath,
        state: documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }),
        now: NOW,
        warn: () => {
          throw new Error("logger unavailable");
        },
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      expect(readJson(filePath).pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW },
      ]);
    });

    it("keeps a load result when the warning callback throws", async function () {
      const result = await loadPairSpreadState({
        filePath,
        now: NOW,
        warn: () => {
          throw new Error("logger unavailable");
        },
      });

      expect(result.status).to.equal("absent");
      expect(result.writable).to.equal(true);
    });

    it("keeps a write failure result when the warning callback throws", async function () {
      const originalRename = fsp.rename;
      fsp.rename = async () => {
        const err = new Error("simulated rename failure");
        err.code = "EIO";
        throw err;
      };

      try {
        const result = await writePairSpreadState({
          filePath,
          state: documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }),
          now: NOW,
          warn: () => {
            throw new Error("logger unavailable");
          },
        });

        expect(result.ok).to.equal(false);
        expect(result.written).to.equal(false);
        expect(result.error.code).to.equal(PAIR_SPREAD_STORE_CODES.WRITE_FAILED);
        expect(tmpFilesFor(filePath)).to.deep.equal([]);
      } finally {
        fsp.rename = originalRename;
      }
    });
  });

  describe("load: valid state", function () {
    it("returns canonical samples and ignores unknown fields", async function () {
      writeJson(filePath, {
        version: 1,
        ignoredRoot: true,
        pairs: {
          [KEY_A]: {
            ignoredPair: "x",
            samples: [
              { netProfitBps: "007", at: NOW - MINUTE_MS, ignoredSample: true },
              { netProfitBps: "-0", at: NOW },
            ],
          },
        },
      });

      const result = await loadPairSpreadState({ filePath, now: NOW });

      expect(result.ok).to.equal(true);
      expect(result.status).to.equal("ok");
      expect(result.writable).to.equal(true);
      expect(result.warning).to.equal(null);
      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "7", at: NOW - MINUTE_MS },
        { netProfitBps: "0", at: NOW },
      ]);
      expect(result.state).to.not.have.property("ignoredRoot");
      expect(result.state.pairs[KEY_A]).to.not.have.property("ignoredPair");
      expect(result.state.pairs[KEY_A].samples[0]).to.not.have.property("ignoredSample");
    });

    it("sorts samples by at", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([
            sample(10, NOW),
            sample(20, NOW - 2 * MINUTE_MS),
            sample(30, NOW - MINUTE_MS),
          ]),
        })
      );

      const result = await loadPairSpreadState({ filePath, now: NOW });

      expect(result.state.pairs[KEY_A].samples.map((s) => s.at)).to.deep.equal([
        NOW - 2 * MINUTE_MS,
        NOW - MINUTE_MS,
        NOW,
      ]);
    });
  });

  describe("load: corrupt files are never overwritten", function () {
    const corruptContents = [
      ["empty file", ""],
      ["whitespace only", "   \n"],
      ["invalid JSON", "{not valid json"],
      ["truncated JSON", '{"version":1,"pairs":'],
    ];

    for (const [label, content] of corruptContents) {
      it(`fails open on ${label} and preserves the file`, async function () {
        writeRaw(filePath, content);
        const before = readRaw(filePath);

        const loaded = await loadPairSpreadState({ filePath, now: NOW });
        expect(loaded.ok).to.equal(false);
        expect(loaded.status).to.equal("corrupt");
        expect(loaded.writable).to.equal(false);
        expect(loaded.error).to.be.instanceOf(PairSpreadStoreError);
        expect(loaded.error.code).to.equal(PAIR_SPREAD_STORE_CODES.CORRUPT);
        expect(loaded.warning).to.include(filePath);

        const recorded = await recordPairSpreadSamples({
          filePath,
          samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
          now: NOW,
        });
        expect(recorded.ok).to.equal(false);
        expect(recorded.written).to.equal(false);
        expect(recorded.warning).to.include(PAIR_SPREAD_STORE_CODES.CORRUPT);
        expect(readRaw(filePath)).to.equal(before);
        expect(tmpFilesFor(filePath)).to.deep.equal([]);
      });
    }

    it("treats a directory as unreadable and never replaces it", async function () {
      const directoryPath = path.join(storeDir, "state-dir");
      fs.mkdirSync(directoryPath);

      const loaded = await loadPairSpreadState({ filePath: directoryPath, now: NOW });
      expect(loaded.ok).to.equal(false);
      expect(loaded.status).to.equal("unreadable");
      expect(loaded.writable).to.equal(false);
      expect(loaded.error.code).to.equal(PAIR_SPREAD_STORE_CODES.UNREADABLE);
      expect(loaded.warning).to.include(directoryPath);

      const recorded = await recordPairSpreadSamples({
        filePath: directoryPath,
        samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
        now: NOW,
      });
      expect(recorded.ok).to.equal(false);
      expect(recorded.written).to.equal(false);
      expect(fs.statSync(directoryPath).isDirectory()).to.equal(true);
      expect(tmpFilesFor(directoryPath)).to.deep.equal([]);
    });
  });

  describe("load: unknown version", function () {
    for (const version of [0, 2, "1", null, undefined]) {
      it(`fails open without writing for version ${String(version)}`, async function () {
        const payload = { version, pairs: {} };
        if (version === undefined) delete payload.version;
        writeJson(filePath, payload);
        const before = readRaw(filePath);

        const loaded = await loadPairSpreadState({ filePath, now: NOW });
        expect(loaded.ok).to.equal(false);
        expect(loaded.status).to.equal("unsupported_version");
        expect(loaded.writable).to.equal(false);
        expect(loaded.error.code).to.equal(PAIR_SPREAD_STORE_CODES.SCHEMA_INVALID);
        expect(loaded.warning).to.include("version");

        const recorded = await recordPairSpreadSamples({
          filePath,
          samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
          now: NOW,
        });
        expect(recorded.ok).to.equal(false);
        expect(recorded.written).to.equal(false);
        expect(readRaw(filePath)).to.equal(before);
      });
    }
  });

  describe("write: D6 never overwrites an invalid state", function () {
    const invalidStates = [
      [
        "corrupt JSON",
        "{not valid json",
        "corrupt",
        PAIR_SPREAD_STORE_CODES.CORRUPT,
      ],
      [
        "an empty file",
        "",
        "corrupt",
        PAIR_SPREAD_STORE_CODES.CORRUPT,
      ],
      [
        "an unknown version",
        `${JSON.stringify({ version: 2, pairs: {} })}\n`,
        "unsupported_version",
        PAIR_SPREAD_STORE_CODES.SCHEMA_INVALID,
      ],
      [
        "an invalid schema",
        `${JSON.stringify({ version: 1, pairs: [] })}\n`,
        "schema_invalid",
        PAIR_SPREAD_STORE_CODES.SCHEMA_INVALID,
      ],
    ];

    for (const [label, content, status, code] of invalidStates) {
      it(`refuses to overwrite ${label}`, async function () {
        writeRaw(filePath, content);
        const before = readRaw(filePath);
        const warnings = [];

        const result = await writePairSpreadState({
          filePath,
          state: documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }),
          now: NOW,
          warn: (message) => warnings.push(message),
        });

        expect(result.ok).to.equal(false);
        expect(result.written).to.equal(false);
        expect(result.writable).to.equal(false);
        expect(result.status).to.equal(status);
        expect(result.error).to.be.instanceOf(PairSpreadStoreError);
        expect(result.error.code).to.equal(code);
        expect(result.warning).to.include(filePath);
        expect(warnings).to.deep.equal([result.warning]);
        expect(readRaw(filePath)).to.equal(before);
        expect(tmpFilesFor(filePath)).to.deep.equal([]);
      });
    }

    it("still writes over an absent file and a valid file", async function () {
      const absent = await writePairSpreadState({
        filePath,
        state: documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }),
        now: NOW,
      });
      expect(absent.ok).to.equal(true);
      expect(absent.status).to.equal("absent");

      const valid = await writePairSpreadState({
        filePath,
        state: documentWith({ [KEY_B]: pairEntry([sample(20, NOW)]) }),
        now: NOW,
      });
      expect(valid.ok).to.equal(true);
      expect(valid.status).to.equal("ok");
      expect(readJson(filePath).pairs).to.have.property(KEY_B);
    });
  });

  describe("load: invalid schema", function () {
    const invalidDocuments = [
      ["root array", []],
      ["root null", null],
      ["root string", "not-an-object"],
      ["missing pairs", { version: 1 }],
      ["pairs array", { version: 1, pairs: [] }],
      ["pairs null", { version: 1, pairs: null }],
      ["pair entry null", documentWith({ [KEY_A]: null })],
      ["pair entry array", documentWith({ [KEY_A]: [] })],
      ["missing samples", documentWith({ [KEY_A]: {} })],
      ["samples not array", documentWith({ [KEY_A]: { samples: {} } })],
      ["sample not object", documentWith({ [KEY_A]: pairEntry([null]) })],
      ["missing bps", documentWith({ [KEY_A]: pairEntry([{ at: NOW }]) })],
      ["bps number", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: 10, at: NOW }]) })],
      ["bps decimal", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: "10.5", at: NOW }]) })],
      ["bps exponent", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: "1e3", at: NOW }]) })],
      ["bps hex", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: "0x10", at: NOW }]) })],
      ["at negative", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: "10", at: -1 }]) })],
      ["at float", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: "10", at: 1.5 }]) })],
      ["at string", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: "10", at: "1" }]) })],
      ["at null", documentWith({ [KEY_A]: pairEntry([{ netProfitBps: "10", at: null }]) })],
      [
        "at unsafe",
        documentWith({
          [KEY_A]: pairEntry([
            { netProfitBps: "10", at: Number.MAX_SAFE_INTEGER + 1 },
          ]),
        }),
      ],
    ];

    for (const [label, payload] of invalidDocuments) {
      it(`fails open on ${label} and preserves the file`, async function () {
        writeJson(filePath, payload);
        const before = readRaw(filePath);

        const loaded = await loadPairSpreadState({ filePath, now: NOW });
        expect(loaded.ok).to.equal(false);
        expect(loaded.status).to.equal("schema_invalid");
        expect(loaded.writable).to.equal(false);
        expect(loaded.error.code).to.equal(PAIR_SPREAD_STORE_CODES.SCHEMA_INVALID);
        expect(loaded.warning).to.include(filePath);

        const recorded = await recordPairSpreadSamples({
          filePath,
          samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
          now: NOW,
        });
        expect(recorded.ok).to.equal(false);
        expect(recorded.written).to.equal(false);
        expect(readRaw(filePath)).to.equal(before);
      });
    }
  });

  describe("window, age and duplicates", function () {
    it("keeps only the last windowSize samples by at on read", async function () {
      const samples = [];
      for (let i = 0; i < 8; i += 1) {
        samples.push(sample(i, NOW - (7 - i) * MINUTE_MS));
      }
      writeJson(filePath, documentWith({ [KEY_A]: pairEntry(samples) }));

      const result = await loadPairSpreadState({
        filePath,
        now: NOW,
        windowSize: 5,
      });

      expect(result.state.pairs[KEY_A].samples.map((s) => s.at)).to.deep.equal([
        NOW - 4 * MINUTE_MS,
        NOW - 3 * MINUTE_MS,
        NOW - 2 * MINUTE_MS,
        NOW - MINUTE_MS,
        NOW,
      ]);
      expect(result.truncated).to.equal(3);
    });

    it("drops expired samples and keeps the inclusive age boundary", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([
            sample(1, NOW - DAY_MS - 1),
            sample(2, NOW - DAY_MS),
            sample(3, NOW - 1),
            sample(4, NOW),
          ]),
        })
      );

      const result = await loadPairSpreadState({ filePath, now: NOW });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "2", at: NOW - DAY_MS },
        { netProfitBps: "3", at: NOW - 1 },
        { netProfitBps: "4", at: NOW },
      ]);
      expect(result.expiredPruned).to.equal(1);
    });

    it("drops future samples from the evaluation view", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([
            sample(1, NOW - MINUTE_MS),
            sample(2, NOW + 1),
            sample(3, NOW + MINUTE_MS),
          ]),
        })
      );

      const result = await loadPairSpreadState({ filePath, now: NOW });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "1", at: NOW - MINUTE_MS },
      ]);
      expect(result.futurePruned).to.equal(2);
    });

    it("dedupes samples sharing the same at, keeping the best bps", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([
            sample(10, NOW - MINUTE_MS),
            sample(30, NOW - MINUTE_MS),
            sample(20, NOW),
          ]),
        })
      );

      const result = await loadPairSpreadState({ filePath, now: NOW });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "30", at: NOW - MINUTE_MS },
        { netProfitBps: "20", at: NOW },
      ]);
      expect(result.duplicatesRemoved).to.equal(1);
    });

    it("tolerates an empty samples array and prunes the entry on the next write", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([]),
          [KEY_B]: pairEntry([sample(5, NOW)]),
        })
      );

      const loaded = await loadPairSpreadState({ filePath, now: NOW });
      expect(loaded.ok).to.equal(true);
      expect(loaded.state.pairs).to.not.have.property(KEY_A);
      expect(loaded.emptyEntries).to.equal(1);

      const recorded = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_B, netProfitBps: 6n, at: NOW }],
        now: NOW,
      });
      expect(recorded.written).to.equal(true);
      const stored = readJson(filePath);
      expect(stored.pairs).to.not.have.property(KEY_A);
      expect(stored.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "6", at: NOW },
      ]);
    });

    it("prunes expired samples on write even without a new sample", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([
            sample(1, NOW - DAY_MS - 1),
            sample(2, NOW - DAY_MS - 2),
          ]),
          [KEY_B]: pairEntry([sample(3, NOW - MINUTE_MS)]),
        })
      );

      const result = await recordPairSpreadSamples({
        filePath,
        samples: [],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      expect(result.added).to.equal(0);
      expect(result.expiredPruned).to.equal(2);
      const stored = readJson(filePath);
      expect(stored.pairs).to.not.have.property(KEY_A);
      expect(stored.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "3", at: NOW - MINUTE_MS },
      ]);
    });

    it("does not rewrite a file just to drop future samples", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([sample(1, NOW + MINUTE_MS)]),
        })
      );
      const before = readRaw(filePath);

      const result = await recordPairSpreadSamples({
        filePath,
        samples: [],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(false);
      expect(readRaw(filePath)).to.equal(before);
    });

    it("prunes future samples when another sample triggers a write", async function () {
      writeJson(
        filePath,
        documentWith({
          [KEY_A]: pairEntry([sample(1, NOW + MINUTE_MS)]),
        })
      );

      const result = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_B, netProfitBps: 5n, at: NOW }],
        now: NOW,
      });

      expect(result.written).to.equal(true);
      const stored = readJson(filePath);
      expect(stored.pairs).to.not.have.property(KEY_A);
      expect(stored.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "5", at: NOW },
      ]);
    });
  });

  describe("append and record", function () {
    it("records multiple keys in one cycle", async function () {
      const result = await recordPairSpreadSamples({
        filePath,
        samples: [
          { key: KEY_A, netProfitBps: 10n, at: NOW },
          { key: KEY_B, netProfitBps: -20n, at: NOW },
        ],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      expect(result.added).to.equal(2);
      const stored = readJson(filePath);
      expect(stored.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW },
      ]);
      expect(stored.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "-20", at: NOW },
      ]);
    });

    it("dedupes duplicate keys in one call, keeping the best bps (D8)", async function () {
      const result = await recordPairSpreadSamples({
        filePath,
        samples: [
          { key: KEY_A, netProfitBps: 10n, at: NOW },
          { key: KEY_A, netProfitBps: 40n, at: NOW },
          { key: KEY_A, netProfitBps: 20n, at: NOW },
        ],
        now: NOW,
      });

      expect(result.added).to.equal(1);
      const stored = readJson(filePath);
      expect(stored.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "40", at: NOW },
      ]);
    });

    it("keeps every timestamp for the same key in one call", function () {
      const result = appendPairSpreadSamples({
        state: createEmptyPairSpreadState(),
        samples: [
          { key: KEY_A, netProfitBps: 10n, at: NOW - MINUTE_MS },
          { key: KEY_A, netProfitBps: 20n, at: NOW },
        ],
        now: NOW,
      });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW - MINUTE_MS },
        { netProfitBps: "20", at: NOW },
      ]);
      expect(result.added).to.equal(2);
      expect(result.changed).to.equal(true);
    });

    it("keeps the best value for the same key and timestamp in one call", function () {
      const result = appendPairSpreadSamples({
        state: createEmptyPairSpreadState(),
        samples: [
          { key: KEY_A, netProfitBps: 10n, at: NOW },
          { key: KEY_A, netProfitBps: 40n, at: NOW },
          { key: KEY_A, netProfitBps: 20n, at: NOW },
        ],
        now: NOW,
      });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "40", at: NOW },
      ]);
      expect(result.added).to.equal(1);
      expect(result.changed).to.equal(true);
    });

    it("keeps pairs and timestamps independent in one call", function () {
      const result = appendPairSpreadSamples({
        state: createEmptyPairSpreadState(),
        samples: [
          { key: KEY_A, netProfitBps: 10n, at: NOW - MINUTE_MS },
          { key: KEY_B, netProfitBps: 20n, at: NOW - MINUTE_MS },
          { key: KEY_A, netProfitBps: 30n, at: NOW },
          { key: KEY_B, netProfitBps: 40n, at: NOW },
        ],
        now: NOW,
      });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW - MINUTE_MS },
        { netProfitBps: "30", at: NOW },
      ]);
      expect(result.state.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "20", at: NOW - MINUTE_MS },
        { netProfitBps: "40", at: NOW },
      ]);
      expect(result.added).to.equal(4);
      expect(result.changed).to.equal(true);
    });

    it("keeps the most recent timestamps when the window overflows", function () {
      const samples = [];
      for (let i = 0; i < 7; i += 1) {
        samples.push({
          key: KEY_A,
          netProfitBps: BigInt(i),
          at: NOW - (6 - i) * MINUTE_MS,
        });
      }

      const result = appendPairSpreadSamples({
        state: createEmptyPairSpreadState(),
        samples,
        now: NOW,
        windowSize: 5,
      });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "2", at: NOW - 4 * MINUTE_MS },
        { netProfitBps: "3", at: NOW - 3 * MINUTE_MS },
        { netProfitBps: "4", at: NOW - 2 * MINUTE_MS },
        { netProfitBps: "5", at: NOW - MINUTE_MS },
        { netProfitBps: "6", at: NOW },
      ]);
      expect(result.added).to.equal(5);
      expect(result.changed).to.equal(true);
    });

    it("counts added only for new timestamps that survive the window", function () {
      const state = documentWith({
        [KEY_A]: pairEntry([sample(10, NOW - 2 * MINUTE_MS)]),
        [KEY_B]: pairEntry([sample(20, NOW - 2 * MINUTE_MS)]),
      });

      const result = appendPairSpreadSamples({
        state,
        samples: [
          { key: KEY_A, netProfitBps: 30n, at: NOW - MINUTE_MS },
          { key: KEY_A, netProfitBps: 15n, at: NOW - 2 * MINUTE_MS },
          { key: KEY_B, netProfitBps: 10n, at: NOW - 2 * MINUTE_MS },
        ],
        now: NOW,
      });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "15", at: NOW - 2 * MINUTE_MS },
        { netProfitBps: "30", at: NOW - MINUTE_MS },
      ]);
      expect(result.state.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "20", at: NOW - 2 * MINUTE_MS },
      ]);
      expect(result.added).to.equal(1);
      expect(result.changed).to.equal(true);
    });

    it("keeps added and changed false for expired or lower-value duplicates", function () {
      const state = documentWith({ [KEY_A]: pairEntry([sample(20, NOW)]) });

      const result = appendPairSpreadSamples({
        state,
        samples: [
          { key: KEY_A, netProfitBps: 10n, at: NOW },
          { key: KEY_A, netProfitBps: 99n, at: NOW - DAY_MS - 1 },
        ],
        now: NOW,
      });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "20", at: NOW },
      ]);
      expect(result.added).to.equal(0);
      expect(result.changed).to.equal(false);
    });

    it("does not mutate the input state when appending several timestamps", function () {
      const state = documentWith({
        [KEY_A]: pairEntry([sample(10, NOW - 2 * MINUTE_MS)]),
      });
      const snapshot = JSON.parse(JSON.stringify(state));

      const result = appendPairSpreadSamples({
        state,
        samples: [
          { key: KEY_A, netProfitBps: 20n, at: NOW - MINUTE_MS },
          { key: KEY_A, netProfitBps: 30n, at: NOW },
          { key: KEY_B, netProfitBps: 40n, at: NOW },
        ],
        now: NOW,
      });

      expect(state).to.deep.equal(snapshot);
      expect(result.state).to.not.equal(state);
      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW - 2 * MINUTE_MS },
        { netProfitBps: "20", at: NOW - MINUTE_MS },
        { netProfitBps: "30", at: NOW },
      ]);
      expect(result.state.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "40", at: NOW },
      ]);
      expect(result.added).to.equal(3);
      expect(result.changed).to.equal(true);
    });

    it("accepts signed decimal strings and a measured zero", async function () {
      const result = await recordPairSpreadSamples({
        filePath,
        samples: [
          { key: KEY_A, netProfitBps: "0" },
          { key: KEY_B, netProfitBps: "-0", at: NOW },
        ],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      const stored = readJson(filePath);
      expect(stored.pairs[KEY_A].samples[0]).to.deep.equal({
        netProfitBps: "0",
        at: NOW,
      });
      expect(stored.pairs[KEY_B].samples[0].netProfitBps).to.equal("0");
    });

    it("appends one sample per cycle and keeps the window bounded", async function () {
      for (let i = 0; i < 7; i += 1) {
        const result = await recordPairSpreadSamples({
          filePath,
          samples: [
            { key: KEY_A, netProfitBps: BigInt(i), at: NOW + i * MINUTE_MS },
          ],
          now: NOW + i * MINUTE_MS,
          windowSize: 5,
        });
        expect(result.ok).to.equal(true);
      }

      const stored = readJson(filePath);
      expect(stored.pairs[KEY_A].samples.map((s) => s.netProfitBps)).to.deep.equal([
        "2",
        "3",
        "4",
        "5",
        "6",
      ]);
      expect(stored.pairs[KEY_A].samples.map((s) => s.at)).to.deep.equal([
        NOW + 2 * MINUTE_MS,
        NOW + 3 * MINUTE_MS,
        NOW + 4 * MINUTE_MS,
        NOW + 5 * MINUTE_MS,
        NOW + 6 * MINUTE_MS,
      ]);
    });

    it("keeps the best value when the same key and at are recorded again", async function () {
      await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: 20n, at: NOW }],
        now: NOW,
      });

      const lower = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
        now: NOW,
      });
      expect(lower.written).to.equal(false);
      expect(readJson(filePath).pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "20", at: NOW },
      ]);

      const higher = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: 30n, at: NOW }],
        now: NOW,
      });
      expect(higher.written).to.equal(true);
      expect(readJson(filePath).pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "30", at: NOW },
      ]);
    });

    it("does not record a sample older than the maximum age", async function () {
      const result = await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW - DAY_MS - 1 }],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.added).to.equal(0);
      expect(result.written).to.equal(false);
      expect(fs.existsSync(filePath)).to.equal(false);
    });

    it("rejects a future sample before writing", async function () {
      const err = await rejection(
        recordPairSpreadSamples({
          filePath,
          samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW + 1 }],
          now: NOW,
        })
      );

      expect(err).to.be.instanceOf(RangeError);
      expect(err.message).to.include("future");
      expect(fs.existsSync(filePath)).to.equal(false);
    });

    it("rejects invalid input samples without writing", async function () {
      const invalid = [
        [null, TypeError],
        [{ key: "", netProfitBps: 1n, at: NOW }, TypeError],
        [{ key: KEY_A, netProfitBps: null, at: NOW }, TypeError],
        [{ key: KEY_A, netProfitBps: "1.5", at: NOW }, TypeError],
        [{ key: KEY_A, netProfitBps: 1n, at: -1 }, RangeError],
        [{ key: KEY_A, netProfitBps: 1n, at: 1.5 }, RangeError],
      ];

      for (const [input, ErrorType] of invalid) {
        const err = await rejection(
          recordPairSpreadSamples({
            filePath,
            samples: [input],
            now: NOW,
          })
        );
        expect(err).to.be.instanceOf(ErrorType);
        expect(fs.existsSync(filePath)).to.equal(false);
      }
    });

    it("does not mutate the input state in appendPairSpreadSamples", function () {
      const state = documentWith({
        [KEY_A]: pairEntry([sample(10, NOW - MINUTE_MS)]),
      });
      const snapshot = JSON.parse(JSON.stringify(state));

      const result = appendPairSpreadSamples({
        state,
        samples: [{ key: KEY_A, netProfitBps: 20n, at: NOW }],
        now: NOW,
      });

      expect(state).to.deep.equal(snapshot);
      expect(result.state).to.not.equal(state);
      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW - MINUTE_MS },
        { netProfitBps: "20", at: NOW },
      ]);
      expect(result.added).to.equal(1);
      expect(result.changed).to.equal(true);
    });

    it("returns no change from appendPairSpreadSamples with no samples", function () {
      const state = documentWith({
        [KEY_A]: pairEntry([sample(10, NOW)]),
      });

      const result = appendPairSpreadSamples({ state, samples: [], now: NOW });

      expect(result.added).to.equal(0);
      expect(result.changed).to.equal(false);
      expect(result.state).to.deep.equal(state);
    });

    it("reports changed when an expired pair is pruned", function () {
      const state = documentWith({
        [KEY_A]: pairEntry([sample(1, NOW - DAY_MS - 1)]),
        [KEY_B]: pairEntry([sample(2, NOW - MINUTE_MS)]),
      });

      const result = appendPairSpreadSamples({ state, samples: [], now: NOW });

      expect(result.state.pairs).to.not.have.property(KEY_A);
      expect(result.state.pairs[KEY_B].samples).to.deep.equal([
        { netProfitBps: "2", at: NOW - MINUTE_MS },
      ]);
      expect(result.added).to.equal(0);
      expect(result.changed).to.equal(true);
    });

    it("reports changed when an empty pair is pruned", function () {
      const state = documentWith({
        [KEY_A]: pairEntry([]),
        [KEY_B]: pairEntry([sample(2, NOW - MINUTE_MS)]),
      });

      const result = appendPairSpreadSamples({ state, samples: [], now: NOW });

      expect(result.state.pairs).to.not.have.property(KEY_A);
      expect(result.added).to.equal(0);
      expect(result.changed).to.equal(true);
    });

    it("reports changed when an expired sample is pruned from a retained pair", function () {
      const state = documentWith({
        [KEY_A]: pairEntry([
          sample(1, NOW - DAY_MS - 1),
          sample(2, NOW - MINUTE_MS),
        ]),
      });

      const result = appendPairSpreadSamples({ state, samples: [], now: NOW });

      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "2", at: NOW - MINUTE_MS },
      ]);
      expect(result.added).to.equal(0);
      expect(result.changed).to.equal(true);
    });

    it("counts only new timestamps in added and reports updates in changed", function () {
      const state = documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) });

      const result = appendPairSpreadSamples({
        state,
        samples: [{ key: KEY_A, netProfitBps: 20n, at: NOW }],
        now: NOW,
      });

      expect(result.added).to.equal(0);
      expect(result.changed).to.equal(true);
      expect(result.state.pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "20", at: NOW },
      ]);
    });

    it("keeps changed false when the only incoming sample is expired", function () {
      const result = appendPairSpreadSamples({
        state: createEmptyPairSpreadState(),
        samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW - DAY_MS - 1 }],
        now: NOW,
      });

      expect(result.added).to.equal(0);
      expect(result.changed).to.equal(false);
      expect(result.state).to.deep.equal(createEmptyPairSpreadState());
    });

    it("uses a loaded state without re-reading the file", async function () {
      const loaded = await loadPairSpreadState({ filePath, now: NOW });
      expect(loaded.status).to.equal("absent");

      const result = await recordPairSpreadSamples({
        filePath,
        loaded,
        samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      expect(readJson(filePath).pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW },
      ]);
    });

    it("does not change DRY_RUN", async function () {
      const before = process.env.DRY_RUN;
      await loadPairSpreadState({ filePath, now: NOW });
      await recordPairSpreadSamples({
        filePath,
        samples: [{ key: KEY_A, netProfitBps: 1n, at: NOW }],
        now: NOW,
      });
      expect(process.env.DRY_RUN).to.equal(before);
    });
  });

  describe("atomic write", function () {
    it("writes a complete indented JSON file with a trailing newline", async function () {
      const result = await writePairSpreadState({
        filePath,
        state: documentWith({
          [KEY_A]: pairEntry([sample(10, NOW)]),
        }),
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(result.written).to.equal(true);
      const raw = readRaw(filePath);
      expect(raw.endsWith("\n")).to.equal(true);
      expect(raw).to.include('\n  "version": 1');
      expect(raw).to.include('\n      "samples": [');
      expect(JSON.parse(raw).pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "10", at: NOW },
      ]);
      expect(tmpFilesFor(filePath)).to.deep.equal([]);
    });

    it("calls write, sync, close, then rename in that order", async function () {
      const calls = [];
      const originalOpen = fsp.open;
      const originalRename = fsp.rename;

      fsp.open = async (target, flags) => {
        calls.push("open");
        const handle = await originalOpen.call(fsp, target, flags);
        return {
          writeFile: async (...args) => {
            calls.push("writeFile");
            return handle.writeFile(...args);
          },
          sync: async () => {
            calls.push("sync");
            return handle.sync();
          },
          close: async () => {
            calls.push("close");
            return handle.close();
          },
        };
      };
      fsp.rename = async (...args) => {
        calls.push("rename");
        return originalRename.call(fsp, ...args);
      };

      try {
        const result = await writePairSpreadState({
          filePath,
          state: createEmptyPairSpreadState(),
          now: NOW,
        });
        expect(result.ok).to.equal(true);
      } finally {
        fsp.open = originalOpen;
        fsp.rename = originalRename;
      }

      expect(calls).to.deep.equal(["open", "writeFile", "sync", "close", "rename"]);
    });

    it("returns a warning and removes the temp file when rename fails", async function () {
      writeJson(filePath, documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }));
      const before = readRaw(filePath);
      const originalRename = fsp.rename;
      const warnings = [];

      fsp.rename = async () => {
        const err = new Error("simulated rename failure");
        err.code = "EIO";
        throw err;
      };

      try {
        const result = await writePairSpreadState({
          filePath,
          state: documentWith({ [KEY_A]: pairEntry([sample(20, NOW)]) }),
          now: NOW,
          warn: (message) => warnings.push(message),
        });

        expect(result.ok).to.equal(false);
        expect(result.written).to.equal(false);
        expect(result.error.code).to.equal(PAIR_SPREAD_STORE_CODES.WRITE_FAILED);
        expect(result.warning).to.include(PAIR_SPREAD_STORE_CODES.WRITE_FAILED);
        expect(warnings).to.deep.equal([result.warning]);
        expect(readRaw(filePath)).to.equal(before);
        expect(tmpFilesFor(filePath)).to.deep.equal([]);
      } finally {
        fsp.rename = originalRename;
      }
    });

    it("refuses to replace a directory target (unreadable)", async function () {
      const directoryPath = path.join(storeDir, "target-dir");
      fs.mkdirSync(directoryPath);

      const result = await writePairSpreadState({
        filePath: directoryPath,
        state: createEmptyPairSpreadState(),
        now: NOW,
      });

      expect(result.ok).to.equal(false);
      expect(result.written).to.equal(false);
      expect(result.writable).to.equal(false);
      expect(result.status).to.equal("unreadable");
      expect(result.error.code).to.equal(PAIR_SPREAD_STORE_CODES.UNREADABLE);
      expect(fs.statSync(directoryPath).isDirectory()).to.equal(true);
      expect(tmpFilesFor(directoryPath)).to.deep.equal([]);
    });

    it("reports a write failure from recordPairSpreadSamples without throwing", async function () {
      const originalOpen = fsp.open;
      const warnings = [];

      fsp.open = async (target, flags) => {
        if (String(target).endsWith(".tmp")) {
          const err = new Error("simulated open failure");
          err.code = "EIO";
          throw err;
        }
        return originalOpen.call(fsp, target, flags);
      };

      try {
        const result = await recordPairSpreadSamples({
          filePath,
          samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
          now: NOW,
          warn: (message) => warnings.push(message),
        });

        expect(result.ok).to.equal(false);
        expect(result.written).to.equal(false);
        expect(result.error.code).to.equal(PAIR_SPREAD_STORE_CODES.WRITE_FAILED);
        expect(warnings).to.deep.equal([result.warning]);
        expect(fs.existsSync(filePath)).to.equal(false);
      } finally {
        fsp.open = originalOpen;
      }
    });

    it("rejects an invalid in-memory state before writing", async function () {
      const err = await rejection(
        writePairSpreadState({
          filePath,
          state: documentWith({
            [KEY_A]: pairEntry([{ netProfitBps: "1.5", at: NOW }]),
          }),
          now: NOW,
        })
      );

      expect(err).to.be.instanceOf(PairSpreadStoreError);
      expect(err.code).to.equal(PAIR_SPREAD_STORE_CODES.SCHEMA_INVALID);
      expect(fs.existsSync(filePath)).to.equal(false);
    });

    it("prunes expired samples before writing", async function () {
      const result = await writePairSpreadState({
        filePath,
        state: documentWith({
          [KEY_A]: pairEntry([
            sample(1, NOW - DAY_MS - 1),
            sample(2, NOW),
          ]),
        }),
        now: NOW,
      });

      expect(result.ok).to.equal(true);
      expect(readJson(filePath).pairs[KEY_A].samples).to.deep.equal([
        { netProfitBps: "2", at: NOW },
      ]);
    });

    it("validates options before touching the filesystem", async function () {
      const cases = [
        [{ filePath: "", now: NOW }, TypeError],
        [{ filePath: 42, now: NOW }, TypeError],
        [{ filePath, now: -1 }, RangeError],
        [{ filePath, now: 1.5 }, RangeError],
        [{ filePath, now: NOW, windowSize: 4 }, RangeError],
        [{ filePath, now: NOW, windowSize: 101 }, RangeError],
        [{ filePath, now: NOW, windowSize: 5.5 }, RangeError],
        [{ filePath, now: NOW, maxAgeMs: 0 }, RangeError],
        [{ filePath, now: NOW, maxAgeMs: -1 }, RangeError],
        [{ filePath, now: NOW, maxAgeMs: 169 * HOUR_MS }, RangeError],
        [{ filePath, now: NOW, maxAgeMs: Infinity }, RangeError],
      ];

      for (const [options, ErrorType] of cases) {
        const err = await rejection(loadPairSpreadState(options));
        expect(err).to.be.instanceOf(ErrorType);
        expect(fs.existsSync(filePath)).to.equal(false);
      }
    });

    it("exposes a usable PairSpreadStoreError guard", function () {
      const error = new PairSpreadStoreError(
        PAIR_SPREAD_STORE_CODES.CORRUPT,
        filePath,
        "test"
      );
      expect(isPairSpreadStoreError(error)).to.equal(true);
      expect(isPairSpreadStoreError({ code: PAIR_SPREAD_STORE_CODES.CORRUPT })).to.equal(true);
      expect(isPairSpreadStoreError(new Error("nope"))).to.equal(false);
    });
  });

  describe("concurrent writes", function () {
    it("uses a distinct temp path in the target directory for each write", async function () {
      const seen = [];
      const originalOpen = fsp.open;
      fsp.open = async (target, flags) => {
        if (String(target).endsWith(".tmp")) seen.push(target);
        return originalOpen.call(fsp, target, flags);
      };

      try {
        const results = await Promise.all([
          writePairSpreadState({
            filePath,
            state: documentWith({ [KEY_A]: pairEntry([sample(1, NOW)]) }),
            now: NOW,
          }),
          writePairSpreadState({
            filePath,
            state: documentWith({ [KEY_B]: pairEntry([sample(2, NOW)]) }),
            now: NOW,
          }),
        ]);
        expect(results.every((result) => result.ok)).to.equal(true);
      } finally {
        fsp.open = originalOpen;
      }

      expect(seen).to.have.length(2);
      expect(new Set(seen).size).to.equal(2);
      for (const target of seen) {
        expect(path.dirname(target)).to.equal(path.dirname(filePath));
      }
      expect(tmpFilesFor(filePath)).to.deep.equal([]);
    });

    it("keeps the final file a valid JSON after two concurrent writes", async function () {
      const states = [
        documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }),
        documentWith({ [KEY_B]: pairEntry([sample(20, NOW)]) }),
      ];

      const results = await Promise.all(
        states.map((state) =>
          writePairSpreadState({ filePath, state, now: NOW })
        )
      );

      expect(results.every((result) => result.ok && result.written)).to.equal(true);
      const stored = readJson(filePath);
      expect(states).to.deep.include(stored);
      expect(tmpFilesFor(filePath)).to.deep.equal([]);
    });

    it("keeps the final file valid across repeated concurrent writes", async function () {
      for (let round = 0; round < 5; round += 1) {
        const writes = [];
        for (let index = 0; index < 4; index += 1) {
          writes.push(
            writePairSpreadState({
              filePath,
              state: documentWith({
                [KEY_A]: pairEntry([sample(round * 10 + index, NOW)]),
              }),
              now: NOW,
            })
          );
        }

        const results = await Promise.all(writes);
        expect(results.every((result) => result.ok)).to.equal(true);

        const stored = readJson(filePath);
        expect(stored.version).to.equal(PAIR_SPREAD_STORE_VERSION);
        expect(stored.pairs[KEY_A].samples).to.have.length(1);
        expect(tmpFilesFor(filePath)).to.deep.equal([]);
      }
    });

    it("removes only its own temp file when a write fails", async function () {
      const foreignTmp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      writeRaw(foreignTmp, "foreign temp file\n");
      const originalRename = fsp.rename;

      fsp.rename = async () => {
        const err = new Error("simulated rename failure");
        err.code = "EIO";
        throw err;
      };

      try {
        const result = await writePairSpreadState({
          filePath,
          state: documentWith({ [KEY_A]: pairEntry([sample(10, NOW)]) }),
          now: NOW,
        });

        expect(result.ok).to.equal(false);
        expect(result.written).to.equal(false);
        expect(fs.existsSync(foreignTmp)).to.equal(true);
        expect(tmpFilesFor(filePath)).to.deep.equal([path.basename(foreignTmp)]);
      } finally {
        fsp.rename = originalRename;
        fs.rmSync(foreignTmp, { force: true });
      }
    });

    it("does not claim to merge concurrent read-modify-write cycles", async function () {
      // Atomic rename guarantees a complete document, not the merge of two
      // read-modify-write cycles. The final file must stay valid; an update may
      // be lost (last writer wins, ADR 0006 D14).
      const results = await Promise.all([
        recordPairSpreadSamples({
          filePath,
          samples: [{ key: KEY_A, netProfitBps: 10n, at: NOW }],
          now: NOW,
        }),
        recordPairSpreadSamples({
          filePath,
          samples: [{ key: KEY_B, netProfitBps: 20n, at: NOW }],
          now: NOW,
        }),
      ]);

      expect(results.every((result) => result.ok)).to.equal(true);
      const stored = readJson(filePath);
      expect(stored.version).to.equal(PAIR_SPREAD_STORE_VERSION);
      expect(Object.keys(stored.pairs).length).to.be.at.least(1);
      expect(tmpFilesFor(filePath)).to.deep.equal([]);
    });
  });
});
