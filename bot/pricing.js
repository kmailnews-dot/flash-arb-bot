const BPS_DENOMINATOR = 10000n;
const WEI_PER_ETHER = 10n ** 18n;
const GAS_COST_MARGIN_BPS = 11000n;
const GAS_LIMIT_MARGIN_BPS = 11500n;
const GAS_PROFIT_MULTIPLIER = 3n;

function withSlippage(amount, slippageBps) {
  return (amount * (BPS_DENOMINATOR - slippageBps)) / BPS_DENOMINATOR;
}

function gasCostInBorrowedToken({ gasCostWei, pair, config }) {
  const borrowedToken = pair.borrowedToken || {};

  if (borrowedToken.isStable === true) {
    const ethUsdPrice = Number(config.ethUsdPrice);
    if (!Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) return null;
    const scale = 10n ** BigInt(borrowedToken.decimals ?? 18);
    const priceScale = 1_000_000n;
    const price = BigInt(Math.round(ethUsdPrice * Number(priceScale)));
    if (price <= 0n) return null;
    const denominator = WEI_PER_ETHER * priceScale;
    const numerator = gasCostWei * price * scale;
    return (numerator + denominator - 1n) / denominator;
  }

  if (borrowedToken.isWeth === true) {
    const ethUsdPrice = Number(config.ethUsdPrice);
    if (!Number.isFinite(ethUsdPrice) || ethUsdPrice <= 0) return null;
    const WETH_PRICE_IN_USD = ethUsdPrice;
    const inTokenUnits = (Number(gasCostWei) / 1e18 / ethUsdPrice) * WETH_PRICE_IN_USD;
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

module.exports = {
  BPS_DENOMINATOR,
  GAS_COST_MARGIN_BPS,
  GAS_LIMIT_MARGIN_BPS,
  GAS_PROFIT_MULTIPLIER,
  WEI_PER_ETHER,
  buildFeeOverrides,
  gasCostInBorrowedToken,
  withSlippage,
};
