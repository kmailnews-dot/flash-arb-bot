const { ethers } = require("ethers");
const { FLASH_ARB_EXECUTOR_ABI } = require("./abis");
const { usdToTokenUnits } = require("./minProfitUsd");
const { quoteLeg } = require("./prices");
const {
  DEFAULT_GAS_SPENT_PATH,
  DEFAULT_CIRCUIT_BREAKER_PATH,
  checkChainId,
  checkContractOwner,
  checkWalletBalance,
  checkDailyGas,
  addGasSpent,
  checkCircuitBreaker,
  recordSuccess,
  recordFailure,
} = require("./guards");

const BPS_DENOMINATOR = 10000n;
const WEI_PER_ETHER = 10n ** 18n;
const GAS_COST_MARGIN_BPS = 11000n;
const GAS_LIMIT_MARGIN_BPS = 11500n;
const WAIT_RECEIPT_TIMEOUT_MS = 120_000;
const DEX_KIND = { V2: 0, V3: 1 };
let txInFlight = false;

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

function buildLeg(leg, quotedOut, slippageBps) {
  return {
    kind: DEX_KIND[leg.kind],
    router: leg.router,
    tokenOut: leg.tokenOut,
    v3Fee: leg.v3Fee || 0,
    minAmountOut: withSlippage(quotedOut, slippageBps),
  };
}

function guardSettings(config) {
  return {
    expectedChainId: config.expectedChainId ?? 42161,
    maxWalletBalanceEth: config.maxWalletBalanceEth ?? 0.1,
    maxDailyGasEth: config.maxDailyGasEth ?? 0.01,
    maxConsecutiveFailures: config.maxConsecutiveFailures ?? 5,
    circuitBreakerCooldownMinutes: config.circuitBreakerCooldownMinutes ?? 60,
    gasSpentPath: config.gasSpentPath || DEFAULT_GAS_SPENT_PATH,
    circuitBreakerPath: config.circuitBreakerPath || DEFAULT_CIRCUIT_BREAKER_PATH,
  };
}

/// Runs a guard and turns an unexpected read/write failure into a fail-closed result: if we cannot
/// prove the trade is allowed, we do not send it.
async function runGuard(label, check) {
  try {
    return await check();
  } catch (err) {
    const message = `GUARD_ERROR (${label}): ${err.shortMessage || err.message}`;
    console.error(`  [GUARD ERROR] ${message} - transaction not sent.`);
    return { ok: false, error: message };
  }
}

async function recordFailureSafely(settings) {
  try {
    const state = await recordFailure({
      filePath: settings.circuitBreakerPath,
      maxConsecutiveFailures: settings.maxConsecutiveFailures,
      cooldownMinutes: settings.circuitBreakerCooldownMinutes,
    });
    if (state.opened) {
      console.warn(
        `  [CIRCUIT BREAKER] ${state.consecutiveFailures} consecutive failures - ` +
          `live attempts paused until ${new Date(state.openUntil).toISOString()}.`
      );
    }
  } catch (err) {
    console.warn(`  [GUARD WARNING] could not persist failure state: ${err.message}`);
  }
}

async function recordSuccessSafely(settings) {
  try {
    await recordSuccess({ filePath: settings.circuitBreakerPath });
  } catch (err) {
    console.warn(`  [GUARD WARNING] could not persist success state: ${err.message}`);
  }
}

async function addGasSpentSafely(settings, deltaWei) {
  try {
    return await addGasSpent({ filePath: settings.gasSpentPath, deltaWei });
  } catch (err) {
    console.warn(`  [GUARD WARNING] could not persist gas spend: ${err.message}`);
    return null;
  }
}

function errorMessage(err) {
  return err?.shortMessage || err?.message || String(err);
}

function timeoutWaitReceiptError(txHash) {
  const err = new Error(
    `TIMEOUT_WAIT_RECEIPT: no receipt for ${txHash} after ${WAIT_RECEIPT_TIMEOUT_MS}ms`
  );
  err.name = "TimeoutWaitReceiptError";
  err.code = "TIMEOUT_WAIT_RECEIPT";
  err.txHash = txHash;
  return err;
}

async function waitForReceipt(tx) {
  try {
    return await tx.wait(1, WAIT_RECEIPT_TIMEOUT_MS);
  } catch (err) {
    if (err?.code === "TIMEOUT" && !err.receipt) {
      throw timeoutWaitReceiptError(tx.hash);
    }
    throw err;
  }
}

