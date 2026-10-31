const { ethers } = require("ethers");
const { FLASH_ARB_EXECUTOR_ABI } = require("./abis");
const { quoteLeg } = require("./prices");
const {
  BPS_DENOMINATOR,
  GAS_COST_MARGIN_BPS,
  GAS_LIMIT_MARGIN_BPS,
  gasCostInBorrowedToken,
  buildFeeOverrides,
} = require("./pricing");
const { execute, buildLeg, errorMessage } = require("./execute");
const { decide } = require("./decide");
const { createThrottle, withThrottle } = require("./throttle");
const { withTimeout } = require("./timeout");

let txInFlight = false;
let txInFlightSince = null;
let executorThrottle = null;

function getExecutorThrottle(config = {}) {
  if (!executorThrottle) {
    executorThrottle = createThrottle({
      minIntervalMs: config.throttleMinIntervalMs,
      name: "executor",
    });
  }
  return executorThrottle;
}

/// Either logs the opportunity (DRY_RUN, the default) or submits the flash-loan transaction
/// against the deployed FlashArbExecutor contract. Never throws for an execution failure - a
/// reverted/failed live trade is caught, logged, and the scan loop continues to the next pair.
async function maybeExecute({
  opportunity,
  provider,
  config,
  contract: injectedContract,
  quoteLeg: injectedQuoteLeg = quoteLeg,
}) {
  if (txInFlight) {
    const maxMs = config.txInFlightMaxMs ?? 180_000;
    const elapsed = txInFlightSince === null ? 0 : Date.now() - txInFlightSince;
    if (elapsed > maxMs) {
      console.log(
        `  [STUCK] txInFlight stuck for ${elapsed}ms - manual reconciliation required.`
      );
      return {
        submitted: false,
        error: "TRANSACTION_IN_FLIGHT_STALE",
        stale: true,
        elapsedMs: elapsed,
      };
    }
    return { submitted: false, error: "TRANSACTION_IN_FLIGHT" };
  }

  txInFlight = true;
  txInFlightSince = Date.now();
  try {
    // Le breaker compte les échecs coûteux (reverts on-chain) et les issues ambiguës après
    // acceptation (envoi sans receipt, timeout de confirmation). Les échecs avant acceptation
    // (estimateGas, staticCall, validation) restent gratuits.
    const { pair, amountIn, intermediateOut, finalOut, grossProfit } = opportunity;
    const effectivePremiumBps =
      config.aaveFlashLoanPremiumBps === undefined ? null : BigInt(config.aaveFlashLoanPremiumBps);
    const effectivePremium =
      effectivePremiumBps === null ? null : (amountIn * effectivePremiumBps) / BPS_DENOMINATOR;
    const effectiveGrossProfit =
      effectivePremium === null ? grossProfit : finalOut - amountIn - effectivePremium;

    if (effectiveGrossProfit !== grossProfit) {
      console.log(
        `  [PREMIUM] Aave premium ${effectivePremiumBps} bps -> expected gross profit ` +
          `${ethers.formatUnits(effectiveGrossProfit, pair.borrowedToken.decimals)} ${pair.borrowedToken.symbol} ` +
          `(scan used ${ethers.formatUnits(grossProfit, pair.borrowedToken.decimals)})`
      );
    }

    if (config.dryRun) {
      console.log(
        `  [SIMULATED] would flash-borrow ${ethers.formatUnits(amountIn, pair.borrowedToken.decimals)} ` +
          `${pair.borrowedToken.symbol}, expected profit ` +
          `${ethers.formatUnits(effectiveGrossProfit, pair.borrowedToken.decimals)} ${pair.borrowedToken.symbol}` +
          (opportunity.netProfitUsd !== null ? ` (~$${opportunity.netProfitUsd.toFixed(2)} net of gas)` : "")
      );
      return { submitted: false };
    }

    if (!config.privateKey || !config.contractAddress) {
      console.log("  [SKIPPED] DRY_RUN=false but PRIVATE_KEY or CONTRACT_ADDRESS is not set - not submitting.");
      return { submitted: false };
    }

    const wallet = new ethers.Wallet(config.privateKey, provider);
    const contract =
      injectedContract || new ethers.Contract(config.contractAddress, FLASH_ARB_EXECUTOR_ABI, wallet);

    const params = {
      leg1: buildLeg(pair.legOut, intermediateOut, config.slippageBps),
      leg2: buildLeg(pair.legBack, finalOut, config.slippageBps),
      // Require the on-chain execution to still clear at least half of the off-chain estimate,
      // so a price move between quoting and mining reverts the whole (borrowed-capital) trade
      // instead of executing at a worse-than-expected profit.
      minProfit: (effectiveGrossProfit * config.minProfitBufferBps) / BPS_DENOMINATOR,
      minProfitBps: BigInt(config.minProfitBps ?? 0),
      deadline: Math.floor(Date.now() / 1000) + 300,
    };

    let estimatedGas;
    try {
      estimatedGas = (
        await withThrottle(getExecutorThrottle(config), () =>
          withTimeout(
            contract.startArbitrage.estimateGas(pair.borrowedToken.address, amountIn, params),
            config.rpcTimeoutMs ?? 30_000,
            "ESTIMATE_GAS"
          )
        )
      ).result;
    } catch (err) {
      const message = errorMessage(err);
      console.log(`  [SKIP FREE] gas estimation failed: ${message} - transaction not sent.`);
      return { submitted: false, simulated: false, error: message };
    }

    if (estimatedGas > config.maxGasLimit) {
      const message = `Estimated gas ${estimatedGas} exceeds MAX_GAS_LIMIT ${config.maxGasLimit}`;
      console.log(`  [SKIPPED] ${message} - transaction not sent.`);
      return { submitted: false, simulated: true, estimatedGas, error: message };
    }

    const gasLimitWithMargin = (estimatedGas * GAS_LIMIT_MARGIN_BPS) / BPS_DENOMINATOR;
    if (gasLimitWithMargin > config.maxGasLimit) {
      const message =
        `Estimated gas ${estimatedGas} with margin (${gasLimitWithMargin}) exceeds ` +
        `MAX_GAS_LIMIT ${config.maxGasLimit}`;
      console.log(`  [SKIPPED] ${message} - transaction not sent.`);
      return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
    }

    let feeData;
    try {
      feeData = (
        await withThrottle(getExecutorThrottle(config), () =>
          withTimeout(provider.getFeeData(), config.rpcTimeoutMs ?? 30_000, "FEE_DATA")
        )
      ).result;
    } catch (err) {
      const message = errorMessage(err);
      console.log(`  [SKIP FREE] getFeeData failed: ${message} - transaction not sent.`);
      return { submitted: false, simulated: false, error: message };
    }

    let intermediateOutFresh;
    let finalOutFresh;
    let grossProfitFresh;
    let premiumFresh;
    let owedFresh;
    try {
      intermediateOutFresh = await withTimeout(
        injectedQuoteLeg(provider, pair.legOut, pair.borrowedToken.address, amountIn),
        config.rpcTimeoutMs ?? 30_000,
        "REQUOTE_LEG1"
      );
      finalOutFresh = await withTimeout(
        injectedQuoteLeg(
          provider,
          pair.legBack,
          pair.intermediateToken.address,
          intermediateOutFresh
        ),
        config.rpcTimeoutMs ?? 30_000,
        "REQUOTE_LEG2"
      );
      premiumFresh =
        effectivePremiumBps === null
          ? finalOut - amountIn - grossProfit
          : (amountIn * effectivePremiumBps) / BPS_DENOMINATOR;
      owedFresh = amountIn + premiumFresh;
      grossProfitFresh = finalOutFresh - owedFresh;
    } catch (err) {
      const cachedDecision = decide({ opportunity, config, feeData, estimatedGas });
      if (!cachedDecision.shouldExecute) {
        console.log(`  [SKIPPED] ${cachedDecision.reason} - transaction not sent.`);
        return {
          submitted: false,
          simulated: true,
          estimatedGas,
          gasLimitWithMargin,
          error: `[SKIPPED] ${cachedDecision.reason}`,
        };
      }
      const message = errorMessage(err);
      console.log(`  [SKIPPED] re-quote failed: ${message} - transaction not sent.`);
      return {
        submitted: false,
        simulated: false,
        estimatedGas,
        gasLimitWithMargin,
        error: `[SKIPPED] re-quote failed: ${message}`,
      };
    }

    const decision = decide({
      opportunity: { ...opportunity, grossProfitFresh },
      config,
      feeData,
      estimatedGas,
    });

    if (!decision.shouldExecute) {
      console.log(`  [SKIPPED] ${decision.reason} - transaction not sent.`);
      return {
        submitted: false,
        simulated: true,
        estimatedGas,
        gasLimitWithMargin,
        error: `[SKIPPED] ${decision.reason}`,
      };
    }

    return await execute({
      opportunity,
      decision,
      provider,
      config,
      contract,
      quoteLeg: injectedQuoteLeg,
      reQuoted: { intermediateOutFresh, finalOutFresh, grossProfitFresh, premiumFresh, owedFresh },
    });
  } finally {
    txInFlight = false;
    txInFlightSince = null;
  }
}

module.exports = {
  maybeExecute,
  gasCostInBorrowedToken,
  buildFeeOverrides,
  BPS_DENOMINATOR,
  GAS_COST_MARGIN_BPS,
  GAS_LIMIT_MARGIN_BPS,
};
