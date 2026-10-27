const fs = require("fs/promises");
const path = require("path");

const DEFAULT_SCAN_LOG_PATH = "./logs/scans.jsonl";

/// Appends one scan result to an append-only JSONL file. JSONL was chosen over SQLite because it
/// needs no extra dependency/native build, stays human-readable, and is easy to load into pandas or
/// jq later. BigInt values are stored as decimal strings so the line stays valid JSON.
function toNullableNumber(value) {
  return value === undefined || value === null || Number.isNaN(value) ? null : value;
}

function toNullableString(value) {
  return value === undefined || value === null ? null : String(value);
}

async function appendScanResult(logPath = DEFAULT_SCAN_LOG_PATH, result, { chainId, timestamp = new Date() } = {}) {
  const pair = result.pair || {};
  const borrowedToken = pair.borrowedToken || {};

  const entry = {
    timestamp: timestamp instanceof Date ? timestamp.toISOString() : String(timestamp),
    chainId: toNullableNumber(chainId),
    pair: pair.label ?? null,
    borrowedToken: borrowedToken.symbol ?? null,
    tradeSize: result.tradeSizeHuman ?? null,
    grossProfit: toNullableString(result.grossProfit),
    grossProfitSymbol: borrowedToken.symbol ?? null,
    grossProfitUsd: toNullableNumber(result.grossProfitUsd),
    netProfitUsd: toNullableNumber(result.netProfitUsd),
    gasCostUsd: toNullableNumber(result.gasCostUsd),
    isOpportunity: Boolean(result.isOpportunity),
    error: toNullableString(result.error),
  };

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

module.exports = { DEFAULT_SCAN_LOG_PATH, appendScanResult };
