require("dotenv").config();
const { ethers } = require("ethers");
const path = require("path");

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env (locally) or set it as a ` +
        "GitHub Actions secret (in CI) - see the README setup section."
    );
  }
  return value;
}

function optionalString(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function optionalNumber(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : Number(value);
}

function validateAddress(value, path) {
  try {
    return ethers.getAddress(value);
  } catch (err) {
    throw new Error(`Invalid address at ${path}: ${value} (${err.message})`);
  }
}

function validatePairs(pairs) {
  return pairs.map((pair, index) => {
    const prefix = `PAIRS_CONFIG_JSON[${index}]`;
    if (!pair || typeof pair !== "object") {
      throw new Error(`${prefix} must be an object.`);
    }
    if (!pair.borrowedToken || !pair.intermediateToken || !pair.legOut || !pair.legBack) {
      throw new Error(`${prefix} must define borrowedToken, intermediateToken, legOut and legBack.`);
    }

    const borrowed = validateAddress(pair.borrowedToken.address, `${prefix}.borrowedToken.address`);
    const intermediate = validateAddress(pair.intermediateToken.address, `${prefix}.intermediateToken.address`);

    if (
      !Number.isInteger(pair.borrowedToken.decimals) ||
      pair.borrowedToken.decimals < 0 ||
      pair.borrowedToken.decimals > 18
    ) {
      throw new Error(`${prefix}.borrowedToken.decimals must be an integer between 0 and 18.`);
    }
    if (
      !Number.isInteger(pair.intermediateToken.decimals) ||
      pair.intermediateToken.decimals < 0 ||
      pair.intermediateToken.decimals > 18
    ) {
      throw new Error(`${prefix}.intermediateToken.decimals must be an integer between 0 and 18.`);
    }
    if (pair.borrowedToken.isStable !== undefined && typeof pair.borrowedToken.isStable !== "boolean") {
      throw new Error(`${prefix}.borrowedToken.isStable must be a boolean if present.`);
    }
    if (pair.borrowedToken.isWeth !== undefined && typeof pair.borrowedToken.isWeth !== "boolean") {
      throw new Error(`${prefix}.borrowedToken.isWeth must be a boolean if present.`);
    }
    if (pair.borrowedToken.isStable === true && pair.borrowedToken.isWeth === true) {
      throw new Error(`${prefix}.borrowedToken must not set both isStable and isWeth to true.`);
    }

    if (pair.tradeSizes === undefined) {
      throw new Error(`${prefix}.tradeSizes is required.`);
    }
    if (!Array.isArray(pair.tradeSizes)) {
      throw new Error(`${prefix}.tradeSizes must be an array.`);
    }
    if (pair.tradeSizes.length === 0) {
      throw new Error(`${prefix}.tradeSizes must not be empty.`);
    }
    const decimals = pair.borrowedToken.decimals;
    const seenTradeSizes = new Set();
    for (let i = 0; i < pair.tradeSizes.length; i += 1) {
      if (typeof pair.tradeSizes[i] !== "string") {
        throw new Error(`${prefix}.tradeSizes[${i}] must be a string.`);
      }
      let tradeSize;
      try {
        tradeSize = ethers.parseUnits(pair.tradeSizes[i], decimals);
      } catch (err) {
        throw new Error(
          `${prefix}.tradeSizes[${i}] must be parseable with borrowedToken.decimals (${decimals}).`
        );
      }
      if (tradeSize <= 0n) {
        throw new Error(`${prefix}.tradeSizes[${i}] must be greater than 0.`);
      }
      if (seenTradeSizes.has(tradeSize.toString())) {
        throw new Error(`${prefix}.tradeSizes[${i}] duplicates an earlier trade size (${tradeSize}).`);
      }
      seenTradeSizes.add(tradeSize.toString());
    }

    if (pair.legOut.kind !== "V2" && pair.legOut.kind !== "V3") {
      throw new Error(`${prefix}.legOut.kind must be "V2" or "V3".`);
    }
    if (pair.legBack.kind !== "V2" && pair.legBack.kind !== "V3") {
      throw new Error(`${prefix}.legBack.kind must be "V2" or "V3".`);
    }

    const v3Fees = [100, 500, 3000, 10000];
    if (pair.legOut.kind === "V3") {
      if (!Number.isInteger(pair.legOut.v3Fee) || !v3Fees.includes(pair.legOut.v3Fee)) {
        throw new Error(`${prefix}.legOut.v3Fee must be one of 100, 500, 3000 or 10000 when kind is "V3".`);
      }
      if (pair.legOut.quoter === undefined) {
        throw new Error(`${prefix}.legOut.quoter is required when kind is "V3".`);
      }
    }
    if (pair.legBack.kind === "V3") {
      if (!Number.isInteger(pair.legBack.v3Fee) || !v3Fees.includes(pair.legBack.v3Fee)) {
        throw new Error(`${prefix}.legBack.v3Fee must be one of 100, 500, 3000 or 10000 when kind is "V3".`);
      }
      if (pair.legBack.quoter === undefined) {
        throw new Error(`${prefix}.legBack.quoter is required when kind is "V3".`);
      }
    }

    validateAddress(pair.legOut.router, `${prefix}.legOut.router`);
    const legOutTokenOut = validateAddress(pair.legOut.tokenOut, `${prefix}.legOut.tokenOut`);
    if (pair.legOut.quoter !== undefined) {
      validateAddress(pair.legOut.quoter, `${prefix}.legOut.quoter`);
    }

    validateAddress(pair.legBack.router, `${prefix}.legBack.router`);
    const legBackTokenOut = validateAddress(pair.legBack.tokenOut, `${prefix}.legBack.tokenOut`);
    if (pair.legBack.quoter !== undefined) {
      validateAddress(pair.legBack.quoter, `${prefix}.legBack.quoter`);
    }

    const originalV3SwapRouter = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
    if (pair.legOut.kind === "V3" && ethers.getAddress(pair.legOut.router) !== originalV3SwapRouter) {
      throw new Error(
        `${prefix}.legOut.router must be the original Uniswap V3 SwapRouter (0xE592...1564), not SwapRouter02 (0x68b3...Fc45)`
      );
    }
    if (pair.legBack.kind === "V3" && ethers.getAddress(pair.legBack.router) !== originalV3SwapRouter) {
      throw new Error(
        `${prefix}.legBack.router must be the original Uniswap V3 SwapRouter (0xE592...1564), not SwapRouter02 (0x68b3...Fc45)`
      );
    }

    if (legOutTokenOut !== intermediate) {
      throw new Error(`${prefix}.legOut.tokenOut must equal intermediateToken.address (${intermediate}).`);
    }
    if (legBackTokenOut !== borrowed) {
      throw new Error(`${prefix}.legBack.tokenOut must equal borrowedToken.address (${borrowed}).`);
    }

    return pair;
  });
}

function loadPairs() {
  const raw = required("PAIRS_CONFIG_JSON");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`PAIRS_CONFIG_JSON is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("PAIRS_CONFIG_JSON must be a non-empty array. See .env.example for the shape.");
  }
  return validatePairs(parsed);
}

