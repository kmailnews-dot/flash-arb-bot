const { expect } = require("chai");

const BORROWED = "0x1111111111111111111111111111111111111111";
const INTERMEDIATE = "0x2222222222222222222222222222222222222222";
const ROUTER_OUT = "0x3333333333333333333333333333333333333333";
const ROUTER_BACK = "0x4444444444444444444444444444444444444444";

const VALID_CONFIG = {
  minProfitUsd: 5,
  aaveFlashLoanPremiumBps: 5n,
  gasPriceBufferPct: 20,
  maxGasLimit: 1000000n,
  maxWalletBalanceEth: 0.1,
  maxDailyGasEth: 0.01,
};

const previousEnv = {
  ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL,
  PAIRS_CONFIG_JSON: process.env.PAIRS_CONFIG_JSON,
  ETH_USD_ROUTE_JSON: process.env.ETH_USD_ROUTE_JSON,
};

process.env.ARBITRUM_RPC_URL = previousEnv.ARBITRUM_RPC_URL || "http://127.0.0.1:8545";
process.env.PAIRS_CONFIG_JSON = JSON.stringify([
  {
    borrowedToken: { address: BORROWED, decimals: 18 },
    intermediateToken: { address: INTERMEDIATE, decimals: 18 },
    legOut: { kind: "V2", router: ROUTER_OUT, tokenOut: INTERMEDIATE },
    legBack: { kind: "V2", router: ROUTER_BACK, tokenOut: BORROWED },
    tradeSizes: ["0.1"],
  },
]);
process.env.ETH_USD_ROUTE_JSON = "";

const { validateScannerConfig } = require("../bot/config");

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("bot/config validateScannerConfig", function () {
  it("accepts a valid minProfitUsd", function () {
    expect(() => validateScannerConfig(VALID_CONFIG)).to.not.throw();
  });

  it("rejects a negative minProfitUsd", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, minProfitUsd: -1 })).to.throw(
      "MIN_PROFIT_USD must be a finite number >= 0 when set."
    );
  });

  it("rejects a NaN minProfitUsd", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, minProfitUsd: NaN })).to.throw(
      "MIN_PROFIT_USD must be a finite number >= 0 when set."
    );
  });

  it("accepts a bigint aaveFlashLoanPremiumBps", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, aaveFlashLoanPremiumBps: 5n })).to.not.throw();
  });

  it("rejects a Number aaveFlashLoanPremiumBps", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, aaveFlashLoanPremiumBps: 5 })).to.throw(
      "AAVE_FLASH_LOAN_PREMIUM_BPS must be a non-negative bigint."
    );
  });

  it("accepts a valid gasPriceBufferPct", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, gasPriceBufferPct: 20 })).to.not.throw();
  });

  it("rejects a negative gasPriceBufferPct", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, gasPriceBufferPct: -5 })).to.throw(
      "GAS_PRICE_BUFFER_PCT must be a non-negative integer."
    );
  });

  it("accepts gasPriceBufferPct = 20", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, gasPriceBufferPct: 20 })).to.not.throw();
  });

  it("rejects a non-integer gasPriceBufferPct", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, gasPriceBufferPct: 20.5 })).to.throw(
      "GAS_PRICE_BUFFER_PCT must be a non-negative integer."
    );
  });

  it("accepts a positive maxGasLimit", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxGasLimit: 1000000n })).to.not.throw();
  });

  it("rejects a zero maxGasLimit", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxGasLimit: 0n })).to.throw(
      "MAX_GAS_LIMIT must be a positive bigint."
    );
  });

  it("rejects a negative maxGasLimit", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxGasLimit: -1n })).to.throw(
      "MAX_GAS_LIMIT must be a positive bigint."
    );
  });

  it("accepts a positive maxWalletBalanceEth", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxWalletBalanceEth: 0.1 })).to.not.throw();
  });

  it("rejects a zero maxWalletBalanceEth", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxWalletBalanceEth: 0 })).to.throw(
      "MAX_WALLET_BALANCE_ETH must be a finite number > 0."
    );
  });

  it("rejects a zero maxDailyGasEth", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxDailyGasEth: 0 })).to.throw(
      "MAX_DAILY_GAS_ETH must be a finite number > 0."
    );
  });

  it("rejects a gasPriceBufferPct above 1000", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, gasPriceBufferPct: 1001 })).to.throw(
      "GAS_PRICE_BUFFER_PCT must be <= 1000."
    );
  });

  it("rejects a maxGasLimit above 10000000", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxGasLimit: 10000001n })).to.throw(
      "MAX_GAS_LIMIT must be <= 10000000."
    );
  });

  it("rejects a maxWalletBalanceEth above 10", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxWalletBalanceEth: 11 })).to.throw(
      "MAX_WALLET_BALANCE_ETH must be <= 10."
    );
  });

  it("rejects a maxDailyGasEth above 10", function () {
    expect(() => validateScannerConfig({ ...VALID_CONFIG, maxDailyGasEth: 11 })).to.throw(
      "MAX_DAILY_GAS_ETH must be <= 10."
    );
  });
});
