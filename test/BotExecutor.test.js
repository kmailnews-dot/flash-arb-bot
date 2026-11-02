const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { maybeExecute, gasCostInBorrowedToken, buildFeeOverrides } = require("../bot/executor");
const { FLASH_ARB_EXECUTOR_ABI } = require("../bot/abis");
const { writeExecutionJournal } = require("../bot/persist");

const RATE_1_TO_1 = ethers.parseEther("1");
const FLASH_LOAN_PREMIUM_BPS = 5n;

describe("bot/executor maybeExecute", function () {
  let defaultOwnerAddress = null;

  async function deployFixture({ legBackRate = ethers.parseEther("1.02"), borrowedDecimals = 18 } = {}) {
    const [deployer] = await ethers.getSigners();
    const botWallet = ethers.Wallet.createRandom();
    defaultOwnerAddress = botWallet.address;
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
        executionJournalPath: path.join(guardDir, "executions.json"),
        executionPnlPath: path.join(guardDir, "pnl.jsonl"),
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
    owner = async () => defaultOwnerAddress,
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
    return { contract: { startArbitrage, owner }, calls };
  }

  function makeMockTx({ wait }) {
    return { hash: `0x${"66".repeat(32)}`, wait };
  }

  async function opportunityAboveGasFloor({ opportunity, config, estimatedGas = 300000n }) {
    const feeData = await ethers.provider.getFeeData();
    const decisionGasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
    const gasLimitWithMargin = (estimatedGas * 11500n) / 10000n;
    const gasCost = gasCostInBorrowedToken({
      gasCostWei: gasLimitWithMargin * decisionGasPriceWei,
      pair: opportunity.pair,
      config,
    });
    const gasFloor = (gasCost * 11000n) / 10000n;
    const margin = gasFloor / 100n + 1n;
    return {
      gasFloor,
      gasCost,
      opportunity: { ...opportunity, grossProfit: gasFloor + margin },
    };
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
    expect(staticCall.args[2].minProfitBps).to.equal(BigInt(config.minProfitBps ?? 0));
    expect(send.args[3].gasLimit).to.equal((300000n * 11500n) / 10000n);
  });

  it("forwards pair.minProfitBps to staticCall and send", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { contract, calls } = makeSpyContract();
    const pairOverride = { ...opportunity.pair, minProfitBps: 10 };
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity: { ...opportunity, pair: pairOverride },
      config,
    });

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(true);
    const staticCall = calls.find((entry) => entry.method === "staticCall");
    const send = calls.find((entry) => entry.method === "send");
    expect(staticCall.args[2].minProfitBps).to.equal(10n);
    expect(send.args[2].minProfitBps).to.equal(10n);
  });

  it("uses adaptive minProfitBps when it exceeds pair floor", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ effectiveMinProfitBps: 20 });
    const { contract, calls } = makeSpyContract();
    const pairOverride = { ...opportunity.pair, minProfitBps: 10 };
    const feeData = await ethers.provider.getFeeData();
    const decisionGasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
    const gasLimitWithMargin = (300000n * 11500n) / 10000n;
    const gasCost = gasCostInBorrowedToken({
      gasCostWei: gasLimitWithMargin * decisionGasPriceWei,
      pair: pairOverride,
      config,
    });
    const grossProfitFresh = gasCost + ethers.parseEther("10");
    const inferredPremium = opportunity.finalOut - opportunity.amountIn - opportunity.grossProfit;
    const finalOutFresh = opportunity.amountIn + inferredPremium + grossProfitFresh;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : finalOutFresh;

    const result = await maybeExecute({
      opportunity: { ...opportunity, pair: pairOverride },
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(true);
    const staticCall = calls.find((entry) => entry.method === "staticCall");
    const send = calls.find((entry) => entry.method === "send");
    expect(staticCall.args[2].minProfitBps).to.equal(20n);
    expect(send.args[2].minProfitBps).to.equal(20n);
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
    expect(send.args[2].minProfitBps).to.equal(BigInt(config.minProfitBps ?? 0));
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

  it("T5: a failed second re-quote does not count in the breaker", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-requote-second-")),
      "circuit_breaker.json"
    );
    const config = makeConfig({ circuitBreakerPath: breakerPath });
    const { contract, calls } = makeSpyContract();
    let quoteCalls = 0;
    const quoteLeg = async () => {
      quoteCalls += 1;
      if (quoteCalls === 2) throw new Error("RPC unavailable");
      return opportunity.intermediateOut;
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
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({
      opportunity: { ...opportunity, grossProfit: ethers.parseEther("1") },
      provider,
      config,
      contract,
      quoteLeg,
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

  it("reconciles gas spent to the receipt cost when send throws with a receipt", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ maxDailyGasEth: 0.01 });
    const sendError = Object.assign(new Error("transaction reverted on-chain"), {
      receipt: { gasUsed: 100000n, gasPrice: 5n },
    });
    const { contract } = makeSpyContract({ sendError });
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({
      opportunity,
      provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(false);
    expect(result.error).to.include("transaction reverted on-chain");

    const reservedGasWei = (300000n * 11500n) / 10000n;
    const actualGasWei = 100000n * 5n;
    expect(actualGasWei - reservedGasWei).to.equal(155000n);

    const state = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));
    expect(state.gasSpentWei).to.equal(actualGasWei.toString());
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

  it("blocks when the revert rate window exceeds threshold", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const records = {};
    for (let i = 0; i < 20; i += 1) {
      records[`exec-${i}`] = {
        id: `exec-${i}`,
        status: i < 15 ? "REVERTED" : "CONFIRMED",
        lastUpdateAt: 1000 + i,
      };
    }
    await writeExecutionJournal({ version: 1, records }, config.executionJournalPath);
    const { contract, calls } = makeSpyContract();

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(false);
    expect(result.guard).to.equal("circuitBreaker");
    expect(result.error).to.include("revert rate");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("skips when the fresh net profit is below MIN_PROFIT_USD", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ minProfitUsd: 5 });
    const { contract, calls } = makeSpyContract();
    const { gasFloor, gasCost, opportunity: aboveFloorOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const grossProfitFresh = aboveFloorOpportunity.grossProfit;
    expect(grossProfitFresh).to.be.greaterThan(gasFloor);
    const inferredPremium = opportunity.finalOut - opportunity.amountIn - opportunity.grossProfit;
    const finalOutFresh = opportunity.amountIn + inferredPremium + grossProfitFresh;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : finalOutFresh;

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    const netProfitFresh = grossProfitFresh - gasCost;
    const threshold = 5n * 10n ** 18n;
    expect(netProfitFresh).to.be.lessThan(threshold);
    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.error).to.include("[SKIPPED] fresh net profit below MIN_PROFIT_USD");
    expect(result.error).to.include(`net=${netProfitFresh}`);
    expect(result.error).to.include(`threshold=${threshold}`);
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("sends when the fresh net profit meets MIN_PROFIT_USD", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ minProfitUsd: 5 });
    const { contract, calls } = makeSpyContract();
    const feeData = await ethers.provider.getFeeData();
    const gasPriceWei = feeData.gasPrice ?? feeData.maxFeePerGas;
    const gasLimitWithMargin = (300000n * 11500n) / 10000n;
    const gasCost = gasCostInBorrowedToken({
      gasCostWei: gasLimitWithMargin * gasPriceWei,
      pair: opportunity.pair,
      config,
    });
    const grossProfitFresh = gasCost + ethers.parseEther("10");
    const inferredPremium = opportunity.finalOut - opportunity.amountIn - opportunity.grossProfit;
    const finalOutFresh = opportunity.amountIn + inferredPremium + grossProfitFresh;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : finalOutFresh;

    const result = await maybeExecute({
      opportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(true);
    expect(result.receipt.status).to.equal(1);
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas", "staticCall", "send"]);
  });

  it("skips when fresh net profit passes MIN_PROFIT_USD but is below MIN_PROFIT_BPS", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ minProfitUsd: 5, minProfitBps: 30, ethUsdPrice: 1800 });
    const { contract, calls } = makeSpyContract();
    const feeData = await ethers.provider.getFeeData();
    const decisionGasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
    const gasLimitWithMargin = (300000n * 11500n) / 10000n;
    const gasCost = gasCostInBorrowedToken({
      gasCostWei: gasLimitWithMargin * decisionGasPriceWei,
      pair: opportunity.pair,
      config,
    });
    const amountIn = ethers.parseUnits("10000", 18);
    const grossProfitFresh = gasCost + ethers.parseEther("10");
    const premium = (amountIn * 5n) / 10000n;
    const finalOut = amountIn + premium + grossProfitFresh;
    const cachedOpportunity = {
      ...opportunity,
      amountIn,
      intermediateOut: amountIn,
      finalOut,
      grossProfit: grossProfitFresh,
    };
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? amountIn : finalOut;

    const result = await maybeExecute({
      opportunity: cachedOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    const netProfitBps = (ethers.parseEther("10") * 10000n) / amountIn;
    expect(netProfitBps).to.equal(10n);
    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.error).to.include("[SKIPPED] fresh net profit below MIN_PROFIT_BPS");
    expect(result.error).to.include(`net=${ethers.parseEther("10")}`);
    expect(result.error).to.include(`notional=${amountIn}`);
    expect(result.error).to.include(`netBps=${netProfitBps}`);
    expect(result.error).to.include("thresholdBps=30");
    expect(result.error).to.include("minProfitUsd=5");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("skips when MIN_PROFIT_USD cannot be priced for the borrowed token", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const pair = {
      ...opportunity.pair,
      borrowedToken: { ...opportunity.pair.borrowedToken, isStable: false, isWeth: false },
    };
    const config = makeConfig({ minProfitUsd: 5 });
    const { contract, calls } = makeSpyContract();

    const result = await maybeExecute({
      opportunity: { ...opportunity, pair },
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.error).to.include("[SKIPPED] cannot price MIN_PROFIT_USD for token BOR");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("sends the verified EIP-1559 fee overrides", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ ethUsdPrice: 1800 });
    const { contract, calls } = makeSpyContract();
    const maxFeePerGas = ethers.parseUnits("30", "gwei");
    const maxPriorityFeePerGas = ethers.parseUnits("1", "gwei");
    const provider = {
      getFeeData: async () => ({ gasPrice: null, maxFeePerGas, maxPriorityFeePerGas }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const cachedOpportunity = { ...opportunity, grossProfit: ethers.parseEther("200") };
    const inferredPremium =
      cachedOpportunity.finalOut - cachedOpportunity.amountIn - cachedOpportunity.grossProfit;
    const grossProfitFresh = ethers.parseEther("100");
    const finalOutFresh = cachedOpportunity.amountIn + inferredPremium + grossProfitFresh;
    const quoteLeg = async (_provider, leg) =>
      leg === cachedOpportunity.pair.legOut ? cachedOpportunity.intermediateOut : finalOutFresh;

    const result = await maybeExecute({
      opportunity: cachedOpportunity,
      provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(true);
    const send = calls.find((entry) => entry.method === "send");
    expect(send.args[3].gasLimit).to.equal((300000n * 11500n) / 10000n);
    expect(send.args[3].maxFeePerGas).to.equal(maxFeePerGas);
    expect(send.args[3].maxPriorityFeePerGas).to.equal(maxPriorityFeePerGas);
    expect(send.args[3]).to.not.have.property("gasPrice");
  });

  it("sends the verified legacy gasPrice override", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ ethUsdPrice: 1800 });
    const { contract, calls } = makeSpyContract();
    const gasPrice = ethers.parseUnits("10", "gwei");
    const provider = {
      getFeeData: async () => ({ gasPrice, maxFeePerGas: null, maxPriorityFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const inferredPremium = opportunity.finalOut - opportunity.amountIn - opportunity.grossProfit;
    const grossProfitFresh = ethers.parseEther("100");
    const finalOutFresh = opportunity.amountIn + inferredPremium + grossProfitFresh;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : finalOutFresh;

    const result = await maybeExecute({
      opportunity,
      provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(true);
    const send = calls.find((entry) => entry.method === "send");
    expect(send.args[3].gasPrice).to.equal(gasPrice);
    expect(send.args[3]).to.not.have.property("maxFeePerGas");
    expect(send.args[3]).to.not.have.property("maxPriorityFeePerGas");
  });

  it("adds no fee override when feeData is empty", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const { contract, calls } = makeSpyContract();
    const provider = {
      getFeeData: async () => ({}),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };

    const result = await maybeExecute({
      opportunity,
      provider,
      config: makeConfig(),
      contract,
    });

    expect(buildFeeOverrides({})).to.deep.equal({});
    expect(result.submitted).to.equal(false);
    expect(result.error).to.include("gasPrice is 0");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("treats a tx.wait timeout as ambiguous and keeps the gas reservation", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    const timeoutError = Object.assign(new Error("timed out"), { code: "TIMEOUT" });
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () => ({
        hash: `0x${"22".repeat(32)}`,
        wait: async () => {
          throw timeoutError;
        },
      }),
    };
    contract.startArbitrage.estimateGas = async () => 300000n;
    contract.startArbitrage.staticCall = async () => true;

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    const feeData = await ethers.provider.getFeeData();
    const decisionGasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
    const reservedGasWei = ((300000n * 11500n) / 10000n) * decisionGasPriceWei;
    const breaker = JSON.parse(fs.readFileSync(config.circuitBreakerPath, "utf8"));
    const gasSpent = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));

    expect(result.submitted).to.equal(true);
    expect(result.error).to.include("TIMEOUT_WAIT_RECEIPT");
    expect(breaker.consecutiveFailures).to.equal(1);
    expect(gasSpent.gasSpentWei).to.equal(reservedGasWei.toString());
  });

  it("retries waitForReceipt on transient ETIMEDOUT until the receipt arrives", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    let waitCalls = 0;
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () =>
        makeMockTx({
          wait: async () => {
            waitCalls += 1;
            if (waitCalls < 3) {
              throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
            }
            return { status: 1, gasUsed: 100000n, gasPrice: 1n, blockNumber: 1 };
          },
        }),
    };
    contract.startArbitrage.estimateGas = async () => 300000n;
    contract.startArbitrage.staticCall = async () => true;

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(waitCalls).to.equal(3);
    expect(result.submitted).to.equal(true);
    expect(result.error).to.equal(undefined);
    expect(result.receipt.status).to.equal(1);
  });

  it("throws the last transient wait error after three attempts and counts one breaker failure", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    let waitCalls = 0;
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () =>
        makeMockTx({
          wait: async () => {
            waitCalls += 1;
            throw Object.assign(new Error(`timed out ${waitCalls}`), { code: "ETIMEDOUT" });
          },
        }),
    };
    contract.startArbitrage.estimateGas = async () => 300000n;
    contract.startArbitrage.staticCall = async () => true;

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    const breaker = JSON.parse(fs.readFileSync(config.circuitBreakerPath, "utf8"));

    expect(waitCalls).to.equal(3);
    expect(result.submitted).to.equal(true);
    expect(result.error).to.include("timed out 3");
    expect(breaker.consecutiveFailures).to.equal(1);
  });

  it("does not retry waitForReceipt on a permanent error", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    let waitCalls = 0;
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () =>
        makeMockTx({
          wait: async () => {
            waitCalls += 1;
            throw Object.assign(new Error("NOT_PROFITABLE"), { code: "NOT_PROFITABLE" });
          },
        }),
    };
    contract.startArbitrage.estimateGas = async () => 300000n;
    contract.startArbitrage.staticCall = async () => true;

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(waitCalls).to.equal(1);
    expect(result.submitted).to.equal(true);
    expect(result.error).to.include("NOT_PROFITABLE");
  });

  it("treats a send error without receipt as ambiguous and keeps the gas reservation", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    const { contract } = makeSpyContract({ sendError: new Error("broadcast failed") });

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    const feeData = await ethers.provider.getFeeData();
    const decisionGasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
    const reservedGasWei = ((300000n * 11500n) / 10000n) * decisionGasPriceWei;
    const breaker = JSON.parse(fs.readFileSync(config.circuitBreakerPath, "utf8"));
    const gasSpent = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));

    expect(result.submitted).to.equal(true);
    expect(result.error).to.include("broadcast failed");
    expect(breaker.consecutiveFailures).to.equal(1);
    expect(gasSpent.gasSpentWei).to.equal(reservedGasWei.toString());
  });

  it("records the tx hash from err.transaction when the send throws ambiguously", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const recoveredHash = `0x${"bb".repeat(32)}`;
    const sendError = Object.assign(new Error("timed out"), {
      transaction: { hash: recoveredHash },
    });
    const { contract } = makeSpyContract({ sendError });
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });
    expect(result.submitted).to.equal(true);
    expect(result.journalStatus).to.equal("UNKNOWN");
    const journal = JSON.parse(fs.readFileSync(config.executionJournalPath, "utf8"));
    expect(journal.records[result.journalId]).to.include({
      status: "UNKNOWN",
      txHash: recoveredHash,
    });
  });

  it("records a null tx hash when err.transaction is absent", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const { contract } = makeSpyContract({ sendError: new Error("broadcast failed") });
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });
    expect(result.submitted).to.equal(true);
    expect(result.journalStatus).to.equal("UNKNOWN");
    const journal = JSON.parse(fs.readFileSync(config.executionJournalPath, "utf8"));
    expect(journal.records[result.journalId]).to.include({
      status: "UNKNOWN",
      txHash: null,
    });
  });

  it("fails closed when the contract has no owner function", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const calls = [];
    const contract = {
      startArbitrage: async () => {
        calls.push("send");
        return {
          hash: `0x${"aa".repeat(32)}`,
          wait: async () => ({ status: 1, gasUsed: 300000n, gasPrice: 1n }),
        };
      },
    };
    contract.startArbitrage.estimateGas = async () => {
      calls.push("estimateGas");
      return 300000n;
    };
    contract.startArbitrage.staticCall = async () => {
      calls.push("staticCall");
      return true;
    };

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(false);
    expect(result.guard).to.equal("contractOwner");
    expect(result.error).to.include("OWNER_GUARD_UNAVAILABLE");
    expect(calls).to.deep.equal(["estimateGas"]);
  });

  it("rechecks the circuit breaker after reservation and before send", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-breaker-recheck-")),
      "circuit_breaker.json"
    );
    const config = makeConfig({ circuitBreakerPath: breakerPath });
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    const methods = [];
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () => {
        methods.push("send");
        return { hash: `0x${"33".repeat(32)}`, wait: async () => ({ status: 1 }) };
      },
    };
    contract.startArbitrage.estimateGas = async () => {
      methods.push("estimateGas");
      return 300000n;
    };
    contract.startArbitrage.staticCall = async () => {
      methods.push("staticCall");
      fs.writeFileSync(
        breakerPath,
        `${JSON.stringify({ consecutiveFailures: 5, openUntil: Date.now() + 60_000 })}\n`,
        "utf8"
      );
      return true;
    };

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(false);
    expect(result.guard).to.equal("circuitBreaker");
    expect(result.error).to.include("CIRCUIT_BREAKER_OPEN");
    expect(methods).to.deep.equal(["estimateGas", "staticCall"]);
  });

  it("reserves gas at maxFeePerGas rather than gasPrice before sending", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ ethUsdPrice: 1800 });
    const maxFeePerGas = 5n;
    const gasPrice = 1n;
    const provider = {
      getFeeData: async () => ({ gasPrice, maxFeePerGas, maxPriorityFeePerGas: 1n }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    let reservedDuringSend;
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () => {
        reservedDuringSend = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8")).gasSpentWei;
        return {
          hash: `0x${"44".repeat(32)}`,
          wait: async () => ({ status: 1, gasUsed: 100000n, gasPrice: 1n, blockNumber: 1 }),
        };
      },
    };
    contract.startArbitrage.estimateGas = async () => 300000n;
    contract.startArbitrage.staticCall = async () => true;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({ opportunity, provider, config, contract, quoteLeg });

    const gasLimitWithMargin = (300000n * 11500n) / 10000n;
    const expectedReservation = gasLimitWithMargin * maxFeePerGas;
    const gasSpent = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));

    expect(result.submitted).to.equal(true);
    expect(BigInt(reservedDuringSend)).to.equal(expectedReservation);
    expect(gasSpent.gasSpentWei).to.equal((100000n * 1n).toString());
  });

  it("includes receipt.l1Fee in the actual gas cost", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ maxDailyGasEth: 0.01 });
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () => ({
        hash: `0x${"cc".repeat(32)}`,
        wait: async () => ({
          status: 1,
          gasUsed: 100000n,
          gasPrice: 1n,
          l1Fee: 500n,
          blockNumber: 1,
        }),
      }),
    };
    contract.startArbitrage.estimateGas = async () => 300000n;
    contract.startArbitrage.staticCall = async () => true;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(true);
    const gasSpent = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));
    expect(gasSpent.gasSpentWei).to.equal("100500");
  });

  it("treats a missing receipt.l1Fee as zero", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ maxDailyGasEth: 0.01 });
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () => ({
        hash: `0x${"cd".repeat(32)}`,
        wait: async () => ({
          status: 1,
          gasUsed: 100000n,
          gasPrice: 1n,
          blockNumber: 1,
        }),
      }),
    };
    contract.startArbitrage.estimateGas = async () => 300000n;
    contract.startArbitrage.staticCall = async () => true;
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });

    expect(result.submitted).to.equal(true);
    const gasSpent = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));
    expect(gasSpent.gasSpentWei).to.equal("100000");
  });

  it("rejects on the maxFeePerGas-based floor when the profit clears only the gasPrice cost", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ ethUsdPrice: 1800 });
    const gasPrice = 1n;
    const maxFeePerGas = 5n;
    const provider = {
      getFeeData: async () => ({ gasPrice, maxFeePerGas, maxPriorityFeePerGas: 1n }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const { contract, calls } = makeSpyContract();
    const gasLimitWithMargin = (300000n * 11500n) / 10000n;
    const gasPriceCost = gasCostInBorrowedToken({
      gasCostWei: gasLimitWithMargin * gasPrice,
      pair: opportunity.pair,
      config,
    });
    const maxFeeFloor =
      (gasCostInBorrowedToken({
        gasCostWei: gasLimitWithMargin * maxFeePerGas,
        pair: opportunity.pair,
        config,
      }) *
        11000n) /
      10000n;
    const grossProfit = (gasPriceCost + maxFeeFloor) / 2n;

    expect(grossProfit).to.be.greaterThan(gasPriceCost);
    expect(grossProfit).to.be.lessThan(maxFeeFloor);

    const result = await maybeExecute({
      opportunity: { ...opportunity, grossProfit },
      provider,
      config,
      contract,
    });

    expect(result.submitted).to.equal(false);
    expect(result.simulated).to.equal(true);
    expect(result.error).to.include("[SKIPPED] gas cost exceeds profit");
    expect(calls.map((entry) => entry.method)).to.deep.equal(["estimateGas"]);
  });

  it("rejects a concurrent call while a transaction is in flight", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    const calls = [];
    let releaseSend;
    let markSendStarted;
    const sendGate = new Promise((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise((resolve) => {
      markSendStarted = resolve;
    });
    let sendCount = 0;
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async () => {
        calls.push("send");
        sendCount += 1;
        if (sendCount === 1) {
          markSendStarted();
          await sendGate;
        }
        return {
          hash: `0x${"55".repeat(32)}`,
          wait: async () => ({ status: 1, gasUsed: 300000n, gasPrice: 1n, blockNumber: 1 }),
        };
      },
    };
    contract.startArbitrage.estimateGas = async () => {
      calls.push("estimateGas");
      return 300000n;
    };
    contract.startArbitrage.staticCall = async () => {
      calls.push("staticCall");
      return true;
    };

    const firstPromise = maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });
    await sendStarted;
    const second = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
    });
    releaseSend();
    const first = await firstPromise;

    expect(second).to.deep.equal({ submitted: false, error: "TRANSACTION_IN_FLIGHT" });
    expect(first.submitted).to.equal(true);
    expect(calls).to.deep.equal(["estimateGas", "staticCall", "send"]);
  });

  it("returns TIMEOUT_ESTIMATE_GAS and releases txInFlight when estimateGas hangs", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ rpcTimeoutMs: 50 });
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const { contract: hangingContract } = makeSpyContract();
    let releaseEstimate;
    const estimateGate = new Promise((resolve) => {
      releaseEstimate = resolve;
    });
    hangingContract.startArbitrage.estimateGas = async () => {
      await estimateGate;
      return 300000n;
    };

    let first;
    try {
      first = await maybeExecute({
        opportunity: freshOpportunity,
        provider,
        config,
        contract: hangingContract,
      });
    } finally {
      releaseEstimate();
    }

    expect(first.submitted).to.equal(false);
    expect(first.error).to.include("TIMEOUT_ESTIMATE_GAS");

    const { contract } = makeSpyContract();
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const second = await maybeExecute({
      opportunity: freshOpportunity,
      provider,
      config,
      contract,
      quoteLeg,
    });

    expect(second.submitted).to.equal(true);
  });

  it("returns TRANSACTION_IN_FLIGHT_STALE when txInFlight exceeds txInFlightMaxMs", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ txInFlightMaxMs: 50 });
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({ opportunity, config });
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const { contract } = makeSpyContract();
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    let releaseEstimate;
    let markEstimateStarted;
    const estimateGate = new Promise((resolve) => {
      releaseEstimate = resolve;
    });
    const estimateStarted = new Promise((resolve) => {
      markEstimateStarted = resolve;
    });
    contract.startArbitrage.estimateGas = async () => {
      markEstimateStarted();
      await estimateGate;
      return 300000n;
    };

    let first;
    let firstPromise;
    try {
      firstPromise = maybeExecute({
        opportunity: freshOpportunity,
        provider,
        config,
        contract,
        quoteLeg,
      });
      await estimateStarted;
      await new Promise((resolve) => setTimeout(resolve, 60));

      const second = await maybeExecute({
        opportunity: freshOpportunity,
        provider,
        config,
        contract,
        quoteLeg,
      });
      expect(second.submitted).to.equal(false);
      expect(second.error).to.equal("TRANSACTION_IN_FLIGHT_STALE");
      expect(second.stale).to.equal(true);
      expect(second.elapsedMs).to.be.greaterThan(50);
    } finally {
      releaseEstimate();
      if (firstPromise) {
        first = await firstPromise;
      }
    }

    expect(first.submitted).to.equal(true);
  });

  it("releases the gas reservation and skips the breaker on INSUFFICIENT_FUNDS", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ maxDailyGasEth: 0.01 });
    const sendError = Object.assign(new Error("insufficient funds"), {
      code: "INSUFFICIENT_FUNDS",
    });
    const { contract } = makeSpyContract({ sendError });
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({ opportunity, provider, config, contract, quoteLeg });

    expect(result.submitted).to.equal(false);
    expect(result.error).to.include("insufficient funds");
    const state = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));
    expect(state.gasSpentWei).to.equal("0");
  });

  it("treats UNSUPPORTED_OPERATION as ambiguous and keeps the reservation", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig({ maxDailyGasEth: 0.01 });
    const sendError = Object.assign(new Error("unsupported operation"), {
      code: "UNSUPPORTED_OPERATION",
    });
    const { contract } = makeSpyContract({ sendError });
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({ opportunity, provider, config, contract, quoteLeg });

    expect(result.submitted).to.equal(true);
    expect(result.error).to.include("unsupported operation");
    const feeData = await provider.getFeeData();
    const decisionGasPriceWei = feeData.maxFeePerGas ?? feeData.gasPrice;
    const reserved = ((300000n * 11500n) / 10000n) * decisionGasPriceWei;
    const state = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));
    expect(state.gasSpentWei).to.equal(reserved.toString());
  });

  it("releases the reservation when breakerBeforeSend fails after reservation", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const breakerPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-prebreaker-")),
      "circuit_breaker.json"
    );
    const config = makeConfig({
      maxDailyGasEth: 0.01,
      circuitBreakerPath: breakerPath,
    });
    const { contract } = makeSpyContract();
    contract.startArbitrage.staticCall = async (...args) => {
      fs.writeFileSync(
        breakerPath,
        `${JSON.stringify({
          consecutiveFailures: 5,
          openUntil: Date.now() + 60_000,
          lastFailureAt: Date.now(),
        })}\n`,
        "utf8"
      );
      return true;
    };
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;

    const result = await maybeExecute({ opportunity, provider, config, contract, quoteLeg });

    expect(result.submitted).to.equal(false);
    expect(result.guard).to.equal("circuitBreaker");
    const state = JSON.parse(fs.readFileSync(config.gasSpentPath, "utf8"));
    expect(state.gasSpentWei).to.equal("0");
  });

  it("does not count a TRANSIENT send error against the breaker", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const sendError = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
    const { contract } = makeSpyContract({ sendError });
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });
    expect(result.submitted).to.equal(true);
    expect(result.journalStatus).to.equal("UNKNOWN");
    expect(result.error).to.include("timed out");
    const breaker = fs.existsSync(config.circuitBreakerPath)
      ? JSON.parse(fs.readFileSync(config.circuitBreakerPath, "utf8"))
      : { consecutiveFailures: 0 };
    expect(breaker.consecutiveFailures ?? 0).to.equal(0);
  });

  it("counts a PERMANENT send error against the breaker", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const sendError = Object.assign(new Error("not profitable"), { code: "NOT_PROFITABLE" });
    const { contract } = makeSpyContract({ sendError });
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });
    expect(result.submitted).to.equal(true);
    expect(result.journalStatus).to.equal("UNKNOWN");
    expect(result.error).to.include("not profitable");
    const breaker = JSON.parse(fs.readFileSync(config.circuitBreakerPath, "utf8"));
    expect(breaker.consecutiveFailures).to.equal(1);
  });

  it("counts an UNKNOWN send error against the breaker", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const { contract } = makeSpyContract({ sendError: new Error("broadcast failed") });
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider: ethers.provider,
      config,
      contract,
      quoteLeg,
    });
    expect(result.submitted).to.equal(true);
    expect(result.journalStatus).to.equal("UNKNOWN");
    const breaker = JSON.parse(fs.readFileSync(config.circuitBreakerPath, "utf8"));
    expect(breaker.consecutiveFailures).to.equal(1);
  });

  it("passes an explicit nonce to startArbitrage when dryRun is false", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const provider = {
      getTransactionCount: async () => 42,
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const calls = [];
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async (...args) => {
        calls.push({ method: "send", args });
        return {
          hash: `0x${"99".repeat(32)}`,
          wait: async () => ({ status: 1, gasUsed: 300000n, gasPrice: 1n, blockNumber: 1 }),
        };
      },
    };
    contract.startArbitrage.estimateGas = async (...args) => {
      calls.push({ method: "estimateGas", args });
      return 300000n;
    };
    contract.startArbitrage.staticCall = async (...args) => {
      calls.push({ method: "staticCall", args });
      return true;
    };
    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider,
      config,
      contract,
      quoteLeg,
    });
    expect(result.submitted).to.equal(true);
    const send = calls.find((entry) => entry.method === "send");
    expect(send.args[3].nonce).to.equal(42);
  });

  it("does not pass a nonce when the provider lacks getTransactionCount", async function () {
    const { opportunity, makeConfig } = await deployFixture();
    const config = makeConfig();
    const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
      opportunity,
      config,
    });
    const provider = {
      getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
      getNetwork: () => ethers.provider.getNetwork(),
      getBalance: (address) => ethers.provider.getBalance(address),
    };
    const quoteLeg = async (_provider, leg) =>
      leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
    const calls = [];
    const contract = {
      owner: async () => defaultOwnerAddress,
      startArbitrage: async (...args) => {
        calls.push({ method: "send", args });
        return {
          hash: `0x${"9a".repeat(32)}`,
          wait: async () => ({ status: 1, gasUsed: 300000n, gasPrice: 1n, blockNumber: 1 }),
        };
      },
    };
    contract.startArbitrage.estimateGas = async (...args) => {
      calls.push({ method: "estimateGas", args });
      return 300000n;
    };
    contract.startArbitrage.staticCall = async (...args) => {
      calls.push({ method: "staticCall", args });
      return true;
    };
    const result = await maybeExecute({
      opportunity: freshOpportunity,
      provider,
      config,
      contract,
      quoteLeg,
    });
    expect(result.submitted).to.equal(true);
    const send = calls.find((entry) => entry.method === "send");
    expect(send.args[3]).to.not.have.property("nonce");
  });

  describe("bot/executor execution journal", function () {
    function readJournal(filePath) {
      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }

    it("writes SIGNED before the transaction is sent", async function () {
      const { opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const txHash = `0x${"77".repeat(32)}`;
      let statusDuringSend;
      const contract = {
        owner: async () => defaultOwnerAddress,
        startArbitrage: async () => {
          statusDuringSend = Object.values(
            readJournal(config.executionJournalPath).records
          )[0]?.status;
          return {
            hash: txHash,
            wait: async () => ({ status: 1, gasUsed: 100000n, gasPrice: 1n, blockNumber: 1 }),
          };
        },
      };
      contract.startArbitrage.estimateGas = async () => 300000n;
      contract.startArbitrage.staticCall = async () => true;

      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });

      expect(statusDuringSend).to.equal("SIGNED");
      expect(result.journalId).to.be.a("string");
      expect(result.journalStatus).to.equal("CONFIRMED");
      expect(readJournal(config.executionJournalPath).records[result.journalId]).to.include({
        status: "CONFIRMED",
        txHash,
      });
    });

    it("records SUBMITTED with the tx hash before waiting for the receipt", async function () {
      const { opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const txHash = `0x${"78".repeat(32)}`;
      let statusDuringWait;
      let hashDuringWait;
      const contract = {
        owner: async () => defaultOwnerAddress,
        startArbitrage: async () => ({
          hash: txHash,
          nonce: 7,
          wait: async () => {
            const record = Object.values(
              readJournal(config.executionJournalPath).records
            )[0];
            statusDuringWait = record?.status;
            hashDuringWait = record?.txHash;
            return { status: 1, gasUsed: 100000n, gasPrice: 1n, blockNumber: 1 };
          },
        }),
      };
      contract.startArbitrage.estimateGas = async () => 300000n;
      contract.startArbitrage.staticCall = async () => true;

      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });

      expect(statusDuringWait).to.equal("SUBMITTED");
      expect(hashDuringWait).to.equal(txHash);
      expect(result.journalStatus).to.equal("CONFIRMED");
      expect(readJournal(config.executionJournalPath).records[result.journalId]).to.include({
        status: "CONFIRMED",
        txHash,
        nonce: 7,
      });
    });

    it("deletes the journal record on a certain pre-broadcast rejection", async function () {
      const { opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const sendError = Object.assign(new Error("nonce too low"), { code: "NONCE_EXPIRED" });
      const { contract } = makeSpyContract({ sendError });

      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });

      expect(result.submitted).to.equal(false);
      expect(result.journalStatus).to.equal("REJECTED");
      expect(readJournal(config.executionJournalPath).records).to.deep.equal({});
    });

    it("marks the record UNKNOWN when the receipt times out", async function () {
      const { opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const txHash = `0x${"79".repeat(32)}`;
      const contract = {
        owner: async () => defaultOwnerAddress,
        startArbitrage: async () => ({
          hash: txHash,
          wait: async () => {
            throw Object.assign(new Error("timed out"), { code: "TIMEOUT" });
          },
        }),
      };
      contract.startArbitrage.estimateGas = async () => 300000n;
      contract.startArbitrage.staticCall = async () => true;

      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });

      expect(result.submitted).to.equal(true);
      expect(result.journalStatus).to.equal("UNKNOWN");
      expect(readJournal(config.executionJournalPath).records[result.journalId]).to.include({
        status: "UNKNOWN",
        txHash,
      });
    });
  });

  describe("bot/executor pnl", function () {
    it("writes realized P&L from ArbitrageExecuted on confirmation", async function () {
      const { botWallet, pair, opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const iface = new ethers.Interface(FLASH_ARB_EXECUTOR_ABI);
      const profit = ethers.parseEther("0.5");
      const premium = ethers.parseEther("0.01");
      const encoded = iface.encodeEventLog(iface.getEvent("ArbitrageExecuted"), [
        botWallet.address,
        pair.borrowedToken.address,
        opportunity.amountIn,
        premium,
        profit,
      ]);
      const eventLog = {
        address: config.contractAddress,
        topics: encoded.topics,
        data: encoded.data,
      };
      const txHash = `0x${"7a".repeat(32)}`;
      const contract = {
        owner: async () => defaultOwnerAddress,
        startArbitrage: async () => ({
          hash: txHash,
          wait: async () => ({
            status: 1,
            gasUsed: 100000n,
            gasPrice: 2n,
            blockNumber: 1,
            l1Fee: 123n,
            logs: [eventLog],
          }),
        }),
      };
      contract.startArbitrage.estimateGas = async () => 300000n;
      contract.startArbitrage.staticCall = async () => true;

      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });

      expect(result.submitted).to.equal(true);
      const lines = fs.readFileSync(config.executionPnlPath, "utf8").trim().split("\n");
      expect(lines).to.have.lengthOf(1);
      const pnl = JSON.parse(lines[0]);
      expect(pnl).to.include({
        txHash,
        journalId: result.journalId,
        pairLabel: pair.label,
        realizedProfitWei: profit.toString(),
        premiumWei: premium.toString(),
        gasPaidWei: "200123",
        l1FeeWei: "123",
        status: "CONFIRMED",
      });
      expect(pnl.timestamp).to.be.a("string");
    });

    it("writes null realized profit when the receipt has no ArbitrageExecuted", async function () {
      const { pair, opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const txHash = `0x${"7b".repeat(32)}`;
      const contract = {
        owner: async () => defaultOwnerAddress,
        startArbitrage: async () => ({
          hash: txHash,
          wait: async () => ({
            status: 1,
            gasUsed: 100000n,
            gasPrice: 1n,
            blockNumber: 1,
            logs: [],
          }),
        }),
      };
      contract.startArbitrage.estimateGas = async () => 300000n;
      contract.startArbitrage.staticCall = async () => true;

      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });

      expect(result.submitted).to.equal(true);
      expect(result.error).to.equal(undefined);
      const pnl = JSON.parse(fs.readFileSync(config.executionPnlPath, "utf8").trim());
      expect(pnl).to.include({
        txHash,
        journalId: result.journalId,
        pairLabel: pair.label,
        realizedProfitWei: null,
        premiumWei: null,
        gasPaidWei: "100000",
        l1FeeWei: "0",
        status: "CONFIRMED",
      });
    });

    it("writes a CONFIRMED PnL line when send throws with a successful receipt", async function () {
      const { opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const txHash = `0x${"7c".repeat(32)}`;
      const sendError = Object.assign(new Error("receipt available"), {
        receipt: { status: 1, gasUsed: 100000n, gasPrice: 1n, blockNumber: 1, l1Fee: 7n, logs: [] },
      });
      const { contract } = makeSpyContract({ sendError });
      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });
      expect(result.submitted).to.equal(false);
      expect(result.journalStatus).to.equal("CONFIRMED");
      const lines = fs.readFileSync(config.executionPnlPath, "utf8").trim().split("\n");
      expect(lines).to.have.lengthOf(1);
      const pnl = JSON.parse(lines[0]);
      expect(pnl).to.include({
        txHash: null,
        journalId: result.journalId,
        status: "CONFIRMED",
        l1FeeWei: "7",
      });
      expect(pnl.timestamp).to.be.a("string");
    });

    it("writes a REVERTED PnL line when send throws with a reverted receipt", async function () {
      const { opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const sendError = Object.assign(new Error("transaction reverted on-chain"), {
        receipt: { status: 0, gasUsed: 100000n, gasPrice: 1n, blockNumber: 1 },
      });
      const { contract } = makeSpyContract({ sendError });
      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider: ethers.provider,
        config,
        contract,
      });
      expect(result.submitted).to.equal(false);
      expect(result.journalStatus).to.equal("REVERTED");
      const lines = fs.readFileSync(config.executionPnlPath, "utf8").trim().split("\n");
      expect(lines).to.have.lengthOf(1);
      const pnl = JSON.parse(lines[0]);
      expect(pnl).to.include({
        journalId: result.journalId,
        status: "REVERTED",
        realizedProfitWei: null,
        premiumWei: null,
      });
    });

    it("writes a REVERTED PnL line when the late receipt has status 0", async function () {
      const { opportunity, makeConfig } = await deployFixture();
      const config = makeConfig();
      const { opportunity: freshOpportunity } = await opportunityAboveGasFloor({
        opportunity,
        config,
      });
      const txHash = `0x${"7d".repeat(32)}`;
      const contract = {
        owner: async () => defaultOwnerAddress,
        startArbitrage: async () => ({
          hash: txHash,
          wait: async () => {
            throw Object.assign(new Error("timed out"), { code: "TIMEOUT" });
          },
        }),
      };
      contract.startArbitrage.estimateGas = async () => 300000n;
      contract.startArbitrage.staticCall = async () => true;
      const provider = {
        getFeeData: async () => ({ gasPrice: 1n, maxFeePerGas: null }),
        getNetwork: () => ethers.provider.getNetwork(),
        getBalance: (address) => ethers.provider.getBalance(address),
        getTransactionReceipt: async () => ({
          status: 0,
          gasUsed: 100000n,
          gasPrice: 1n,
          blockNumber: 1,
        }),
      };
      const quoteLeg = async (_provider, leg) =>
        leg === opportunity.pair.legOut ? opportunity.intermediateOut : opportunity.finalOut;
      const result = await maybeExecute({
        opportunity: freshOpportunity,
        provider,
        config,
        contract,
        quoteLeg,
      });
      expect(result.submitted).to.equal(true);
      expect(result.journalStatus).to.equal("REVERTED");
      const lines = fs.readFileSync(config.executionPnlPath, "utf8").trim().split("\n");
      expect(lines).to.have.lengthOf(1);
      const pnl = JSON.parse(lines[0]);
      expect(pnl).to.include({
        txHash,
        journalId: result.journalId,
        status: "REVERTED",
        realizedProfitWei: null,
        premiumWei: null,
      });
    });
  });
});