function isNotProfitableError(err) {
  if (typeof err === "string") return err.includes("NOT_PROFITABLE");
  const seen = new Set();
  let current = err;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = [current.shortMessage, current.message, current.reason, current.info?.error?.message]
      .filter(Boolean)
      .join(" ");
    if (text.includes("NOT_PROFITABLE")) return true;
    current = current.error || current.cause || current.info?.error;
  }
  return false;
}

/// Either logs the opportunity (DRY_RUN, the default) or submits the flash-loan transaction
/// against the deployed FlashArbExecutor contract. Never throws for an execution failure - a
/// reverted/failed live trade is caught, logged, and the scan loop continues to the next pair.
async function maybeExecute(options) {
  if (txInFlight) {
    return { submitted: false, error: "TRANSACTION_IN_FLIGHT" };
  }

  txInFlight = true;
  try {
    return await executeMaybe(options);
  } finally {
    txInFlight = false;
  }
}

async function executeMaybe({
  opportunity,
  provider,
  config,
  contract: injectedContract,
  quoteLeg: injectedQuoteLeg = quoteLeg,
}) {
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

  const settings = guardSettings(config);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const contract =
    injectedContract || new ethers.Contract(config.contractAddress, FLASH_ARB_EXECUTOR_ABI, wallet);

  const ownerCheck =
    typeof contract.owner === "function"
      ? await runGuard("contract owner", () =>
          checkContractOwner({ contract, walletAddress: wallet.address })
        )
      : { ok: true };
  if (!ownerCheck.ok) {
    console.log(`  [OWNER GUARD] ${ownerCheck.error} - transaction not sent.`);
    return { submitted: false, guard: "contractOwner", error: ownerCheck.error };
  }

  const breaker = await runGuard("circuit breaker", () =>
    checkCircuitBreaker({ filePath: settings.circuitBreakerPath })
  );
  if (!breaker.ok) {
    console.log(`  [CIRCUIT BREAKER] ${breaker.error} - transaction not sent.`);
    return { submitted: false, guard: "circuitBreaker", error: breaker.error };
  }

  const chain = await runGuard("chainId", () =>
    checkChainId({ provider, expectedChainId: settings.expectedChainId })
  );
  if (!chain.ok) {
    console.log(`  [CHAIN GUARD] ${chain.error} - transaction not sent.`);
    return { submitted: false, guard: "chainId", error: chain.error };
  }

  const balance = await runGuard("wallet balance", () =>
    checkWalletBalance({
      provider,
      address: wallet.address,
      maxWalletBalanceEth: settings.maxWalletBalanceEth,
    })
  );
  if (!balance.ok) {
    console.log(`  [BALANCE GUARD] ${balance.error} - transaction not sent.`);
    return { submitted: false, guard: "walletBalance", error: balance.error };
  }

  const params = {
    leg1: buildLeg(pair.legOut, intermediateOut, config.slippageBps),
    leg2: buildLeg(pair.legBack, finalOut, config.slippageBps),
    // Require the on-chain execution to still clear at least half of the off-chain estimate,
    // so a price move between quoting and mining reverts the whole (borrowed-capital) trade
    // instead of executing at a worse-than-expected profit.
    minProfit: (effectiveGrossProfit * config.minProfitBufferBps) / BPS_DENOMINATOR,
    deadline: Math.floor(Date.now() / 1000) + 300,
  };

  let estimatedGas;
  try {
    estimatedGas = await contract.startArbitrage.estimateGas(pair.borrowedToken.address, amountIn, params);
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

  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPriceWei || gasPriceWei === 0n) {
    console.log("  [SKIPPED] gasPrice is 0 - transaction not sent.");
    return { submitted: false, error: "gasPrice is 0" };
  }

  const feeOverrides = buildFeeOverrides(feeData);
  const reservationGasPriceWei = feeOverrides.maxFeePerGas ?? feeOverrides.gasPrice ?? gasPriceWei;
  const decisionGasPriceWei = reservationGasPriceWei;
  const gasCostWei = gasLimitWithMargin * decisionGasPriceWei;
  const gasCostInToken = gasCostInBorrowedToken({ gasCostWei, pair, config });
  if (gasCostInToken === null) {
    const token = pair.borrowedToken?.symbol ?? pair.borrowedToken?.address ?? "unknown";
    const message =
      config.minProfitUsd === undefined || config.minProfitUsd === null
        ? `[SKIPPED] cannot price gas for token ${token} — enable ETH_USD_ROUTE_JSON`
        : `[SKIPPED] cannot price MIN_PROFIT_USD for token ${token}`;
    console.log(`  ${message} - transaction not sent.`);
    return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
  }

  const gasFloor = (gasCostInToken * GAS_COST_MARGIN_BPS) / BPS_DENOMINATOR;
  if (effectiveGrossProfit < gasFloor) {
    const message = `[SKIPPED] gas cost exceeds profit (gross=${effectiveGrossProfit}, gas=${gasCostInToken})`;
    console.log(`  ${message} - transaction not sent.`);
    return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
  }

  let intermediateOutFresh;
  let finalOutFresh;
  let grossProfitFresh;
  try {
    intermediateOutFresh = await injectedQuoteLeg(
      provider,
      pair.legOut,
      pair.borrowedToken.address,
      amountIn
    );
    finalOutFresh = await injectedQuoteLeg(
      provider,
      pair.legBack,
      pair.intermediateToken.address,
      intermediateOutFresh
    );
    const premiumFresh =
      effectivePremiumBps === null
        ? finalOut - amountIn - grossProfit
        : (amountIn * effectivePremiumBps) / BPS_DENOMINATOR;
    const owedFresh = amountIn + premiumFresh;
    grossProfitFresh = finalOutFresh - owedFresh;
  } catch (err) {
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

  if (grossProfitFresh < gasFloor) {
    const message =
      `[SKIPPED] re-quote profit below gas floor ` +
      `(cached=${effectiveGrossProfit}, fresh=${grossProfitFresh})`;
    console.log(`  ${message} - transaction not sent.`);
    return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
  }

  if (config.minProfitUsd !== undefined && config.minProfitUsd !== null) {
    const gasCostFreshInToken = gasCostInBorrowedToken({ gasCostWei, pair, config });
    const token = pair.borrowedToken?.symbol ?? pair.borrowedToken?.address ?? "unknown";
    if (gasCostFreshInToken === null) {
      const message = `[SKIPPED] cannot price MIN_PROFIT_USD for token ${token}`;
      console.log(`  ${message} - transaction not sent.`);
      return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
    }

    let tokenUsdPrice;
    if (pair.borrowedToken?.isStable === true) {
      tokenUsdPrice = 1;
    } else if (
      pair.borrowedToken?.isWeth === true &&
      Number.isFinite(Number(config.ethUsdPrice)) &&
      Number(config.ethUsdPrice) > 0
    ) {
      tokenUsdPrice = Number(config.ethUsdPrice);
    } else {
      const message = `[SKIPPED] cannot price MIN_PROFIT_USD for token ${token}`;
      console.log(`  ${message} - transaction not sent.`);
      return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
    }

    const netProfitFresh = grossProfitFresh - gasCostFreshInToken;
    const minProfitUsdInToken = usdToTokenUnits({
      usdAmount: config.minProfitUsd,
      tokenUsdPrice,
      decimals: pair.borrowedToken.decimals,
    });
    if (netProfitFresh < minProfitUsdInToken) {
      const message =
        `[SKIPPED] fresh net profit below MIN_PROFIT_USD ` +
        `(net=${netProfitFresh}, threshold=${minProfitUsdInToken})`;
      console.log(`  ${message} - transaction not sent.`);
      return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
    }
  }

  const maxFeePerGas = feeData.maxFeePerGas;
  if (maxFeePerGas && maxFeePerGas > 0n) {
    const maxFeeCostInToken = gasCostInBorrowedToken({
      gasCostWei: maxFeePerGas * gasLimitWithMargin,
      pair,
      config,
    });
    if (maxFeeCostInToken !== null && maxFeeCostInToken > grossProfitFresh) {
      const message =
        `[SKIPPED] maxFeePerGas exceeds profit cap ` +
        `(maxFeePerGas=${maxFeePerGas}, profit=${grossProfitFresh}, gasLimit=${gasLimitWithMargin})`;
      console.log(`  ${message} - transaction not sent.`);
      return { submitted: false, simulated: true, estimatedGas, gasLimitWithMargin, error: message };
    }
  }

  const reservationGasCostWei = gasCostWei;

  const bufferedMinProfit = (grossProfitFresh * config.minProfitBufferBps) / BPS_DENOMINATOR;
  const finalMinProfit = bufferedMinProfit > gasFloor ? bufferedMinProfit : gasFloor;
  const finalParams = {
    ...params,
    leg1: buildLeg(pair.legOut, intermediateOutFresh, config.slippageBps),
    leg2: buildLeg(pair.legBack, finalOutFresh, config.slippageBps),
    minProfit: finalMinProfit,
  };

  try {
    await contract.startArbitrage.staticCall(pair.borrowedToken.address, amountIn, finalParams);
  } catch (err) {
    const message = errorMessage(err);
    const reason = isNotProfitableError(err) ? "NOT_PROFITABLE" : "simulation failed";
    console.log(`  [SKIP FREE] ${reason}: ${message} - transaction not sent.`);
    return { submitted: false, simulated: false, error: message };
  }

  const dailyGas = await runGuard("daily gas", () =>
    checkDailyGas({
      filePath: settings.gasSpentPath,
      estimatedGasCostWei: reservationGasCostWei,
      maxDailyGasEth: settings.maxDailyGasEth,
    })
  );
  if (!dailyGas.ok) {
    console.log(`  [GAS GUARD] ${dailyGas.error} - transaction not sent.`);
    return { submitted: false, guard: "dailyGas", error: dailyGas.error };
  }

  // Reserve the estimated cost before broadcasting, so a crash after submission still counts
  // against today's budget. It is reconciled to the actual receipt cost below.
  const reserved = await runGuard("gas reservation", () =>
    addGasSpent({ filePath: settings.gasSpentPath, deltaWei: reservationGasCostWei })
  );
  if (!reserved.ok) {
    return { submitted: false, guard: "dailyGas", error: reserved.error };
  }

  const breakerBeforeSend = await runGuard("circuit breaker", () =>
    checkCircuitBreaker({ filePath: settings.circuitBreakerPath })
  );
  if (!breakerBeforeSend.ok) {
    console.log(`  [CIRCUIT BREAKER] ${breakerBeforeSend.error} - transaction not sent.`);
    return { submitted: false, guard: "circuitBreaker", error: breakerBeforeSend.error };
  }

  let tx;
  try {
    tx = await contract.startArbitrage(pair.borrowedToken.address, amountIn, finalParams, {
      gasLimit: gasLimitWithMargin,
      ...feeOverrides,
    });
  } catch (err) {
    const message = errorMessage(err);
    if (err.receipt) {
      const actualGasCostWei = err.receipt.gasUsed * (err.receipt.gasPrice ?? gasPriceWei);
      await addGasSpentSafely(settings, actualGasCostWei - reservationGasCostWei);
      await recordFailureSafely(settings);
      console.error(`  [FAILED] ${message}`);
      return { submitted: false, error: message, estimatedGas };
    }

    await recordFailureSafely(settings);
    console.error(`  [FAILED] broadcast outcome unknown (tx may be mined): ${message}`);
    return { submitted: true, error: message, estimatedGas };
  }

  console.log(`  [SUBMITTED] tx ${tx.hash} (gas limit ${gasLimitWithMargin}, estimated ${estimatedGas})`);
  try {
    const receipt = await waitForReceipt(tx);
    const actualGasCostWei = receipt.gasUsed * (receipt.gasPrice ?? gasPriceWei);
    await addGasSpentSafely(settings, actualGasCostWei - reservationGasCostWei);

    if (receipt.status !== 1) {
      const message = `Transaction ${tx.hash} reverted on-chain (status ${receipt.status})`;
      await recordFailureSafely(settings);
      console.error(`  [FAILED] ${message}`);
      return { submitted: true, error: message, estimatedGas, receipt };
    }

    await recordSuccessSafely(settings);
    console.log(`  [CONFIRMED] block ${receipt.blockNumber}, status success`);
    return { submitted: true, txHash: tx.hash, receipt, estimatedGas };
  } catch (err) {
    const message = err.shortMessage || err.message;
    if (err.receipt) {
      const actualGasCostWei = err.receipt.gasUsed * (err.receipt.gasPrice ?? gasPriceWei);
      await addGasSpentSafely(settings, actualGasCostWei - reservationGasCostWei);
      await recordFailureSafely(settings);
      console.error(`  [FAILED] ${message}`);
      return { submitted: true, error: message, estimatedGas, receipt: err.receipt };
    }

    await recordFailureSafely(settings);

    let lateReceipt = null;
    if (typeof provider.getTransactionReceipt === "function") {
      lateReceipt = await provider.getTransactionReceipt(tx.hash).catch(() => null);
      if (lateReceipt) {
        const actualGasCostWei = lateReceipt.gasUsed * (lateReceipt.gasPrice ?? gasPriceWei);
        await addGasSpentSafely(settings, actualGasCostWei - reservationGasCostWei);
      }
    }

    console.error(`  [FAILED] confirmation outcome unknown (tx may be mined): ${message}`);
    return { submitted: true, error: message, estimatedGas, receipt: lateReceipt };
  }
}

module.exports = { maybeExecute, gasCostInBorrowedToken, buildFeeOverrides };
