const { expect } = require("chai");
const { ethers, network } = require("hardhat");

const AAVE_POOL_ADDRESSES_PROVIDER = "0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb";
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const SUSHI_V2_ROUTER = "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506";
const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
const PUBLIC_ARBITRUM_RPC = "https://arb1.arbitrum.io/rpc";

const DEX_KIND = { V2: 0, V3: 1 };

// This suite is opt-in: `npm test` skips it, `npm run test:fork` runs it.
const describeFork = process.env.RUN_FORK_TESTS === "true" ? describe : describe.skip;

function errorMessage(err) {
  return err?.shortMessage || err?.message || String(err);
}

describeFork("Arbitrum fork integration", function () {
  this.timeout(300_000);

  let forkReady = false;
  let executor;
  let owner;

  before(async function () {
    const rawBlock = process.env.ARBITRUM_FORK_BLOCK;
    const blockNumber = Number(rawBlock);
    if (!rawBlock || !Number.isInteger(blockNumber) || blockNumber <= 0) {
      console.warn("[fork] SKIPPED: set ARBITRUM_FORK_BLOCK to a recent Arbitrum block number.");
      this.skip();
    }

    const rpcUrl =
      process.env.ARBITRUM_FORK_RPC_URL || process.env.ARBITRUM_RPC_URL || PUBLIC_ARBITRUM_RPC;

    try {
      const probe = new ethers.JsonRpcProvider(rpcUrl);
      const providerCode = await probe.getCode(AAVE_POOL_ADDRESSES_PROVIDER, blockNumber);
      probe.destroy();
      if (providerCode === "0x") {
        throw new Error(`no state available for Aave provider at block ${blockNumber}`);
      }

      await network.provider.request({
        method: "hardhat_reset",
        params: [{ forking: { jsonRpcUrl: rpcUrl, blockNumber } }],
      });
      forkReady = true;
    } catch (err) {
      const message = errorMessage(err).split(rpcUrl).join("[RPC]");
      console.warn(
        `[fork] SKIPPED: the RPC does not support forking at block ${blockNumber}. ` +
          `An archive node is usually required. Details: ${message}`
      );
      this.skip();
    }

    [owner] = await ethers.getSigners();
    await network.provider.send("hardhat_setBalance", [
      owner.address,
      ethers.toBeHex(ethers.parseEther("100")),
    ]);

    const FlashArbExecutor = await ethers.getContractFactory("FlashArbExecutor");
    executor = await FlashArbExecutor.deploy(AAVE_POOL_ADDRESSES_PROVIDER, owner.address);
    await executor.waitForDeployment();
  });

  after(async function () {
    if (forkReady) {
      await network.provider.request({ method: "hardhat_reset", params: [] });
    }
  });

  function buildParams({ leg2Router = UNISWAP_V3_ROUTER } = {}) {
    return {
      leg1: {
        kind: DEX_KIND.V2,
        router: SUSHI_V2_ROUTER,
        tokenOut: USDC,
        v3Fee: 0,
        minAmountOut: 0n,
      },
      leg2: {
        kind: DEX_KIND.V3,
        router: leg2Router,
        tokenOut: WETH,
        v3Fee: 500,
        minAmountOut: 0n,
      },
      minProfit: 0n,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  it("reverts NOT_PROFITABLE (or succeeds if an edge exists) on a real WETH/USDC round trip", async function () {
    for (const amount of ["0.01", "0.1"].map((value) => ethers.parseUnits(value, 18))) {
      let succeeded = false;
      let failure;

      try {
        const tx = await executor.startArbitrage(WETH, amount, buildParams());
        await tx.wait();
        succeeded = true;
      } catch (err) {
        failure = err;
      }

      if (!succeeded) {
        expect(errorMessage(failure)).to.include(
          "NOT_PROFITABLE",
          `unexpected revert reason for ${amount} WETH: ${errorMessage(failure)}`
        );
      }
    }
  });

  it("reverts when the V3 leg uses the incompatible SwapRouter02", async function () {
    let failure;

    try {
      await executor.startArbitrage.staticCall(
        WETH,
        ethers.parseUnits("0.01", 18),
        buildParams({ leg2Router: SWAP_ROUTER_02 })
      );
    } catch (err) {
      failure = err;
    }

    expect(failure, "SwapRouter02 call should revert").to.not.equal(undefined);
    expect(errorMessage(failure)).to.match(/revert|call_exception|without a reason|unrecognized/i);
    expect(errorMessage(failure).toLowerCase()).to.not.include("not_profitable");
  });
});
