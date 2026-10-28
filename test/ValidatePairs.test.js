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
    expect(() => validatePairs([pairWithBorrowed({ decimals: 0 })])).to.not.throw();
    expect(() => validatePairs([pairWithBorrowed({ decimals: 18 })])).to.not.throw();
    expect(() => validatePairs([pairWithIntermediate({ decimals: 0 })])).to.not.throw();
    expect(() => validatePairs([pairWithIntermediate({ decimals: 18 })])).to.not.throw();
  });
});
