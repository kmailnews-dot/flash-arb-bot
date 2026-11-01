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
const {
  classifyError,
  shouldRetry,
  backoffMs,
  DEFAULT_MAX_ATTEMPTS,
} = require("./resilient");
const { createThrottle, withThrottle } = require("./throttle");
const { withTimeout } = require("./timeout");
const { FLASH_ARB_EXECUTOR_ABI } = require("./abis");
const { randomUUID } = require("crypto");
const {
  DEFAULT_EXECUTION_JOURNAL_PATH,
  DEFAULT_PNL_LOG_PATH,
  appendExecutionPnl,
  upsertExecutionRecord,
  deleteExecutionRecord,
  listPendingExecutions,
} = require("./persist");

// Codes ethers v6 correspondant à un rejet du nœud AVANT acceptation.
// Vérifiés dans node_modules/ethers@6.17.0 :
//   INSUFFICIENT_FUNDS      provider-jsonrpc.js:720-723
//   NONCE_EXPIRED           provider-jsonrpc.js:725-726
//   REPLACEMENT_UNDERPRICED provider-jsonrpc.js:729-730
//   INVALID_ARGUMENT        errors.js:168 (validation locale)
// Volontairement exclus :
//   ACTION_REJECTED         inatteignable (pas de wallet navigateur)
//   UNSUPPORTED_OPERATION   course provider détruit après _send (provider-jsonrpc.js:281-288)
const REJECTED_BEFORE_ACCEPTANCE = new Set([
  "INSUFFICIENT_FUNDS",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
  "INVALID_ARGUMENT",
]);

const WAIT_RECEIPT_TIMEOUT_MS = 120_000;
const DEX_KIND = { V2: 0, V3: 1 };

let executeThrottle = null;

