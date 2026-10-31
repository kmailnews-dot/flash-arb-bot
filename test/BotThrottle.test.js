const { expect } = require("chai");
const {
  createThrottle,
  withThrottle,
  getStats,
  DEFAULT_MIN_INTERVAL_MS,
  DEFAULT_NAME,
} = require("../bot/throttle");
const { getScannerThrottle, scanTradeSize } = require("../bot/scanner");

describe("bot/throttle", function () {
  it("initializes stats and defaults", function () {
    const throttle = createThrottle();

    expect(throttle.name).to.equal(DEFAULT_NAME);
    expect(throttle.minIntervalMs).to.equal(DEFAULT_MIN_INTERVAL_MS);
    expect(throttle.stats).to.deep.equal({
      calls: 0,
      totalWaitMs: 0,
      lastCallAt: null,
    });
  });

  it("runs fn and returns its result with a stats snapshot", async function () {
    const throttle = createThrottle({ minIntervalMs: 0 });
    const outcome = await withThrottle(throttle, async () => "ok");

    expect(outcome.result).to.equal("ok");
    expect(outcome.stats).to.deep.equal({
      calls: 1,
      totalWaitMs: 0,
      lastCallAt: outcome.stats.lastCallAt,
    });
    expect(outcome.stats.lastCallAt).to.be.a("number");
  });

  it("increments stats.calls on every call", async function () {
    const throttle = createThrottle({ minIntervalMs: 0 });

    await withThrottle(throttle, async () => 1);
    await withThrottle(throttle, async () => 2);

    expect(getStats(throttle).calls).to.equal(2);
  });

  it("records the call start time with the injected now", async function () {
    const throttle = createThrottle({ minIntervalMs: 0, now: () => 12345 });

    await withThrottle(throttle, async () => "clock");

    expect(getStats(throttle).lastCallAt).to.equal(12345);
  });

  it("serializes consecutive calls on the same throttle in order", async function () {
    const throttle = createThrottle({ minIntervalMs: 0 });
    const order = [];

    const first = withThrottle(throttle, async () => {
      order.push("first:start");
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push("first:end");
      return 1;
    });
    const second = withThrottle(throttle, async () => {
      order.push("second");
      return 2;
    });

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    expect(order).to.deep.equal(["first:start", "first:end", "second"]);
    expect(firstOutcome.result).to.equal(1);
    expect(secondOutcome.result).to.equal(2);
  });

  it("does not serialize calls across distinct throttles", async function () {
    const firstThrottle = createThrottle({ minIntervalMs: 0 });
    const secondThrottle = createThrottle({ minIntervalMs: 0 });
    let active = 0;
    let maxActive = 0;

    const fn = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return "ok";
    };

    await Promise.all([
      withThrottle(firstThrottle, fn),
      withThrottle(secondThrottle, fn),
    ]);

    expect(maxActive).to.equal(2);
  });

  it("propagates fn errors and still updates calls and lastCallAt", async function () {
    const throttle = createThrottle({ minIntervalMs: 0, now: () => 77 });

    await expect(
      withThrottle(throttle, async () => {
        throw new Error("boom");
      })
    ).to.be.rejectedWith("boom");
    await expect(
      withThrottle(throttle, async () => Promise.reject(new Error("later")))
    ).to.be.rejectedWith("later");

    const stats = getStats(throttle);
    expect(stats.calls).to.equal(2);
    expect(stats.lastCallAt).to.equal(77);
  });

  it("returns a frozen copy of stats", async function () {
    const throttle = createThrottle({ minIntervalMs: 0 });
    await withThrottle(throttle, async () => "ok");

    const snapshot = getStats(throttle);

    expect(Object.isFrozen(snapshot)).to.equal(true);
    expect(Reflect.set(snapshot, "calls", 99)).to.equal(false);
    expect(getStats(throttle).calls).to.equal(1);
    expect(snapshot).to.not.equal(throttle.stats);
  });

  it("respects minIntervalMs and measures the actual wait", async function () {
    const epoch = Date.now();
    const throttle = createThrottle({
      minIntervalMs: 20,
      now: () => Date.now() - epoch,
    });

    await withThrottle(throttle, async () => 1);

    const startedAt = Date.now();
    const outcome = await withThrottle(throttle, async () => 2);
    const elapsed = Date.now() - startedAt;

    expect(elapsed).to.be.gte(20);
    expect(outcome.stats.totalWaitMs).to.be.gte(20);
  });

  it("does not throw on its own across multiple calls", async function () {
    const throttle = createThrottle({ minIntervalMs: 0 });
    const outcomes = [];

    for (let index = 0; index < 5; index += 1) {
      outcomes.push(await withThrottle(throttle, async () => 42));
    }

    expect(outcomes.map((outcome) => outcome.result)).to.deep.equal([
      42, 42, 42, 42, 42,
    ]);
    expect(getStats(throttle).calls).to.equal(5);
  });

  it("uses the scanner throttle for quote calls", async function () {
    const config = {
      aaveFlashLoanPremiumBps: 5n,
      gasLimitEstimate: 700000n,
      gasPriceBufferPct: 20,
      minProfitUsd: 5,
      throttleMinIntervalMs: 0,
    };
    const pair = {
      borrowedToken: {
        address: "0x1111111111111111111111111111111111111111",
        decimals: 18,
      },
      intermediateToken: {
        address: "0x2222222222222222222222222222222222222222",
        decimals: 18,
      },
      legOut: {
        kind: "V2",
        router: "0x3333333333333333333333333333333333333333",
        tokenOut: "0x2222222222222222222222222222222222222222",
      },
      legBack: {
        kind: "V2",
        router: "0x4444444444444444444444444444444444444444",
        tokenOut: "0x1111111111111111111111111111111111111111",
      },
    };
    const throttle = getScannerThrottle(config);
    const callsBefore = getStats(throttle).calls;

    await scanTradeSize({
      provider: {},
      pair,
      tradeSizeHuman: "1",
      config,
      gasPriceWei: null,
      ethUsdPrice: null,
      quoteLeg: async () => 1000n,
    });

    expect(getStats(throttle).calls).to.equal(callsBefore + 2);
  });
});
