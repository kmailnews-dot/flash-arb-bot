const BPS_DENOMINATOR = 10000n;
const WEI_PER_ETHER = 10n ** 18n;
const GAS_COST_MARGIN_BPS = 11000n;
const GAS_LIMIT_MARGIN_BPS = 11500n;
const GAS_PROFIT_MULTIPLIER = 3n;

function withSlippage(amount, slippageBps) {
  return (amount * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
}

function gasCostInBorrowedToken({ gasCostWei, pair, config, l1MultiplierBps }) {
  const borrowedToken = pair.borrowedToken || {};
  const l1Bps =
    typeof l1MultiplierBps === "number"
      ? l1MultiplierBps
      : Number(config?.l1CostMultiplierBps ?? 0);
  const effectiveGasWei =
    l1Bps > 0
      ? (gasCostWei * (BPS_DENOMINATOR + BigInt(Math.round(l1Bps)))) / BPS_DENOMINATOR
      : gasCostWei;

  if (borrowedToken.isStable === true) {
    const ethUsdPrice = Number(config.ethUsdPrice);
    if (!Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) return null;
    const scale = 10n ** BigInt(borrowedToken.decimals ?? 18);
    const priceScale = 1_000_000n;
    const price = BigInt(Math.round(ethUsdPrice * Number(priceScale)));
    if (price <= 0n) return null;
    const denominator = WEI_PER_ETHER * priceScale;
    const numerator = effectiveGasWei * price * scale;
    return (numerator + denominator - 1n) / denominator;
  }

  if (borrowedToken.isWeth === true) {
    const ethUsdPrice = Number(config.ethUsdPrice);
    if (!Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) return null;
    const WETH_PRICE_IN_USD = ethUsdPrice;
    const inTokenUnits = (Number(effectiveGasWei) / 1e18 / ethUsdPrice) * WETH_PRICE_IN_USD;
    return BigInt(Math.ceil(inTokenUnits * 10 ** Number(borrowedToken.decimals ?? 18)));
  }

  return null;
}

function buildFeeOverrides(feeData) {
  const maxFeePerGas = feeData?.maxFeePerGas;
  const maxPriorityFeePerGas = feeData?.maxPriorityFeePerGas;
  if (
    typeof maxFeePerGas === "bigint" &&
    maxFeePerGas > 0n &&
    typeof maxPriorityFeePerGas === "bigint" &&
    maxPriorityFeePerGas > 0n
  ) {
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  const gasPrice = feeData?.gasPrice;
  if (typeof gasPrice === "bigint" && gasPrice > 0n) {
    return { gasPrice };
  }

  return {};
}

function logSweepSizes({ min, max, steps }) {
  if (!Number.isInteger(steps) || steps < 3) {
    throw new Error("logSweepSizes: steps must be an integer >= 3");
  }
  const minNum = Number(min);
  const maxNum = Number(max);
  if (!Number.isFinite(minNum) || !Number.isFinite(maxNum) || minNum <= 0 || maxNum <= minNum) {
    throw new Error("logSweepSizes: invalid min/max");
  }
  const logMin = Math.log10(minNum);
  const logMax = Math.log10(maxNum);
  const result = [];
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const value = 10 ** (logMin + t * (logMax - logMin));
    result.push(value.toFixed(6));
  }
  return result;
}

function interpolateMaximum({ sizes, profits, maxTradeSize = null }) {
  if (!Array.isArray(sizes) || !Array.isArray(profits)) {
    throw new Error("interpolateMaximum: sizes and profits must be arrays");
  }
  if (sizes.length !== profits.length || sizes.length === 0) {
    throw new Error("interpolateMaximum: sizes and profits must have the same non-zero length");
  }
  let bestIndex = -1;
  let bestProfit = null;
  for (let i = 0; i < profits.length; i += 1) {
    const p = profits[i];
    if (p === null || p === undefined || typeof p === "bigint" || Number(p) < 0) continue;
    if (bestProfit === null || Number(p) > bestProfit) {
      bestProfit = Number(p);
      bestIndex = i;
    }
  }
  if (bestIndex < 0) {
    return { size: sizes[0], interpolated: false };
  }
  if (bestIndex === 0 || bestIndex === profits.length - 1) {
    return { size: sizes[bestIndex], interpolated: false };
  }
  const prevProfit = profits[bestIndex - 1];
  const nextProfit = profits[bestIndex + 1];
  if (
    prevProfit === null || prevProfit === undefined || typeof prevProfit === "bigint" || Number(prevProfit) < 0 ||
    nextProfit === null || nextProfit === undefined || typeof nextProfit === "bigint" || Number(nextProfit) < 0
  ) {
    return { size: sizes[bestIndex], interpolated: false };
  }
  const x0 = Math.log10(Number(sizes[bestIndex - 1]));
  const x1 = Math.log10(Number(sizes[bestIndex]));
  const x2 = Math.log10(Number(sizes[bestIndex + 1]));
  const y0 = Number(prevProfit);
  const y1 = bestProfit;
  const y2 = Number(nextProfit);
  const denom = y0 - 2 * y1 + y2;
  if (denom >= 0) {
    return { size: sizes[bestIndex], interpolated: false };
  }
  const h = x2 - x1;
  const xStar = x1 + (h / 2) * ((y0 - y2) / denom);
  let sizeStar = 10 ** xStar;
  const lower = Math.min(Number(sizes[bestIndex - 1]), Number(sizes[bestIndex + 1]));
  const upper = Math.max(Number(sizes[bestIndex - 1]), Number(sizes[bestIndex + 1]));
  if (sizeStar < lower) sizeStar = lower;
  if (sizeStar > upper) sizeStar = upper;
  if (maxTradeSize !== null && maxTradeSize !== undefined) {
    const cap = Number(maxTradeSize);
    if (Number.isFinite(cap) && sizeStar > cap) sizeStar = cap;
  }
  return { size: sizeStar.toFixed(6), interpolated: true };
}

module.exports = {
  BPS_DENOMINATOR,
  GAS_COST_MARGIN_BPS,
  GAS_LIMIT_MARGIN_BPS,
  GAS_PROFIT_MULTIPLIER,
  WEI_PER_ETHER,
  buildFeeOverrides,
  gasCostInBorrowedToken,
  interpolateMaximum,
  logSweepSizes,
  withSlippage,
};
