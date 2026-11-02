const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main, readAaveFlashLoanPremium } = require("../bot/index");
const { NETWORKS } = require("../bot/networks");
const { reconcilePendingExecutions } = require("../bot/execute");
const { readExecutionJournal, writeExecutionJournal } = require("../bot/persist");

describe("bot/index main", function () {
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
