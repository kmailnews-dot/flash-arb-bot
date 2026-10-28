const { expect } = require("chai");
const { redactUrls, sanitizeError } = require("../bot/sanitizeError");

describe("bot/sanitizeError", function () {
  it("redacts https URLs from messages", function () {
    const url = "https://arb-mainnet.g.alchemy.com/v2/SECRET_KEY";

    expect(redactUrls(`request to ${url} failed`)).to.equal("request to [REDACTED_URL] failed");
    expect(sanitizeError({ code: "SERVER_ERROR", shortMessage: `request to ${url} failed` })).to.deep.equal({
      code: "SERVER_ERROR",
      shortMessage: "request to [REDACTED_URL] failed",
    });
  });

  it("redacts ws URLs from messages", function () {
    const url = "wss://arb-mainnet.g.alchemy.com/v2/SECRET_KEY";

    expect(sanitizeError({ code: "WEBSOCKET_ERROR", message: `connection to ${url} closed` })).to.deep.equal({
      code: "WEBSOCKET_ERROR",
      shortMessage: "connection to [REDACTED_URL] closed",
    });
  });

  it("leaves errors without URLs unchanged", function () {
    expect(sanitizeError({ code: "CALL_EXCEPTION", shortMessage: "execution reverted" })).to.deep.equal({
      code: "CALL_EXCEPTION",
      shortMessage: "execution reverted",
    });
  });

  it("handles non-error values without crashing", function () {
    expect(sanitizeError("boom https://rpc.example/v2/SECRET_KEY")).to.deep.equal({
      code: null,
      shortMessage: "boom [REDACTED_URL]",
    });
    expect(sanitizeError(null)).to.deep.equal({ code: null, shortMessage: null });
  });
});
