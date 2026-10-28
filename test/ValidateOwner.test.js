const { expect } = require("chai");
const { ethers } = require("ethers");
const { validateOwner } = require("../scripts/validateOwner");

const OWNER = "0x1111111111111111111111111111111111111111";
const OTHER_OWNER = "0x2222222222222222222222222222222222222222";

describe("scripts/validateOwner", function () {
  it("rejects a missing EXPECTED_OWNER", function () {
    expect(() => validateOwner({ owner: OWNER, expectedOwner: undefined })).to.throw(
      "EXPECTED_OWNER is required"
    );
    expect(() => validateOwner({ owner: OWNER, expectedOwner: null })).to.throw("EXPECTED_OWNER is required");
    expect(() => validateOwner({ owner: OWNER, expectedOwner: "" })).to.throw("EXPECTED_OWNER is required");
  });

  it("accepts an EXPECTED_OWNER that matches the owner", function () {
    const result = validateOwner({ owner: OWNER, expectedOwner: OWNER.toLowerCase() });

    expect(result).to.deep.equal({ ok: true, owner: ethers.getAddress(OWNER) });
  });

  it("rejects an EXPECTED_OWNER that differs from the owner", function () {
    expect(() => validateOwner({ owner: OWNER, expectedOwner: OTHER_OWNER })).to.throw("owner() mismatch");
  });

  it("rejects an owner that is not an address", function () {
    expect(() => validateOwner({ owner: "not-an-address", expectedOwner: OWNER })).to.throw(
      "not a valid Ethereum address"
    );
  });
});
