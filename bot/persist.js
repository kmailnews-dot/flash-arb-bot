const fs = require("fs/promises");
const path = require("path");
const { redactUrls } = require("./sanitizeError");

const LOG_DIR = path.resolve(__dirname, "..", "logs");
const DEFAULT_SCAN_LOG_PATH = path.join(LOG_DIR, "scans.jsonl");
const DEFAULT_LOG_FORMAT = "text";

function logFormat() {
  const value = (process.env.LOG_FORMAT || DEFAULT_LOG_FORMAT).toLowerCase();
  return value === "json" ? "json" : "text";
}

function jsonReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

/// Formats one log event as either the existing human-readable line (text, the default) or a
/// single-line JSON object when LOG_FORMAT=json. JSON mode is meant for pm2/journald ingestion.
function formatLogLine(event, format = logFormat()) {
  if (format === "json") {
    return JSON.stringify({ timestamp: new Date().toISOString(), ...event }, jsonReplacer);
  }
  return event.message ?? JSON.stringify(event, jsonReplacer);
}

function logEvent(event) {
  console.log(formatLogLine(event));
}

/// Appends one scan result to an append-only JSONL file. JSONL was chosen over SQLite because it
/// needs no extra dependency/native build, stays human-readable, and is easy to load into pandas or
/// jq later. BigInt values are stored as decimal strings so the line stays valid JSON.
function toNullableNumber(value) {
  return value === undefined || value === null || Number.isNaN(value) ? null : value;
}

function toNullableString(value) {
  return value === undefined || value === null ? null : String(value);
}

function persistableError(error) {
  if (typeof error === "string") return redactUrls(error);
  if (!error || typeof error !== "object") return null;
  return {
    code: toNullableString(redactUrls(error.code)),
    shortMessage: toNullableString(redactUrls(error.shortMessage)),
  };
}

async function appendScanResult(logPath = DEFAULT_SCAN_LOG_PATH, result, { chainId, timestamp = new Date() } = {}) {
  const pair = result.pair || {};
  const borrowedToken = pair.borrowedToken || {};

  const entry = {
    timestamp: timestamp instanceof Date ? timestamp.toISOString() : String(timestamp),
    chainId: toNullableNumber(chainId),
    blockNumber: toNullableNumber(result.blockNumber),
    pair: pair.label ?? null,
    borrowedToken: borrowedToken.symbol ?? null,
    tradeSize: result.tradeSizeHuman ?? null,
    quoteTimestamp: result.quoteTimestamp ?? null,
    gasPriceWei: toNullableString(result.gasPriceWei),
    ethUsdPrice: toNullableNumber(result.ethUsdPrice),
    amountIn: toNullableString(result.amountIn),
    intermediateOut: toNullableString(result.intermediateOut),
    finalOut: toNullableString(result.finalOut),
    owed: toNullableString(result.owed),
    premium: toNullableString(result.premium),
    grossProfit: toNullableString(result.grossProfit),
    grossProfitSymbol: borrowedToken.symbol ?? null,
    grossProfitUsd: toNullableNumber(result.grossProfitUsd),
    netProfitUsd: toNullableNumber(result.netProfitUsd),
    gasCostUsd: toNullableNumber(result.gasCostUsd),
    priced: Boolean(result.priced),
    isOpportunity: Boolean(result.isOpportunity),
    error: persistableError(result.error),
  };

  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

module.exports = {
  DEFAULT_SCAN_LOG_PATH,
  appendScanResult,
  logFormat,
  formatLogLine,
  logEvent,
};
