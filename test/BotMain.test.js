const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { main } = require("../bot/index");
const { NETWORKS } = require("../bot/networks");

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
});
