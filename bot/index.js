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
  const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas ?? 0n;

  if (ethUsdPrice !== null) {
    console.log(`Reference price: 1 WETH ~= $${ethUsdPrice.toFixed(2)} (from ETH_USD_ROUTE_JSON)`);
  } else {
    console.log("No ETH/USD reference available - USD filtering is disabled, using raw on-chain profit only.");
  }

  let scanned = 0;
  let opportunities = 0;
  let executed = 0;

  for (const pair of config.pairs) {
    console.log(`\nScanning ${pair.label} ...`);
    const results = await scanPair({ provider, pair, config, gasPriceWei, ethUsdPrice });

    for (const result of results) {
      scanned += 1;
      await persistResultSafely(scanLogPath, result, chainId);

      if (result.error) {
        console.log(`  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: ERROR - ${result.error}`);
        continue;
      }

      const profitStr = ethers.formatUnits(result.grossProfit, pair.borrowedToken.decimals);
      const usdStr = result.netProfitUsd !== null ? ` (~$${result.netProfitUsd.toFixed(2)} net)` : "";
      console.log(
        `  ${result.tradeSizeHuman} ${pair.borrowedToken.symbol}: gross profit ${profitStr} ` +
          `${pair.borrowedToken.symbol}${usdStr}${result.isOpportunity ? " -> OPPORTUNITY" : ""}`
      );

      if (result.isOpportunity) {
        opportunities += 1;
        const outcome = await maybeExecute({ opportunity: result, provider, config });
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
