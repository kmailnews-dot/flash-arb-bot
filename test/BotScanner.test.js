const { expect } = require("chai");
const { ethers } = require("hardhat");
const { scanTradeSize } = require("../bot/scanner");

const USDC = "0x1111111111111111111111111111111111111111";
const WETH = "0x2222222222222222222222222222222222222222";
const ROUTER_A = "0x3333333333333333333333333333333333333333";
const ROUTER_B = "0x4444444444444444444444444444444444444444";

const AMOUNT_IN = ethers.parseUnits("1000", 6);
const PREMIUM = 500_000n;
const GROSS_PROFIT_ABOVE_THRESHOLD = 10_000_000n;
const GROSS_PROFIT_BELOW_THRESHOLD = 5_000_000n;
const GAS_PRICE_WEI = 1_000_000_000n;
const ETH_USD_PRICE = 1800;

const pair = {
  label: "USDC/WETH test",
  borrowedToken: { address: USDC, decimals: 6, symbol: "USDC", isStable: true },
  intermediateToken: { address: WETH, decimals: 18, symbol: "WETH" },
  legOut: { kind: "V2", router: ROUTER_A, tokenOut: WETH },
  legBack: { kind: "V3", router: ROUTER_B, tokenOut: USDC, v3Fee: 500 },
  tradeSizes: ["1000"],
};

const config = {
  aaveFlashLoanPremiumBps: 5n,
  minProfitUsd: 5,
  gasLimitEstimate: 700_000n,
  gasPriceBufferPct: 20,
};

function makeQuoteLeg(finalOut) {
  return async (_provider, leg) => (leg === pair.legOut ? AMOUNT_IN : finalOut);
}

async function scan({ ethUsdPrice, gasPriceWei, grossProfit = GROSS_PROFIT_ABOVE_THRESHOLD }) {
  const finalOut = AMOUNT_IN + PREMIUM + grossProfit;
  return scanTradeSize({
    provider: {},
    pair,
    tradeSizeHuman: "1000",
    config,
    gasPriceWei,
    ethUsdPrice,
    quoteLeg: makeQuoteLeg(finalOut),
  });
}

describe("bot/scanner scanTradeSize", function () {
  it("marks the result unpriced when the ETH/USD price is unavailable", async function () {
    const result = await scan({ ethUsdPrice: null, gasPriceWei: GAS_PRICE_WEI });

    expect(result.priced).to.equal(false);
    expect(result.isOpportunity).to.equal(false);
    expect(result.grossProfit).to.be.greaterThan(0n);
    expect(result.netProfitUsd).to.equal(null);
  });

  it("marks the result unpriced when the gas price is zero", async function () {
    const result = await scan({ ethUsdPrice: ETH_USD_PRICE, gasPriceWei: 0n });

    expect(result.priced).to.equal(false);
    expect(result.isOpportunity).to.equal(false);
    expect(result.grossProfit).to.be.greaterThan(0n);
    expect(result.netProfitUsd).to.equal(null);
  });

  it("flags an opportunity when priced net profit meets the USD threshold", async function () {
    const result = await scan({ ethUsdPrice: ETH_USD_PRICE, gasPriceWei: GAS_PRICE_WEI });

    expect(result.priced).to.equal(true);
    expect(result.netProfitUsd).to.be.at.least(config.minProfitUsd);
    expect(result.isOpportunity).to.equal(true);
  });

  it("does not flag an opportunity when priced net profit is below the USD threshold", async function () {
    const result = await scan({
      ethUsdPrice: ETH_USD_PRICE,
      gasPriceWei: GAS_PRICE_WEI,
      grossProfit: GROSS_PROFIT_BELOW_THRESHOLD,
    });

    expect(result.priced).to.equal(true);
    expect(result.netProfitUsd).to.be.below(config.minProfitUsd);
    expect(result.isOpportunity).to.equal(false);
  });
});
