const { expect } = require("chai");
const { run } = require("../bot/run");

describe("bot/run persistent runner", function () {
  it("stops cleanly when SIGTERM is received", async function () {
    this.timeout(5000);
    let mainCalls = 0;
    let resolveFirstCycle;
    const firstCycle = new Promise((resolve) => {
      resolveFirstCycle = resolve;
    });
    let providerClosed = false;
    const provider = {
      async destroy() {
        providerClosed = true;
      },
    };
    const config = { dryRun: true, rpcUrl: "http://127.0.0.1:8545", pollIntervalMs: 60000 };

    const handle = run({
      provider,
      config,
      pollIntervalMs: 60000,
      main: async () => {
        mainCalls += 1;
        resolveFirstCycle();
        return { scanned: 0, exitCode: 0 };
      },
    });

    try {
      await firstCycle;
      process.emit("SIGTERM");
      const summary = await handle.done;

      expect(summary).to.deep.equal({ signal: "SIGTERM", stopped: true, cycles: 1 });
      expect(handle.stopped).to.equal(true);
      expect(mainCalls).to.equal(1);
      expect(providerClosed).to.equal(true);
    } finally {
      if (!handle.stopped) await handle.stop("TEST_CLEANUP");
      else await handle.done;
    }
  });
});