function getExecuteThrottle(config = {}) {
  if (!executeThrottle) {
    executeThrottle = createThrottle({
      minIntervalMs: config.throttleMinIntervalMs,
      name: "execute",
    });
  }
  return executeThrottle;
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReceipt(tx) {
  let attempt = 0;
  for (;;) {
    try {
      return await tx.wait(1, WAIT_RECEIPT_TIMEOUT_MS);
    } catch (err) {
      if (err?.code === "TIMEOUT" && !err.receipt) {
        throw timeoutWaitReceiptError(tx.hash);
      }
      attempt += 1;
      if (
        classifyError(err) !== "TRANSIENT" ||
        !shouldRetry({ error: err, attempt, maxAttempts: DEFAULT_MAX_ATTEMPTS })
      ) {
        throw err;
      }
      await sleep(backoffMs({ attempt }));
    }
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

function extractArbitrageEvent(receipt) {
  if (!receipt || !Array.isArray(receipt.logs)) {
    return { realizedProfitWei: null, premiumWei: null };
  }
  const iface = new ethers.Interface(FLASH_ARB_EXECUTOR_ABI);
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog(log);
      if (parsed?.name === "ArbitrageExecuted") {
        return {
          realizedProfitWei: parsed.args.profit?.toString() ?? null,
          premiumWei: parsed.args.premium?.toString() ?? null,
        };
      }
    } catch {
      // log non reconnu, ignorer
    }
  }
  return { realizedProfitWei: null, premiumWei: null };
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
  const journalId = randomUUID();
  const journalPath = config.executionJournalPath || DEFAULT_EXECUTION_JOURNAL_PATH;
  const journalBase = {
    id: journalId,
    opportunityId: opportunity.opportunityId ?? null,
    pairLabel: pair.label ?? null,
    amountIn: amountIn.toString(),
    status: "SIGNED",
    txHash: null,
    nonce: null,
    reservedGasWei: decision.gasCostWei.toString(),
    submittedAt: Date.now(),
    lastUpdateAt: Date.now(),
    confirmedAt: null,
    receiptStatus: null,
    gasPaidWei: null,
    error: null,
  };

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
      const { result: intermediateOutFresh } = await withThrottle(getExecuteThrottle(config), () =>
        injectedQuoteLeg(provider, pair.legOut, pair.borrowedToken.address, amountIn)
      );
      const { result: finalOutFresh } = await withThrottle(getExecuteThrottle(config), () =>
        injectedQuoteLeg(provider, pair.legBack, pair.intermediateToken.address, intermediateOutFresh)
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
    minProfitBps: BigInt(Math.max(pair.minProfitBps ?? config.minProfitBps ?? 0, config.effectiveMinProfitBps ?? pair.minProfitBps ?? config.minProfitBps ?? 0)),
    deadline: Math.floor(Date.now() / 1000) + 300,
  };

  try {
    await withThrottle(getExecuteThrottle(config), () =>
      withTimeout(
        contract.startArbitrage.staticCall(pair.borrowedToken.address, amountIn, finalParams),
        config.rpcTimeoutMs ?? 30_000,
        "STATIC_CALL"
      )
    );
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
    // Réservation posée juste au-dessus : aucune tx n'a été envoyée, on la libère.
    await addGasSpentSafely(settings, -decision.gasCostWei);
    console.log(`  [CIRCUIT BREAKER] ${breakerBeforeSend.error} - transaction not sent.`);
    return { submitted: false, guard: "circuitBreaker", error: breakerBeforeSend.error };
  }

  const gasPriceWei = decision.gasPriceWei ?? decision.decisionGasPriceWei;
  const feeOverrides = decision.feeOverrides || {};
  const estimatedGas = decision.estimatedGas;
  const gasLimitWithMargin = decision.gasLimitWithMargin;

  await upsertExecutionRecord(journalBase, journalPath).catch((err) =>
    console.warn(`  [JOURNAL WARNING] SIGNED: ${err.message}`)
  );

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
      const journalStatus = err.receipt.status === 1 ? "CONFIRMED" : "REVERTED";
      await upsertExecutionRecord(
        {
          ...journalBase,
          status: journalStatus,
          confirmedAt: Date.now(),
          receiptStatus: err.receipt.status ?? null,
          gasPaidWei: actualGasCostWei.toString(),
          error: message,
          lastUpdateAt: Date.now(),
        },
        journalPath
      ).catch((journalErr) =>
        console.warn(`  [JOURNAL WARNING] ${journalStatus}: ${journalErr.message}`)
      );
      console.error(`  [FAILED] ${message}`);
      return { submitted: false, error: message, estimatedGas, journalId, journalStatus };
    }

    if (REJECTED_BEFORE_ACCEPTANCE.has(err?.code)) {
      // Rejet certain avant broadcast : libérer la réservation, ne pas toucher au breaker.
      await addGasSpentSafely(settings, -decision.gasCostWei);
      await deleteExecutionRecord(journalId, journalPath).catch((journalErr) =>
        console.warn(`  [JOURNAL WARNING] REJECTED: ${journalErr.message}`)
      );
      console.log(`  [SKIP FREE] broadcast rejected (${err.code}): ${message} - transaction not sent.`);
      return { submitted: false, error: message, estimatedGas, journalId, journalStatus: "REJECTED" };
    }

    await recordFailureSafely(settings);
    await upsertExecutionRecord(
      {
        ...journalBase,
        status: "UNKNOWN",
        error: message,
        lastUpdateAt: Date.now(),
      },
      journalPath
    ).catch((journalErr) => console.warn(`  [JOURNAL WARNING] UNKNOWN: ${journalErr.message}`));
    console.error(`  [FAILED] broadcast outcome unknown (tx may be mined): ${message}`);
    return { submitted: true, error: message, estimatedGas, journalId, journalStatus: "UNKNOWN" };
  }

  console.log(
    `  [SUBMITTED] tx ${tx.hash} (gas limit ${gasLimitWithMargin}, estimated ${estimatedGas})`
  );
  await upsertExecutionRecord(
    {
      ...journalBase,
      status: "SUBMITTED",
      txHash: tx.hash,
      nonce: typeof tx.nonce === "number" ? tx.nonce : null,
      lastUpdateAt: Date.now(),
    },
    journalPath
  ).catch((err) => console.warn(`  [JOURNAL WARNING] SUBMITTED: ${err.message}`));

  try {
    const receipt = await waitForReceipt(tx);
    const actualGasCostWei = receipt.gasUsed * (receipt.gasPrice ?? gasPriceWei);
    await addGasSpentSafely(settings, actualGasCostWei - decision.gasCostWei);

    if (receipt.status !== 1) {
      const message = `Transaction ${tx.hash} reverted on-chain (status ${receipt.status})`;
      await recordFailureSafely(settings);
      await upsertExecutionRecord(
        {
          ...journalBase,
          status: "REVERTED",
          txHash: tx.hash,
          nonce: typeof tx.nonce === "number" ? tx.nonce : null,
          confirmedAt: Date.now(),
          receiptStatus: receipt.status ?? null,
          gasPaidWei: actualGasCostWei.toString(),
          error: message,
          lastUpdateAt: Date.now(),
        },
        journalPath
      ).catch((journalErr) =>
        console.warn(`  [JOURNAL WARNING] REVERTED: ${journalErr.message}`)
      );
      const l1FeeWei =
        typeof receipt.l1Fee === "bigint" ? receipt.l1Fee.toString() : "0";
      await appendExecutionPnl(
        {
          timestamp: new Date().toISOString(),
          txHash: tx.hash,
          journalId,
          pairLabel: pair.label ?? null,
          realizedProfitWei: null,
          premiumWei: null,
          gasPaidWei: actualGasCostWei.toString(),
          l1FeeWei,
          status: "REVERTED",
        },
        config.executionPnlPath || DEFAULT_PNL_LOG_PATH
      ).catch((err) => console.warn(`  [PNL WARNING] ${err.message}`));
      console.error(`  [FAILED] ${message}`);
      return {
        submitted: true,
        error: message,
        estimatedGas,
        receipt,
        journalId,
        journalStatus: "REVERTED",
      };
    }

    await recordSuccessSafely(settings);
    await upsertExecutionRecord(
      {
        ...journalBase,
        status: "CONFIRMED",
        txHash: tx.hash,
        nonce: typeof tx.nonce === "number" ? tx.nonce : null,
        confirmedAt: Date.now(),
        receiptStatus: receipt.status,
        gasPaidWei: actualGasCostWei.toString(),
        lastUpdateAt: Date.now(),
      },
      journalPath
    ).catch((journalErr) =>
      console.warn(`  [JOURNAL WARNING] CONFIRMED: ${journalErr.message}`)
    );
    const eventData = extractArbitrageEvent(receipt);
    const l1FeeWei =
      typeof receipt.l1Fee === "bigint" ? receipt.l1Fee.toString() : "0";
    await appendExecutionPnl(
      {
        timestamp: new Date().toISOString(),
        txHash: tx.hash,
        journalId,
        pairLabel: pair.label ?? null,
        realizedProfitWei: eventData.realizedProfitWei,
        premiumWei: eventData.premiumWei,
        gasPaidWei: actualGasCostWei.toString(),
        l1FeeWei,
        status: "CONFIRMED",
      },
      config.executionPnlPath || DEFAULT_PNL_LOG_PATH
    ).catch((err) => console.warn(`  [PNL WARNING] ${err.message}`));
    console.log(`  [CONFIRMED] block ${receipt.blockNumber}, status success`);
    return {
      submitted: true,
      txHash: tx.hash,
      receipt,
      estimatedGas,
      journalId,
      journalStatus: "CONFIRMED",
    };
  } catch (err) {
    const message = err.shortMessage || err.message;
    if (err.receipt) {
      const actualGasCostWei = err.receipt.gasUsed * (err.receipt.gasPrice ?? gasPriceWei);
      await addGasSpentSafely(settings, actualGasCostWei - decision.gasCostWei);
      await recordFailureSafely(settings);
      const journalStatus = err.receipt.status === 1 ? "CONFIRMED" : "REVERTED";
      await upsertExecutionRecord(
        {
          ...journalBase,
          status: journalStatus,
          txHash: tx.hash,
          nonce: typeof tx.nonce === "number" ? tx.nonce : null,
          confirmedAt: Date.now(),
          receiptStatus: err.receipt.status ?? null,
          gasPaidWei: actualGasCostWei.toString(),
          error: message,
          lastUpdateAt: Date.now(),
        },
        journalPath
      ).catch((journalErr) =>
        console.warn(`  [JOURNAL WARNING] ${journalStatus}: ${journalErr.message}`)
      );
      console.error(`  [FAILED] ${message}`);
      return {
        submitted: true,
        error: message,
        estimatedGas,
        receipt: err.receipt,
        journalId,
        journalStatus,
      };
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

    if (lateReceipt) {
      const journalStatus = lateReceipt.status === 1 ? "CONFIRMED" : "REVERTED";
      await upsertExecutionRecord(
        {
          ...journalBase,
          status: journalStatus,
          txHash: tx.hash,
          nonce: typeof tx.nonce === "number" ? tx.nonce : null,
          confirmedAt: Date.now(),
          receiptStatus: lateReceipt.status ?? null,
          gasPaidWei: (
            lateReceipt.gasUsed * (lateReceipt.gasPrice ?? gasPriceWei)
          ).toString(),
          error: message,
          lastUpdateAt: Date.now(),
        },
        journalPath
      ).catch((journalErr) =>
        console.warn(`  [JOURNAL WARNING] ${journalStatus}: ${journalErr.message}`)
      );
      if (lateReceipt.status === 1) {
        const eventData = extractArbitrageEvent(lateReceipt);
        const l1FeeWei =
          typeof lateReceipt.l1Fee === "bigint" ? lateReceipt.l1Fee.toString() : "0";
        await appendExecutionPnl(
          {
            timestamp: new Date().toISOString(),
            txHash: tx.hash,
            journalId,
            pairLabel: pair.label ?? null,
            realizedProfitWei: eventData.realizedProfitWei,
            premiumWei: eventData.premiumWei,
            gasPaidWei: (
              lateReceipt.gasUsed * (lateReceipt.gasPrice ?? gasPriceWei)
            ).toString(),
            l1FeeWei,
            status: "CONFIRMED",
          },
          config.executionPnlPath || DEFAULT_PNL_LOG_PATH
        ).catch((err) => console.warn(`  [PNL WARNING] ${err.message}`));
      }
      console.error(`  [FAILED] confirmation outcome unknown (tx may be mined): ${message}`);
      return {
        submitted: true,
        error: message,
        estimatedGas,
        receipt: lateReceipt,
        journalId,
        journalStatus,
      };
    }

    await upsertExecutionRecord(
      {
        ...journalBase,
        status: "UNKNOWN",
        txHash: tx.hash,
        nonce: typeof tx.nonce === "number" ? tx.nonce : null,
        error: message,
        lastUpdateAt: Date.now(),
      },
      journalPath
    ).catch((journalErr) => console.warn(`  [JOURNAL WARNING] UNKNOWN: ${journalErr.message}`));

    console.error(`  [FAILED] confirmation outcome unknown (tx may be mined): ${message}`);
    return {
      submitted: true,
      error: message,
      estimatedGas,
      receipt: lateReceipt,
      journalId,
      journalStatus: "UNKNOWN",
    };
  }
}

