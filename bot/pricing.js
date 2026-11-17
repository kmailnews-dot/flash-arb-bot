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
    // gasCostWei is already denominated in ETH/WETH: no USD conversion needed.
    // Integer arithmetic avoids the float64 rounding of the previous formula.
    const scale = 10n ** BigInt(borrowedToken.decimals ?? 18);
    return (effectiveGasWei * scale + WEI_PER_ETHER - 1n) / WEI_PER_ETHER;
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

  // Sort by size: callers previously passed points in profit order, which made the
  // parabola fit use x0/x1/x2 out of order and silently returned a wrong amount.
  const points = [];
  for (let i = 0; i < sizes.length; i += 1) {
    const sizeNum = Number(sizes[i]);
    const profitNum = profits[i] === null || profits[i] === undefined ? NaN : Number(profits[i]);
    if (!Number.isFinite(sizeNum) || sizeNum <= 0 || !Number.isFinite(profitNum) || profitNum < 0) {
      continue;
    }
    points.push({ size: sizeNum, rawSize: sizes[i], x: Math.log10(sizeNum), y: profitNum });
  }
  if (points.length === 0) {
    return { size: sizes[0], interpolated: false };
  }
  points.sort((a, b) => a.x - b.x);

  let bestIndex = 0;
  for (let i = 1; i < points.length; i += 1) {
    if (points[i].y > points[bestIndex].y) bestIndex = i;
  }
  const best = points[bestIndex];
  if (bestIndex === 0 || bestIndex === points.length - 1) {
    return { size: best.rawSize, interpolated: false };
  }

  const p0 = points[bestIndex - 1];
  const p1 = best;
  const p2 = points[bestIndex + 1];
  // Quadratic through (x0,y0), (x1,y1), (x2,y2). a >= 0 means no interior maximum.
  const slope01 = (p1.y - p0.y) / (p1.x - p0.x);
  const slope12 = (p2.y - p1.y) / (p2.x - p1.x);
  const a = (slope12 - slope01) / (p2.x - p0.x);
  if (!(a < 0)) {
    return { size: best.rawSize, interpolated: false };
  }
  const b = slope01 - a * (p0.x + p1.x);
  const xStar = -b / (2 * a);
  if (!Number.isFinite(xStar)) {
    return { size: best.rawSize, interpolated: false };
  }
  let sizeStar = 10 ** xStar;
  if (sizeStar < p0.size) sizeStar = p0.size;
  if (sizeStar > p2.size) sizeStar = p2.size;
  if (maxTradeSize !== null && maxTradeSize !== undefined) {
    const cap = Number(maxTradeSize);
    if (Number.isFinite(cap) && sizeStar > cap) sizeStar = cap;
  }
  return { size: sizeStar.toFixed(6), interpolated: true };
}

function effectiveMinProfitBps({ pair, config }) {
  const pairFloorBps = pair?.minProfitBps ?? config?.minProfitBps ?? 0;
  const adaptiveBps = config?.effectiveMinProfitBps ?? pairFloorBps;
  return BigInt(Math.max(pairFloorBps, adaptiveBps));
}

module.exports = {
  BPS_DENOMINATOR,
  GAS_COST_MARGIN_BPS,
  GAS_LIMIT_MARGIN_BPS,
  GAS_PROFIT_MULTIPLIER,
  WEI_PER_ETHER,
  buildFeeOverrides,
  effectiveMinProfitBps,
  gasCostInBorrowedToken,
  interpolateMaximum,
  logSweepSizes,
  withSlippage,
};
