const { expect } = require("chai");
const {
  classifyError,
  shouldRetry,
  backoffMs,
  DEFAULT_BASE_MS,
} = require("../bot/resilient");

describe("bot/resilient", function () {
  it("classifies a NOT_PROFITABLE string as PERMANENT", function () {
    expect(classifyError("NOT_PROFITABLE")).to.equal("PERMANENT");
  });

  it("classifies an ETIMEDOUT string as TRANSIENT", function () {
    expect(classifyError("ETIMEDOUT")).to.equal("TRANSIENT");
  });

  it("classifies an unrecognized string as UNKNOWN", function () {
    expect(classifyError("something else")).to.equal("UNKNOWN");
  });

  it("classifies an object with a transient code as TRANSIENT", function () {
    expect(classifyError({ code: "ETIMEDOUT" })).to.equal("TRANSIENT");
  });

  it("classifies a CIRCUIT_BREAKER_OPEN shortMessage as PERMANENT", function () {
    expect(
      classifyError({ shortMessage: "CIRCUIT_BREAKER_OPEN: cooling down until later" })
    ).to.equal("PERMANENT");
  });

  it("classifies a 429 Too Many Requests message as TRANSIENT", function () {
    expect(classifyError({ message: "429 Too Many Requests" })).to.equal("TRANSIENT");
  });

  it("classifies an empty object as UNKNOWN", function () {
    expect(classifyError({})).to.equal("UNKNOWN");
  });

  it("classifies null and undefined as UNKNOWN", function () {
    expect(classifyError(null)).to.equal("UNKNOWN");
    expect(classifyError(undefined)).to.equal("UNKNOWN");
  });

  it("retries a transient error before the attempt limit", function () {
    expect(
      shouldRetry({ error: { code: "ETIMEDOUT" }, attempt: 0, maxAttempts: 3 })
    ).to.equal(true);
  });

  it("does not retry a transient error at the attempt limit", function () {
    expect(
      shouldRetry({ error: { code: "ETIMEDOUT" }, attempt: 3, maxAttempts: 3 })
    ).to.equal(false);
  });

  it("does not retry a permanent error", function () {
    expect(
      shouldRetry({ error: { code: "NOT_PROFITABLE" }, attempt: 0, maxAttempts: 3 })
    ).to.equal(false);
  });

  it("computes exponential backoff and applies the cap", function () {
    expect(backoffMs({ attempt: 0 })).to.equal(500);
    expect(backoffMs({ attempt: 1 })).to.equal(1000);
    expect(backoffMs({ attempt: 2 })).to.equal(2000);
    expect(backoffMs({ attempt: 3 })).to.equal(4000);
    expect(backoffMs({ attempt: 5 })).to.equal(4000);
  });

  it("falls back to baseMs for a negative or non-integer attempt", function () {
    expect(backoffMs({ attempt: -1 })).to.equal(DEFAULT_BASE_MS);
    expect(backoffMs({ attempt: 1.5 })).to.equal(DEFAULT_BASE_MS);
    expect(backoffMs({ attempt: "2" })).to.equal(DEFAULT_BASE_MS);
    expect(backoffMs({ attempt: -2, baseMs: 250 })).to.equal(250);
  });

  it("does not mutate the error object when classifying it", function () {
    const error = {
      code: "ETIMEDOUT",
      shortMessage: "timeout while quoting",
      message: "request failed",
      reason: "network",
    };
    const snapshot = JSON.stringify(error);

    expect(classifyError(error)).to.equal("TRANSIENT");
    expect(JSON.stringify(error)).to.equal(snapshot);
  });
});
