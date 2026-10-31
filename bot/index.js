const { ethers } = require("ethers");
const { getEthUsdPrice, scanPair } = require("./scanner");
const { maybeExecute } = require("./executor");
const { DEFAULT_SCAN_LOG_PATH, appendScanResult, logEvent, logFormat } = require("./persist");
const { NETWORKS } = require("./networks");
const { checkWalletBalanceLow } = require("./guards");
const {
  DEFAULT_ADAPTIVE_PATH,
  applyAdaptive,
  loadAdaptive,
  recordOutcome,
} = require("./adaptive");
const { createThrottle, withThrottle } = require("./throttle");

const AAVE_POOL_PREMIUM_ABI = ["function FLASHLOAN_PREMIUM_TOTAL() view returns (uint128)"];

let mainThrottle = null;

function getMainThrottle(config = {}) {
  if (!mainThrottle) {
    mainThrottle = createThrottle({
      minIntervalMs: config.throttleMinIntervalMs,
      name: "main",
    });
  }
  return mainThrottle;
}

async function persistResultSafely(logPath, result, chainId) {
  try {
    await appendScanResult(logPath, result, { chainId });
  } catch (err) {
    console.warn(`WARNING: could not persist scan result to ${logPath}: ${err.message}`);
  }
}

function describeError(error) {
  if (!error) return { code: null, shortMessage: "unknown error" };
  if (typeof error === "string") return { code: null, shortMessage: error };
  return {
    code: error.code ?? null,
    shortMessage: error.shortMessage ?? error.code ?? "unknown error",
  };
}

function hasNetProfit(result) {
  return typeof result.netProfitUsd === "number" && Number.isFinite(result.netProfitUsd);
}

function compareResults(a, b) {
  if (a.error && !b.error) return 1;
  if (!a.error && b.error) return -1;
  if (a.error && b.error) return 0;

  if (hasNetProfit(a) && hasNetProfit(b)) return b.netProfitUsd - a.netProfitUsd;
  if (a.grossProfit > b.grossProfit) return -1;
  if (a.grossProfit < b.grossProfit) return 1;
  return 0;
}

function selectBestResult(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  return [...results].sort(compareResults)[0];
}

async function readAaveFlashLoanPremium({ provider, chainId, config }) {
  const network = NETWORKS[chainId];
  if (!network) return config.aaveFlashLoanPremiumBps;

  try {
    const pool = new ethers.Contract(network.pool, AAVE_POOL_PREMIUM_ABI, provider);
    const onChainPremiumBps = BigInt(await pool.FLASHLOAN_PREMIUM_TOTAL());
    const configuredPremiumBps =
      config.aaveFlashLoanPremiumBps === undefined
        ? onChainPremiumBps
        : BigInt(config.aaveFlashLoanPremiumBps);
    const divergence =
      onChainPremiumBps > configuredPremiumBps
        ? onChainPremiumBps - configuredPremiumBps
        : configuredPremiumBps - onChainPremiumBps;

    if (divergence > 1n) {
      console.warn(
        `WARNING: Aave flash loan premium on ${network.name} (${chainId}) is ${onChainPremiumBps} bps on-chain, ` +
          `but AAVE_FLASH_LOAN_PREMIUM_BPS is ${configuredPremiumBps} bps. ` +
          "Using the on-chain value for execution estimates."
      );
    }

    return onChainPremiumBps;
  } catch (err) {
    const message = err?.shortMessage || err?.message || String(err);
    console.warn(
      `WARNING: could not read Aave flash loan premium from ${network.name} (${chainId}) pool ${network.pool}: ` +
        `${message}. Using configured ${config.aaveFlashLoanPremiumBps} bps.`
    );
    return config.aaveFlashLoanPremiumBps;
  }
}

