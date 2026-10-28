const { ethers } = require("ethers");

function validateOwner({ owner, expectedOwner }) {
  if (typeof expectedOwner !== "string" || expectedOwner.trim() === "") {
    throw new Error("EXPECTED_OWNER is required");
  }

  let normalizedOwner;
  try {
    normalizedOwner = ethers.getAddress(owner);
  } catch {
    throw new Error(`owner is not a valid Ethereum address: ${owner}`);
  }

  let normalizedExpectedOwner;
  try {
    normalizedExpectedOwner = ethers.getAddress(expectedOwner.trim());
  } catch {
    throw new Error(`EXPECTED_OWNER is not a valid Ethereum address: ${expectedOwner}`);
  }

  if (normalizedOwner !== normalizedExpectedOwner) {
    throw new Error(`owner() mismatch: got ${normalizedOwner}, expected ${normalizedExpectedOwner}`);
  }

  return { ok: true, owner: normalizedOwner };
}

module.exports = { validateOwner };
