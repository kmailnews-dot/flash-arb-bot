const { ethers } = require("ethers");
const { main } = require("./index");

const DEFAULT_POLL_INTERVAL_MS = 15000;

function isWebSocketUrl(value) {
  return typeof value === "string" && /^wss?:\/\//i.test(value);
}

function httpFallbackUrl(value) {
  return value.replace(/^wss:\/\//i, "https://").replace(/^ws:\/\//i, "http://");
}

function normalizeInterval(value) {
  const interval = Number(value);
  return Number.isFinite(interval) && interval > 0 ? interval : DEFAULT_POLL_INTERVAL_MS;
}

/// Creates the provider used by the persistent runner. A ws:// or wss:// URL gets a
/// WebSocketProvider; HTTP URLs get a JsonRpcProvider with polling. If the WebSocket provider
/// cannot be constructed, fall back to the HTTP form of the same URL.
function createProvider({ rpcUrl, pollIntervalMs = DEFAULT_POLL_INTERVAL_MS } = {}) {
  if (!rpcUrl) {
    throw new Error("bot/run.js requires config.rpcUrl or an injected provider.");
  }

  const interval = normalizeInterval(pollIntervalMs);
  if (isWebSocketUrl(rpcUrl)) {
    try {
      return { provider: new ethers.WebSocketProvider(rpcUrl), kind: "websocket" };
    } catch (err) {
      console.warn(
        `[RUN] WebSocket provider unavailable (${err?.shortMessage || err?.message || err}); ` +
          "falling back to JSON-RPC polling."
      );
    }
  }

  const provider = new ethers.JsonRpcProvider(httpFallbackUrl(rpcUrl));
  provider.pollingInterval = interval;
  return { provider, kind: "polling" };
}

async function closeProvider(provider) {
  if (!provider) return;
  try {
    if (typeof provider.destroy === "function") await provider.destroy();
    else if (typeof provider.close === "function") await provider.close();
  } catch (err) {
    console.warn(`[RUN] could not close provider: ${err?.shortMessage || err?.message || err}`);
  }
}

/// Persistent entry point: runs main() on an interval until SIGTERM/SIGINT. Guard state is
/// already persisted atomically by bot/guards.js on every mutation; shutdown waits for the
/// in-flight cycle so no guard write is interrupted before the provider is closed.
function run({
  provider: injectedProvider,
  config: injectedConfig,
  main: mainImpl = main,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  installSignalHandlers = true,
} = {}) {
  const config = injectedConfig || require("./config");
  const providerInfo = injectedProvider
    ? { provider: injectedProvider, kind: "injected" }
    : createProvider({ rpcUrl: config.rpcUrl, pollIntervalMs: config.pollIntervalMs ?? pollIntervalMs });
  const provider = providerInfo.provider;
  const intervalMs = normalizeInterval(config.pollIntervalMs ?? pollIntervalMs);

  let stopped = false;
  let timer = null;
  let inFlight = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const cycles = [];

  function schedule(delay = intervalMs) {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      startCycle();
    }, delay);
  }

  function startCycle() {
    if (stopped || inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const summary = await mainImpl({ provider, config });
        cycles.push(summary);
        return summary;
      } catch (err) {
        console.error(`[RUN] scan cycle failed: ${err?.shortMessage || err?.message || err}`);
        return null;
      } finally {
        inFlight = null;
        if (!stopped) schedule();
      }
    })();
    return inFlight;
  }

  function removeSignalHandlers() {
    if (!installSignalHandlers) return;
    process.removeListener("SIGTERM", onSigterm);
    process.removeListener("SIGINT", onSigint);
  }

  async function shutdown(signal = "MANUAL") {
    if (stopped) return done;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    removeSignalHandlers();

    if (inFlight) {
      try {
        await inFlight;
      } catch (err) {
        // startCycle already logged it; keep shutting down.
      }
    }

    await closeProvider(provider);
    resolveDone({ signal, stopped: true, cycles: cycles.length });
    return done;
  }

  const onSigterm = () => {
    shutdown("SIGTERM");
  };
  const onSigint = () => {
    shutdown("SIGINT");
  };

  if (installSignalHandlers) {
    process.on("SIGTERM", onSigterm);
    process.on("SIGINT", onSigint);
  }

  startCycle();

  return {
    done,
    stop: shutdown,
    provider,
    providerKind: providerInfo.kind,
    get stopped() {
      return stopped;
    },
  };
}

module.exports = { run, createProvider, closeProvider, DEFAULT_POLL_INTERVAL_MS };

if (require.main === module) {
  let handle;
  try {
    handle = run();
  } catch (err) {
    console.error("[RUN] failed to start:", err?.shortMessage || err?.message || err);
    process.exit(1);
  }

  handle.done
    .then((summary) => {
      console.log(`[RUN] stopped cleanly (${summary.signal})`);
      process.exitCode = 0;
    })
    .catch((err) => {
      console.error("[RUN] fatal:", err);
      process.exitCode = 1;
    });
}