async function reconcilePendingExecutions({ provider, config } = {}) {
  const filePath = config?.executionJournalPath || DEFAULT_EXECUTION_JOURNAL_PATH;
  const pendings = await listPendingExecutions(filePath);
  if (pendings.length === 0) return { reconciled: 0, skipped: 0 };
  let reconciled = 0;
  let skipped = 0;
  for (const record of pendings) {
    if (!record.txHash) {
      await upsertExecutionRecord(
        {
          ...record,
          status: "DROPPED",
          error: "recovered: crashed before submit",
          lastUpdateAt: Date.now(),
        },
        filePath
      ).catch((e) => console.warn(`  [RECONCILE WARNING] ${e.message}`));
      reconciled += 1;
      continue;
    }
    if (typeof provider.getTransactionReceipt !== "function") {
      skipped += 1;
      continue;
    }
    const receipt = await provider.getTransactionReceipt(record.txHash).catch(() => null);
    if (!receipt) {
      const age = Date.now() - (record.submittedAt ?? 0);
      if (age > 24 * 3600_000) {
        await upsertExecutionRecord(
          {
            ...record,
            status: "STALE",
            error: "recovered: no receipt after 24h",
            lastUpdateAt: Date.now(),
          },
          filePath
        ).catch((e) => console.warn(`  [RECONCILE WARNING] ${e.message}`));
        reconciled += 1;
      } else {
        skipped += 1;
      }
      continue;
    }
    await upsertExecutionRecord(
      {
        ...record,
        status: receipt.status === 1 ? "CONFIRMED" : "REVERTED",
        confirmedAt: Date.now(),
        receiptStatus: receipt.status,
        gasPaidWei: (receipt.gasUsed * (receipt.gasPrice ?? 0n)).toString(),
        lastUpdateAt: Date.now(),
      },
      filePath
    ).catch((e) => console.warn(`  [RECONCILE WARNING] ${e.message}`));
    reconciled += 1;
  }
  return { reconciled, skipped };
}

module.exports = { execute, buildLeg, errorMessage, reconcilePendingExecutions };
