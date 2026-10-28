const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s]+/gi;

function redactUrls(value) {
  if (typeof value !== "string") return value;
  return value.replace(URL_PATTERN, "[REDACTED_URL]");
}

function sanitizeError(err) {
  if (typeof err === "string") {
    return { code: null, shortMessage: redactUrls(err) };
  }
  if (!err || typeof err !== "object") {
    return { code: null, shortMessage: null };
  }

  return {
    code: redactUrls(err.code ?? null),
    shortMessage: redactUrls(err.shortMessage ?? err.message ?? null),
  };
}

module.exports = { redactUrls, sanitizeError };
