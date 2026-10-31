const DEFAULT_TIMEOUT_MS = 30_000;

function withTimeout(promise, ms = DEFAULT_TIMEOUT_MS, label = "RPC") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`TIMEOUT_${label}: no response after ${ms}ms`);
      err.code = `TIMEOUT_${label}`;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout, DEFAULT_TIMEOUT_MS };
