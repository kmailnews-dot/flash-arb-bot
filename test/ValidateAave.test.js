const { expect } = require("chai");
const { ethers } = require("hardhat");
const { AAVE_BY_CHAIN_ID, validateAaveAddresses } = require("../scripts/validateAave");

const CHAIN_ID = 42161;
const EXPECTED_PROVIDER = AAVE_BY_CHAIN_ID[CHAIN_ID].provider;
const EXPECTED_POOL = AAVE_BY_CHAIN_ID[CHAIN_ID].pool;

function mockProvider({ providerCode = "0x6000", poolCode = "0x6000", returnedPool = EXPECTED_POOL } = {}) {
  const encodedPool = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [returnedPool]);

  return {
    getCode: async (address) => {
      const normalized = ethers.getAddress(address);
      if (normalized === ethers.getAddress(EXPECTED_PROVIDER)) return providerCode;
      if (normalized === ethers.getAddress(EXPECTED_POOL)) return poolCode;
      return "0x";
    },
    call: async () => encodedPool,
  };
}

describe("scripts/validateAave", function () {
  it("rejects an unsupported chainId", async function () {
    await expect(
      validateAaveAddresses({
        provider: mockProvider(),
        addressesProvider: EXPECTED_PROVIDER,
        chainId: 1,
      })
    ).to.be.rejectedWith("Unsupported chainId 1");
  });

  it("rejects a provider that does not match the network", async function () {
    await expect(
      validateAaveAddresses({
        provider: mockProvider(),
        addressesProvider: AAVE_BY_CHAIN_ID[421614].provider,
        chainId: CHAIN_ID,
      })
    ).to.be.rejectedWith("mismatch");
  });

  it("rejects a provider that returns the wrong pool", async function () {
    await expect(
      validateAaveAddresses({
        provider: mockProvider({ returnedPool: AAVE_BY_CHAIN_ID[421614].pool }),
        addressesProvider: EXPECTED_PROVIDER,
        chainId: CHAIN_ID,
      })
    ).to.be.rejectedWith("pool mismatch");
  });

  it("rejects a provider without contract code", async function () {
    await expect(
      validateAaveAddresses({
        provider: mockProvider({ providerCode: "0x" }),
        addressesProvider: EXPECTED_PROVIDER,
        chainId: CHAIN_ID,
      })
    ).to.be.rejectedWith("No contract code");
  });

  it("accepts the expected provider and pool", async function () {
    const result = await validateAaveAddresses({
      provider: mockProvider(),
      addressesProvider: EXPECTED_PROVIDER,
      chainId: CHAIN_ID,
    });

    expect(result).to.deep.equal({
      ok: true,
      provider: ethers.getAddress(EXPECTED_PROVIDER),
      pool: ethers.getAddress(EXPECTED_POOL),
    });
  });
});