function loadEthUsdRoute() {
  const raw = process.env.ETH_USD_ROUTE_JSON;
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`ETH_USD_ROUTE_JSON is not valid JSON: ${err.message}`);
  }
  if (parsed.kind === "V3") {
    if (!parsed.quoter) {
      throw new Error(
        'ETH_USD_ROUTE_JSON with kind "V3" requires a "quoter" address (Uniswap V3 QuoterV2); ' +
          '"router" alone cannot quote prices.'
      );
    }
    validateAddress(parsed.quoter, "ETH_USD_ROUTE_JSON.quoter");
  }
  return parsed;
}

const dryRun = optionalString("DRY_RUN", "true").toLowerCase() !== "false";

function validateSlippageBps() {
  const value = optionalNumber("SLIPPAGE_BPS", 50);
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error("SLIPPAGE_BPS must be an integer between 1 and 200.");
  }
  return value;
}

function validateScannerConfig({
  minProfitUsd,
  minProfitBps,
  aaveFlashLoanPremiumBps,
  gasPriceBufferPct,
  maxGasLimit,
  maxWalletBalanceEth,
  maxDailyGasEth,
  throttleMinIntervalMs,
}) {
  if (minProfitUsd !== undefined && minProfitUsd !== null) {
    if (typeof minProfitUsd !== "number" || !Number.isFinite(minProfitUsd) || minProfitUsd < 0) {
      throw new Error("MIN_PROFIT_USD must be a finite number >= 0 when set.");
    }
  }
  if (minProfitBps !== undefined && minProfitBps !== null) {
    if (!Number.isInteger(minProfitBps) || minProfitBps < 0 || minProfitBps > 10000) {
      throw new Error("MIN_PROFIT_BPS must be an integer between 0 and 10000.");
    }
  }
  if (typeof aaveFlashLoanPremiumBps !== "bigint" || aaveFlashLoanPremiumBps < 0n) {
    throw new Error("AAVE_FLASH_LOAN_PREMIUM_BPS must be a non-negative bigint.");
  }
  if (typeof gasPriceBufferPct !== "number" || !Number.isInteger(gasPriceBufferPct) || gasPriceBufferPct < 0) {
    throw new Error("GAS_PRICE_BUFFER_PCT must be a non-negative integer.");
  }
  if (gasPriceBufferPct > 1000) {
    throw new Error("GAS_PRICE_BUFFER_PCT must be <= 1000.");
  }
  if (typeof maxGasLimit !== "bigint" || maxGasLimit <= 0n) {
    throw new Error("MAX_GAS_LIMIT must be a positive bigint.");
  }
  if (maxGasLimit > 10_000_000n) {
    throw new Error("MAX_GAS_LIMIT must be <= 10000000.");
  }
  if (
    typeof maxWalletBalanceEth !== "number" ||
    !Number.isFinite(maxWalletBalanceEth) ||
    maxWalletBalanceEth <= 0
  ) {
    throw new Error("MAX_WALLET_BALANCE_ETH must be a finite number > 0.");
  }
  if (maxWalletBalanceEth > 10) {
    throw new Error("MAX_WALLET_BALANCE_ETH must be <= 10.");
  }
  if (
    typeof maxDailyGasEth !== "number" ||
    !Number.isFinite(maxDailyGasEth) ||
    maxDailyGasEth <= 0
  ) {
    throw new Error("MAX_DAILY_GAS_ETH must be a finite number > 0.");
  }
  if (maxDailyGasEth > 10) {
    throw new Error("MAX_DAILY_GAS_ETH must be <= 10.");
  }
  if (throttleMinIntervalMs !== undefined && throttleMinIntervalMs !== null) {
    if (!Number.isInteger(throttleMinIntervalMs) || throttleMinIntervalMs < 0) {
      throw new Error("THROTTLE_MIN_INTERVAL_MS must be a non-negative integer.");
    }
  }
}

