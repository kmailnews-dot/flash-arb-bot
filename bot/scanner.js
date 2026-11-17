const { ethers } = require("ethers");
const { quoteLeg, quoteV2, quoteV3 } = require("./prices");
const { createThrottle, withThrottle } = require("./throttle");
const {
  BPS_DENOMINATOR,
  GAS_PROFIT_MULTIPLIER,
  effectiveMinProfitBps,
  gasCostInBorrowedToken,
  logSweepSizes,
  interpolateMaximum,
} = require("./pricing");
const { sanitizeError } = require("./sanitizeError");
const { usdToTokenUnits } = require("./minProfitUsd");

const MAX_DEPTH_IMPACT_BPS = 50n;

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

/// Buffers the gas price and multiplies it by the gas limit. Returns null when gas pricing is
/// unavailable: a missing or zero gas price must never be treated as free gas (fail closed).
function estimateGasCostWei({ gasPriceWei, gasLimit, gasPriceBufferPct }) {
  if (gasPriceWei === null || gasPriceWei === undefined || gasPriceWei === 0n) return null;
  const limit = typeof gasLimit === "bigint" ? gasLimit : BigInt(gasLimit ?? 0);
  if (limit === 0n) return null;
  const bufferPct = Number(gasPriceBufferPct);
  const buffer = Number.isFinite(bufferPct) && bufferPct >= 0 ? Math.round(bufferPct) : 0;
  const bufferedGasPrice = (gasPriceWei * BigInt(100 + buffer)) / 100n;
  return bufferedGasPrice * limit;
}

/// Converts a raw amount (in borrowedToken units) into USD, when possible.
/// Returns null when the borrowed token is neither a stablecoin nor WETH, since that's the only
/// case this bot can price without an external feed - see README "Configuring pairs & DEXs".
function profitInUsd(amountTokenUnits, borrowedToken, ethUsdPrice) {
  if (amountTokenUnits === null || amountTokenUnits === undefined) return null;
  const asFloat = Number(ethers.formatUnits(amountTokenUnits, borrowedToken.decimals));
  if (borrowedToken.isStable) return asFloat;
  if (borrowedToken.isWeth && ethUsdPrice !== null) return asFloat * ethUsdPrice;
  return null;
}

function tokenUsdPrice(borrowedToken, ethUsdPrice) {
  if (borrowedToken.isStable === true) return 1;
  const ethPrice = Number(ethUsdPrice);
  if (borrowedToken.isWeth === true && Number.isFinite(ethPrice) && ethPrice > 0) return ethPrice;
  return null;
}

/// USD floor: max(MIN_PROFIT_USD, 3x gas cost). The gas multiple makes sure a trade pays for
/// itself several times over instead of merely clearing its own gas.
function effectiveMinProfitUsd(gasCostUsd, config) {
  const configured = Number(config.minProfitUsd);
  const absolute = Number.isFinite(configured) && configured > 0 ? configured : 0;
  const gasMultiple = gasCostUsd !== null ? Number(gasCostUsd) * Number(GAS_PROFIT_MULTIPLIER) : 0;
  return Math.max(absolute, gasMultiple);
}

