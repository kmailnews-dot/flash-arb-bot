const { ethers } = require("ethers");
const { FLASH_ARB_EXECUTOR_ABI } = require("./abis");
const {
  DEFAULT_GAS_SPENT_PATH,
  DEFAULT_CIRCUIT_BREAKER_PATH,
  checkChainId,
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
const DEX_KIND = { V2: 0, V3: 1 };

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
async function maybeExecute({ opportunity, provider, config, contract: injectedContract }) {
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
    console.log(`  [GAS ESTIMATION FAILED] ${message} - transaction not sent.`);
    await recordFailureSafely(settings);
    return { submitted: false, simulated: false, error: message };
  }

  if (estimatedGas > config.maxGasLimit) {
    const message = `Estimated gas ${estimatedGas} exceeds MAX_GAS_LIMIT ${config.maxGasLimit}`;
    console.log(`  [SKIPPED] ${message} - transaction not sent.`);
    return { submitted: false, simulated: true, estimatedGas, error: message };
  }

  const feeData = await provider.getFeeData();
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPriceWei || gasPriceWei === 0n) {
    console.log("  [SKIPPED] gasPrice is 0 - transaction not sent.");
    return { submitted: false, error: "gasPrice is 0" };
  }

  const gasCostWei = estimatedGas * gasPriceWei;
  const gasCostInToken = gasCostInBorrowedToken({ gasCostWei, pair, config });
  if (gasCostInToken === null) {
    const token = pair.borrowedToken?.symbol ?? pair.borrowedToken?.address ?? "unknown";
    const message = `[SKIPPED] cannot price gas for token ${token} — enable ETH_USD_ROUTE_JSON`;
    console.log(`  ${message} - transaction not sent.`);
    return { submitted: false, simulated: true, estimatedGas, error: message };
  }

  const gasFloor = (gasCostInToken * GAS_COST_MARGIN_BPS) / BPS_DENOMINATOR;
  if (effectiveGrossProfit < gasFloor) {
    const message = `[SKIPPED] gas cost exceeds profit (gross=${effectiveGrossProfit}, gas=${gasCostInToken})`;
    console.log(`  ${message} - transaction not sent.`);
    return { submitted: false, simulated: true, estimatedGas, error: message };
  }

  const bufferedMinProfit = (effectiveGrossProfit * config.minProfitBufferBps) / BPS_DENOMINATOR;
  const finalMinProfit = bufferedMinProfit > gasFloor ? bufferedMinProfit : gasFloor;
  const finalParams = { ...params, minProfit: finalMinProfit };

  try {
    await contract.startArbitrage.staticCall(pair.borrowedToken.address, amountIn, finalParams);
  } catch (err) {
    const message = errorMessage(err);
    if (isNotProfitableError(err)) {
      console.log(`  [SKIPPED] ${message} - transaction not sent.`);
      return { submitted: false, simulated: false, error: message };
    }
    console.log(`  [SIMULATION FAILED] ${message} - transaction not sent.`);
    await recordFailureSafely(settings);
    return { submitted: false, simulated: false, error: message };
  }

  const dailyGas = await runGuard("daily gas", () =>
    checkDailyGas({
      filePath: settings.gasSpentPath,
      estimatedGasCostWei: gasCostWei,
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
    addGasSpent({ filePath: settings.gasSpentPath, deltaWei: gasCostWei })
  );
  if (!reserved.ok) {
    return { submitted: false, guard: "dailyGas", error: reserved.error };
  }

  let tx;
  try {
    tx = await contract.startArbitrage(pair.borrowedToken.address, amountIn, finalParams, { gasLimit: estimatedGas });
  } catch (err) {
    const message = errorMessage(err);
    await addGasSpentSafely(settings, -gasCostWei);
    await recordFailureSafely(settings);
    console.error(`  [FAILED] ${message}`);
    return { submitted: false, error: message, estimatedGas };
  }

  console.log(`  [SUBMITTED] tx ${tx.hash} (gas limit ${estimatedGas})`);
  try {
    const receipt = await tx.wait();
    const actualGasCostWei = receipt.gasUsed * (receipt.gasPrice ?? gasPriceWei);
    await addGasSpentSafely(settings, actualGasCostWei - gasCostWei);

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
      await addGasSpentSafely(settings, actualGasCostWei - gasCostWei);
    }
    await recordFailureSafely(settings);
    console.error(`  [FAILED] ${message}`);
    return { submitted: true, error: message, estimatedGas, receipt: err.receipt };
  }
}

module.exports = { maybeExecute, gasCostInBorrowedToken };