/// Runs one scan cycle. Config and provider are injectable so tests can run against the Hardhat
/// network without depending on environment variables; production callers pass nothing.
async function main({
  provider: injectedProvider,
  config: injectedConfig,
  scanPair: scanPairImpl = scanPair,
  maybeExecute: maybeExecuteImpl = maybeExecute,
} = {}) {
  const config = injectedConfig || require("./config");
  const adaptivePath = config.adaptivePath ?? DEFAULT_ADAPTIVE_PATH;
  let cycleConfig = config;
  try {
    const adaptiveState = await loadAdaptive({ filePath: adaptivePath, config });
    cycleConfig = applyAdaptive({ config, state: adaptiveState });
    const adaptiveMessage =
      `[ADAPTIVE] state=loaded bps=${adaptiveState.effectiveMinProfitBps} ` +
      `factor=${adaptiveState.effectiveMaxTradeSize}`;
    if (logFormat() === "json") {
      logEvent({
        event: "adaptive_state",
        level: "info",
        effectiveMinProfitBps: adaptiveState.effectiveMinProfitBps,
        effectiveMaxTradeSize: adaptiveState.effectiveMaxTradeSize,
        message: adaptiveMessage,
      });
    } else {
      console.log(adaptiveMessage);
    }
  } catch (err) {
    const adaptiveMessage =
      `WARNING: could not load adaptive state from ${adaptivePath}: ${err.message}. ` +
      "Continuing with base config.";
    if (logFormat() === "json") {
      logEvent({ event: "adaptive_state_error", level: "warn", message: adaptiveMessage });
    } else {
      console.warn(adaptiveMessage);
    }
  }
  const provider = injectedProvider || new ethers.JsonRpcProvider(config.rpcUrl);
  const scanLogPath = config.scanLogPath || DEFAULT_SCAN_LOG_PATH;

  console.log(`flash-arb-bot scan starting - DRY_RUN=${config.dryRun} - ${new Date().toISOString()}`);
  if (config.dryRun) {
    console.log("Running in SIMULATION mode: opportunities are logged, no transaction is sent.");
  }

  const [networkOutcome, feeDataOutcome, ethUsdPrice] = await Promise.all([
    withThrottle(getMainThrottle(config), () => provider.getNetwork()),
    withThrottle(getMainThrottle(config), () => provider.getFeeData()),
    getEthUsdPrice(provider, config.ethUsdRoute, config),
  ]);
  const network = networkOutcome.result;
  const feeData = feeDataOutcome.result;
  const chainId = Number(network.chainId);

  if (config.privateKey) {
    const walletAddress = new ethers.Wallet(config.privateKey).address;
    const balanceCheck = await checkWalletBalanceLow({
      provider,
      address: walletAddress,
      minWalletBalanceEth: config.minWalletBalanceEth,
    });
    if (!balanceCheck.ok) {
      console.warn(
        `[BALANCE LOW] ${walletAddress} holds ${ethers.formatEther(balanceCheck.balanceWei)} ETH, ` +
          `below MIN_WALLET_BALANCE_ETH=${config.minWalletBalanceEth}`
      );
    }
  }

  if (config.dryRun === false && ethUsdPrice === null) {
    const reason =
      "ETH_USD_ROUTE_JSON required for live execution, but quote failed. Set DRY_RUN=true or fix the route.";
    console.error(`[LIVE REFUSED] ${reason}`);
    return { refused: true, reason };
  }

  const aaveFlashLoanPremiumBps = await readAaveFlashLoanPremium({ provider, chainId, config });
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
  if (!gasPriceWei || gasPriceWei === 0n) {
    console.warn(
      "WARNING: gasPrice is 0 or unavailable - gas cost is not estimated for this run; " +
        "opportunities will be ranked on raw gross profit only."
    );
  }

  if (ethUsdPrice !== null) {
    console.log(`Reference price: 1 WETH ~= $${ethUsdPrice.toFixed(2)} (from ETH_USD_ROUTE_JSON)`);
  } else {
    console.log("No ETH/USD reference available - USD filtering is disabled, using raw on-chain profit only.");
  }

  let scanned = 0;
  let opportunities = 0;
  let executed = 0;
  let rpcErrors = 0;
  const executionConfig = { ...cycleConfig, ethUsdPrice, aaveFlashLoanPremiumBps };

  for (const pair of cycleConfig.pairs) {
    try {
      console.log(`\nScanning ${pair.label} ...`);
      const results = await scanPairImpl({ provider, pair, config: cycleConfig, gasPriceWei, ethUsdPrice });

      for (const result of results) {
        scanned += 1;
        await persistResultSafely(scanLogPath, result, chainId);

        if (result.error) {
          rpcErrors += 1;
          const errorInfo = describeError(result.error);
          logEvent({
            event: "scan_result",
            level: "error",
            pair: pair.label,
            tradeSize: result.tradeSizeHuman,
            borrowedToken: pair.borrowedToken.symbol,
            error: errorInfo,
            message: `  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: ERROR - ${errorInfo.shortMessage}`,
          });
          continue;
        }

        const profitStr = ethers.formatUnits(result.grossProfit, pair.borrowedToken.decimals);
        const usdStr = result.netProfitUsd !== null ? ` (~$${result.netProfitUsd.toFixed(2)} net)` : "";
        logEvent({
          event: "scan_result",
          level: "info",
          pair: pair.label,
          tradeSize: result.tradeSizeHuman,
          borrowedToken: pair.borrowedToken.symbol,
          grossProfit: profitStr,
          netProfitUsd: result.netProfitUsd,
          isOpportunity: result.isOpportunity,
          message:
            `  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: gross profit ${profitStr} ` +
            `${pair.borrowedToken.symbol}${usdStr}${result.isOpportunity ? " -> OPPORTUNITY" : ""}`,
        });

        if (result.isOpportunity) opportunities += 1;
      }

      const best = selectBestResult(results);
      if (best && !best.error) {
        const bestGross = ethers.formatUnits(best.grossProfit, pair.borrowedToken.decimals);
        const bestNet = hasNetProfit(best) ? best.netProfitUsd.toFixed(2) : "n/a";
        logEvent({
          event: "best_result",
          pair: pair.label,
          tradeSize: best.tradeSizeHuman,
          gross: bestGross,
          net: bestNet,
          isOpportunity: best.isOpportunity,
          message: `  [BEST] pair=${pair.label}, size=${best.tradeSizeHuman}, gross=${bestGross}, net=${bestNet}`,
        });

        if (best.isOpportunity) {
          const outcome = await maybeExecuteImpl({ opportunity: best, provider, config: executionConfig });
          if (outcome.submitted) executed += 1;

          if (config.dryRun !== true) {
            let adaptiveOutcome = "FAILURE";
            if (outcome.submitted && outcome.receipt && outcome.receipt.status === 1) {
              adaptiveOutcome = "SUCCESS";
            }
            if (outcome.error && String(outcome.error).includes("TRANSACTION_IN_FLIGHT")) {
              adaptiveOutcome = "UNKNOWN";
            }
            try {
              await recordOutcome({ filePath: adaptivePath, outcome: adaptiveOutcome, config });
            } catch (err) {
              console.warn(
                `WARNING: could not record adaptive outcome to ${adaptivePath}: ${err.message}`
              );
            }
          }
        }
      }
    } catch (err) {
      console.warn(`[PAIR ERROR] ${pair.label}: ${err.message} - continuing to next pair.`);
    }
  }

  if (rpcErrors > config.maxRpcErrorsPerScan) {
    console.warn(`[RPC ERRORS] ${rpcErrors} erreurs sur ce cycle.`);
  }

  const exitCode = rpcErrors > config.maxRpcErrorsPerScan || scanned === 0 ? 1 : 0;

  console.log(
    `\nDone: ${scanned} quotes checked, ${opportunities} opportunit${opportunities === 1 ? "y" : "ies"} found, ` +
      `${executed} transaction attempt(s).`
  );

  return { ethUsdPrice, aaveFlashLoanPremiumBps, scanned, opportunities, executed, exitCode };
}

if (require.main === module) {
  main()
    .then((summary) => process.exit(summary.exitCode ?? (summary.refused ? 1 : 0)))
    .catch((err) => {
      console.error("flash-arb-bot scan failed:", err);
      process.exit(1);
    });
}

module.exports = { main };
