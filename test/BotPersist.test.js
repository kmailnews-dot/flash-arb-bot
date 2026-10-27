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
});
