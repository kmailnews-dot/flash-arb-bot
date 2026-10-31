const { expect } = require("chai");
const { ethers } = require("hardhat");
const { decide } = require("../bot/decide");

const AMOUNT_IN = ethers.parseEther("1000");
const GAS_PRICE = 1n;
const ETH_USD = 1800;
const ESTIMATED_GAS = 300000n;
const GAS_LIMIT_WITH_MARGIN = (ESTIMATED_GAS * 11500n) / 10000n;
const GAS_COST_AT_2_WEI = 1_242_000_000n;
const GAS_FLOOR_AT_2_WEI = 1_366_200_000n;

const pair = {
  label: "USDC/WETH decide test",
  borrowedToken: {
    address: "0x1111111111111111111111111111111111111111",
    decimals: 18,
    symbol: "USDC",
    isStable: true,
  },
  intermediateToken: {
    address: "0x2222222222222222222222222222222222222222",
    decimals: 18,
    symbol: "WETH",
  },
  legOut: {
    kind: "V2",
    router: "0x3333333333333333333333333333333333333333",
    tokenOut: "0x2222222222222222222222222222222222222222",
  },
  legBack: {
    kind: "V2",
    router: "0x4444444444444444444444444444444444444444",
    tokenOut: "0x1111111111111111111111111111111111111111",
  },
  tradeSizes: ["1000"],
};

function makeOpportunity({ grossProfit, amountIn = AMOUNT_IN }) {
  return {
    pair,
    tradeSizeHuman: "1000",
    quoteTimestamp: "2026-01-01T00:00:00.000Z",
    gasPriceWei: GAS_PRICE,
    ethUsdPrice: ETH_USD,
    amountIn,
    intermediateOut: amountIn,
    finalOut: amountIn + grossProfit,
    premium: 0n,
    owed: amountIn,
    grossProfit,
    grossProfitUsd: null,
    gasCostUsd: null,
    netProfitUsd: null,
    priced: false,
    isOpportunity: true,
  };
}

function makeConfig(overrides = {}) {
  return {
    aaveFlashLoanPremiumBps: 0n,
    minProfitUsd: 5,
    minProfitBps: 30,
    ethUsdPrice: ETH_USD,
    ...overrides,
  };
}

function makeFeeData(overrides = {}) {
  return {
    gasPrice: GAS_PRICE,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
    ...overrides,
  };
}

function runDecide({ opportunity, config = makeConfig(), feeData = makeFeeData() }) {
  return decide({ opportunity, config, feeData, estimatedGas: ESTIMATED_GAS });
}

describe("bot/decide decide", function () {
  it("autorise l'exécution quand tous les seuils sont respectés", function () {
    const result = runDecide({
      opportunity: makeOpportunity({ grossProfit: ethers.parseEther("10") }),
    });

    expect(result.shouldExecute).to.equal(true);
    expect(result.reason).to.equal("OK");
    expect(result.gasCostInToken).to.equal(GAS_COST_AT_2_WEI);
    expect(result.gasFloor).to.equal(GAS_FLOOR_AT_2_WEI);
    expect(result.netProfitFresh).to.equal(ethers.parseEther("10") - GAS_COST_AT_2_WEI);
    expect(result.netProfitBps).to.equal(99n);
    expect(result.maxFeeCostInToken).to.equal(GAS_COST_AT_2_WEI);
    expect(result.decisionGasPriceWei).to.equal(2n);
    expect(result.gasLimitWithMargin).to.equal(GAS_LIMIT_WITH_MARGIN);
  });

  it("refuse quand gasPrice est nul", function () {
    const result = runDecide({
      opportunity: makeOpportunity({ grossProfit: ethers.parseEther("10") }),
      feeData: makeFeeData({ gasPrice: 0n }),
    });

    expect(result.shouldExecute).to.equal(false);
    expect(result.reason).to.equal("gasPrice is 0");
    expect(result.decisionGasPriceWei).to.equal(0n);
    expect(result.gasLimitWithMargin).to.equal(GAS_LIMIT_WITH_MARGIN);
  });

  it("refuse quand le profit est sous le gasFloor", function () {
    const result = runDecide({
      opportunity: makeOpportunity({ grossProfit: 1n }),
    });

    expect(result.shouldExecute).to.equal(false);
    expect(result.reason).to.include("gas cost exceeds profit");
    expect(result.gasFloor).to.be.greaterThan(1n);
  });

  it("refuse quand le profit net frais est sous MIN_PROFIT_USD", function () {
    const result = runDecide({
      opportunity: makeOpportunity({ grossProfit: 2_000_000_000n }),
    });

    expect(result.shouldExecute).to.equal(false);
    expect(result.reason).to.include("fresh net profit below MIN_PROFIT_USD");
    expect(result.netProfitFresh).to.be.lessThan(ethers.parseEther("5"));
  });

  it("refuse quand le profit net frais est sous MIN_PROFIT_BPS", function () {
    const amountIn = ethers.parseEther("10000");
    const result = runDecide({
      opportunity: makeOpportunity({
        amountIn,
        grossProfit: ethers.parseEther("10") + GAS_COST_AT_2_WEI,
      }),
    });

    expect(result.shouldExecute).to.equal(false);
    expect(result.reason).to.include("fresh net profit below MIN_PROFIT_BPS");
    expect(result.netProfitFresh).to.equal(ethers.parseEther("10"));
    expect(result.netProfitBps).to.equal(10n);
  });

  it("refuse quand maxFeePerGas dépasse le plafond de profit", function () {
    const result = runDecide({
      opportunity: makeOpportunity({ grossProfit: ethers.parseEther("10") }),
      feeData: makeFeeData({
        gasPrice: 1n,
        maxFeePerGas: 10n ** 18n,
        maxPriorityFeePerGas: null,
      }),
    });

    expect(result.shouldExecute).to.equal(false);
    expect(result.reason).to.include("maxFeePerGas exceeds profit cap");
    expect(result.maxFeeCostInToken).to.be.greaterThan(ethers.parseEther("10"));
  });

  it("ne fait aucun appel réseau et reste synchrone", function () {
    const originalFetch = global.fetch;
    let fetchCalls = 0;
    global.fetch = () => {
      fetchCalls += 1;
      throw new Error("network access");
    };

    try {
      const result = runDecide({
        opportunity: makeOpportunity({ grossProfit: ethers.parseEther("10") }),
      });

      expect(fetchCalls).to.equal(0);
      expect(result).to.be.an("object");
      expect(result.then).to.equal(undefined);
      expect(result.shouldExecute).to.equal(true);
    } finally {
      if (originalFetch === undefined) {
        delete global.fetch;
      } else {
        global.fetch = originalFetch;
      }
    }
  });
});