const slippageBps = validateSlippageBps();

const minProfitBufferBps = optionalNumber("MIN_PROFIT_BUFFER_BPS", 5000);
if (!Number.isInteger(minProfitBufferBps) || minProfitBufferBps < 1 || minProfitBufferBps > 10000) {
  throw new Error("MIN_PROFIT_BUFFER_BPS must be an integer between 1 and 10000.");
}

const LOG_DIR = path.resolve(__dirname, "..", "logs");

const config = {
  rpcUrl: required("ARBITRUM_RPC_URL"),
  dryRun,
  // Persistent runner (bot/run.js): polling interval for HTTP JSON-RPC providers. A ws:// or
  // wss:// ARBITRUM_RPC_URL uses WebSocketProvider instead.
  pollIntervalMs: optionalNumber("POLL_INTERVAL_MS", 15000),
  throttleMinIntervalMs: optionalNumber("THROTTLE_MIN_INTERVAL_MS", 250),
  // Only needed when DRY_RUN=false - this wallet needs a small ETH/ARB balance to pay gas.
  // It is NOT the flash loan capital: the flash loan itself always borrows with zero collateral.
  privateKey: process.env.PRIVATE_KEY,
  contractAddress: process.env.CONTRACT_ADDRESS,

  aaveFlashLoanPremiumBps: BigInt(optionalNumber("AAVE_FLASH_LOAN_PREMIUM_BPS", 5)), // 0.05% Aave V3 default

  minProfitUsd: optionalNumber("MIN_PROFIT_USD", 5),
  minProfitBps: optionalNumber("MIN_PROFIT_BPS", 30), // require net profit >= 0.30% of the borrowed notional
  minProfitBufferBps: BigInt(minProfitBufferBps), // require on-chain minProfit >= 50% of the off-chain estimate, to absorb slippage/front-running between quote and execution
  slippageBps: BigInt(slippageBps), // 0.5% per-leg slippage tolerance for minAmountOut

  gasLimitEstimate: BigInt(optionalNumber("GAS_LIMIT_ESTIMATE", 700000)),
  maxGasLimit: BigInt(optionalNumber("MAX_GAS_LIMIT", 1000000)),
  gasPriceBufferPct: optionalNumber("GAS_PRICE_BUFFER_PCT", 20),

  // Live-execution safety guards. They only apply when DRY_RUN=false and a transaction is about
  // to be sent. See README "Live-execution loss guards" and bot/guards.js.
  expectedChainId: optionalNumber("EXPECTED_CHAIN_ID", 42161),
  maxWalletBalanceEth: optionalNumber("MAX_WALLET_BALANCE_ETH", 0.1),
  minWalletBalanceEth: optionalNumber("MIN_WALLET_BALANCE_ETH", 0.005),
  maxRpcErrorsPerScan: optionalNumber("MAX_RPC_ERRORS_PER_SCAN", 3),
  maxDailyGasEth: optionalNumber("MAX_DAILY_GAS_ETH", 0.01),
  maxConsecutiveFailures: optionalNumber("MAX_CONSECUTIVE_FAILURES", 5),
  circuitBreakerCooldownMinutes: optionalNumber("CIRCUIT_BREAKER_COOLDOWN_MINUTES", 60),
  gasSpentPath: optionalString("GAS_SPENT_PATH", path.join(LOG_DIR, "gas_spent.json")),
  circuitBreakerPath: optionalString("CIRCUIT_BREAKER_PATH", path.join(LOG_DIR, "circuit_breaker.json")),

  // Append-only JSONL log of every scan result, used to measure opportunities over time.
  scanLogPath: optionalString("SCAN_LOG_PATH", path.join(LOG_DIR, "scans.jsonl")),

  // Optional: lets the bot price gas in USD by quoting 1 WETH -> a stablecoin on a live DEX pool.
  // Required only for pairs whose borrowed token is WETH or a stablecoin (see README). Leave unset
  // to skip USD filtering entirely and rely solely on the contract's on-chain minProfit guard.
  ethUsdRoute: loadEthUsdRoute(),

  // Array of pair configs to scan - tokens, routers, trade sizes. See .env.example for the shape.
  pairs: loadPairs(),
};

validateScannerConfig({
  minProfitUsd: config.minProfitUsd,
  minProfitBps: config.minProfitBps,
  aaveFlashLoanPremiumBps: config.aaveFlashLoanPremiumBps,
  gasPriceBufferPct: config.gasPriceBufferPct,
  maxGasLimit: config.maxGasLimit,
  maxWalletBalanceEth: config.maxWalletBalanceEth,
  maxDailyGasEth: config.maxDailyGasEth,
  throttleMinIntervalMs: config.throttleMinIntervalMs,
});

module.exports = config;
module.exports.validatePairs = validatePairs;
module.exports.validateSlippageBps = validateSlippageBps;
module.exports.validateScannerConfig = validateScannerConfig;