/// Scans one configured trade size for one pair and returns an opportunity descriptor
/// (profitable or not) - never throws for "just not profitable", only for real errors.
///
/// `intermediateOut` lets `scanPair` reuse the entry-leg quote it already fetched for the depth
/// check instead of paying a second identical RPC call for the same amount and block.
async function scanTradeSize({
  provider,
  pair,
  tradeSizeHuman,
  config,
  gasPriceWei,
  ethUsdPrice,
  quoteLeg: injectedQuoteLeg = quoteLeg,
  blockTag = "latest",
  intermediateOut: precomputedIntermediateOut = null,
}) {
  const quoteTimestamp = new Date().toISOString();
  const amountIn = ethers.parseUnits(tradeSizeHuman, pair.borrowedToken.decimals);

  let intermediateOut = precomputedIntermediateOut;
  if (intermediateOut === null || intermediateOut === undefined) {
    const quote = await withThrottle(getScannerThrottle(config), () =>
      injectedQuoteLeg(provider, pair.legOut, pair.borrowedToken.address, amountIn, blockTag)
    );
    intermediateOut = quote.result;
  }
  const { result: finalOut } = await withThrottle(getScannerThrottle(config), () =>
    injectedQuoteLeg(
      provider,
      pair.legBack,
      pair.intermediateToken.address,
      intermediateOut,
      blockTag
    )
  );

  const premiumBps = BigInt(config.aaveFlashLoanPremiumBps ?? 0);
  const premium = (amountIn * premiumBps) / BPS_DENOMINATOR;
  const owed = amountIn + premium;
  const grossProfit = finalOut - owed; // bigint, may be negative

  const gasCostWei = estimateGasCostWei({
    gasPriceWei,
    gasLimit: config.gasLimitEstimate,
    gasPriceBufferPct: config.gasPriceBufferPct,
  });
  const gasCostInToken =
    gasCostWei === null
      ? null
      : gasCostInBorrowedToken({
          gasCostWei,
          pair,
          config: { ...config, ethUsdPrice },
          l1MultiplierBps: config.l1CostMultiplierBps,
        });
  const netProfit = gasCostInToken === null ? null : grossProfit - gasCostInToken;
  const netProfitBps =
    netProfit !== null && amountIn > 0n ? (netProfit * BPS_DENOMINATOR) / amountIn : null;

  const grossProfitUsd = profitInUsd(grossProfit, pair.borrowedToken, ethUsdPrice);
  const gasCostUsd = profitInUsd(gasCostInToken, pair.borrowedToken, ethUsdPrice);
  const netProfitUsd = profitInUsd(netProfit, pair.borrowedToken, ethUsdPrice);
  const priced = netProfitUsd !== null;

  // Mirror decide(): the BPS floor is applied to net profit, not gross profit.
  const minProfitBps = effectiveMinProfitBps({ pair, config });
  const meetsBpsFloor =
    netProfit !== null &&
    amountIn > 0n &&
    netProfit * BPS_DENOMINATOR >= amountIn * minProfitBps;

  const usdPrice = tokenUsdPrice(pair.borrowedToken, ethUsdPrice);
  const minProfitUsdConfigured = config.minProfitUsd !== undefined && config.minProfitUsd !== null;
  let minProfitUsdInToken = null;
  if (priced && minProfitUsdConfigured && usdPrice !== null) {
    minProfitUsdInToken = usdToTokenUnits({
      usdAmount: effectiveMinProfitUsd(gasCostUsd, config),
      tokenUsdPrice: usdPrice,
      decimals: pair.borrowedToken.decimals,
    });
  }
  const meetsUsdFloor =
    !minProfitUsdConfigured ||
    (minProfitUsdInToken !== null && netProfit !== null && netProfit >= minProfitUsdInToken);

  return {
    pair,
    tradeSizeHuman,
    blockNumber: typeof blockTag === "number" ? blockTag : null,
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
    gasCostWei,
    gasCostInToken,
    gasCostUsd,
    netProfit,
    netProfitBps,
    netProfitUsd,
    minProfitBps,
    minProfitUsdInToken,
    priced,
    isOpportunity:
      priced === true &&
      grossProfit > 0n &&
      netProfit !== null &&
      netProfit > 0n &&
      meetsBpsFloor &&
      meetsUsdFloor,
  };
}

/// Quotes the entry leg at X and X/2. Returns the full X quote so `scanTradeSize` can reuse it.
/// The depth rule is `fullOut >= 2 * halfOut * (1 - 0.5%)`: X stays within 0.5% of pool depth.
async function quoteEntryDepth({
  pair,
  tradeSizeHuman,
  provider,
  config,
  quoteLeg: injectedQuoteLeg = quoteLeg,
  blockTag = "latest",
}) {
  const amountIn = ethers.parseUnits(tradeSizeHuman, pair.borrowedToken.decimals);
  const halfAmountIn = amountIn / 2n;
  if (halfAmountIn === 0n) return { within: true, fullOut: null };

  const { result: fullOut } = await withThrottle(getScannerThrottle(config), () =>
    injectedQuoteLeg(provider, pair.legOut, pair.borrowedToken.address, amountIn, blockTag)
  );
  const { result: halfOut } = await withThrottle(getScannerThrottle(config), () =>
    injectedQuoteLeg(provider, pair.legOut, pair.borrowedToken.address, halfAmountIn, blockTag)
  );

  const expectedOut = (2n * halfOut * (BPS_DENOMINATOR - MAX_DEPTH_IMPACT_BPS)) / BPS_DENOMINATOR;
  return { within: fullOut >= expectedOut, fullOut };
}

/// Returns true when the entry-leg quote of X is not more than MAX_DEPTH_IMPACT_BPS
/// below twice the quote of X/2, i.e. when X stays within 0.5% of the pool depth.
async function isTradeSizeWithinDepth(args) {
  return (await quoteEntryDepth(args)).within;
}

function bestProfitInToken(result) {
  if (result.netProfit !== null && result.netProfit !== undefined) return result.netProfit;
  return result.grossProfit;
}

