const { expect } = require("chai");
const { ethers } = require("hardhat");
const { main } = require("../bot/index");

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

    const config = {
      dryRun: true,
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
    expect(summary.opportunities).to.equal(1);
    expect(warnings.join("\n")).to.include("could not quote ETH/USD");
    expect(warnings.join("\n")).to.include("USD filtering is disabled");
  });
});
