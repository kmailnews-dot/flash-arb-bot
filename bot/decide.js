const { usdToTokenUnits } = require("./minProfitUsd");
const {
  buildFeeOverrides,
  gasCostInBorrowedToken,
  BPS_DENOMINATOR,
  GAS_COST_MARGIN_BPS,
  GAS_LIMIT_MARGIN_BPS,
  GAS_PROFIT_MULTIPLIER,
} = require("./pricing");

function buildDecision({
  shouldExecute,
  reason,
  opportunity,
  effectiveGrossProfit,
  gasCostInToken = null,
  gasFloor = null,
  netProfitFresh = null,
  netProfitUsd = null,
  netProfitBps = null,
  maxFeeCostInToken = null,
  decisionGasPriceWei,
  gasLimitWithMargin,
  gasCostWei,
  freshGrossProfit = null,
}) {
  return {
    shouldExecute,
    reason,
    opportunity,
    effectiveGrossProfit,
    gasCostInToken,
    gasFloor,
    netProfitFresh,
    netProfit: netProfitFresh,
    netProfitUsd,
    netProfitBps,
    maxFeeCostInToken,
    decisionGasPriceWei,
    gasLimitWithMargin,
    gasCostWei,
    freshGrossProfit,
  };
}

function decideInternal({ opportunity, config, feeData, estimatedGas }) {
  const { pair, amountIn, finalOut, grossProfit } = opportunity;
  const effectivePremiumBps =
    config.aaveFlashLoanPremiumBps === undefined ? null : BigInt(config.aaveFlashLoanPremiumBps);
  const effectivePremium =
    effectivePremiumBps === null ? null : (amountIn * effectivePremiumBps) / BPS_DENOMINATOR;
  const effectiveGrossProfit =
    effectivePremium === null ? grossProfit : finalOut - amountIn - effectivePremium;
  const freshGrossProfit = opportunity.grossProfitFresh ?? effectiveGrossProfit;
  const gasLimitWithMargin = (estimatedGas * GAS_LIMIT_MARGIN_BPS) / BPS_DENOMINATOR;
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;

  if (!gasPriceWei || gasPriceWei === 0n) {
    return buildDecision({
      shouldExecute: false,
      reason: "gasPrice is 0",
      opportunity,
      effectiveGrossProfit,
      decisionGasPriceWei: 0n,
      gasLimitWithMargin,
      gasCostWei: 0n,
      freshGrossProfit,
    });
  }

  const feeOverrides = buildFeeOverrides(feeData);
  const decisionGasPriceWei = feeOverrides.maxFeePerGas ?? feeOverrides.gasPrice ?? gasPriceWei;
  const gasCostWei = gasLimitWithMargin * decisionGasPriceWei;
  const gasCostInToken = gasCostInBorrowedToken({ gasCostWei, pair, config });

  if (gasCostInToken === null) {
    const token = pair.borrowedToken?.symbol ?? pair.borrowedToken?.address ?? "unknown";
    const minProfitUsdConfigured = config.minProfitUsd !== undefined && config.minProfitUsd !== null;
    const reason = minProfitUsdConfigured
      ? `cannot price MIN_PROFIT_USD for token ${token} (cannot price gas)`
      : `cannot price gas for token ${token} — enable ETH_USD_ROUTE_JSON`;
    return buildDecision({
      shouldExecute: false,
      reason,
      opportunity,
      effectiveGrossProfit,
      decisionGasPriceWei,
      gasLimitWithMargin,
      gasCostWei,
      freshGrossProfit,
    });
  }

  const gasFloor = (gasCostInToken * GAS_COST_MARGIN_BPS) / BPS_DENOMINATOR;
  if (effectiveGrossProfit < gasFloor) {
    return buildDecision({
      shouldExecute: false,
      reason: `gas cost exceeds profit (gross=${effectiveGrossProfit}, gas=${gasCostInToken})`,
      opportunity,
      effectiveGrossProfit,
      gasCostInToken,
      gasFloor,
      decisionGasPriceWei,
      gasLimitWithMargin,
      gasCostWei,
      freshGrossProfit,
    });
  }

  if (freshGrossProfit < gasFloor) {
    return buildDecision({
      shouldExecute: false,
      reason:
        `re-quote profit below gas floor ` +
        `(cached=${effectiveGrossProfit}, fresh=${freshGrossProfit})`,
      opportunity,
      effectiveGrossProfit,
      gasCostInToken,
      gasFloor,
      decisionGasPriceWei,
      gasLimitWithMargin,
      gasCostWei,
      freshGrossProfit,
    });
  }

  const netProfitFresh = freshGrossProfit - gasCostInToken;
  const netProfitBps = amountIn > 0n ? (netProfitFresh * BPS_DENOMINATOR) / amountIn : 0n;
  const minProfitUsdConfigured = config.minProfitUsd !== undefined && config.minProfitUsd !== null;
  const minProfitBpsConfigured = config.minProfitBps !== undefined && config.minProfitBps !== null;

  let tokenUsdPrice = null;
  if (minProfitUsdConfigured) {
    if (pair.borrowedToken?.isStable === true) {
      tokenUsdPrice = 1;
    } else if (
      pair.borrowedToken?.isWeth === true &&
      Number.isFinite(Number(config.ethUsdPrice)) &&
      Number(config.ethUsdPrice) > 0
    ) {
      tokenUsdPrice = Number(config.ethUsdPrice);
    } else {
      const token = pair.borrowedToken?.symbol ?? pair.borrowedToken?.address ?? "unknown";
      return buildDecision({
        shouldExecute: false,
        reason: `cannot price MIN_PROFIT_USD for token ${token}`,
        opportunity,
        effectiveGrossProfit,
        gasCostInToken,
        gasFloor,
        netProfitFresh,
        netProfitBps,
        decisionGasPriceWei,
        gasLimitWithMargin,
        gasCostWei,
        freshGrossProfit,
      });
    }
  }

  const netProfitUsd =
    tokenUsdPrice === null
      ? null
      : (Number(netProfitFresh) / 10 ** pair.borrowedToken.decimals) * tokenUsdPrice;

  if (minProfitUsdConfigured) {
    const gasCostUsd =
      tokenUsdPrice !== null
        ? (Number(gasCostInToken) / 10 ** pair.borrowedToken.decimals) * tokenUsdPrice
        : null;
    const effectiveMinProfitUsd =
      gasCostUsd !== null
        ? Math.max(Number(config.minProfitUsd), gasCostUsd * Number(GAS_PROFIT_MULTIPLIER))
        : Number(config.minProfitUsd);
    const minProfitUsdInToken = usdToTokenUnits({
      usdAmount: effectiveMinProfitUsd,
      tokenUsdPrice,
      decimals: pair.borrowedToken.decimals,
    });
    if (netProfitFresh < minProfitUsdInToken) {
      const bpsDetail = minProfitBpsConfigured
        ? `, netBps=${netProfitBps}, thresholdBps=${BigInt(config.minProfitBps)}`
        : "";
      return buildDecision({
        shouldExecute: false,
        reason:
          `fresh net profit below MIN_PROFIT_USD ` +
          `(net=${netProfitFresh}, threshold=${minProfitUsdInToken}${bpsDetail})`,
        opportunity,
        effectiveGrossProfit,
        gasCostInToken,
        gasFloor,
        netProfitFresh,
        netProfitUsd,
        netProfitBps,
        decisionGasPriceWei,
        gasLimitWithMargin,
        gasCostWei,
        freshGrossProfit,
      });
    }
  }

  if (minProfitBpsConfigured) {
    const minProfitBps = BigInt(config.minProfitBps);
    const meetsMinProfitBps =
      amountIn > 0n && netProfitFresh * BPS_DENOMINATOR >= amountIn * minProfitBps;
    if (!meetsMinProfitBps) {
      const usdDetail =
        minProfitUsdConfigured && netProfitUsd !== null
          ? `, netProfitUsd=${netProfitUsd}, minProfitUsd=${config.minProfitUsd}`
          : "";
      return buildDecision({
        shouldExecute: false,
        reason:
          `fresh net profit below MIN_PROFIT_BPS ` +
          `(net=${netProfitFresh}, notional=${amountIn}, netBps=${netProfitBps}, ` +
          `thresholdBps=${minProfitBps}${usdDetail})`,
        opportunity,
        effectiveGrossProfit,
        gasCostInToken,
        gasFloor,
        netProfitFresh,
        netProfitUsd,
        netProfitBps,
        decisionGasPriceWei,
        gasLimitWithMargin,
        gasCostWei,
        freshGrossProfit,
      });
    }
  }

  let maxFeeCostInToken = null;
  const maxFeePerGas = feeData.maxFeePerGas;
  if (maxFeePerGas && maxFeePerGas > 0n) {
    maxFeeCostInToken = gasCostInBorrowedToken({
      gasCostWei: maxFeePerGas * gasLimitWithMargin,
      pair,
      config,
    });
    if (maxFeeCostInToken !== null && maxFeeCostInToken > freshGrossProfit) {
      return buildDecision({
        shouldExecute: false,
        reason:
          `maxFeePerGas exceeds profit cap ` +
          `(maxFeePerGas=${maxFeePerGas}, profit=${freshGrossProfit}, gasLimit=${gasLimitWithMargin})`,
        opportunity,
        effectiveGrossProfit,
        gasCostInToken,
        gasFloor,
        netProfitFresh,
        netProfitUsd,
        netProfitBps,
        maxFeeCostInToken,
        decisionGasPriceWei,
        gasLimitWithMargin,
        gasCostWei,
        freshGrossProfit,
      });
    }
  }

  return buildDecision({
    shouldExecute: true,
    reason: "OK",
    opportunity,
    effectiveGrossProfit,
    gasCostInToken,
    gasFloor,
    netProfitFresh,
    netProfitUsd,
    netProfitBps,
    maxFeeCostInToken,
    decisionGasPriceWei,
    gasLimitWithMargin,
    gasCostWei,
    freshGrossProfit,
  });
}

function decide({ opportunity, config, feeData, estimatedGas }) {
  const decision = decideInternal({ opportunity, config, feeData, estimatedGas });
  return {
    ...decision,
    estimatedGas,
    gasPriceWei: feeData.gasPrice ?? feeData.maxFeePerGas,
    feeOverrides: buildFeeOverrides(feeData),
  };
}

module.exports = { decide };
