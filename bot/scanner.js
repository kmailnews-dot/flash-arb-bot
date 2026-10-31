const { ethers } = require("ethers");
const { quoteLeg, quoteV2, quoteV3 } = require("./prices");
const { createThrottle, withThrottle } = require("./throttle");
const { GAS_PROFIT_MULTIPLIER } = require("./pricing");

const BPS_DENOMINATOR = 10000n;

let scannerThrottle = null;

function getScannerThrottle(config = {}) {
  if (!scannerThrottle) {
    scannerThrottle = createThrottle({
      minIntervalMs: config.throttleMinIntervalMs,
      name: "scanner",
    });
  }
  return scannerThrottle;
}

function redactUrls(value) {
  if (typeof value !== "string") return value;
  return value.replace(/https:\/\/[^\s]+/g, "[REDACTED_URL]");
}

function sanitizeError(err) {
  const source = err || {};
  return {
    code: redactUrls(source.code ?? null),
    shortMessage: redactUrls(source.shortMessage ?? source.message ?? null),
  };
}

/// Quotes 1 WETH -> a reference stablecoin on a live DEX pool, so gas costs and profit can be
/// priced in USD without paying for an external price API. Returns null if ethUsdRoute isn't set.
///
/// A failed quote (wrong-network addresses, missing pool, revert, undecodable return data, ...)
/// is non-fatal: USD pricing is an optional convenience, so warn and return null. Callers then
/// mark the result unpriced instead of crashing the whole scan.
async function getEthUsdPrice(provider, ethUsdRoute, config = {}) {
  if (!ethUsdRoute) return null;

  const routeAddress = ethUsdRoute.kind === "V3" ? ethUsdRoute.quoter : ethUsdRoute.router;

  try {
    const oneEth = ethers.parseUnits("1", 18);
    const { result: out } = await withThrottle(getScannerThrottle(config), () =>
      ethUsdRoute.kind === "V2"
        ? quoteV2(provider, ethUsdRoute.router, ethUsdRoute.weth, ethUsdRoute.usdc, oneEth)
        : quoteV3(provider, ethUsdRoute.quoter, ethUsdRoute.weth, ethUsdRoute.usdc, ethUsdRoute.fee, oneEth)
    );

    return Number(ethers.formatUnits(out, ethUsdRoute.usdcDecimals));
  } catch (err) {
    const { shortMessage } = sanitizeError(err);
    const message = shortMessage ?? "unknown error";
    console.warn(
      `WARNING: could not quote ETH/USD via ${ethUsdRoute.kind} route ${routeAddress}: ${message}. ` +
        "USD filtering is disabled for this run; scan results will be unpriced and not flagged as opportunities. " +
        "Check that ETH_USD_ROUTE_JSON contains addresses for the network configured in ARBITRUM_RPC_URL."
    );
    return null;
  }
}

/// Estimates the USD cost of submitting the arbitrage transaction.
function estimateGasCostUsd({ gasPriceWei, gasLimit, gasPriceBufferPct, ethUsdPrice }) {
  if (ethUsdPrice === null) return null;
  if (gasPriceWei === null || gasPriceWei === undefined || gasPriceWei === 0n) return null;
  const bufferedGasPrice = (gasPriceWei * BigInt(100 + gasPriceBufferPct)) / 100n;
  const gasCostWei = bufferedGasPrice * gasLimit;
  return Number(ethers.formatUnits(gasCostWei, 18)) * ethUsdPrice;
}

/// Converts a raw profit amount (in borrowedToken units) into USD, when possible.
/// Returns null when the borrowed token is neither a stablecoin nor WETH, since that's the only
/// case this bot can price without an external feed - see README "Configuring pairs & DEXs".
function profitInUsd(profitTokenUnits, borrowedToken, ethUsdPrice) {
  const asFloat = Number(ethers.formatUnits(profitTokenUnits, borrowedToken.decimals));
  if (borrowedToken.isStable) return asFloat;
  if (borrowedToken.isWeth && ethUsdPrice !== null) return asFloat * ethUsdPrice;
  return null;
}

function effectiveMinProfitUsd(gasCostUsd, config) {
  const absolute = Number(config.minProfitUsd);
  const gasMultiple = gasCostUsd !== null ? Number(gasCostUsd) * Number(GAS_PROFIT_MULTIPLIER) : 0;
  return Math.max(absolute, gasMultiple);
}

/// Scans one configured trade size for one pair and returns an opportunity descriptor
/// (profitable or not) - never throws for "just not profitable", only for real errors.
async function scanTradeSize({
  provider,
  pair,
  tradeSizeHuman,
  config,
  gasPriceWei,
  ethUsdPrice,
  quoteLeg: injectedQuoteLeg = quoteLeg,
}) {
  const quoteTimestamp = new Date().toISOString();
  const amountIn = ethers.parseUnits(tradeSizeHuman, pair.borrowedToken.decimals);

  const { result: intermediateOut } = await withThrottle(getScannerThrottle(config), () =>
    injectedQuoteLeg(provider, pair.legOut, pair.borrowedToken.address, amountIn)
  );
  const { result: finalOut } = await withThrottle(getScannerThrottle(config), () =>
    injectedQuoteLeg(provider, pair.legBack, pair.intermediateToken.address, intermediateOut)
  );

  const premium = (amountIn * config.aaveFlashLoanPremiumBps) / BPS_DENOMINATOR;
  const owed = amountIn + premium;
  const grossProfit = finalOut - owed; // bigint, may be negative

  const gasCostUsd = estimateGasCostUsd({
    gasPriceWei,
    gasLimit: config.gasLimitEstimate,
    gasPriceBufferPct: config.gasPriceBufferPct,
    ethUsdPrice,
  });
  const grossProfitUsd = profitInUsd(grossProfit, pair.borrowedToken, ethUsdPrice);
  const netProfitUsd = grossProfitUsd !== null && gasCostUsd !== null ? grossProfitUsd - gasCostUsd : null;

  const priced = netProfitUsd !== null;

  return {
    pair,
    tradeSizeHuman,
    quoteTimestamp,
    gasPriceWei,
    ethUsdPrice,
    amountIn,
    intermediateOut,
    finalOut,
    premium,
    owed,
    grossProfit,
    grossProfitUsd,
    gasCostUsd,
    netProfitUsd,
    priced,
    isOpportunity:
      priced === true &&
      grossProfit > 0n &&
      netProfitUsd >= effectiveMinProfitUsd(gasCostUsd, config),
  };
}

/// Scans every configured trade size for a pair and returns only the results worth logging,
/// sorted with the best (highest net-of-fee output) first.
async function scanPair({ provider, pair, config, gasPriceWei, ethUsdPrice }) {
  const results = [];
  for (const tradeSizeHuman of pair.tradeSizes) {
    try {
      results.push(await scanTradeSize({ provider, pair, tradeSizeHuman, config, gasPriceWei, ethUsdPrice }));
    } catch (err) {
      results.push({ pair, tradeSizeHuman, error: sanitizeError(err) });
    }
  }
  return results.sort((a, b) => {
    if (a.error) return 1;
    if (b.error) return -1;
    return a.grossProfit > b.grossProfit ? -1 : a.grossProfit < b.grossProfit ? 1 : 0;
  });
}

module.exports = {
  getEthUsdPrice,
  estimateGasCostUsd,
  sanitizeError,
  scanTradeSize,
  scanPair,
  getScannerThrottle,
};