/// Scans every configured trade size for a pair and returns only the results worth logging,
/// sorted with the best (highest net-of-fee output) first. `blockTag` pins every quote of the
/// pair to one block; callers scanning several pairs should fetch it once and pass it in.
async function scanPair({
  provider,
  pair,
  config,
  gasPriceWei,
  ethUsdPrice,
  quoteLeg: injectedQuoteLeg = quoteLeg,
  blockTag: pinnedBlockTag = null,
}) {
  const blockTag =
    pinnedBlockTag !== null && pinnedBlockTag !== undefined
      ? pinnedBlockTag
      : await provider.getBlockNumber();
  const tradeSizes = pair.logSweep
    ? logSweepSizes({
        min: pair.logSweep.min,
        max: pair.logSweep.max,
        steps: pair.logSweep.steps,
      })
    : pair.tradeSizes;
  // Scan sizes ascending: average price impact is non-decreasing with size, so once one size
  // exceeds pool depth every larger size does too and can be marked without any RPC call.
  const orderedTradeSizes = [...tradeSizes].sort((a, b) => Number(a) - Number(b));
  const blockNumber = typeof blockTag === "number" ? blockTag : null;
  const results = [];
  let depthExceededAbove = null;
  for (const tradeSizeHuman of orderedTradeSizes) {
    if (depthExceededAbove !== null) {
      results.push({ pair, tradeSizeHuman, blockNumber, error: "DEPTH_EXCEEDED" });
      continue;
    }
    try {
      const depth = await quoteEntryDepth({
        pair,
        tradeSizeHuman,
        provider,
        config,
        quoteLeg: injectedQuoteLeg,
        blockTag,
      });
      if (!depth.within) {
        depthExceededAbove = Number(tradeSizeHuman);
        results.push({ pair, tradeSizeHuman, blockNumber, error: "DEPTH_EXCEEDED" });
        continue;
      }
      results.push(
        await scanTradeSize({
          provider,
          pair,
          tradeSizeHuman,
          config,
          gasPriceWei,
          ethUsdPrice,
          quoteLeg: injectedQuoteLeg,
          blockTag,
          intermediateOut: depth.fullOut,
        })
      );
    } catch (err) {
      results.push({ pair, tradeSizeHuman, blockNumber, error: sanitizeError(err) });
    }
  }
  const now = Date.now();
  const checkedResults = results.map((result) => {
    if (!result.quoteTimestamp) return result;
    const quoteAgeMs = now - new Date(result.quoteTimestamp).getTime();
    if (quoteAgeMs > config.maxQuoteAgeMs) {
      return { ...result, error: "QUOTE_STALE", isOpportunity: false };
    }
    return result;
  });
  const sorted = checkedResults.sort((a, b) => {
    if (a.error) return 1;
    if (b.error) return -1;
    return a.grossProfit > b.grossProfit ? -1 : a.grossProfit < b.grossProfit ? 1 : 0;
  });

  if (pair.logSweep && sorted.length >= 3 && sorted.every((r) => !r.error)) {
    const ascending = [...sorted].sort(
      (a, b) => Number(a.tradeSizeHuman) - Number(b.tradeSizeHuman)
    );
    const sizes = ascending.map((r) => r.tradeSizeHuman);
    const profits = ascending.map((r) =>
      r.netProfitUsd !== null ? r.netProfitUsd : Number(r.grossProfit)
    );
    const interp = interpolateMaximum({
      sizes,
      profits,
      maxTradeSize: pair.logSweep.max,
    });
    if (interp.interpolated) {
      try {
        // The interpolated size is only a hypothesis: re-quote it at the same block before
        // selecting it, otherwise the logged size would not match the logged amounts.
        const requoted = await scanTradeSize({
          provider,
          pair,
          tradeSizeHuman: interp.size,
          config,
          gasPriceWei,
          ethUsdPrice,
          quoteLeg: injectedQuoteLeg,
          blockTag,
        });
        requoted.interpolated = true;
        const best = sorted[0];
        const samePricingBasis = (requoted.netProfit === null) === (best.netProfit === null);
        if (samePricingBasis && bestProfitInToken(requoted) > bestProfitInToken(best)) {
          sorted[0] = requoted;
        }
      } catch (err) {
        const { shortMessage } = sanitizeError(err);
        console.warn(
          `WARNING: could not re-quote interpolated size ${interp.size}: ${shortMessage} - keeping best quoted size.`
        );
      }
    }
  }

  return sorted;
}

module.exports = {
  getEthUsdPrice,
  estimateGasCostWei,
  sanitizeError,
  scanTradeSize,
  scanPair,
  isTradeSizeWithinDepth,
  getScannerThrottle,
};
