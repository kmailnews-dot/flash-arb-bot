const { expect } = require("chai");

const BORROWED = "0x1111111111111111111111111111111111111111";
const INTERMEDIATE = "0x2222222222222222222222222222222222222222";
const ROUTER_OUT = "0x3333333333333333333333333333333333333333";
const ROUTER_BACK = "0x4444444444444444444444444444444444444444";
const V3_SWAP_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const V3_SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";

function makePair() {
  return {
    borrowedToken: { address: BORROWED, decimals: 18 },
    intermediateToken: { address: INTERMEDIATE, decimals: 18 },
    legOut: { kind: "V2", router: ROUTER_OUT, tokenOut: INTERMEDIATE },
    legBack: { kind: "V2", router: ROUTER_BACK, tokenOut: BORROWED },
    tradeSizes: ["0.1"],
  };
}

function pairWithBorrowed(overrides) {
  const pair = makePair();
  pair.borrowedToken = { ...pair.borrowedToken, ...overrides };
  return pair;
}

function pairWithIntermediate(overrides) {
  const pair = makePair();
  pair.intermediateToken = { ...pair.intermediateToken, ...overrides };
  return pair;
}

function pairWithLegOut(overrides) {
  const pair = makePair();
  pair.legOut = { ...pair.legOut, ...overrides };
  return pair;
}

function pairWithLegBack(overrides) {
  const pair = makePair();
  pair.legBack = { ...pair.legBack, ...overrides };
  return pair;
}

function pairWithTradeSizes(tradeSizes) {
  const pair = makePair();
  pair.tradeSizes = tradeSizes;
  return pair;
}

const previousEnv = {
  ARBITRUM_RPC_URL: process.env.ARBITRUM_RPC_URL,
  PAIRS_CONFIG_JSON: process.env.PAIRS_CONFIG_JSON,
  ETH_USD_ROUTE_JSON: process.env.ETH_USD_ROUTE_JSON,
};

process.env.ARBITRUM_RPC_URL = previousEnv.ARBITRUM_RPC_URL || "http://127.0.0.1:8545";
process.env.PAIRS_CONFIG_JSON = JSON.stringify([makePair()]);
process.env.ETH_USD_ROUTE_JSON = "";

const { validatePairs } = require("../bot/config");

