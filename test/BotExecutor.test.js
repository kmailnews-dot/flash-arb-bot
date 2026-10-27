const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { maybeExecute, gasCostInBorrowedToken } = require("../bot/executor");

const RATE_1_TO_1 = ethers.parseEther("1");
const FLASH_LOAN_PREMIUM_BPS = 5n;

describe("bot/executor maybeExecute", function () {
  async function deployFixture({ legBackRate = ethers.parseEther("1.02"), borrowedDecimals = 18 } = {}) {
    const [deployer] = await ethers.getSigners();
    const botWallet = ethers.Wallet.createRandom();
    await deployer.sendTransaction({ to: botWallet.address, value: ethers.parseEther("10") });
    const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-guards-"));

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
      borrowedToken: { address: borrowAddr, decimals: borrowedDecimals, symbol: "BOR", isStable: true },
      intermediateToken: { address: midAddr, decimals: 18, symbol: "MID" },
      legOut: { kind: "V2", router: await routerA.getAddress(), tokenOut: midAddr },
      legBack: { kind: "V3", router: await routerB.getAddress(), tokenOut: borrowAddr, v3Fee: 3000 },
    };

    const amountIn = ethers.parseUnits("1000", borrowedDecimals);
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
        expectedChainId: 31337,
        maxWalletBalanceEth: 100,
        maxDailyGasEth: 1,
        ethUsdPrice: 1800,
        maxConsecutiveFailures: 5,
        circuitBreakerCooldownMinutes: 60,
        gasSpentPath: path.join(guardDir, "gas_spent.json"),
        circuitBreakerPath: path.join(guardDir, "circuit_breaker.json"),
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

  it("skips an opportunity whose positive gross profit is below the gas cost", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture();
    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);

    const result = await maybeExecute({
      opportunity: { ...opportunity, grossProfit: 1n },
      provider: ethers.provider,
      config: makeConfig(),
    });

    expect(result.submitted).to.equal(false);
    expect(result.estimatedGas).to.be.greaterThan(0n);
    expect(result.error).to.include("[SKIPPED] gas cost exceeds profit");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });

  it("prices 6-decimal stablecoin gas with ETH/USD and enforces the 10% margin", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture({ borrowedDecimals: 6 });
    const config = makeConfig({ ethUsdPrice: 1800 });

    expect(
      gasCostInBorrowedToken({
        gasCostWei: ethers.parseEther("0.001"),
        pair: { borrowedToken: { isStable: true, decimals: 6 } },
        config,
      })
    ).to.equal(1_800_000n);

    const probe = await maybeExecute({
      opportunity: { ...opportunity, grossProfit: 1n },
      provider: ethers.provider,
      config,
    });
    expect(probe.submitted).to.equal(false);
    expect(probe.error).to.include("gas cost exceeds profit");

    const feeData = await ethers.provider.getFeeData();
    const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
    const gasCostInToken = gasCostInBorrowedToken({
      gasCostWei: probe.estimatedGas * gasPriceWei,
      pair: opportunity.pair,
      config,
    });
    const gasFloor = (gasCostInToken * 11000n) / 10000n;
    const margin = gasFloor / 100n + 1n;
    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);

    const below = await maybeExecute({
      opportunity: { ...opportunity, grossProfit: gasFloor - margin },
      provider: ethers.provider,
      config,
    });
    expect(below.submitted).to.equal(false);
    expect(below.error).to.include("[SKIPPED] gas cost exceeds profit");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);

    const above = await maybeExecute({
      opportunity: { ...opportunity, grossProfit: gasFloor + margin },
      provider: ethers.provider,
      config,
    });
    expect(above.submitted).to.equal(true);
    expect(above.receipt.status).to.equal(1);
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore + 1);
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

  it("does not send a transaction when the RPC chainId does not match EXPECTED_CHAIN_ID", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture();
    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config: makeConfig({ expectedChainId: 42161 }),
    });

    expect(result.submitted).to.equal(false);
    expect(result.guard).to.equal("chainId");
    expect(result.error).to.include("CHAIN_ID_MISMATCH");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });

  it("does not send a transaction when the wallet balance exceeds MAX_WALLET_BALANCE_ETH", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture();
    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config: makeConfig({ maxWalletBalanceEth: 0.001 }),
    });

    expect(result.submitted).to.equal(false);
    expect(result.guard).to.equal("walletBalance");
    expect(result.error).to.include("WALLET_BALANCE_ABOVE_MAX");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });

  it("does not send a transaction when the projected daily gas exceeds MAX_DAILY_GAS_ETH", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture();
    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config: makeConfig({ maxDailyGasEth: 0.000001 }),
    });

    expect(result.submitted).to.equal(false);
    expect(result.guard).to.equal("dailyGas");
    expect(result.error).to.include("DAILY_GAS_LIMIT");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });

  it("opens the circuit breaker after MAX_CONSECUTIVE_FAILURES and blocks the next attempt", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture({
      legBackRate: ethers.parseEther("0.999"),
    });
    const breakerPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-breaker-")), "state.json");
    const losingOpportunity = {
      ...opportunity,
      finalOut: (opportunity.amountIn * ethers.parseEther("0.999")) / RATE_1_TO_1,
      grossProfit: 0n,
    };
    const config = makeConfig({
      circuitBreakerPath: breakerPath,
      maxConsecutiveFailures: 5,
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await maybeExecute({
        opportunity: losingOpportunity,
        provider: ethers.provider,
        config,
      });
      expect(result.error).to.include("NOT_PROFITABLE");
    }

    const state = JSON.parse(fs.readFileSync(breakerPath, "utf8"));
    expect(state.consecutiveFailures).to.equal(5);
    expect(state.openUntil).to.be.greaterThan(Date.now());

    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);
    const blocked = await maybeExecute({ opportunity, provider: ethers.provider, config });
    expect(blocked.submitted).to.equal(false);
    expect(blocked.guard).to.equal("circuitBreaker");
    expect(blocked.error).to.include("CIRCUIT_BREAKER_OPEN");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });
});
