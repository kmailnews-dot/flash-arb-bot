const fs = require("fs/promises");
const path = require("path");
const { redactUrls } = require("./sanitizeError");

const LOG_DIR = path.resolve(__dirname, "..", "logs");
const DEFAULT_SCAN_LOG_PATH = path.join(LOG_DIR, "scans.jsonl");
const DEFAULT_PNL_LOG_PATH = path.join(LOG_DIR, "pnl.jsonl");
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

async function appendExecutionPnl(entry, logPath = DEFAULT_PNL_LOG_PATH) {
  const payload = {
    timestamp:
      entry.timestamp instanceof Date
        ? entry.timestamp.toISOString()
        : String(entry.timestamp ?? new Date().toISOString()),
    txHash: toNullableString(entry.txHash),
    journalId: toNullableString(entry.journalId),
    pairLabel: toNullableString(entry.pairLabel),
    realizedProfitWei: toNullableString(entry.realizedProfitWei),
    premiumWei: toNullableString(entry.premiumWei),
    gasPaidWei: toNullableString(entry.gasPaidWei),
    l1FeeWei: toNullableString(entry.l1FeeWei),
    status: toNullableString(entry.status),
  };
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `${JSON.stringify(payload)}\n`, "utf8");
  return payload;
}

const crypto = require("crypto");
const DEFAULT_EXECUTION_JOURNAL_PATH = path.join(LOG_DIR, "executions.json");
const EXECUTION_JOURNAL_VERSION = 1;

async function readExecutionJournal(filePath = DEFAULT_EXECUTION_JOURNAL_PATH) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`STATE_FILE_CORRUPT: ${filePath}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`STATE_FILE_CORRUPT: ${filePath}`);
    }
    if (parsed.version !== EXECUTION_JOURNAL_VERSION) {
      throw new Error(`STATE_FILE_CORRUPT: ${filePath}`);
    }
    if (!parsed.records || typeof parsed.records !== "object" || Array.isArray(parsed.records)) {
      throw new Error(`STATE_FILE_CORRUPT: ${filePath}`);
    }
    return parsed;
  } catch (err) {
    if (err.code === "ENOENT") return { version: EXECUTION_JOURNAL_VERSION, records: {} };
    throw err;
  }
}

async function writeExecutionJournal(journal, filePath = DEFAULT_EXECUTION_JOURNAL_PATH) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(`${JSON.stringify(journal, jsonReplacer, 2)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await fs.rename(tmpPath, filePath);
}

async function upsertExecutionRecord(record, filePath = DEFAULT_EXECUTION_JOURNAL_PATH) {
  if (!record || typeof record.id !== "string" || record.id.length === 0) {
    throw new Error("upsertExecutionRecord: record.id is required");
  }
  const journal = await readExecutionJournal(filePath);
  journal.records[record.id] = { ...record, lastUpdateAt: Date.now() };
  await writeExecutionJournal(journal, filePath);
  return journal.records[record.id];
}

async function deleteExecutionRecord(id, filePath = DEFAULT_EXECUTION_JOURNAL_PATH) {
  const journal = await readExecutionJournal(filePath);
  delete journal.records[id];
  await writeExecutionJournal(journal, filePath);
}

async function listPendingExecutions(filePath = DEFAULT_EXECUTION_JOURNAL_PATH) {
  const journal = await readExecutionJournal(filePath);
  const PENDING = new Set(["SIGNED", "SUBMITTED", "UNKNOWN", "STALE"]);
  return Object.values(journal.records)
    .filter((r) => PENDING.has(r.status))
    .sort((a, b) => (a.submittedAt ?? 0) - (b.submittedAt ?? 0));
}

module.exports = {
  DEFAULT_SCAN_LOG_PATH,
  DEFAULT_PNL_LOG_PATH,
  DEFAULT_EXECUTION_JOURNAL_PATH,
  EXECUTION_JOURNAL_VERSION,
  appendScanResult,
  appendExecutionPnl,
  logFormat,
  formatLogLine,
  logEvent,
  readExecutionJournal,
  writeExecutionJournal,
  upsertExecutionRecord,
  deleteExecutionRecord,
  listPendingExecutions,
};
