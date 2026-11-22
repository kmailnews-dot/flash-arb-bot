const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { main, readAaveFlashLoanPremium } = require("../bot/index");
const { NETWORKS } = require("../bot/networks");
const { buildPairKey } = require("../bot/pairSpread");
const { reconcilePendingExecutions } = require("../bot/execute");
const { readExecutionJournal, writeExecutionJournal } = require("../bot/persist");

describe("bot/index main", function () {
  function makeMinimalProvider({ chainId = "0x7a69", blockNumber = 777 } = {}) {
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

  function makeMinimalConfig(tmpDir, overrides = {}) {
    return {
      dryRun: true,
      pairs: [],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 0,
      scanLogPath: path.join(tmpDir, "scans.jsonl"),
      adaptivePath: path.join(tmpDir, "adaptive.json"),
      rpcErrorsPath: path.join(tmpDir, "rpc_errors.json"),
      gasHistoryPath: path.join(tmpDir, "gas_history.json"),
      executionJournalPath: path.join(tmpDir, "executions.json"),
      ...overrides,
    };
  }

  const spreadTmpDirs = [];

  function makeSpreadTmpDir(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    spreadTmpDirs.push(dir);
    return dir;
  }

  afterEach(function () {
    while (spreadTmpDirs.length > 0) {
      fs.rmSync(spreadTmpDirs.pop(), { recursive: true, force: true });
    }
  });

  function addressFromByte(byte) {
    return `0x${byte.toString(16).padStart(2, "0").repeat(20)}`;
  }

  function makePairSpreadPair(byte, overrides = {}) {
    const borrowed = addressFromByte(byte);
    const intermediate = addressFromByte(byte + 1);
    return {
      label: `SPREAD pair ${byte}`,
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

  function makePairSpreadConfig(tmpDir, overrides = {}) {
    return makeMinimalConfig(tmpDir, {
      expectedChainId: 31337,
      pairSpreadMode: "enforce",
      pairSpreadPath: path.join(tmpDir, "pair_spreads.json"),
      ...overrides,
    });
  }

  function pairSpreadSamples(values, { now = Date.now(), stepMs = 60_000 } = {}) {
    return values.map((value, index) => ({
      netProfitBps: String(value),
      at: now - (values.length - 1 - index) * stepMs,
    }));
  }

  function writePairSpreadFile(filePath, pairs, { version = 1 } = {}) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ version, pairs }, null, 2)}\n`,
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

  it("refuses to scan when the raw eth_chainId differs from expectedChainId", async function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-chain-mismatch-"));
    let scans = 0;
    const provider = makeMinimalProvider({ chainId: "0xa4b1" });
    const summary = await main({
      provider,
      config: makeMinimalConfig(tmpDir, { expectedChainId: 421614 }),
      scanPair: async () => {
        scans += 1;
        return [];
      },
    });

    expect(summary.refused).to.equal(true);
    expect(summary.reason).to.include("CHAIN_ID_MISMATCH");
    expect(scans).to.equal(0);
    // Fail closed before fees, block number, reconciliation, or any scan.
    expect(provider.calls).to.deep.equal(["eth_chainId"]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pins one blockTag per cycle and passes it to scanPair", async function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-blocktag-"));
    const blockTags = [];
    const summary = await main({
      provider: makeMinimalProvider({ blockNumber: 777 }),
      config: makeMinimalConfig(tmpDir, {
        expectedChainId: 31337,
        pairs: [{ label: "TEST pair", borrowedToken: { symbol: "USDC", decimals: 6 } }],
      }),
      scanPair: async ({ blockTag }) => {
        blockTags.push(blockTag);
        return [];
      },
    });

    expect(summary.refused).to.equal(undefined);
    expect(blockTags).to.deep.equal([777]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps scanning when the ETH/USD route points at an address with no code", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const borrowToken = await MockERC20.deploy("Borrow Token", "BOR");
    const midToken = await MockERC20.deploy("Intermediate Token", "MID");

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const routerOut = await MockRouter.deploy();
    const routerBack = await MockRouter.deploy();

    const borrowAddr = await borrowToken.getAddress();
    const midAddr = await midToken.getAddress();
    await routerOut.setRate(borrowAddr, midAddr, ethers.parseEther("1"));
    await routerBack.setRate(midAddr, borrowAddr, ethers.parseEther("1.02"));

    const pair = {
      label: "BOR/MID test pair",
      borrowedToken: { address: borrowAddr, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: midAddr, decimals: 18, symbol: "MID" },
      legOut: { kind: "V2", router: await routerOut.getAddress(), tokenOut: midAddr },
      legBack: { kind: "V2", router: await routerBack.getAddress(), tokenOut: borrowAddr },
      tradeSizes: ["1000"],
    };

    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-scan-"));
    const scanLogPath = path.join(scanDir, "scans.jsonl");
    const config = {
      dryRun: true,
      scanLogPath,
      pairs: [pair],
      aaveFlashLoanPremiumBps: 5n,
      minProfitUsd: 5,
      gasLimitEstimate: 700000n,
      gasPriceBufferPct: 20,
      ethUsdRoute: {
        kind: "V2",
        // An EOA has no code, so getAmountsOut returns "0x" and ethers throws a BAD_DATA error.
        router: ethers.Wallet.createRandom().address,
        weth: borrowAddr,
        usdc: midAddr,
        usdcDecimals: 18,
      },
    };

    const warnings = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (message) => warnings.push(String(message));
    console.log = () => {};

    let summary;
    try {
      summary = await main({ provider: ethers.provider, config });
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }

    expect(summary.ethUsdPrice).to.equal(null);
    expect(summary.scanned).to.equal(1);
    expect(summary.opportunities).to.equal(0);
    expect(warnings.join("\n")).to.include("could not quote ETH/USD");
    expect(warnings.join("\n")).to.include("USD filtering is disabled");

    const entries = fs
      .readFileSync(scanLogPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(entries).to.have.length(1);
    expect(entries[0].chainId).to.equal(31337);
    expect(entries[0].isOpportunity).to.equal(false);
    expect(BigInt(entries[0].grossProfit)).to.be.greaterThan(0n);

    fs.rmSync(scanDir, { recursive: true, force: true });
  });

  it("warns when the configured Aave premium diverges from the on-chain value", async function () {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    let premiumCallTo;
    const provider = {
      async getNetwork() {
        return { chainId: 42161n };
      },
      async getFeeData() {
        return { gasPrice: 1n, maxFeePerGas: null };
      },
      async call(tx) {
        premiumCallTo = tx.to;
        return abi.encode(["uint128"], [23n]);
      },
    };
    const config = {
      dryRun: true,
      pairs: [],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
    };

    const warnings = [];
    const originalWarn = console.warn;
    const originalLog = console.log;
    console.warn = (message) => warnings.push(String(message));
    console.log = () => {};

    let summary;
    try {
      summary = await main({ provider, config });
    } finally {
      console.warn = originalWarn;
      console.log = originalLog;
    }

    expect(premiumCallTo).to.equal(NETWORKS[42161].pool);
    expect(summary.aaveFlashLoanPremiumBps).to.equal(23n);
    expect(warnings.join("\n")).to.include("Aave flash loan premium");
    expect(warnings.join("\n")).to.include("23 bps");
    expect(warnings.join("\n")).to.include("5 bps");
  });

  it("passes the on-chain Aave premium to scanPair", async function () {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const provider = {
      async getNetwork() {
        return { chainId: 42161n };
      },
      async getFeeData() {
        return { gasPrice: 1n, maxFeePerGas: null };
      },
      async call() {
        return abi.encode(["uint128"], [30n]);
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-premium-scan-"));
    const config = {
      dryRun: true,
      pairs: [
        {
          label: "BOR/MID premium pair",
          borrowedToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "BOR" },
          intermediateToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "MID" },
        },
      ],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 0,
      scanLogPath: path.join(tmpDir, "scans.jsonl"),
      adaptivePath: path.join(tmpDir, "adaptive.json"),
      executionJournalPath: path.join(tmpDir, "executions.json"),
    };
    const premiums = [];

    await main({
      provider,
      config,
      scanPair: async ({ config: scanConfig }) => {
        premiums.push(scanConfig.aaveFlashLoanPremiumBps);
        return [];
      },
    });

    expect(premiums).to.deep.equal([30n]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("passes the same on-chain premium to scanPair and maybeExecute", async function () {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    const provider = {
      async getNetwork() {
        return { chainId: 42161n };
      },
      async getFeeData() {
        return { gasPrice: 1n, maxFeePerGas: null };
      },
      async call() {
        return abi.encode(["uint128"], [30n]);
      },
    };
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-premium-exec-"));
    const config = {
      dryRun: true,
      pairs: [
        {
          label: "BOR/MID premium pair",
          borrowedToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "BOR" },
          intermediateToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "MID" },
        },
      ],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 0,
      scanLogPath: path.join(tmpDir, "scans.jsonl"),
      adaptivePath: path.join(tmpDir, "adaptive.json"),
      executionJournalPath: path.join(tmpDir, "executions.json"),
    };
    const scanPremiums = [];
    const executePremiums = [];
    const opportunity = {
      tradeSizeHuman: "1000",
      grossProfit: 1n,
      netProfitUsd: 10,
      isOpportunity: true,
    };

    await main({
      provider,
      config,
      scanPair: async ({ config: scanConfig }) => {
        scanPremiums.push(scanConfig.aaveFlashLoanPremiumBps);
        return [opportunity];
      },
      maybeExecute: async ({ config: execConfig }) => {
        executePremiums.push(execConfig.aaveFlashLoanPremiumBps);
        return { submitted: false };
      },
    });

    expect(scanPremiums).to.deep.equal([30n]);
    expect(executePremiums).to.deep.equal([30n]);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses live execution when the ETH/USD quote failed, without scanning or executing", async function () {
    let scans = 0;
    let executions = 0;
    const config = {
      dryRun: false,
      pairs: [],
      ethUsdRoute: null,
    };

    const errors = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (message) => errors.push(String(message));
    console.log = () => {};

    let summary;
    try {
      summary = await main({
        provider: ethers.provider,
        config,
        scanPair: async () => {
          scans += 1;
          return [];
        },
        maybeExecute: async () => {
          executions += 1;
          return { submitted: false };
        },
      });
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }

    const reason =
      "ETH_USD_ROUTE_JSON required for live execution, but quote failed. Set DRY_RUN=true or fix the route.";
    expect(summary).to.deep.equal({ refused: true, reason });
    expect(scans).to.equal(0);
    expect(executions).to.equal(0);
    expect(errors.join("\n")).to.include(`[LIVE REFUSED] ${reason}`);
  });

  it("derives exitCode 1 when live execution is refused", async function () {
    const config = {
      dryRun: false,
      pairs: [],
      ethUsdRoute: null,
    };

    const summary = await main({ provider: ethers.provider, config, scanPair: async () => [] });

    expect(summary.refused).to.equal(true);
    expect(summary.exitCode ?? (summary.refused ? 1 : 0)).to.equal(1);
  });

  it("records adaptive outcomes only outside DRY_RUN", async function () {
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const borrowToken = await MockERC20.deploy("Borrow Token", "BOR");
    const midToken = await MockERC20.deploy("Intermediate Token", "MID");
    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy();

    const borrowAddr = await borrowToken.getAddress();
    const midAddr = await midToken.getAddress();
    await router.setRate(borrowAddr, midAddr, ethers.parseEther("1"));
    const routerAddr = await router.getAddress();

    const pair = {
      label: "BOR/MID adaptive pair",
      borrowedToken: { address: borrowAddr, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: midAddr, decimals: 18, symbol: "MID" },
      legOut: { kind: "V2", router: routerAddr, tokenOut: midAddr },
      legBack: { kind: "V2", router: routerAddr, tokenOut: borrowAddr },
      tradeSizes: ["1000"],
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-adaptive-main-"));
    const adaptivePath = path.join(tmpDir, "adaptive.json");
    const config = {
      dryRun: true,
      scanLogPath: path.join(tmpDir, "scans.jsonl"),
      adaptivePath,
      pairs: [pair],
      aaveFlashLoanPremiumBps: 5n,
      minProfitBps: 30,
      minProfitUsd: 5,
      gasLimitEstimate: 700000n,
      gasPriceBufferPct: 20,
      maxRpcErrorsPerScan: 0,
      ethUsdRoute: {
        kind: "V2",
        router: routerAddr,
        weth: borrowAddr,
        usdc: midAddr,
        usdcDecimals: 18,
      },
    };
    const opportunity = {
      tradeSizeHuman: "1000",
      grossProfit: 1n,
      netProfitUsd: 10,
      isOpportunity: true,
    };
    const success = { submitted: true, receipt: { status: 1 } };

    let dryExecutions = 0;
    await main({
      provider: ethers.provider,
      config,
      scanPair: async () => [opportunity],
      maybeExecute: async () => {
        dryExecutions += 1;
        return success;
      },
    });

    expect(dryExecutions).to.equal(1);
    expect(fs.existsSync(adaptivePath)).to.equal(false);

    fs.writeFileSync(
      adaptivePath,
      `${JSON.stringify(
        {
          effectiveMinProfitBps: 60,
          effectiveMaxTradeSize: "1.00",
          history: [
            { outcome: "SUCCESS", at: 1000 },
            { outcome: "SUCCESS", at: 2000 },
          ],
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    let liveExecutions = 0;
    await main({
      provider: ethers.provider,
      config: { ...config, dryRun: false },
      scanPair: async () => [opportunity],
      maybeExecute: async () => {
        liveExecutions += 1;
        return success;
      },
    });

    expect(liveExecutions).to.equal(1);
    const state = JSON.parse(fs.readFileSync(adaptivePath, "utf8"));
    expect(state.history).to.have.lengthOf(3);
    expect(state.history[2].outcome).to.equal("SUCCESS");
    expect(state.effectiveMinProfitBps).to.equal(55);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sets exitCode 1 when rpcErrors exceeds maxRpcErrorsPerScan", async function () {
    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-rpc-errors-"));
    const pair = {
      label: "BOR/MID exit code pair",
      borrowedToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "MID" },
    };
    const config = {
      dryRun: true,
      scanLogPath: path.join(scanDir, "scans.jsonl"),
      pairs: [pair],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 1,
    };

    const summary = await main({
      provider: ethers.provider,
      config,
      scanPair: async () => [
        { tradeSizeHuman: "1000", error: new Error("RPC down") },
        { tradeSizeHuman: "1000", error: new Error("RPC down") },
      ],
    });

    expect(summary.scanned).to.equal(2);
    expect(summary.exitCode).to.equal(1);
    fs.rmSync(scanDir, { recursive: true, force: true });
  });

  it("sets exitCode 1 when no result is scanned", async function () {
    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-zero-scanned-"));
    const pair = {
      label: "BOR/MID exit code pair",
      borrowedToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "MID" },
    };
    const config = {
      dryRun: true,
      scanLogPath: path.join(scanDir, "scans.jsonl"),
      pairs: [pair],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 0,
    };

    const summary = await main({
      provider: ethers.provider,
      config,
      scanPair: async () => [],
    });

    expect(summary.scanned).to.equal(0);
    expect(summary.exitCode).to.equal(1);
    fs.rmSync(scanDir, { recursive: true, force: true });
  });

  it("sets exitCode 0 on a normal scan", async function () {
    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-normal-scan-"));
    const pair = {
      label: "BOR/MID exit code pair",
      borrowedToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "MID" },
    };
    const config = {
      dryRun: true,
      scanLogPath: path.join(scanDir, "scans.jsonl"),
      pairs: [pair],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 0,
    };

    const summary = await main({
      provider: ethers.provider,
      config,
      scanPair: async () => [
        { tradeSizeHuman: "1000", grossProfit: 1n, netProfitUsd: null, isOpportunity: false },
      ],
    });

    expect(summary.scanned).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    fs.rmSync(scanDir, { recursive: true, force: true });
  });

  it("does not count QUOTE_STALE or DEPTH_EXCEEDED as RPC errors", async function () {
    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-quality-filters-"));
    const pair = {
      label: "BOR/MID quality pair",
      borrowedToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "MID" },
    };
    const config = {
      dryRun: true,
      scanLogPath: path.join(scanDir, "scans.jsonl"),
      pairs: [pair],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 1,
    };

    const summary = await main({
      provider: ethers.provider,
      config,
      scanPair: async () => [
        { tradeSizeHuman: "1000", error: "QUOTE_STALE" },
        { tradeSizeHuman: "1000", error: "QUOTE_STALE" },
        { tradeSizeHuman: "1000", error: "DEPTH_EXCEEDED" },
        { tradeSizeHuman: "1000", error: "QUOTE_STALE" },
        { tradeSizeHuman: "1000", error: "DEPTH_EXCEEDED" },
      ],
    });

    expect(summary.scanned).to.equal(5);
    expect(summary.exitCode).to.equal(0);
    fs.rmSync(scanDir, { recursive: true, force: true });
  });

  it("records an RPC cycle after each scan", async function () {
    const scanDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-rpc-cycle-"));
    const rpcErrorsPath = path.join(scanDir, "rpc_errors.json");
    const pair = {
      label: "BOR/MID rpc-cycle pair",
      borrowedToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: ethers.Wallet.createRandom().address, decimals: 18, symbol: "MID" },
    };
    const config = {
      dryRun: true,
      scanLogPath: path.join(scanDir, "scans.jsonl"),
      rpcErrorsPath,
      rpcErrorRateWindowSize: 10,
      rpcErrorRateThreshold: 0.5,
      pairs: [pair],
      aaveFlashLoanPremiumBps: 5n,
      ethUsdRoute: null,
      maxRpcErrorsPerScan: 0,
    };
    const summary = await main({
      provider: ethers.provider,
      config,
      scanPair: async () => [
        { tradeSizeHuman: "1000", grossProfit: 1n, netProfitUsd: null, isOpportunity: false },
        { tradeSizeHuman: "1000", error: new Error("RPC down") },
      ],
    });
    expect(summary.scanned).to.equal(2);
    const state = JSON.parse(fs.readFileSync(rpcErrorsPath, "utf8"));
    expect(state.version).to.equal(1);
    expect(state.cycles).to.have.length(1);
    expect(state.cycles[0].errors).to.equal(1);
    expect(state.cycles[0].total).to.equal(2);
    fs.rmSync(scanDir, { recursive: true, force: true });
  });

  it("keeps mode off free of pair-spread state I/O", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-off-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const corrupt = "{not valid json";
    fs.writeFileSync(pairSpreadPath, corrupt, "utf8");
    const pair = makePairSpreadPair(10);
    let scans = 0;

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makeMinimalConfig(tmpDir, {
          pairs: [pair],
          pairSpreadMode: "off",
          pairSpreadPath,
        }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 10n })];
        },
      })
    );

    expect(scans).to.equal(1);
    expect(summary.scanned).to.equal(1);
    expect(summary.filteredPairs).to.equal(0);
    expect(summary.exitCode).to.equal(0);
    expect(fs.readFileSync(pairSpreadPath, "utf8")).to.equal(corrupt);
    expect(warnings.join("\n")).to.not.include("PAIR_SPREAD_STATE");
  });

  it("logs a would-filter decision in shadow mode and still scans", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-shadow-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(20);
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(pairSpreadPath, {
      [key]: { samples: pairSpreadSamples([-80, -60, -40, -20, -10]) },
    });
    let scans = 0;

    const { result: summary, logs } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, {
          pairs: [pair],
          pairSpreadMode: "shadow",
          pairSpreadPath,
        }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 10n })];
        },
      })
    );

    expect(scans).to.equal(1);
    expect(summary.scanned).to.equal(1);
    expect(summary.filteredPairs).to.equal(0);
    expect(summary.wouldFilterPairs).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    expect(logs.join("\n")).to.include("decision=would-filter");
    expect(logs.join("\n")).to.include("PAIR_SPREAD_BELOW_FLOOR");
  });

  it("filters a pair before scanPair in enforce mode", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-enforce-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(30);
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(pairSpreadPath, {
      [key]: { samples: pairSpreadSamples([-80, -60, -40, -20, -10]) },
    });
    let scans = 0;

    const { result: summary, logs, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => {
          scans += 1;
          return [scanResult()];
        },
      })
    );

    const output = [...logs, ...warnings].join("\n");
    expect(scans).to.equal(0);
    expect(summary.scanned).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    expect(summary.exitCode).to.equal(0);
    expect(output).to.include(`SKIP pair=${pair.label}`);
    expect(output).to.include("PAIR_SPREAD_BELOW_FLOOR");
  });

  it("scans a pair with insufficient samples in enforce mode", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-insufficient-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(40);
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(pairSpreadPath, {
      [key]: { samples: pairSpreadSamples([-80, -10]) },
    });
    let scans = 0;

    const { result: summary, logs } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 10n })];
        },
      })
    );

    expect(scans).to.equal(1);
    expect(summary.scanned).to.equal(1);
    expect(summary.filteredPairs).to.equal(0);
    expect(logs.join("\n")).to.include("INSUFFICIENT_SAMPLES");
  });

  it("fails open and creates the state when the history is absent", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-absent-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(50);
    const key = buildPairKey({ chainId: 31337, pair });
    let scans = 0;

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 12n })];
        },
      })
    );

    expect(scans).to.equal(1);
    expect(summary.scanned).to.equal(1);
    expect(summary.filteredPairs).to.equal(0);
    expect(fs.existsSync(pairSpreadPath)).to.equal(true);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.have.length(1);
    expect(stored.pairs[key].samples[0].netProfitBps).to.equal("12");
  });

  it("fails open on a corrupt state and preserves the file", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-corrupt-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const corrupt = "{not valid json";
    fs.writeFileSync(pairSpreadPath, corrupt, "utf8");
    const pair = makePairSpreadPair(60);
    let scans = 0;

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 12n })];
        },
      })
    );

    expect(scans).to.equal(1);
    expect(summary.scanned).to.equal(1);
    expect(summary.filteredPairs).to.equal(0);
    expect(fs.readFileSync(pairSpreadPath, "utf8")).to.equal(corrupt);
    expect(warnings.join("\n")).to.include("PAIR_SPREAD_STATE_CORRUPT");
  });

  it("collects the best valid netProfitBps once after a scan", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-sample-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(70);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [
          scanResult({ netProfitBps: -10n }),
          scanResult({ netProfitBps: 25n, amountIn: 2_000_000n }),
          scanResult({ netProfitBps: 100n, error: "DEPTH_EXCEEDED" }),
          scanResult({ netProfitBps: null }),
        ],
      })
    );

    expect(summary.scanned).to.equal(4);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.have.length(1);
    expect(stored.pairs[key].samples[0].netProfitBps).to.equal("25");
  });

  it("records an empty attempt and no sample when netProfitBps is null", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-null-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(80);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [scanResult({ netProfitBps: null })],
      })
    );

    expect(summary.scanned).to.equal(1);
    expect(fs.existsSync(pairSpreadPath)).to.equal(true);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.deep.equal([]);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "empty",
      source: "scan",
      reason: "UNPRICED",
    });
  });

  it("records one sample per route and cycle, keeping the best value", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-dedupe-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(90);
    const duplicate = { ...pair, label: "SPREAD duplicate" };
    const key = buildPairKey({ chainId: 31337, pair });
    let scans = 0;

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair, duplicate] }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: scans === 1 ? 10n : 20n })];
        },
      })
    );

    expect(scans).to.equal(2);
    expect(summary.scanned).to.equal(2);
    expect(summary.filteredPairs).to.equal(0);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.have.length(1);
    expect(stored.pairs[key].samples[0].netProfitBps).to.equal("20");
  });

  it("persists the pair-spread state at most once after the loop", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-persist-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pairA = makePairSpreadPair(100);
    const pairB = makePairSpreadPair(110);
    const originalRename = fsp.rename;
    let pairSpreadWrites = 0;
    fsp.rename = async (from, to) => {
      if (path.resolve(to) === path.resolve(pairSpreadPath)) pairSpreadWrites += 1;
      return originalRename.call(fsp, from, to);
    };

    let summary;
    try {
      ({ result: summary } = await captureConsole(() =>
        main({
          provider: makeMinimalProvider(),
          config: makePairSpreadConfig(tmpDir, { pairs: [pairA, pairB] }),
          scanPair: async ({ pair }) => [
            scanResult({ netProfitBps: pair.label === pairA.label ? 10n : 20n }),
          ],
        })
      ));
    } finally {
      fsp.rename = originalRename;
    }

    expect(summary.scanned).to.equal(2);
    expect(pairSpreadWrites).to.equal(1);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(Object.keys(stored.pairs)).to.have.length(2);
  });

  it("returns exitCode 0 when enforce filters every configured pair", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-all-filtered-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pairA = makePairSpreadPair(120);
    const pairB = makePairSpreadPair(130);
    const keyA = buildPairKey({ chainId: 31337, pair: pairA });
    const keyB = buildPairKey({ chainId: 31337, pair: pairB });
    writePairSpreadFile(pairSpreadPath, {
      [keyA]: { samples: pairSpreadSamples([-80, -60, -40, -20, -10]) },
      [keyB]: { samples: pairSpreadSamples([-90, -70, -50, -30, -20]) },
    });
    let scans = 0;

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pairA, pairB] }),
        scanPair: async () => {
          scans += 1;
          return [scanResult()];
        },
      })
    );

    expect(scans).to.equal(0);
    expect(summary.scanned).to.equal(0);
    expect(summary.filteredPairs).to.equal(2);
    expect(summary.exitCode).to.equal(0);
  });

  it("keeps exitCode 1 when no pair is configured", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-no-pairs-");

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [] }),
        scanPair: async () => [],
      })
    );

    expect(summary.scanned).to.equal(0);
    expect(summary.filteredPairs).to.equal(0);
    expect(summary.exitCode).to.equal(1);
  });

  it("does not treat an independent pair error as a voluntary filter", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-independent-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const filteredPair = makePairSpreadPair(140);
    const failingPair = makePairSpreadPair(150);
    const key = buildPairKey({ chainId: 31337, pair: filteredPair });
    writePairSpreadFile(pairSpreadPath, {
      [key]: { samples: pairSpreadSamples([-80, -60, -40, -20, -10]) },
    });
    let scans = 0;

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [filteredPair, failingPair] }),
        scanPair: async ({ pair }) => {
          scans += 1;
          throw new Error(`independent failure for ${pair.label}`);
        },
      })
    );

    expect(scans).to.equal(1);
    expect(summary.scanned).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    expect(summary.exitCode).to.equal(1);
    expect(warnings.join("\n")).to.include("independent failure");
  });

  it("rejects an invalid pair-spread mode explicitly", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-mode-");
    const provider = makeMinimalProvider();

    await expect(
      main({
        provider,
        config: makeMinimalConfig(tmpDir, { pairSpreadMode: "bogus" }),
        scanPair: async () => [],
      })
    ).to.be.rejectedWith(/PAIR_SPREAD_MODE/);

    expect(provider.calls).to.deep.equal([]);
  });

  it("does not create the pair-spread state file in mode off", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-pair-spread-off-create-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(160);

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makeMinimalConfig(tmpDir, {
          pairs: [pair],
          pairSpreadMode: "off",
          pairSpreadPath,
        }),
        scanPair: async () => [scanResult({ netProfitBps: 10n })],
      })
    );

    expect(summary.scanned).to.equal(1);
    expect(fs.existsSync(pairSpreadPath)).to.equal(false);
  });

  it("records a success attempt with its sample after a priced scan", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-success-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(170);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [scanResult({ netProfitBps: 42n })],
      })
    );

    expect(summary.scanned).to.equal(1);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.version).to.equal(2);
    expect(stored.pairs[key].samples).to.have.length(1);
    expect(stored.pairs[key].samples[0].netProfitBps).to.equal("42");
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "success",
      source: "scan",
    });
    expect(stored.pairs[key].attempts[0]).to.not.have.property("reason");
    expect(stored.pairs[key].attempts[0].at).to.equal(stored.pairs[key].samples[0].at);
  });

  it("records success attempts for zero and negative valid net profit", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-zero-negative-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const zeroPair = makePairSpreadPair(180);
    const negativePair = makePairSpreadPair(190);
    const zeroKey = buildPairKey({ chainId: 31337, pair: zeroPair });
    const negativeKey = buildPairKey({ chainId: 31337, pair: negativePair });
    const bpsByLabel = new Map([
      [zeroPair.label, 0n],
      [negativePair.label, -25n],
    ]);

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [zeroPair, negativePair] }),
        scanPair: async ({ pair }) => [
          scanResult({ netProfitBps: bpsByLabel.get(pair.label) }),
        ],
      })
    );

    expect(summary.scanned).to.equal(2);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[zeroKey].samples[0].netProfitBps).to.equal("0");
    expect(stored.pairs[zeroKey].attempts[0].outcome).to.equal("success");
    expect(stored.pairs[negativeKey].samples[0].netProfitBps).to.equal("-25");
    expect(stored.pairs[negativeKey].attempts[0].outcome).to.equal("success");
  });

  it("records an empty NO_RESULTS attempt when scanPair returns no result", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-no-results-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(200);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [],
      })
    );

    expect(summary.scanned).to.equal(0);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.deep.equal([]);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "empty",
      source: "scan",
      reason: "NO_RESULTS",
    });
  });

  it("records an empty UNPRICED attempt when no netProfitBps is calculable", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-unpriced-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(210);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [scanResult({ netProfitBps: null })],
      })
    );

    expect(summary.scanned).to.equal(1);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.deep.equal([]);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "empty",
      source: "scan",
      reason: "UNPRICED",
    });
  });

  it("records an empty QUOTE_ERRORS attempt when every result is an error", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-quote-errors-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(220);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [
          scanResult({ error: new Error("RPC down") }),
          scanResult({ error: "DEPTH_EXCEEDED" }),
        ],
      })
    );

    expect(summary.scanned).to.equal(2);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.deep.equal([]);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "empty",
      source: "scan",
      reason: "QUOTE_ERRORS",
    });
  });

  it("classifies entries with missing or non-positive amountIn as QUOTE_ERRORS", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-invalid-amount-in-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const zeroPair = makePairSpreadPair(40);
    const negativePair = makePairSpreadPair(50);
    const missingPair = makePairSpreadPair(60);
    const zeroKey = buildPairKey({ chainId: 31337, pair: zeroPair });
    const negativeKey = buildPairKey({ chainId: 31337, pair: negativePair });
    const missingKey = buildPairKey({ chainId: 31337, pair: missingPair });
    const missingAmountIn = scanResult({ netProfitBps: null });
    delete missingAmountIn.amountIn;
    const resultsByLabel = new Map([
      [zeroPair.label, scanResult({ netProfitBps: null, amountIn: 0n })],
      [negativePair.label, scanResult({ netProfitBps: null, amountIn: -1n })],
      [missingPair.label, missingAmountIn],
    ]);

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, {
          pairs: [zeroPair, negativePair, missingPair],
        }),
        scanPair: async ({ pair }) => [resultsByLabel.get(pair.label)],
      })
    );

    expect(summary.scanned).to.equal(3);
    const stored = readPairSpreadFile(pairSpreadPath);
    for (const key of [zeroKey, negativeKey, missingKey]) {
      expect(stored.pairs[key].samples).to.deep.equal([]);
      expect(stored.pairs[key].attempts).to.have.length(1);
      expect(stored.pairs[key].attempts[0]).to.include({
        outcome: "empty",
        source: "scan",
        reason: "QUOTE_ERRORS",
      });
    }
  });

  it("keeps UNPRICED when at least one usable quote has no calculable bps", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-mixed-quote-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(70);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [
          scanResult({ netProfitBps: null, amountIn: 0n }),
          scanResult({ netProfitBps: null }),
        ],
      })
    );

    expect(summary.scanned).to.equal(2);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "empty",
      source: "scan",
      reason: "UNPRICED",
    });
  });

  it("records a failure SCAN_ERROR attempt when scanPair throws", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-scan-failure-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(230);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => {
          throw new Error("SCAN_BOOM");
        },
      })
    );

    expect(summary.scanned).to.equal(0);
    expect(summary.exitCode).to.equal(1);
    expect(warnings.join("\n")).to.include("SCAN_BOOM");
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.deep.equal([]);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "failure",
      source: "scan",
      reason: "SCAN_ERROR",
    });
    expect(stored.pairs[key].attempts[0]).to.not.have.property("message");
  });

  it("records a failure SCAN_ERROR attempt when scanPair returns a non-array", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-scan-contract-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const undefinedPair = makePairSpreadPair(80);
    const objectPair = makePairSpreadPair(90);
    const undefinedKey = buildPairKey({ chainId: 31337, pair: undefinedPair });
    const objectKey = buildPairKey({ chainId: 31337, pair: objectPair });

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, {
          pairs: [undefinedPair, objectPair],
        }),
        scanPair: async ({ pair }) =>
          pair.label === undefinedPair.label ? undefined : { results: [] },
      })
    );

    expect(summary.scanned).to.equal(0);
    expect(summary.exitCode).to.equal(1);
    expect(warnings.join("\n")).to.include(
      "scanPair must return an array of results"
    );
    expect(warnings.join("\n")).to.not.include("bestNetProfitBps");
    const stored = readPairSpreadFile(pairSpreadPath);
    for (const key of [undefinedKey, objectKey]) {
      expect(stored.pairs[key].samples).to.deep.equal([]);
      expect(stored.pairs[key].attempts).to.have.length(1);
      expect(stored.pairs[key].attempts[0]).to.include({
        outcome: "failure",
        source: "scan",
        reason: "SCAN_ERROR",
      });
    }
  });

  it("records no attempt for a pair skipped by enforce", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-enforce-skip-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(240);
    const key = buildPairKey({ chainId: 31337, pair });
    writePairSpreadFile(pairSpreadPath, {
      [key]: { samples: pairSpreadSamples([-80, -60, -40, -20, -10]) },
    });
    let scans = 0;

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => {
          scans += 1;
          return [scanResult({ netProfitBps: 10n })];
        },
      })
    );

    expect(scans).to.equal(0);
    expect(summary.filteredPairs).to.equal(1);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.version).to.equal(1);
    expect(stored.pairs[key]).to.not.have.property("attempts");
  });

  it("performs no pair-spread store read or write in mode off", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-mode-off-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(250);
    const originalReadFile = fsp.readFile;
    let pairSpreadReads = 0;
    fsp.readFile = async (file, ...args) => {
      if (path.resolve(file) === path.resolve(pairSpreadPath)) pairSpreadReads += 1;
      return originalReadFile.call(fsp, file, ...args);
    };

    let summary;
    try {
      ({ result: summary } = await captureConsole(() =>
        main({
          provider: makeMinimalProvider(),
          config: makeMinimalConfig(tmpDir, {
            pairs: [pair],
            pairSpreadMode: "off",
            pairSpreadPath,
          }),
          scanPair: async () => [scanResult({ netProfitBps: 10n })],
        })
      ));
    } finally {
      fsp.readFile = originalReadFile;
    }

    expect(summary.scanned).to.equal(1);
    expect(pairSpreadReads).to.equal(0);
    expect(fs.existsSync(pairSpreadPath)).to.equal(false);
  });

  it("keeps one attempt per key with success > failure > empty precedence", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-precedence-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const keyAFailurePair = makePairSpreadPair(200);
    const keyBFailurePair = makePairSpreadPair(210);
    const keyCSuccessPair = makePairSpreadPair(220);
    const keyDSuccessPair = makePairSpreadPair(230);
    const keyESuccessPair = makePairSpreadPair(240);
    const keyAEmptyPair = { ...keyAFailurePair, label: "A empty first" };
    const keyAFailure = { ...keyAFailurePair, label: "A failure second" };
    const keyBFailure = { ...keyBFailurePair, label: "B failure first" };
    const keyBSuccess = { ...keyBFailurePair, label: "B success second" };
    const keyCEmpty = { ...keyCSuccessPair, label: "C empty first" };
    const keyCSuccess = { ...keyCSuccessPair, label: "C success second" };
    const keyDSuccess = { ...keyDSuccessPair, label: "D success first" };
    const keyDFailure = { ...keyDSuccessPair, label: "D failure second" };
    const keyESuccess = { ...keyESuccessPair, label: "E success first" };
    const keyEEmpty = { ...keyESuccessPair, label: "E empty second" };
    const keyA = buildPairKey({ chainId: 31337, pair: keyAFailurePair });
    const keyB = buildPairKey({ chainId: 31337, pair: keyBFailurePair });
    const keyC = buildPairKey({ chainId: 31337, pair: keyCSuccessPair });
    const keyD = buildPairKey({ chainId: 31337, pair: keyDSuccessPair });
    const keyE = buildPairKey({ chainId: 31337, pair: keyESuccessPair });
    const behavior = new Map([
      [keyAEmptyPair.label, "empty"],
      [keyAFailure.label, "throw"],
      [keyBFailure.label, "throw"],
      [keyBSuccess.label, "success"],
      [keyCEmpty.label, "empty"],
      [keyCSuccess.label, "success"],
      [keyDSuccess.label, "success"],
      [keyDFailure.label, "throw"],
      [keyESuccess.label, "success"],
      [keyEEmpty.label, "empty"],
    ]);

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, {
          pairs: [
            keyAEmptyPair,
            keyAFailure,
            keyBFailure,
            keyBSuccess,
            keyCEmpty,
            keyCSuccess,
            keyDSuccess,
            keyDFailure,
            keyESuccess,
            keyEEmpty,
          ],
        }),
        scanPair: async ({ pair }) => {
          const outcome = behavior.get(pair.label);
          if (outcome === "throw") throw new Error(`boom ${pair.label}`);
          if (outcome === "empty") return [];
          return [scanResult({ netProfitBps: 55n })];
        },
      })
    );

    expect(summary.scanned).to.equal(4);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.version).to.equal(2);
    expect(stored.pairs[keyA].samples).to.deep.equal([]);
    expect(stored.pairs[keyA].attempts).to.have.length(1);
    expect(stored.pairs[keyA].attempts[0]).to.include({
      outcome: "failure",
      reason: "SCAN_ERROR",
    });
    expect(stored.pairs[keyB].samples[0].netProfitBps).to.equal("55");
    expect(stored.pairs[keyB].attempts).to.have.length(1);
    expect(stored.pairs[keyB].attempts[0].outcome).to.equal("success");
    expect(stored.pairs[keyC].samples[0].netProfitBps).to.equal("55");
    expect(stored.pairs[keyC].attempts).to.have.length(1);
    expect(stored.pairs[keyC].attempts[0].outcome).to.equal("success");
    // D1: a success is never replaced by a later failure or empty observation.
    expect(stored.pairs[keyD].samples).to.have.length(1);
    expect(stored.pairs[keyD].samples[0].netProfitBps).to.equal("55");
    expect(stored.pairs[keyD].attempts).to.have.length(1);
    expect(stored.pairs[keyD].attempts[0]).to.include({
      outcome: "success",
      source: "scan",
    });
    expect(stored.pairs[keyE].samples).to.have.length(1);
    expect(stored.pairs[keyE].samples[0].netProfitBps).to.equal("55");
    expect(stored.pairs[keyE].attempts).to.have.length(1);
    expect(stored.pairs[keyE].attempts[0]).to.include({
      outcome: "success",
      source: "scan",
    });
    // The Store commit succeeded and emitted no persistence warning.
    expect(warnings.join("\n")).to.not.include("persist status=");
    expect(warnings.join("\n")).to.not.include("could not persist state");
  });

  it("keeps the first observation when two attempts have the same outcome", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-tie-break-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const basePair = makePairSpreadPair(250);
    const key = buildPairKey({ chainId: 31337, pair: basePair });
    const first = { ...basePair, label: "same key empty first" };
    const second = { ...basePair, label: "same key empty second" };

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [first, second] }),
        scanPair: async ({ pair }) =>
          pair.label === first.label
            ? []
            : [scanResult({ netProfitBps: null })],
      })
    );

    expect(summary.scanned).to.equal(1);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "empty",
      source: "scan",
      reason: "NO_RESULTS",
    });
  });

  it("does not record a failure when maybeExecute throws after a successful scan", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-execute-error-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(230);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [
          scanResult({ netProfitBps: 20n, netProfitUsd: 10, isOpportunity: true }),
        ],
        maybeExecute: async () => {
          throw new Error("EXEC_BOOM");
        },
      })
    );

    expect(summary.scanned).to.equal(1);
    expect(warnings.join("\n")).to.include("EXEC_BOOM");
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples[0].netProfitBps).to.equal("20");
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "success",
      source: "scan",
    });
  });

  it("does not record a scan failure when the scan journal write fails", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-journal-error-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(240);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary, warnings } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, {
          pairs: [pair],
          // A directory makes appendScanResult fail with EISDIR.
          scanLogPath: tmpDir,
        }),
        scanPair: async () => [scanResult({ netProfitBps: 30n })],
      })
    );

    expect(summary.scanned).to.equal(1);
    expect(warnings.join("\n")).to.include("could not persist scan result");
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "success",
      source: "scan",
    });
  });

  it("does not record a scan failure when result logging throws", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-log-error-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(250);
    const key = buildPairKey({ chainId: 31337, pair });

    const { result: summary, warnings } = await captureConsole(() => {
      const collector = console.log;
      return main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => {
          console.log = () => {
            console.log = collector;
            throw new Error("LOG_BOOM");
          };
          return [scanResult({ netProfitBps: 35n })];
        },
      });
    });

    expect(summary.scanned).to.equal(1);
    expect(warnings.join("\n")).to.include("LOG_BOOM");
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].attempts).to.have.length(1);
    expect(stored.pairs[key].attempts[0]).to.include({
      outcome: "success",
      source: "scan",
    });
  });

  it("writes samples and attempts once after the loop", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-one-write-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const successPair = makePairSpreadPair(170);
    const emptyPair = makePairSpreadPair(180);
    const failingPair = makePairSpreadPair(190);
    const successKey = buildPairKey({ chainId: 31337, pair: successPair });
    const emptyKey = buildPairKey({ chainId: 31337, pair: emptyPair });
    const failingKey = buildPairKey({ chainId: 31337, pair: failingPair });
    const originalRename = fsp.rename;
    let pairSpreadWrites = 0;
    fsp.rename = async (from, to) => {
      if (path.resolve(to) === path.resolve(pairSpreadPath)) pairSpreadWrites += 1;
      return originalRename.call(fsp, from, to);
    };

    let summary;
    try {
      ({ result: summary } = await captureConsole(() =>
        main({
          provider: makeMinimalProvider(),
          config: makePairSpreadConfig(tmpDir, {
            pairs: [successPair, emptyPair, failingPair],
          }),
          scanPair: async ({ pair }) => {
            if (pair.label === failingPair.label) throw new Error("boom");
            if (pair.label === emptyPair.label) return [];
            return [scanResult({ netProfitBps: 12n })];
          },
        })
      ));
    } finally {
      fsp.rename = originalRename;
    }

    expect(summary.scanned).to.equal(1);
    expect(pairSpreadWrites).to.equal(1);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(Object.keys(stored.pairs)).to.have.length(3);
    expect(stored.pairs[successKey].attempts[0].outcome).to.equal("success");
    expect(stored.pairs[emptyKey].attempts[0].outcome).to.equal("empty");
    expect(stored.pairs[failingKey].attempts[0].outcome).to.equal("failure");
  });

  it("reports the Store attemptsAdded counter in pair_spread_persist", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempts-added-log-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const successPair = makePairSpreadPair(100);
    const emptyPair = makePairSpreadPair(110);
    const successKey = buildPairKey({ chainId: 31337, pair: successPair });
    const emptyKey = buildPairKey({ chainId: 31337, pair: emptyPair });
    const originalFormat = process.env.LOG_FORMAT;
    process.env.LOG_FORMAT = "json";
    let logs;
    try {
      ({ logs } = await captureConsole(() =>
        main({
          provider: makeMinimalProvider(),
          config: makePairSpreadConfig(tmpDir, {
            pairs: [successPair, emptyPair],
          }),
          scanPair: async ({ pair }) =>
            pair.label === successPair.label
              ? [scanResult({ netProfitBps: 42n })]
              : [],
        })
      ));
    } finally {
      if (originalFormat === undefined) delete process.env.LOG_FORMAT;
      else process.env.LOG_FORMAT = originalFormat;
    }

    const persistEvents = logs
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event && event.event === "pair_spread_persist");
    expect(persistEvents).to.have.length(1);
    expect(persistEvents[0].attemptsAdded).to.equal(2);
    expect(persistEvents[0].written).to.equal(true);
    expect(persistEvents[0].message).to.include("attemptsAdded=2");
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[successKey].attempts).to.have.length(1);
    expect(stored.pairs[emptyKey].attempts).to.have.length(1);
  });

  it("uses the cycle timestamp for both the sample and its attempt", async function () {
    const fixedNow = Date.now();
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-timestamp-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(200);
    const key = buildPairKey({ chainId: 31337, pair });

    try {
      await captureConsole(() =>
        main({
          provider: makeMinimalProvider(),
          config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
          scanPair: async () => [scanResult({ netProfitBps: 8n })],
        })
      );
    } finally {
      Date.now = originalNow;
    }

    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples[0].at).to.equal(fixedNow);
    expect(stored.pairs[key].attempts[0].at).to.equal(fixedNow);
  });

  it("preserves attempts already stored when a scan adds a new success", async function () {
    const tmpDir = makeSpreadTmpDir("flash-arb-attempt-preserve-");
    const pairSpreadPath = path.join(tmpDir, "pair_spreads.json");
    const pair = makePairSpreadPair(210);
    const key = buildPairKey({ chainId: 31337, pair });
    const oldNow = Date.now() - 60_000;
    writePairSpreadFile(
      pairSpreadPath,
      {
        [key]: {
          samples: [{ netProfitBps: "5", at: oldNow }],
          attempts: [
            { at: oldNow - 1000, outcome: "success", source: "scan" },
            { at: oldNow, outcome: "empty", source: "probe", reason: "NO_RESULTS" },
          ],
        },
      },
      { version: 2 }
    );

    const { result: summary } = await captureConsole(() =>
      main({
        provider: makeMinimalProvider(),
        config: makePairSpreadConfig(tmpDir, { pairs: [pair] }),
        scanPair: async () => [scanResult({ netProfitBps: 15n })],
      })
    );

    expect(summary.scanned).to.equal(1);
    const stored = readPairSpreadFile(pairSpreadPath);
    expect(stored.pairs[key].samples).to.have.length(2);
    expect(stored.pairs[key].samples.map((sample) => sample.netProfitBps)).to.have.members([
      "5",
      "15",
    ]);
    expect(stored.pairs[key].attempts).to.have.length(3);
    expect(
      stored.pairs[key].attempts.some(
        (attempt) =>
          attempt.at === oldNow - 1000 &&
          attempt.outcome === "success" &&
          attempt.source === "scan"
      )
    ).to.equal(true);
    expect(
      stored.pairs[key].attempts.some(
        (attempt) =>
          attempt.at === oldNow &&
          attempt.outcome === "empty" &&
          attempt.source === "probe" &&
          attempt.reason === "NO_RESULTS"
      )
    ).to.equal(true);
    expect(
      stored.pairs[key].attempts.some(
        (attempt) =>
          attempt.at > oldNow &&
          attempt.outcome === "success" &&
          attempt.source === "scan"
      )
    ).to.equal(true);
  });
});

