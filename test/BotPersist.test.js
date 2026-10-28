const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { appendScanResult } = require("../bot/persist");

describe("bot/persist appendScanResult", function () {
  it("appends one JSONL line per result with all required fields", async function () {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-persist-"));
    const logPath = path.join(logDir, "nested", "scans.jsonl");
    const pair = {
      label: "WETH/USDC test pair",
      borrowedToken: { symbol: "WETH", decimals: 18 },
    };

    await appendScanResult(
      logPath,
      {
        pair,
        tradeSizeHuman: "0.1",
        grossProfit: 123456789n,
        grossProfitUsd: 12.5,
        netProfitUsd: 10.25,
        gasCostUsd: 2.25,
        isOpportunity: true,
      },
      { chainId: 42161, timestamp: new Date("2026-10-27T12:00:00.000Z") }
    );

    await appendScanResult(
      logPath,
      { pair, tradeSizeHuman: "1", error: "CALL_EXCEPTION" },
      { chainId: 42161, timestamp: new Date("2026-10-27T12:01:00.000Z") }
    );

    const lines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines).to.have.length(2);

    const opportunity = JSON.parse(lines[0]);
    expect(opportunity).to.include({
      timestamp: "2026-10-27T12:00:00.000Z",
      chainId: 42161,
      pair: "WETH/USDC test pair",
      borrowedToken: "WETH",
      tradeSize: "0.1",
      grossProfit: "123456789",
      grossProfitSymbol: "WETH",
      grossProfitUsd: 12.5,
      netProfitUsd: 10.25,
      gasCostUsd: 2.25,
      isOpportunity: true,
      error: null,
    });

    const failure = JSON.parse(lines[1]);
    expect(failure).to.include({
      timestamp: "2026-10-27T12:01:00.000Z",
      chainId: 42161,
      pair: "WETH/USDC test pair",
      tradeSize: "1",
      grossProfit: null,
      isOpportunity: false,
      error: "CALL_EXCEPTION",
    });

    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("never persists raw error.message or an RPC URL containing a secret", async function () {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-persist-secret-"));
    const logPath = path.join(logDir, "scans.jsonl");
    const pair = {
      label: "secret pair",
      borrowedToken: { symbol: "WETH", decimals: 18 },
    };

    await appendScanResult(
      logPath,
      {
        pair,
        tradeSizeHuman: "1",
        error: { message: "https://alchemy.com/v2/SECRET_KEY", code: "X" },
      },
      { chainId: 42161 }
    );

    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).to.not.include("SECRET_KEY");
    expect(JSON.parse(contents.trim()).error).to.deep.equal({ code: "X", shortMessage: null });

    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("persists replay fields with BigInt values as strings", async function () {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-persist-fields-"));
    const logPath = path.join(logDir, "scans.jsonl");
    const pair = {
      label: "WETH/USDC replay pair",
      borrowedToken: { symbol: "WETH", decimals: 18 },
    };

    await appendScanResult(
      logPath,
      {
        pair,
        tradeSizeHuman: "0.1",
        blockNumber: 123456,
        quoteTimestamp: "2026-10-27T12:00:00.000Z",
        gasPriceWei: 1_000_000_000n,
        ethUsdPrice: 1800.5,
        amountIn: 100_000_000_000_000_000n,
        intermediateOut: 200_000_000_000_000_000n,
        finalOut: 101_000_000_000_000_000n,
        owed: 100_050_000_000_000_000n,
        premium: 50_000_000_000_000n,
        grossProfit: 950_000_000_000_000n,
        grossProfitUsd: 1.71,
        netProfitUsd: 1.2,
        gasCostUsd: 0.51,
        priced: true,
        isOpportunity: true,
      },
      { chainId: 42161, timestamp: new Date("2026-10-27T12:30:00.000Z") }
    );

    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry).to.include({
      timestamp: "2026-10-27T12:30:00.000Z",
      chainId: 42161,
      blockNumber: 123456,
      quoteTimestamp: "2026-10-27T12:00:00.000Z",
      gasPriceWei: "1000000000",
      ethUsdPrice: 1800.5,
      amountIn: "100000000000000000",
      intermediateOut: "200000000000000000",
      finalOut: "101000000000000000",
      owed: "100050000000000000",
      premium: "50000000000000",
      grossProfit: "950000000000000",
      grossProfitUsd: 1.71,
      netProfitUsd: 1.2,
      gasCostUsd: 0.51,
      priced: true,
      isOpportunity: true,
    });

    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("persists null for missing quoteTimestamp and gasPriceWei", async function () {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-persist-missing-"));
    const logPath = path.join(logDir, "scans.jsonl");
    const pair = {
      label: "missing fields pair",
      borrowedToken: { symbol: "WETH", decimals: 18 },
    };

    await appendScanResult(logPath, { pair, tradeSizeHuman: "1" }, { chainId: 42161 });

    const entry = JSON.parse(fs.readFileSync(logPath, "utf8").trim());
    expect(entry).to.include({
      blockNumber: null,
      quoteTimestamp: null,
      gasPriceWei: null,
      ethUsdPrice: null,
      amountIn: null,
      intermediateOut: null,
      finalOut: null,
      owed: null,
      premium: null,
      priced: false,
    });

    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("persists priced: false", async function () {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-persist-unpriced-"));
    const logPath = path.join(logDir, "scans.jsonl");
    const pair = {
      label: "unpriced pair",
      borrowedToken: { symbol: "USDC", decimals: 6 },
    };

    await appendScanResult(logPath, { pair, tradeSizeHuman: "1", priced: false, isOpportunity: false }, { chainId: 42161 });

    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).to.include('"priced":false');
    expect(JSON.parse(contents.trim()).priced).to.equal(false);

    fs.rmSync(logDir, { recursive: true, force: true });
  });

  it("redacts ws and wss URLs in persisted errors", async function () {
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-persist-ws-"));
    const logPath = path.join(logDir, "scans.jsonl");
    const pair = {
      label: "websocket pair",
      borrowedToken: { symbol: "WETH", decimals: 18 },
    };

    await appendScanResult(
      logPath,
      {
        pair,
        tradeSizeHuman: "1",
        error: {
          code: "WEBSOCKET_ERROR",
          shortMessage: "failed ws://rpc.example/key then wss://rpc.example/other",
        },
      },
      { chainId: 42161 }
    );

    const contents = fs.readFileSync(logPath, "utf8");
    expect(contents).to.not.include("ws://");
    expect(contents).to.not.include("wss://");
    expect(JSON.parse(contents.trim()).error).to.deep.equal({
      code: "WEBSOCKET_ERROR",
      shortMessage: "failed [REDACTED_URL] then [REDACTED_URL]",
    });

    fs.rmSync(logDir, { recursive: true, force: true });
  });
});
