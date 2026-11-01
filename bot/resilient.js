const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_MS = 500;
const DEFAULT_CAP_MS = 4000;

const PERMANENT_CODES = new Set([
  "NOT_PROFITABLE",
  "CALL_EXCEPTION",
  "INVALID_ARGUMENT",
  "CHAIN_ID_MISMATCH",
  "WALLET_BALANCE_ABOVE_MAX",
  "WALLET_BALANCE_BELOW_MIN",
  "CIRCUIT_BREAKER_OPEN",
  "TRANSACTION_IN_FLIGHT",
  "TRANSACTION_IN_FLIGHT_STALE",
  "MAX_GAS_LIMIT",
  "CONTRACT_OWNER_MISMATCH",
  "TIMEOUT_WAIT_RECEIPT",
  "TIMEOUT_ESTIMATE_GAS",
  "TIMEOUT_FEE_DATA",
  "TIMEOUT_REQUOTE_LEG1",
  "TIMEOUT_REQUOTE_LEG2",
  "TIMEOUT_STATIC_CALL",
  "DAILY_GAS_LIMIT",
  "GUARD_ERROR",
]);

const TRANSIENT_CODES = new Set([
  "TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "SERVER_ERROR",
  "NETWORK_ERROR",
  "RATE_LIMITED",
  "TOO_MANY_REQUESTS",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
]);

const UNKNOWN_CODES = new Set([
  "TRANSACTION_REPLACED",
]);

function textOf(value) {
  if (value === undefined || value === null) return "";
  try {
    return String(value);
  } catch (err) {
    return "";
  }
}

function normalizeText(value) {
  return textOf(value).toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function matchesAny(text, codes) {
  if (!text) return false;
  for (const code of codes) {
    if (text.includes(code)) return true;
  }
  return false;
}

function errorChain(root) {
  const nodes = [];
  const seen = new Set();
  function visit(node, depth) {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 3) return;
    seen.add(node);
    nodes.push(node);
    visit(node.error, depth + 1);
    visit(node.cause, depth + 1);
    visit(node.info?.error, depth + 1);
  }
  visit(root, 0);
  return nodes;
}

function classifyError(error) {
  try {
    if (typeof error === "string") {
      const text = normalizeText(error);
      if (matchesAny(text, PERMANENT_CODES)) return "PERMANENT";
      if (matchesAny(text, TRANSIENT_CODES)) return "TRANSIENT";
      if (matchesAny(text, UNKNOWN_CODES)) return "UNKNOWN";
      return "UNKNOWN";
    }

    if (!error || typeof error !== "object") return "UNKNOWN";

    for (const node of errorChain(error)) {
      const code = textOf(node.code);
      const text = normalizeText(
        [node.code, node.shortMessage, node.message, node.reason]
          .map(textOf)
          .filter(Boolean)
          .join(" ")
      );

      if (PERMANENT_CODES.has(code) || matchesAny(text, PERMANENT_CODES)) {
        return "PERMANENT";
      }
      if (TRANSIENT_CODES.has(code) || matchesAny(text, TRANSIENT_CODES)) {
        return "TRANSIENT";
      }
      if (UNKNOWN_CODES.has(code) || matchesAny(text, UNKNOWN_CODES)) {
        return "UNKNOWN";
      }
    }
    return "UNKNOWN";
  } catch (err) {
    return "UNKNOWN";
  }
}

function shouldRetry({ error, attempt, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) {
  try {
    return (
      classifyError(error) === "TRANSIENT" &&
      Number.isInteger(attempt) &&
      attempt >= 0 &&
      attempt < maxAttempts
    );
  } catch (err) {
    return false;
  }
}

function backoffMs({ attempt, baseMs = DEFAULT_BASE_MS, capMs = DEFAULT_CAP_MS } = {}) {
  try {
    if (!Number.isInteger(attempt) || attempt < 0) return baseMs;
    return Math.min(baseMs * 2 ** attempt, capMs);
  } catch (err) {
    return baseMs;
  }
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_BASE_MS,
  DEFAULT_CAP_MS,
  classifyError,
  shouldRetry,
  backoffMs,
  UNKNOWN_CODES,
};