describe("bot/index reconcilePendingExecutions", function () {
  it("marks a SIGNED record without a tx hash as DROPPED", async function () {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-reconcile-signed-"));
    const executionJournalPath = path.join(journalDir, "executions.json");
    await writeExecutionJournal(
      {
        version: 1,
        records: {
          "record-1": {
            id: "record-1",
            status: "SIGNED",
            txHash: null,
            submittedAt: Date.now(),
          },
        },
      },
      executionJournalPath
    );
    const provider = {
      getTransactionReceipt: async () => {
        throw new Error("getTransactionReceipt must not be called without a tx hash");
      },
    };

    const outcome = await reconcilePendingExecutions({
      provider,
      config: { executionJournalPath },
    });

    expect(outcome).to.deep.equal({ reconciled: 1, skipped: 0 });
    const journal = await readExecutionJournal(executionJournalPath);
    expect(journal.records["record-1"]).to.include({
      status: "DROPPED",
      error: "recovered: crashed before submit",
    });

    fs.rmSync(journalDir, { recursive: true, force: true });
  });

  it("marks a SUBMITTED record with a successful receipt as CONFIRMED", async function () {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-reconcile-submitted-"));
    const executionJournalPath = path.join(journalDir, "executions.json");
    const txHash = `0x${"44".repeat(32)}`;
    await writeExecutionJournal(
      {
        version: 1,
        records: {
          "record-2": {
            id: "record-2",
            status: "SUBMITTED",
            txHash,
            submittedAt: Date.now(),
          },
        },
      },
      executionJournalPath
    );
    const provider = {
      getTransactionReceipt: async (hash) => {
        expect(hash).to.equal(txHash);
        return { status: 1, gasUsed: 100000n, gasPrice: 2n };
      },
    };

    const outcome = await reconcilePendingExecutions({
      provider,
      config: { executionJournalPath },
    });

    expect(outcome).to.deep.equal({ reconciled: 1, skipped: 0 });
    const journal = await readExecutionJournal(executionJournalPath);
    expect(journal.records["record-2"]).to.include({
      status: "CONFIRMED",
      receiptStatus: 1,
      gasPaidWei: "200000",
    });

    fs.rmSync(journalDir, { recursive: true, force: true });
  });

  it("marks an UNKNOWN record with a consumed nonce as DROPPED with a distinct reason", async function () {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-reconcile-nonce-"));
    const executionJournalPath = path.join(journalDir, "executions.json");
    await writeExecutionJournal(
      {
        version: 1,
        records: {
          "record-3": {
            id: "record-3",
            status: "UNKNOWN",
            txHash: null,
            nonce: 5,
            submittedAt: Date.now(),
          },
        },
      },
      executionJournalPath
    );
    const provider = {
      getTransactionCount: async () => 7, // pending > record.nonce, tx consumed
      getTransactionReceipt: async () => {
        throw new Error("getTransactionReceipt must not be called without a tx hash");
      },
    };

    const outcome = await reconcilePendingExecutions({
      provider,
      config: { executionJournalPath },
      walletAddress: "0xabc",
    });

    expect(outcome).to.deep.equal({ reconciled: 1, skipped: 0 });
    const journal = await readExecutionJournal(executionJournalPath);
    expect(journal.records["record-3"]).to.include({
      status: "DROPPED",
      error: "recovered: nonce consumed but no tx hash",
    });
    fs.rmSync(journalDir, { recursive: true, force: true });
  });

  it("marks an UNKNOWN record with a pending nonce below its nonce as DROPPED (default)", async function () {
    const journalDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-reconcile-nonce-default-"));
    const executionJournalPath = path.join(journalDir, "executions.json");
    await writeExecutionJournal(
      {
        version: 1,
        records: {
          "record-4": {
            id: "record-4",
            status: "UNKNOWN",
            txHash: null,
            nonce: 5,
            submittedAt: Date.now(),
          },
        },
      },
      executionJournalPath
    );
    const provider = {
      getTransactionCount: async () => 5, // pending <= record.nonce, tx not consumed
      getTransactionReceipt: async () => {
        throw new Error("getTransactionReceipt must not be called without a tx hash");
      },
    };

    const outcome = await reconcilePendingExecutions({
      provider,
      config: { executionJournalPath },
      walletAddress: "0xabc",
    });

    expect(outcome).to.deep.equal({ reconciled: 1, skipped: 0 });
    const journal = await readExecutionJournal(executionJournalPath);
    expect(journal.records["record-4"]).to.include({
      status: "DROPPED",
      error: "recovered: crashed before submit",
    });
    fs.rmSync(journalDir, { recursive: true, force: true });
  });
});

