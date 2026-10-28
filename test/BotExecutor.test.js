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

    const MockQuoterV3 = await ethers.getContractFactory("MockQuoterV3");
    const quoterB = await MockQuoterV3.deploy(await routerB.getAddress());

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
      legBack: {
        kind: "V3",
        router: await routerB.getAddress(),
        quoter: await quoterB.getAddress(),
        tokenOut: borrowAddr,
        v3Fee: 3000,
      },
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

  function makeSpyContract({
    estimatedGas = 300000n,
    staticCallError = null,
    estimateGasError = null,
    sendError = null,
  } = {}) {
    const calls = [];
    const startArbitrage = async (...args) => {
      calls.push({ method: "send", args });
      if (sendError) throw sendError;
      return {
        hash: `0x${"11".repeat(32)}`,
        wait: async () => ({ status: 1, gasUsed: estimatedGas, gasPrice: 1n, blockNumber: 1 }),
      };
    };
    startArbitrage.estimateGas = async (...args) => {
      calls.push({ method: "estimateGas", args });
      if (estimateGasError) throw estimateGasError;
      return estimatedGas;
    };
    startArbitrage.staticCall = async (...args) => {
      calls.push({ method: "staticCall", args });
      if (staticCallError) throw staticCallError;
      return true;
    };
    return { contract: { startArbitrage }, calls };
  }

  async function opportunityAboveGasFloor({ opportunity, config, estimatedGas = 300000n }) {
    const feeData = await ethers.provider.getFeeData();
    const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
    const gasLimitWithMargin = (estimatedGas * 11500n) / 10000n;
    const gasCost = gasCostInBorrowedToken({
      gasCostWei: gasLimitWithMargin * gasPriceWei,
      pair: opportunity.pair,
      config,
    });
    const gasFloor = (gasCost * 11000n) / 10000n;
    const maxFeeCost = feeData.maxFeePerGas
      ? gasCostInBorrowedToken({
          gasCostWei: feeData.maxFeePerGas * gasLimitWithMargin,
          pair: opportunity.pair,
          config,
        })
      : null;
    const profitFloor = maxFeeCost !== null && maxFeeCost > gasFloor ? maxFeeCost : gasFloor;
    return { gasFloor, opportunity: { ...opportunity, grossProfit: profitFloor + 1n } };
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
    expect(tx.gasLimit).to.equal((result.estimatedGas * 11500n) / 10000n);
    expect(await borrowToken.balanceOf(botWallet.address)).to.equal(opportunity.grossProfit);
  });

  it("does not send a transaction when gas estimation reverts", async function () {
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
    expect(
      gasCostInBorrowedToken({
        gasCostWei: ethers.parseEther("0.001"),
        pair: { borrowedToken: { isStable: true, decimals: 18 } },
        config,
      })
    ).to.equal(ethers.parseEther("1.8"));

    const probe = await maybeExecute({
      opportunity: { ...opportunity, grossProfit: 1n },
      provider: ethers.provider,
      config,
    });
    expect(probe.submitted).to.equal(false);
    expect(probe.error).to.include("gas cost exceeds profit");

    const feeData = await ethers.provider.getFeeData();
    const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
    const gasLimitWithMargin = (probe.estimatedGas * 11500n) / 10000n;
    const gasCostInToken = gasCostInBorrowedToken({
      gasCostWei: gasLimitWithMargin * gasPriceWei,
      pair: opportunity.pair,
      config,
    });
    const gasFloor = (gasCostInToken * 11000n) / 10000n;
    const maxFeeCostInToken = feeData.maxFeePerGas
      ? gasCostInBorrowedToken({
          gasCostWei: feeData.maxFeePerGas * gasLimitWithMargin,
          pair: opportunity.pair,
          config,
        })
      : null;
    const profitFloor =
      maxFeeCostInToken !== null && maxFeeCostInToken > gasFloor ? maxFeeCostInToken : gasFloor;
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
      opportunity: { ...opportunity, grossProfit: profitFloor + margin },
      provider: ethers.provider,
      config,
    });
    expect(above.submitted).to.equal(true);
    expect(above.receipt.status).to.equal(1);
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore + 1);
  });

  it("skips a final staticCall NOT_PROFITABLE above gasFloor without touching the breaker", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-final-sim-")),
      "circuit_breaker.json"
    );
    const config = makeConfig({ circuitBreakerPath: breakerPath });
    const { contract, calls } = makeSpyContract({
      staticCallError: new Error("execution reverted: NOT_PROFITABLE"),
    });
    const { gasFloor, opportunity: staleOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    expect(staleOpportunity.grossProfit).to.be.greaterThan(gasFloor);

    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);
    const result = await maybeExecute({
      opportunity: staleOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(false);
    expect(result.error).to.include("NOT_PROFITABLE");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
    expect(fs.existsSync(breakerPath)).to.equal(false);
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas", "staticCall"]);
  });

  it("uses the same final params for the final staticCall and the send", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { contract, calls } = makeSpyContract();
    const { gasFloor, opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(true);
    const estimate = calls.find((entry) => entry.method === "estimateGas");
    const staticCall = calls.find((entry) => entry.method === "staticCall");
    const send = calls.find((entry) => entry.method === "send");
    expect(staticCall.args[2]).to.equal(send.args[2]);
    expect(staticCall.args[2]).to.deep.equal(send.args[2]);
    expect(estimate.args[2]).to.not.equal(staticCall.args[2]);

    const bufferedMinProfit =
      (freshOpportunity.grossProfit * config.minProfitBufferBps) / 10000n;
    expect(staticCall.args[2].minProfit).to.equal(
      bufferedMinProfit > gasFloor ? bufferedMinProfit : gasFloor
    );
    expect(send.args[3].gasLimit).to.equal((300000n * 11500n) / 10000n);
  });

  it("calls estimateGas, then the final staticCall, then sends", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { contract, calls } = makeSpyContract();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(true);
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas", "staticCall", "send"]);
  });

  it("re-quotes both legs and uses fresh values for the final params", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { contract, calls } = makeSpyContract();
    const { gasFloor } = await opportunityAboveGasFloor({ opportunity, config });
    const freshDelta = ethers.parseEther("1");
    const intermediateOutFresh = opportunity.intermediateOut + 1n;
    const finalOutFresh = opportunity.finalOut + freshDelta;
    const grossProfitFresh = opportunity.grossProfit + freshDelta;
    const quoteCalls = [];
    const quoteLeg = async (_provider, leg, tokenIn, amountIn) => {
      quoteCalls.push({ leg, tokenIn, amountIn });
      return leg === opportunity.pair.legOut ? intermediateOutFresh : finalOutFresh;
    };

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(true);
    expect(quoteCalls).to.have.lengthOf(2);
    expect(quoteCalls[0].leg).to.equal(opportunity.pair.legOut);
    expect(quoteCalls[0].tokenIn).to.equal(opportunity.pair.borrowedToken.address);
    expect(quoteCalls[0].amountIn).to.equal(opportunity.amountIn);
    expect(quoteCalls[1].leg).to.equal(opportunity.pair.legBack);
    expect(quoteCalls[1].tokenIn).to.equal(opportunity.pair.intermediateToken.address);
    expect(quoteCalls[1].amountIn).to.equal(intermediateOutFresh);

    const send = calls.find((entry) => entry.method === "send");
    const staticCall = calls.find((entry) => entry.method === "staticCall");
    expect(staticCall.args[2]).to.equal(send.args[2]);
    expect(staticCall.args[2]).to.deep.equal(send.args[2]);
    const slippageFactor = 10000n - config.slippageBps;
    expect(staticCall.args[2].leg1.minAmountOut).to.equal(
      (intermediateOutFresh * slippageFactor) / 10000n
    );
    expect(staticCall.args[2].leg2.minAmountOut).to.equal(
      (finalOutFresh * slippageFactor) / 10000n
    );
    expect(send.args[2].leg1.minAmountOut).to.equal(
      (intermediateOutFresh * slippageFactor) / 10000n
    );
    expect(send.args[2].leg2.minAmountOut).to.equal((finalOutFresh * slippageFactor) / 10000n);
    const bufferedMinProfit = (grossProfitFresh * config.minProfitBufferBps) / 10000n;
    expect(send.args[2].minProfit).to.equal(
      bufferedMinProfit > gasFloor ? bufferedMinProfit : gasFloor
    );
  });

  it("skips when the fresh re-quote profit falls below the gas floor", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { contract, calls } = makeSpyContract();
    const { gasFloor } = await opportunityAboveGasFloor({ opportunity, config });
    const inferredPremium = opportunity.finalOut - opportunity.amountIn - opportunity.grossProfit;
    const finalOutFresh = opportunity.amountIn + inferredPremium + gasFloor - 1n;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : finalOutFresh;

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.error).to.include("[SKIPPED] re-quote profit below gas floor");
    expect(result.error).to.include(`cached=${opportunity.grossProfit}`);
    expect(result.error).to.include(`fresh=${gasFloor - 1n}`);
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("skips a failed re-quote without counting it in the breaker", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-requote-")),
      "circuit_breaker.json"
    );
    const config = makeConfig({ circuitBreakerPath: breakerPath });
    const { contract, calls } = makeSpyContract();
    const quoteLeg = async () => {
      throw new Error("RPC unavailable");
    };

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(false);
    expect(result.error).to.include("[SKIPPED] re-quote failed: RPC unavailable");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
    expect(fs.existsSync(breakerPath)).to.equal(false);
  });

  it("does not open the breaker after five free staticCall failures", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-free-staticcall-")),
      "circuit_breaker.json"
    );
    const config = makeConfig({ circuitBreakerPath: breakerPath });
    const { contract } = makeSpyContract({
      staticCallError: new Error("execution reverted: OTHER_REASON"),
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await maybeExecute({
        opportunity,
        provider: ethers.provider,
        config,
        contract,
      });
      expect(result.submitted).to.equal(false);
      expect(result.error).to.include("OTHER_REASON");
    }

    expect(fs.existsSync(breakerPath)).to.equal(false);
  });

  it("does not open the breaker after five free estimateGas failures", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-free-estimategas-")),
      "circuit_breaker.json"
    );
    const config = makeConfig({ circuitBreakerPath: breakerPath });
    const { contract } = makeSpyContract({
      estimateGasError: new Error("execution reverted: NOT_PROFITABLE"),
    });

    for (let i = 0; i < 5; i += 1) {
      const result = await maybeExecute({
        opportunity,
        provider: ethers.provider,
        config,
        contract,
      });
      expect(result.submitted).to.equal(false);
      expect(result.error).to.include("NOT_PROFITABLE");
    }

    expect(fs.existsSync(breakerPath)).to.equal(false);
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

  it("skips when the gas-limit margin pushes the estimate above MAX_GAS_LIMIT", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ maxGasLimit: 1000000n });
    const { contract, calls } = makeSpyContract({ estimatedGas: 900000n });

    const result = await maybeExecute({ opportunity, provider: ethers.provider, config, contract });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.estimatedGas).to.equal(900000n);
    expect(result.error).to.include("MAX_GAS_LIMIT");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("skips when maxFeePerGas exceeds the profit cap", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ ethUsdPrice: 1800 });
    const { contract, calls } = makeSpyContract();
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: ethers.parseUnits("100", "gwei") }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };

    const result = await maybeExecute({
      opportunity: { ...opportunity, grossProfit: ethers.parseEther("1") },
      provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.error).to.include("[SKIPPED] maxFeePerGas exceeds profit cap");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
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

  it("opens the circuit breaker after five costly send failures with a receipt", async function () {
    const { botWallet, opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-costly-send-")),
      "circuit_breaker.json"
    );
    const sendError = Object.assign(new Error("transaction reverted on-chain"), {
      receipt: { status: 0, gasUsed: 300000n, gasPrice: 1n },
    });
    const config = makeConfig({ circuitBreakerPath: breakerPath });
    const { contract } = makeSpyContract({ sendError });

    for (let i = 0; i < 5; i += 1) {
      const result = await maybeExecute({
        opportunity,
        provider: ethers.provider,
        config,
        contract,
      });
      expect(result.submitted).to.equal(false);
      expect(result.error).to.include("transaction reverted on-chain");
    }

    const state = JSON.parse(fs.readFileSync(breakerPath, "utf8"));
    expect(state.consecutiveFailures).to.equal(5);
    expect(state.openUntil).to.be.greaterThan(Date.now());

    const nonceBefore = await ethers.provider.getTransactionCount(botWallet.address);
    const blocked = await maybeExecute({ opportunity, provider: ethers.provider, config, contract });
    expect(blocked.submitted).to.equal(false);
    expect(blocked.guard).to.equal("circuitBreaker");
    expect(blocked.error).to.include("CIRCUIT_BREAKER_OPEN");
    expect(await ethers.provider.getTransactionCount(botWallet.address)).to.equal(nonceBefore);
  });
});
