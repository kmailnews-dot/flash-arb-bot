const { expect } = require("chai");
const {
  effectiveMinProfitBps,
  gasCostInBorrowedToken,
  interpolateMaximum,
  logSweepSizes,
} = require("../bot/pricing");

describe("bot/pricing gasCostInBorrowedToken L1 cost", function () {
  const gasCostWei = 10_000_000_000n;
  const config = { ethUsdPrice: 1800 };

  it("applies the default 5000 bps L1 multiplier to the gas cost", function () {
    const pair = { borrowedToken: { isStable: true, decimals: 6 } };
    const base = gasCostInBorrowedToken({
      gasCostWei,
      pair,
      config,
      l1MultiplierBps: 0,
    });
    const withMultiplier = gasCostInBorrowedToken({
      gasCostWei,
      pair,
      config,
      l1MultiplierBps: 5000,
    });
    const withConfiguredDefault = gasCostInBorrowedToken({
      gasCostWei,
      pair,
      config: { ...config, l1CostMultiplierBps: 5000 },
    });

    expect(base).to.equal(18n);
    expect(withMultiplier).to.equal((base * 3n) / 2n);
    expect(withConfiguredDefault).to.equal(withMultiplier);
  });

  it("applies the 5000 bps L1 multiplier to a WETH gas cost", function () {
    const pair = { borrowedToken: { isWeth: true, decimals: 18 } };
    const base = gasCostInBorrowedToken({
      gasCostWei,
      pair,
      config,
      l1MultiplierBps: 0,
    });
    const withMultiplier = gasCostInBorrowedToken({
      gasCostWei,
      pair,
      config,
      l1MultiplierBps: 5000,
    });
    const withConfiguredDefault = gasCostInBorrowedToken({
      gasCostWei,
      pair,
      config: { ...config, l1CostMultiplierBps: 5000 },
    });

    expect(base).to.equal(gasCostWei);
    expect(withMultiplier).to.equal((base * 3n) / 2n);
    expect(withConfiguredDefault).to.equal(withMultiplier);
  });
});

describe("bot/pricing logSweepSizes", function () {
  it("generates a logarithmically spaced grid between min and max", function () {
    const sizes = logSweepSizes({ min: "0.01", max: "0.1", steps: 5 });
    expect(sizes).to.have.lengthOf(5);
    expect(Number(sizes[0])).to.be.closeTo(0.01, 1e-6);
    expect(Number(sizes[4])).to.be.closeTo(0.1, 1e-6);
    const ratios = sizes.slice(1).map((s, i) => Number(s) / Number(sizes[i]));
    for (const r of ratios) {
      expect(r).to.be.closeTo(ratios[0], 1e-4);
    }
  });

  it("supports 3 steps", function () {
    const sizes = logSweepSizes({ min: "0.01", max: "1", steps: 3 });
    expect(sizes).to.have.lengthOf(3);
    expect(Number(sizes[1])).to.be.closeTo(0.1, 1e-6);
  });
});

describe("bot/pricing interpolateMaximum", function () {
  it("finds the local maximum of a concave parabola", function () {
    const sizes = ["0.01", "0.0316", "0.1"];
    const profits = [1, 10, 4];
    const result = interpolateMaximum({ sizes, profits });
    expect(result.interpolated).to.equal(true);
    const size = Number(result.size);
    expect(size).to.be.greaterThan(0.0316);
    expect(size).to.be.lessThan(0.1);
  });

  it("returns the raw best point when the maximum is at the grid edge", function () {
    const sizes = ["0.01", "0.0316", "0.1"];
    const profits = [1, 4, 10];
    const result = interpolateMaximum({ sizes, profits });
    expect(result.interpolated).to.equal(false);
    expect(result.size).to.equal("0.1");
  });

  it("returns the raw best point when the curve is convex", function () {
    const sizes = ["0.01", "0.0316", "0.1"];
    const profits = [10, 1, 10];
    const result = interpolateMaximum({ sizes, profits });
    expect(result.interpolated).to.equal(false);
  });
});

describe("effectiveMinProfitBps", function () {
  it("uses pair.minProfitBps as the floor when adaptive is absent", function () {
    const pair = { minProfitBps: 30 };
    const config = { minProfitBps: 20 };
    expect(effectiveMinProfitBps({ pair, config })).to.equal(30n);
  });

  it("uses config.minProfitBps when pair has no floor", function () {
    const pair = {};
    const config = { minProfitBps: 20 };
    expect(effectiveMinProfitBps({ pair, config })).to.equal(20n);
  });

  it("uses adaptive when it exceeds the floor", function () {
    const pair = { minProfitBps: 30 };
    const config = { minProfitBps: 20, effectiveMinProfitBps: 60 };
    expect(effectiveMinProfitBps({ pair, config })).to.equal(60n);
  });

  it("never returns less than the floor when adaptive is lower", function () {
    const pair = { minProfitBps: 30 };
    const config = { effectiveMinProfitBps: 10 };
    expect(effectiveMinProfitBps({ pair, config })).to.equal(30n);
  });

  it("returns 0n when neither floor nor adaptive is set", function () {
    expect(effectiveMinProfitBps({ pair: {}, config: {} })).to.equal(0n);
  });
});