describe("bot/index readAaveFlashLoanPremium", function () {
  it("returns the on-chain premium when it diverges from the configured value", async function () {
    const abi = ethers.AbiCoder.defaultAbiCoder();
    let calledWith;
    const provider = {
      async call(tx) {
        calledWith = tx;
        return abi.encode(["uint128"], [23n]);
      },
    };
    const config = { aaveFlashLoanPremiumBps: 5n };
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const result = await readAaveFlashLoanPremium({ provider, chainId: 42161, config });
      expect(result).to.equal(23n);
    } finally {
      console.warn = originalWarn;
    }
    expect(calledWith.to).to.equal(NETWORKS[42161].pool);
    expect(warnings.join("\n")).to.include("23 bps");
    expect(warnings.join("\n")).to.include("5 bps");
  });

  it("returns the configured premium when the chain is unknown", async function () {
    const provider = {
      async call() {
        throw new Error("should not be called");
      },
    };
    const config = { aaveFlashLoanPremiumBps: 5n };
    const originalWarn = console.warn;
    let warned = false;
    console.warn = () => {
      warned = true;
    };
    try {
      const result = await readAaveFlashLoanPremium({ provider, chainId: 999, config });
      expect(result).to.equal(5n);
    } finally {
      console.warn = originalWarn;
    }
    expect(warned).to.equal(false);
  });

  it("returns the configured premium when the on-chain call throws", async function () {
    const provider = {
      async call() {
        throw new Error("RPC unavailable");
      },
    };
    const config = { aaveFlashLoanPremiumBps: 5n };
    const warnings = [];
    const originalWarn = console.warn;
    console.warn = (msg) => warnings.push(String(msg));
    try {
      const result = await readAaveFlashLoanPremium({ provider, chainId: 42161, config });
      expect(result).to.equal(5n);
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.join("\n")).to.include("could not read Aave flash loan premium");
  });
});
