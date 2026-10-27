const { ethers } = require("ethers");
const { getEthUsdPrice, scanPair } = require("./scanner");
const { maybeExecute } = require("./executor");
const { DEFAULT_SCAN_LOG_PATH, appendScanResult } = require("./persist");

async function persistResultSafely(logPath, result, chainId) {
  try {
    await appendScanResult(logPath, result, { chainId });
  } catch (err) {
    console.warn(`WARNING: could not persist scan result to ${logPath}: ${err.message}`);
  }
}

function describeError(error) {
  if (!error) return "unknown error";
  if (typeof error === "string") return error;
  return error.shortMessage ?? error.code ?? "unknown error";
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

/// Runs one scan cycle. Config and provider are injectable so tests can run against the Hardhat
/// network without depending on environment variables; production callers pass nothing.
async function main({ provider: injectedProvider, config: injectedConfig } = {}) {
  const config = injectedConfig || require("./config");
  const provider = injectedProvider || new ethers.JsonRpcProvider(config.rpcUrl);
  const scanLogPath = config.scanLogPath || DEFAULT_SCAN_LOG_PATH;

  console.log(`flash-arb-bot scan starting - DRY_RUN=${config.dryRun} - ${new Date().toISOString()}`);
  if (config.dryRun) {
    console.log("Running in SIMULATION mode: opportunities are logged, no transaction is sent.");
  }

  const [network, feeData, ethUsdPrice] = await Promise.all([
    provider.getNetwork(),
    provider.getFeeData(),
    getEthUsdPrice(provider, config.ethUsdRoute),
  ]);
  const chainId = Number(network.chainId);
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
  const executionConfig = { ...config, ethUsdPrice };

  for (const pair of config.pairs) {
    console.log(`\nScanning ${pair.label} ...`);
    const results = await scanPair({ provider, pair, config, gasPriceWei, ethUsdPrice });

    for (const result of results) {
      scanned += 1;
      await persistResultSafely(scanLogPath, result, chainId);

      if (result.error) {
        console.log(`  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: ERROR - ${describeError(result.error)}`);
        continue;
      }

      const profitStr = ethers.formatUnits(result.grossProfit, pair.borrowedToken.decimals);
      const usdStr = result.netProfitUsd !== null ? ` (~$${result.netProfitUsd.toFixed(2)} net)` : "";
      console.log(
        `  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: gross profit ${profitStr} ` +
          `${pair.borrowedToken.symbol}${usdStr}${result.isOpportunity ? " -> OPPORTUNITY" : ""}`
      );

      if (result.isOpportunity) opportunities += 1;
    }

    const best = selectBestResult(results);
    if (best && !best.error) {
      const bestGross = ethers.formatUnits(best.grossProfit, pair.borrowedToken.decimals);
      const bestNet = hasNetProfit(best) ? best.netProfitUsd.toFixed(2) : "n/a";
      console.log(
        `  [BEST] pair=${pair.label}, size=${best.tradeSizeHuman}, gross=${bestGross}, net=${bestNet}`
      );

      if (best.isOpportunity) {
        const outcome = await maybeExecute({ opportunity: best, provider, config: executionConfig });
        if (outcome.submitted) executed += 1;
      }
    }
  }

  console.log(
    `\nDone: ${scanned} quotes checked, ${opportunities} opportunit${opportunities === 1 ? "y" : "ies"} found, ` +
      `${executed} transaction attempt(s).`
  );

  return { ethUsdPrice, scanned, opportunities, executed };
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("flash-arb-bot scan failed:", err);
      process.exit(1);
    });
}

module.exports = { main };
