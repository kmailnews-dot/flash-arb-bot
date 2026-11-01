const { expect } = require("chai");
const { gasCostInBorrowedToken } = require("../bot/pricing");

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
