const { expect } = require("chai");

const BORROWED = "0x1111111111111111111111111111111111111111";
const INTERMEDIATE = "0x2222222222222222222222222222222222222222";
const ROUTER_OUT = "0x3333333333333333333333333333333333333333";
const ROUTER_BACK = "0x4444444444444444444444444444444444444444";

function makePair() {
  return {
    borrowedToken: { address: BORROWED, decimals: 18 },
    intermediateToken: { address: INTERMEDIATE, decimals: 18 },
    legOut: { kind: "V2", router: ROUTER_OUT, tokenOut: INTERMEDIATE },
    legBack: { kind: "V2", router: ROUTER_BACK, tokenOut: BORROWED },
    tradeSizes: ["0.1"],
  };
}

const previousEnv = {
  ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL,
  PAIRS_CONFIG_JSON: process.env.PAIRS_CONFIG_JSON,
  ETH_USD_ROUTE_JSON: process.env.ETH_USD_ROUTE_JSON,
};

process.env.ARBITRUM_RPC_URL = previousEnv.ARBITRUM_RPC_URL || "http://127.0.0.1:8545";
process.env.PAIRS_CONFIG_JSON = JSON.stringify([makePair()]);
process.env.ETH_USD_ROUTE_JSON = "";

const { validateSlippageBps } = require("../bot/config");

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("bot/config validateSlippageBps", function () {
  const previousSlippageBps = process.env.SLIPPAGE_BPS;

  afterEach(function () {
    if (previousSlippageBps === undefined) delete process.env.SLIPPAGE_BPS;
    else process.env.SLIPPAGE_BPS = previousSlippageBps;
  });

  it("defaults to 50 when SLIPPAGE_BPS is not set", function () {
    delete process.env.SLIPPAGE_BPS;

    expect(validateSlippageBps()).to.equal(50);
  });

  it("accepts 200", function () {
    process.env.SLIPPAGE_BPS = "200";

    expect(validateSlippageBps()).to.equal(200);
  });

  it("accepts 1", function () {
    process.env.SLIPPAGE_BPS = "1";

    expect(validateSlippageBps()).to.equal(1);
  });

  it("rejects 201", function () {
    process.env.SLIPPAGE_BPS = "201";

    expect(() => validateSlippageBps()).to.throw("SLIPPAGE_BPS must be an integer between 1 and 200.");
  });

  it("rejects 500", function () {
    process.env.SLIPPAGE_BPS = "500";

    expect(() => validateSlippageBps()).to.throw("SLIPPAGE_BPS must be an integer between 1 and 200.");
  });

  it("rejects 0", function () {
    process.env.SLIPPAGE_BPS = "0";

    expect(() => validateSlippageBps()).to.throw("SLIPPAGE_BPS must be an integer between 1 and 200.");
  });

  it("rejects a non-integer", function () {
    process.env.SLIPPAGE_BPS = "2.5";

    expect(() => validateSlippageBps()).to.throw("SLIPPAGE_BPS must be an integer between 1 and 200.");
  });

  it("rejects a non-numeric value", function () {
    process.env.SLIPPAGE_BPS = "abc";

    expect(() => validateSlippageBps()).to.throw("SLIPPAGE_BPS must be an integer between 1 and 200.");
  });
});
