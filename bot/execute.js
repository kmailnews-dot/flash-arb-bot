const { ethers } = require("ethers");
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
const { quoteLeg } = require("./prices");
const { BPS_DENOMINATOR, withSlippage } = require("./pricing");

const WAIT_RECEIPT_TIMEOUT_MS = 120_000;
const DEX_KIND = { V2: 0, V3: 1 };

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

async function execute({
  opportunity,
  decision,
  provider,
  config,
  contract,
  quoteLeg: injectedQuoteLeg = quoteLeg,
  reQuoted,
}) {
  const { pair, amountIn } = opportunity;
  const settings = guardSettings(config);
  const wallet = new ethers.Wallet(config.privateKey, provider);

  let fresh = reQuoted;
  if (!fresh) {
    try {
      const effectivePremiumBps =
        config.aaveFlashLoanPremiumBps === undefined ? null : BigInt(config.aaveFlashLoanPremiumBps);
      const premiumFresh =
        effectivePremiumBps === null
          ? opportunity.finalOut - amountIn - opportunity.grossProfit
          : (amountIn * effectivePremiumBps) / BPS_DENOMINATOR;
      const owedFresh = amountIn + premiumFresh;
      const intermediateOutFresh = await injectedQuoteLeg(
        provider,
        pair.legOut,
        pair.borrowedToken.address,
        amountIn
      );
      const finalOutFresh = await injectedQuoteLeg(
        provider,
        pair.legBack,
        pair.intermediateToken.address,
        intermediateOutFresh
      );
      fresh = {
        intermediateOutFresh,
        finalOutFresh,
        grossProfitFresh: finalOutFresh - owedFresh,
        premiumFresh,
        owedFresh,
      };
    } catch (err) {
      const message = errorMessage(err);
      console.log(`  [SKIPPED] re-quote failed: ${message} - transaction not sent.`);
      return {
        submitted: false,
        simulated: false,
        error: `[SKIPPED] re-quote failed: ${message}`,
      };
    }
  }

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

  const bufferedMinProfit = (fresh.grossProfitFresh * config.minProfitBufferBps) / BPS_DENOMINATOR;
  const finalMinProfit =
    bufferedMinProfit > decision.gasFloor ? bufferedMinProfit : decision.gasFloor;
  const finalParams = {
    leg1: buildLeg(pair.legOut, fresh.intermediateOutFresh, config.slippageBps),
    leg2: buildLeg(pair.legBack, fresh.finalOutFresh, config.slippageBps),
    minProfit: finalMinProfit,
    deadline: Math.floor(Date.now() / 1000) + 300,
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
      estimatedGasCostWei: decision.gasCostWei,
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
    addGasSpent({ filePath: settings.gasSpentPath, deltaWei: decision.gasCostWei })
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

  const gasPriceWei = decision.gasPriceWei ?? decision.decisionGasPriceWei;
  const feeOverrides = decision.feeOverrides || {};
  const estimatedGas = decision.estimatedGas;
  const gasLimitWithMargin = decision.gasLimitWithMargin;

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
      await addGasSpentSafely(settings, actualGasCostWei - decision.gasCostWei);
      await recordFailureSafely(settings);
      console.error(`  [FAILED] ${message}`);
      return { submitted: false, error: message, estimatedGas };
    }

    await recordFailureSafely(settings);
    console.error(`  [FAILED] broadcast outcome unknown (tx may be mined): ${message}`);
    return { submitted: true, error: message, estimatedGas };
  }

  console.log(
    `  [SUBMITTED] tx ${tx.hash} (gas limit ${gasLimitWithMargin}, estimated ${estimatedGas})`
  );
  try {
    const receipt = await waitForReceipt(tx);
    const actualGasCostWei = receipt.gasUsed * (receipt.gasPrice ?? gasPriceWei);
    await addGasSpentSafely(settings, actualGasCostWei - decision.gasCostWei);

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
      await addGasSpentSafely(settings, actualGasCostWei - decision.gasCostWei);
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
        await addGasSpentSafely(settings, actualGasCostWei - decision.gasCostWei);
      }
    }

    console.error(`  [FAILED] confirmation outcome unknown (tx may be mined): ${message}`);
    return { submitted: true, error: message, estimatedGas, receipt: lateReceipt };
  }
}

module.exports = { execute, buildLeg, errorMessage };