for (const [key, value] of Object.entries(previousEnv)) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("bot/config validatePairs", function () {
  it("accepts a valid pair with optional booleans absent or false", function () {
    expect(() => validatePairs([makePair()])).to.not.throw();

    const pair = makePair();
    pair.borrowedToken.isStable = false;
    pair.borrowedToken.isWeth = false;
    expect(() => validatePairs([pair])).to.not.throw();
  });

  it("rejects a missing borrowedToken.decimals", function () {
    const pair = makePair();
    delete pair.borrowedToken.decimals;

    expect(() => validatePairs([pair])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a non-integer borrowedToken.decimals", function () {
    expect(() => validatePairs([pairWithBorrowed({ decimals: 6.5 })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a string borrowedToken.decimals", function () {
    expect(() => validatePairs([pairWithBorrowed({ decimals: "6" })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a negative borrowedToken.decimals", function () {
    expect(() => validatePairs([pairWithBorrowed({ decimals: -1 })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a borrowedToken.decimals above 18", function () {
    expect(() => validatePairs([pairWithBorrowed({ decimals: 19 })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a missing intermediateToken.decimals", function () {
    const pair = makePair();
    delete pair.intermediateToken.decimals;

    expect(() => validatePairs([pair])).to.throw(
      "PAIRS_CONFIG_JSON[0].intermediateToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a non-integer intermediateToken.decimals", function () {
    expect(() => validatePairs([pairWithIntermediate({ decimals: 6.5 })])).to.throw(
      "PAIRS_CONFIG_JSON[0].intermediateToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a negative intermediateToken.decimals", function () {
    expect(() => validatePairs([pairWithIntermediate({ decimals: -1 })])).to.throw(
      "PAIRS_CONFIG_JSON[0].intermediateToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects an intermediateToken.decimals above 18", function () {
    expect(() => validatePairs([pairWithIntermediate({ decimals: 19 })])).to.throw(
      "PAIRS_CONFIG_JSON[0].intermediateToken.decimals must be an integer between 0 and 18."
    );
  });

  it("rejects a non-boolean isStable", function () {
    expect(() => validatePairs([pairWithBorrowed({ isStable: "true" })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.isStable must be a boolean if present."
    );
    expect(() => validatePairs([pairWithBorrowed({ isStable: null })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.isStable must be a boolean if present."
    );
  });

  it("rejects a non-boolean isWeth", function () {
    expect(() => validatePairs([pairWithBorrowed({ isWeth: "false" })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.isWeth must be a boolean if present."
    );
    expect(() => validatePairs([pairWithBorrowed({ isWeth: 1 })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken.isWeth must be a boolean if present."
    );
  });

  it("rejects isStable and isWeth both true", function () {
    expect(() => validatePairs([pairWithBorrowed({ isStable: true, isWeth: true })])).to.throw(
      "PAIRS_CONFIG_JSON[0].borrowedToken must not set both isStable and isWeth to true."
    );
  });

  it("accepts decimals 0 and 18 on both tokens", function () {
    const pairZero = pairWithBorrowed({ decimals: 0 });
    pairZero.tradeSizes = ["1"];
    expect(() => validatePairs([pairZero])).to.not.throw();

    expect(() => validatePairs([pairWithBorrowed({ decimals: 18 })])).to.not.throw();
    expect(() => validatePairs([pairWithIntermediate({ decimals: 0 })])).to.not.throw();
    expect(() => validatePairs([pairWithIntermediate({ decimals: 18 })])).to.not.throw();
  });

  it("rejects a missing tradeSizes", function () {
    const pair = makePair();
    delete pair.tradeSizes;

    expect(() => validatePairs([pair])).to.throw("PAIRS_CONFIG_JSON[0].tradeSizes is required.");
  });

  it("rejects a non-array tradeSizes", function () {
    expect(() => validatePairs([pairWithTradeSizes("0.1")])).to.throw(
      "PAIRS_CONFIG_JSON[0].tradeSizes must be an array."
    );
  });

  it("rejects an empty tradeSizes", function () {
    expect(() => validatePairs([pairWithTradeSizes([])])).to.throw(
      "PAIRS_CONFIG_JSON[0].tradeSizes must not be empty."
    );
  });

  it("rejects a non-string trade size", function () {
    expect(() => validatePairs([pairWithTradeSizes([1])])).to.throw(
      "PAIRS_CONFIG_JSON[0].tradeSizes[0] must be a string."
    );
  });

  it("rejects a trade size with too many decimals", function () {
    const pair = pairWithBorrowed({ decimals: 6 });
    pair.tradeSizes = ["0.0000001"];

    expect(() => validatePairs([pair])).to.throw(
      "PAIRS_CONFIG_JSON[0].tradeSizes[0] must be parseable with borrowedToken.decimals (6)."
    );
  });

  it("rejects a trade size that is zero or negative", function () {
    expect(() => validatePairs([pairWithTradeSizes(["0"])])).to.throw(
      "PAIRS_CONFIG_JSON[0].tradeSizes[0] must be greater than 0."
    );
    expect(() => validatePairs([pairWithTradeSizes(["-1"])])).to.throw(
      "PAIRS_CONFIG_JSON[0].tradeSizes[0] must be greater than 0."
    );
  });

  it("rejects duplicate trade sizes after parsing", function () {
    expect(() => validatePairs([pairWithTradeSizes(["1", "1.0"])])).to.throw(
      "PAIRS_CONFIG_JSON[0].tradeSizes[1] duplicates an earlier trade size (1000000000000000000)."
    );
  });

  it("rejects a missing or invalid legOut.kind", function () {
    const pair = makePair();
    delete pair.legOut.kind;

    expect(() => validatePairs([pair])).to.throw(
      'PAIRS_CONFIG_JSON[0].legOut.kind must be "V2" or "V3".'
    );
    expect(() => validatePairs([pairWithLegOut({ kind: "v3" })])).to.throw(
      'PAIRS_CONFIG_JSON[0].legOut.kind must be "V2" or "V3".'
    );
    expect(() => validatePairs([pairWithLegOut({ kind: "V4" })])).to.throw(
      'PAIRS_CONFIG_JSON[0].legOut.kind must be "V2" or "V3".'
    );
  });

  it("rejects a missing or invalid legBack.kind", function () {
    const pair = makePair();
    delete pair.legBack.kind;

    expect(() => validatePairs([pair])).to.throw(
      'PAIRS_CONFIG_JSON[0].legBack.kind must be "V2" or "V3".'
    );
    expect(() => validatePairs([pairWithLegBack({ kind: "v3" })])).to.throw(
      'PAIRS_CONFIG_JSON[0].legBack.kind must be "V2" or "V3".'
    );
    expect(() => validatePairs([pairWithLegBack({ kind: "V4" })])).to.throw(
      'PAIRS_CONFIG_JSON[0].legBack.kind must be "V2" or "V3".'
    );
  });

  it("rejects a missing or invalid legOut.v3Fee for V3", function () {
    const pair = pairWithLegOut({ kind: "V3", quoter: ROUTER_OUT });
    delete pair.legOut.v3Fee;

    const message =
      'PAIRS_CONFIG_JSON[0].legOut.v3Fee must be one of 100, 500, 3000 or 10000 when kind is "V3".';
    expect(() => validatePairs([pair])).to.throw(message);
    expect(() => validatePairs([pairWithLegOut({ kind: "V3", v3Fee: 500.5, quoter: ROUTER_OUT })])).to.throw(
      message
    );
    expect(() => validatePairs([pairWithLegOut({ kind: "V3", v3Fee: 250, quoter: ROUTER_OUT })])).to.throw(
      message
    );
  });

  it("rejects a missing or invalid legBack.v3Fee for V3", function () {
    const pair = pairWithLegBack({ kind: "V3", quoter: ROUTER_BACK });
    delete pair.legBack.v3Fee;

    const message =
      'PAIRS_CONFIG_JSON[0].legBack.v3Fee must be one of 100, 500, 3000 or 10000 when kind is "V3".';
    expect(() => validatePairs([pair])).to.throw(message);
    expect(() => validatePairs([pairWithLegBack({ kind: "V3", v3Fee: 500.5, quoter: ROUTER_BACK })])).to.throw(
      message
    );
    expect(() => validatePairs([pairWithLegBack({ kind: "V3", v3Fee: 250, quoter: ROUTER_BACK })])).to.throw(
      message
    );
  });

  it("rejects a missing or invalid legOut.quoter for V3", function () {
    const pair = pairWithLegOut({ kind: "V3", v3Fee: 500 });
    delete pair.legOut.quoter;

    expect(() => validatePairs([pair])).to.throw(
      'PAIRS_CONFIG_JSON[0].legOut.quoter is required when kind is "V3".'
    );
    expect(() =>
      validatePairs([pairWithLegOut({ kind: "V3", v3Fee: 500, quoter: "not-an-address" })])
    ).to.throw("Invalid address at PAIRS_CONFIG_JSON[0].legOut.quoter");
  });

  it("rejects a missing or invalid legBack.quoter for V3", function () {
    const pair = pairWithLegBack({ kind: "V3", v3Fee: 500 });
    delete pair.legBack.quoter;

    expect(() => validatePairs([pair])).to.throw(
      'PAIRS_CONFIG_JSON[0].legBack.quoter is required when kind is "V3".'
    );
    expect(() =>
      validatePairs([pairWithLegBack({ kind: "V3", v3Fee: 500, quoter: "not-an-address" })])
    ).to.throw("Invalid address at PAIRS_CONFIG_JSON[0].legBack.quoter");
  });

  it("rejects a V3 leg using SwapRouter02", function () {
    expect(() =>
      validatePairs([
        pairWithLegOut({ kind: "V3", v3Fee: 500, quoter: ROUTER_OUT, router: V3_SWAP_ROUTER_02 }),
      ])
    ).to.throw(
      "PAIRS_CONFIG_JSON[0].legOut.router must be the original Uniswap V3 SwapRouter (0xE592...1564), not SwapRouter02 (0x68b3...Fc45)"
    );
    expect(() =>
      validatePairs([
        pairWithLegBack({ kind: "V3", v3Fee: 500, quoter: ROUTER_BACK, router: V3_SWAP_ROUTER_02 }),
      ])
    ).to.throw(
      "PAIRS_CONFIG_JSON[0].legBack.router must be the original Uniswap V3 SwapRouter (0xE592...1564), not SwapRouter02 (0x68b3...Fc45)"
    );
  });

  it("accepts a V3 leg using the original Uniswap V3 SwapRouter", function () {
    expect(() =>
      validatePairs([
        pairWithLegOut({ kind: "V3", v3Fee: 500, quoter: ROUTER_OUT, router: V3_SWAP_ROUTER }),
      ])
    ).to.not.throw();
    expect(() =>
      validatePairs([
        pairWithLegBack({ kind: "V3", v3Fee: 500, quoter: ROUTER_BACK, router: V3_SWAP_ROUTER }),
      ])
    ).to.not.throw();
  });
});
