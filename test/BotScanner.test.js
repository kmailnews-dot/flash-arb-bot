const { expect } = require("chai");
const { ethers } = require("hardhat");
const { scanTradeSize, scanPair, isTradeSizeWithinDepth } = require("../bot/scanner");

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
  maxQuoteAgeMs: 60_000,
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

  it("raises the USD floor to 3x the gas cost when gas is expensive", async function () {
    const expensiveConfig = {
      ...config,
      minProfitUsd: 0.10,
      gasLimitEstimate: 462_963n,
    };
    const scanWith = (grossProfit) => {
      const finalOut = AMOUNT_IN + PREMIUM + grossProfit;
      return scanTradeSize({
        provider: {},
        pair,
        tradeSizeHuman: "1000",
        config: expensiveConfig,
        gasPriceWei: GAS_PRICE_WEI,
        ethUsdPrice: ETH_USD_PRICE,
        quoteLeg: makeQuoteLeg(finalOut),
      });
    };

    const below = await scanWith(1_500_000n);
    expect(below.gasCostUsd).to.be.closeTo(1, 0.01);
    expect(below.netProfitUsd).to.be.closeTo(0.50, 0.01);
    expect(below.isOpportunity).to.equal(false);

    const above = await scanWith(4_500_000n);
    expect(above.netProfitUsd).to.be.closeTo(3.50, 0.01);
    expect(above.isOpportunity).to.equal(true);
  });
});

describe("bot/scanner isTradeSizeWithinDepth", function () {
  const HALF_OUT = 1_000_000n;

  function makeDepthQuoteLeg(fullOut) {
    return async (_provider, _leg, _tokenIn, amountIn) =>
      amountIn === AMOUNT_IN ? fullOut : HALF_OUT;
  }

  it("keeps a trade size within 0.5% of pool depth", async function () {
    const within = await isTradeSizeWithinDepth({
      pair,
      tradeSizeHuman: "1000",
      provider: {},
      config,
      quoteLeg: makeDepthQuoteLeg(2n * HALF_OUT),
    });

    expect(within).to.equal(true);
  });

  it("skips a trade size beyond 0.5% of pool depth", async function () {
    const within = await isTradeSizeWithinDepth({
      pair,
      tradeSizeHuman: "1000",
      provider: {},
      config,
      quoteLeg: makeDepthQuoteLeg(1_500_000n),
    });

    expect(within).to.equal(false);
  });
});

describe("bot/scanner scanPair", function () {
  const BLOCK_TAG = 12345;

  function makeScanPairQuoteLeg(calls) {
    return async (_provider, leg, _tokenIn, amountIn, blockTag) => {
      calls.push({ leg, amountIn, blockTag });
      if (leg === pair.legOut) return amountIn;
      return AMOUNT_IN + PREMIUM + GROSS_PROFIT_ABOVE_THRESHOLD;
    };
  }

  it("pins the same blockTag across all quotes in one scanPair", async function () {
    const calls = [];
    const provider = { getBlockNumber: async () => BLOCK_TAG };
    const results = await scanPair({
      provider,
      pair,
      config,
      gasPriceWei: GAS_PRICE_WEI,
      ethUsdPrice: ETH_USD_PRICE,
      quoteLeg: makeScanPairQuoteLeg(calls),
    });

    expect(calls).to.have.length(4);
    expect(calls[0].amountIn).to.equal(AMOUNT_IN);
    expect(calls[1].amountIn).to.equal(AMOUNT_IN / 2n);
    expect(calls[2].leg).to.equal(pair.legOut);
    expect(calls[3].leg).to.equal(pair.legBack);
    expect(calls.slice(0, 2).map((call) => call.blockTag)).to.deep.equal([BLOCK_TAG, BLOCK_TAG]);
    expect(calls.slice(2).map((call) => call.blockTag)).to.deep.equal([BLOCK_TAG, BLOCK_TAG]);
    expect(results).to.have.length(1);
    expect(results[0].error).to.equal(undefined);
  });

  it("flags a quote older than maxQuoteAgeMs as QUOTE_STALE", async function () {
    const RealDate = Date;
    const staleNow = RealDate.now() - 120_000;
    global.Date = class extends RealDate {
      constructor(...args) {
        super(...(args.length > 0 ? args : [staleNow]));
      }
    };

    try {
      const calls = [];
      const provider = { getBlockNumber: async () => BLOCK_TAG };
      const results = await scanPair({
        provider,
        pair,
        config,
        gasPriceWei: GAS_PRICE_WEI,
        ethUsdPrice: ETH_USD_PRICE,
        quoteLeg: makeScanPairQuoteLeg(calls),
      });

      expect(results).to.have.length(1);
      expect(results[0].error).to.equal("QUOTE_STALE");
      expect(results[0].isOpportunity).to.equal(false);
    } finally {
      global.Date = RealDate;
    }
  });
});
