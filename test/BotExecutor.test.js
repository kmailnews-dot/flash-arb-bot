const { expect } = require("chai");
const { ethers } = require("hardhat");
const { maybeExecute } = require("../bot/executor");

const RATE_1_TO_1 = ethers.parseEther("1");
const FLASH_LOAN_PREMIUM_BPS = 5n;

describe("bot/executor maybeExecute", function () {
  async function deployFixture({ legBackRate = ethers.parseEther("1.02") } = {}) {
    const [deployer] = await ethers.getSigners();
    const botWallet = ethers.Wallet.createRandom();
    await deployer.sendTransaction({ to: botWallet.address, value: ethers.parseEther("10") });

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const borrowToken = await MockERC20.deploy("Borrow Token", "BOR");
    const midToken = await MockERC20.deploy("Intermediate Token", "MID");

    const MockPool = await ethers.getContractFactory("MockPool");
    const pool = await MockPool.deploy();

    const MockPoolAddressesProvider = await ethers.getContractFactory("MockPoolAddressesProvider");
    const addressesProvider = await MockPoolAddressesProvider.deploy(await pool.getAddress());

    const FlashArbExecutor = await ethers.getContractFactory("FlashArbExecutor");
    const executor = await FlashArbExecutor.deploy(await addressesProvider.getAddress(), botWallet.address);

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const routerA = await MockRouter.deploy();
    const routerB = await MockRouter.deploy();

    const borrowAddr = await borrowToken.getAddress();
    const midAddr = await midToken.getAddress();

    await borrowToken.mint(await pool.getAddress(), ethers.parseEther("1000000"));
    await routerA.setRate(borrowAddr, midAddr, RATE_1_TO_1);
    await routerB.setRate(midAddr, borrowAddr, legBackRate);

    const pair = {
      label: "BOR/MID test pair",
      borrowedToken: { address: borrowAddr, decimals: 18, symbol: "BOR" },
      intermediateToken: { address: midAddr, decimals: 18, symbol: "MID" },
      legOut: { kind: "V2", router: await routerA.getAddress(), tokenOut: midAddr },
      legBack: { kind: "V3", router: await routerB.getAddress(), tokenOut: borrowAddr, v3Fee: 3000 },
    };

    const amountIn = ethers.parseEther("1000");
    const intermediateOut = amountIn;
    const finalOut = (amountIn * ethers.parseEther("1.02")) / RATE_1_TO_1;
    const premium = (amountIn * FLASH_LOAN_PREMIUM_BPS) / 10000n;
    const grossProfit = finalOut - amountIn - premium;

    const opportunity = { pair, amountIn, intermediateOut, finalOut, grossProfit };
    const contractAddress = await executor.getAddress();

    function makeConfig(overrides = {}) {
      return {
        dryRun: false,
        privateKey: botWallet.privateKey,
        contractAddress,
        slippageBps: 50n,
        minProfitBufferBps: 5000n,
        maxGasLimit: 1000000n,
        ...overrides,
      };
    }

    return { deployer, botWallet, borrowToken, pair, opportunity, makeConfig };
  }

  it("simulates, estimates gas and submits within the configured cap", async function () {
    const { botWallet, borrowToken, opportunity, makeConfig } = await deployFixture();

    const result = await maybeExecute({ opportunity, provider: ethers.provider, config: makeConfig() });

    expect(result.submitted).to.equal(true);
    expect(result.error).to.equal(undefined);
    expect(result.receipt.status).to.equal(1);
    expect(result.estimatedGas).to.be.greaterThan(0n);
    expect(result.estimatedGas).to.be.lessThanOrEqual(1000000n);

    const tx = await ethers.provider.getTransaction(result.txHash);
    expect(tx.gasLimit).to.equal(result.estimatedGas);
    expect(await borrowToken.balanceOf(botWallet.address)).to.equal(opportunity.grossProfit);
  });

  it("does not send a transaction when the staticCall simulation reverts", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture({
      legBackRate: ethers.parseEther("0.999"),
    });
    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);

    const losingOpportunity = {
      ...opportunity,
      finalOut: (opportunity.amountIn * ethers.parseEther("0.999")) / RATE_1_TO_1,
      grossProfit: 0n,
    };

    const result = await maybeExecute({ opportunity: losingOpportunity, provider: ethers.provider, config: makeConfig() });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(false);
    expect(result.error).to.include("NOT_PROFITABLE");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });

  it("does not send a transaction when estimateGas exceeds MAX_GAS_LIMIT", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture();
    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config: makeConfig({ maxGasLimit: 1n }),
    });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.estimatedGas).to.be.greaterThan(1n);
    expect(result.error).to.include("MAX_GAS_LIMIT");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });
});
