const { expect } = require("chai");
const { usdToTokenUnits, tokenUnitsToUsd } = require("../bot/minProfitUsd");

describe("bot/minProfitUsd", function () {
  it("converts USD to 18-decimal token units with ceiling", function () {
    expect(usdToTokenUnits({ usdAmount: 5, tokenUsdPrice: 1800, decimals: 18 })).to.equal(
      2777777777777778n
    );
  });

  it("converts USD to 6-decimal token units", function () {
    expect(usdToTokenUnits({ usdAmount: 5, tokenUsdPrice: 1, decimals: 6 })).to.equal(5000000n);
  });

  it("converts 0.50 USD to USDC (6 decimals)", function () {
    expect(usdToTokenUnits({ usdAmount: 0.50, tokenUsdPrice: 1, decimals: 6 })).to.equal(500000n);
  });

  it("converts 0.50 USD to WETH (18 decimals)", function () {
    expect(usdToTokenUnits({ usdAmount: 0.50, tokenUsdPrice: 2000, decimals: 18 })).to.equal(
      250000000000000n
    );
  });

  it("converts 0.50 USD to WBTC (8 decimals)", function () {
    expect(usdToTokenUnits({ usdAmount: 0.50, tokenUsdPrice: 60000, decimals: 8 })).to.equal(834n);
  });

  it("throws when tokenUsdPrice is zero", function () {
    expect(() => usdToTokenUnits({ usdAmount: 5, tokenUsdPrice: 0, decimals: 18 })).to.throw(
      "tokenUsdPrice must be a positive finite number"
    );
  });

  it("converts token units back to USD consistently", function () {
    const tokenUnits = usdToTokenUnits({ usdAmount: 5, tokenUsdPrice: 1800, decimals: 18 });

    expect(tokenUnitsToUsd({ tokenUnits, tokenUsdPrice: 1800, decimals: 18 })).to.be.closeTo(
      5,
      1e-9
    );
  });
});
