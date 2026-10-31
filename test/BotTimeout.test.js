const { expect } = require("chai");
const { withTimeout } = require("../bot/timeout");

describe("bot/timeout", function () {
  it("resolves before timeout", async function () {
    const result = await withTimeout(Promise.resolve(42), 1000, "TEST");
    expect(result).to.equal(42);
  });

  it("rejects with TIMEOUT_<label> after ms", async function () {
    let error;
    try {
      await withTimeout(new Promise(() => {}), 50, "TEST");
    } catch (err) {
      error = err;
    }

    expect(error).to.be.instanceOf(Error);
    expect(error.code).to.equal("TIMEOUT_TEST");
    expect(error.message).to.include("TIMEOUT_TEST");
  });
});
