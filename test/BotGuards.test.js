const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  checkChainId,
  checkContractOwner,
  checkWalletBalance,
  checkWalletBalanceLow,
  addGasSpent,
  checkDailyGas,
  checkCircuitBreaker,
  readCircuitBreaker,
  recordFailure,
  recordSuccess,
  readRpcErrors,
  recordRpcCycle,
  checkRpcErrorRate,
  readGasHistory,
  recordGasSample,
  checkGasAnomaly,
  DEFAULT_RPC_ERRORS_PATH,
  DEFAULT_GAS_HISTORY_PATH,
} = require("../bot/guards");
const { writeExecutionJournal } = require("../bot/persist");

describe("bot/guards", function () {
  let guardDir;

  beforeEach(function () {
    guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-guards-"));
  });

  afterEach(function () {
    fs.rmSync(guardDir, { recursive: true, force: true });
  });

  it("detects a chainId mismatch", async function () {
    const matching = await checkChainId({ provider: ethers.provider, expectedChainId: 31337 });
    expect(matching.ok).to.equal(true);

    const mismatched = await checkChainId({ provider: ethers.provider, expectedChainId: 42161 });
    expect(mismatched.ok).to.equal(false);
    expect(mismatched.error).to.include("CHAIN_ID_MISMATCH");
  });

  it("checks the raw eth_chainId instead of trusting a static provider network", async function () {
    const provider = {
      async getNetwork() {
        return { chainId: 42161n };
      },
      async send(method) {
        if (method === "eth_chainId") return "0x7a69";
        throw new Error(`unexpected method ${method}`);
      },
    };
    const result = await checkChainId({ provider, expectedChainId: 31337 });
    expect(result.ok).to.equal(true);
    expect(result.chainId).to.equal(31337);
  });

  it("rejects a wallet balance above MAX_WALLET_BALANCE_ETH", async function () {
    const [signer] = await ethers.getSigners();

    const blocked = await checkWalletBalance({
      provider: ethers.provider,
      address: signer.address,
      maxWalletBalanceEth: 0.001,
    });
    expect(blocked.ok).to.equal(false);
    expect(blocked.error).to.include("WALLET_BALANCE_ABOVE_MAX");

    const allowed = await checkWalletBalance({
      provider: ethers.provider,
      address: signer.address,
      maxWalletBalanceEth: 10000,
    });
    expect(allowed.ok).to.equal(true);
  });

  it("accepts a wallet balance above MIN_WALLET_BALANCE_ETH", async function () {
    const [signer] = await ethers.getSigners();

    const result = await checkWalletBalanceLow({
      provider: ethers.provider,
      address: signer.address,
      minWalletBalanceEth: 0.001,
    });
    expect(result.ok).to.equal(true);
  });

  it("flags a wallet balance below MIN_WALLET_BALANCE_ETH", async function () {
    const result = await checkWalletBalanceLow({
      provider: ethers.provider,
      address: ethers.Wallet.createRandom().address,
      minWalletBalanceEth: 0.005,
    });
    expect(result.ok).to.equal(false);
    expect(result.error).to.include("WALLET_BALANCE_BELOW_MIN");
    expect(result.error).to.include("0.005");
  });

  it("accepts any balance when MIN_WALLET_BALANCE_ETH is zero", async function () {
    const result = await checkWalletBalanceLow({
      provider: ethers.provider,
      address: ethers.Wallet.createRandom().address,
      minWalletBalanceEth: 0,
    });
    expect(result.ok).to.equal(true);
  });

  it("persists daily gas spend and blocks a trade that would exceed the cap", async function () {
    const gasSpentPath = path.join(guardDir, "gas_spent.json");
    const now = Date.parse("2026-10-27T12:00:00.000Z");

    await addGasSpent({ filePath: gasSpentPath, deltaWei: ethers.parseEther("0.009"), now });

    const blocked = await checkDailyGas({
      filePath: gasSpentPath,
      estimatedGasCostWei: ethers.parseEther("0.002"),
      maxDailyGasEth: 0.01,
      now,
    });
    expect(blocked.ok).to.equal(false);
    expect(blocked.error).to.include("DAILY_GAS_LIMIT");

    const allowed = await checkDailyGas({
      filePath: gasSpentPath,
      estimatedGasCostWei: ethers.parseEther("0.0005"),
      maxDailyGasEth: 0.01,
      now,
    });
    expect(allowed.ok).to.equal(true);

    const state = JSON.parse(fs.readFileSync(gasSpentPath, "utf8"));
    expect(state.date).to.equal("2026-10-27");
    expect(state.gasSpentWei).to.equal(ethers.parseEther("0.009").toString());
  });

  it("opens the circuit breaker after N consecutive failures and resets it after cooldown", async function () {
    const breakerPath = path.join(guardDir, "circuit_breaker.json");
    const now = Date.parse("2026-10-27T12:00:00.000Z");

    for (let i = 0; i < 5; i += 1) {
      await recordFailure({
        filePath: breakerPath,
        maxConsecutiveFailures: 5,
        cooldownMinutes: 60,
        now,
      });
    }

    const open = await checkCircuitBreaker({
      filePath: breakerPath,
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      now,
    });
    expect(open.ok).to.equal(false);
    expect(open.error).to.include("CIRCUIT_BREAKER_OPEN");

    const state = JSON.parse(fs.readFileSync(breakerPath, "utf8"));
    expect(state.consecutiveFailures).to.equal(5);
    expect(state.openUntil).to.equal(now + 60 * 60_000);

    const stillOpen = await checkCircuitBreaker({
      filePath: breakerPath,
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      now: now + 1000,
    });
    expect(stillOpen.ok).to.equal(false);

    const afterCooldown = await checkCircuitBreaker({
      filePath: breakerPath,
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      now: now + 60 * 60_000 + 1,
    });
    expect(afterCooldown.ok).to.equal(true);
    expect(afterCooldown.consecutiveFailures).to.equal(0);

    await recordFailure({ filePath: breakerPath, maxConsecutiveFailures: 5, now: now + 60 * 61_000 });
    const afterOneFailure = JSON.parse(fs.readFileSync(breakerPath, "utf8"));
    expect(afterOneFailure.consecutiveFailures).to.equal(1);
    expect(afterOneFailure.openUntil).to.equal(null);

    await recordSuccess({ filePath: breakerPath });
    const afterSuccess = JSON.parse(fs.readFileSync(breakerPath, "utf8"));
    expect(afterSuccess.consecutiveFailures).to.equal(0);
  });
});

describe("bot/guards breaker windows", function () {
  let guardDir;

  beforeEach(function () {
    guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-guard-windows-"));
  });

  afterEach(function () {
    fs.rmSync(guardDir, { recursive: true, force: true });
  });

  async function seedJournal(filePath, statuses) {
    const records = {};
    statuses.forEach((status, index) => {
      records[`exec-${index}`] = {
        id: `exec-${index}`,
        status,
        lastUpdateAt: 1000 + index,
      };
    });
    await writeExecutionJournal({ version: 1, records }, filePath);
  }

  it("opens the breaker when the revert rate exceeds the threshold", async function () {
    const executionJournalPath = path.join(guardDir, "executions.json");
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    await seedJournal(executionJournalPath, [
      ...Array(15).fill("REVERTED"),
      ...Array(5).fill("CONFIRMED"),
    ]);

    const result = await checkCircuitBreaker({
      filePath: path.join(guardDir, "circuit_breaker.json"),
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      executionJournalPath,
      now,
    });

    expect(result.ok).to.equal(false);
    expect(result.error).to.include("revert rate");
    expect(result.revertRate).to.equal(0.75);
    expect(result.openUntil).to.equal(now + 60 * 60_000);
  });

  it("keeps the breaker closed when the revert rate is below the threshold", async function () {
    const executionJournalPath = path.join(guardDir, "executions.json");
    await seedJournal(executionJournalPath, [
      ...Array(5).fill("REVERTED"),
      ...Array(15).fill("CONFIRMED"),
    ]);

    const result = await checkCircuitBreaker({
      filePath: path.join(guardDir, "circuit_breaker.json"),
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      executionJournalPath,
    });

    expect(result.ok).to.equal(true);
    expect(result.revertRate).to.equal(0.25);
  });

  it("opens the breaker when the unknown rate exceeds the threshold", async function () {
    const executionJournalPath = path.join(guardDir, "executions.json");
    const now = Date.parse("2026-10-27T12:00:00.000Z");
    await seedJournal(executionJournalPath, [
      ...Array(10).fill("UNKNOWN"),
      ...Array(10).fill("CONFIRMED"),
    ]);

    const result = await checkCircuitBreaker({
      filePath: path.join(guardDir, "circuit_breaker.json"),
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      executionJournalPath,
      now,
    });

    expect(result.ok).to.equal(false);
    expect(result.error).to.include("unknown rate");
    expect(result.unknownRate).to.equal(0.5);
    expect(result.openUntil).to.equal(now + 60 * 60_000);
  });

  it("keeps the breaker closed when the execution journal is missing", async function () {
    const result = await checkCircuitBreaker({
      filePath: path.join(guardDir, "circuit_breaker.json"),
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      executionJournalPath: path.join(guardDir, "missing.json"),
    });

    expect(result.ok).to.equal(true);
    expect(result.revertRate).to.equal(0);
    expect(result.unknownRate).to.equal(0);
  });

  it("throws on an invalid revertRateWindowSize", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({
        filePath,
        rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
        gasHistoryPath: path.join(guardDir, "gas_history.json"),
        revertRateWindowSize: 0,
      })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
    await expect(
      checkCircuitBreaker({
        filePath,
        rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
        gasHistoryPath: path.join(guardDir, "gas_history.json"),
        revertRateWindowSize: -1,
      })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
  });

  it("throws on an invalid revertRateThreshold", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({
        filePath,
        rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
        gasHistoryPath: path.join(guardDir, "gas_history.json"),
        revertRateThreshold: NaN,
      })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
  });

  it("throws on an invalid unknownRateWindowSize", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({
        filePath,
        rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
        gasHistoryPath: path.join(guardDir, "gas_history.json"),
        unknownRateWindowSize: 0,
      })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
  });

  it("throws on an invalid unknownRateThreshold", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({
        filePath,
        rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
        gasHistoryPath: path.join(guardDir, "gas_history.json"),
        unknownRateThreshold: NaN,
      })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
  });

  it("opens the breaker when the daily gas spend exceeds the drawdown threshold", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    const gasSpentPath = path.join(guardDir, "gas_spent.json");
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      gasSpentPath,
      `${JSON.stringify({ date: today, gasSpentWei: ethers.parseEther("0.013").toString() })}\n`,
      "utf8"
    );
    const result = await checkCircuitBreaker({
      filePath,
      gasSpentPath,
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      maxDailyGasEth: 0.01,
      gasDrawdownMultiplier: 1.2,
      now: Date.parse("2026-11-02T12:00:00.000Z"),
    });
    expect(result.ok).to.equal(false);
    expect(result.error).to.include("gas drawdown");
  });

  it("keeps the breaker closed when the daily gas spend is below the drawdown threshold", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    const gasSpentPath = path.join(guardDir, "gas_spent.json");
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      gasSpentPath,
      `${JSON.stringify({ date: today, gasSpentWei: ethers.parseEther("0.005").toString() })}\n`,
      "utf8"
    );
    const result = await checkCircuitBreaker({
      filePath,
      gasSpentPath,
      rpcErrorsPath: path.join(guardDir, "rpc_errors.json"),
      gasHistoryPath: path.join(guardDir, "gas_history.json"),
      maxDailyGasEth: 0.01,
      gasDrawdownMultiplier: 1.2,
      now: Date.parse("2026-11-02T12:00:00.000Z"),
    });
    expect(result.ok).to.equal(true);
  });
});

describe("bot/guards checkContractOwner", function () {
  it("accepts a contract owner matching the wallet", async function () {
    const walletAddress = ethers.Wallet.createRandom().address;
    const contract = { owner: async () => walletAddress };

    const result = await checkContractOwner({ contract, walletAddress });

    expect(result.ok).to.equal(true);
    expect(result.owner).to.equal(walletAddress);
  });

  it("rejects a contract owner that differs from the wallet", async function () {
    const walletAddress = ethers.Wallet.createRandom().address;
    const owner = ethers.Wallet.createRandom().address;
    const contract = { owner: async () => owner };

    const result = await checkContractOwner({ contract, walletAddress });

    expect(result.ok).to.equal(false);
    expect(result.owner).to.equal(owner);
    expect(result.error).to.include("CONTRACT_OWNER_MISMATCH");
  });
});

describe("bot/guards rpcErrors", function () {
  let guardDir;

  beforeEach(function () {
    guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-rpc-errors-"));
  });

  afterEach(function () {
    fs.rmSync(guardDir, { recursive: true, force: true });
  });

  async function rejection(promise) {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  }

  it("records an RPC cycle and truncates to windowSize", async function () {
    const filePath = path.join(guardDir, "rpc_errors.json");
    for (let i = 0; i < 5; i += 1) {
      await recordRpcCycle({ filePath, errors: i, total: 10, at: 1000 + i, windowSize: 3 });
    }
    const state = await readRpcErrors({ filePath });
    expect(state.version).to.equal(1);
    expect(state.cycles).to.have.length(3);
    expect(state.cycles.map((c) => c.errors)).to.deep.equal([2, 3, 4]);
  });

  it("rejects errors greater than total without writing state", async function () {
    const filePath = path.join(guardDir, "rpc_errors.json");

    const err = await rejection(recordRpcCycle({ filePath, errors: 11, total: 10, at: 1000 }));

    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.include("errors must not exceed total");
    expect(fs.existsSync(filePath)).to.equal(false);
  });

  it("accepts errors equal to total", async function () {
    const filePath = path.join(guardDir, "rpc_errors.json");

    const state = await recordRpcCycle({ filePath, errors: 10, total: 10, at: 1000 });

    expect(state.cycles).to.deep.equal([{ errors: 10, total: 10, at: 1000 }]);
  });

  it("rejects a non-finite at timestamp without writing state", async function () {
    const invalidTimestamps = [NaN, Infinity, -Infinity, "1000", null];

    for (const [index, at] of invalidTimestamps.entries()) {
      const filePath = path.join(guardDir, `invalid-at-${index}.json`);

      const err = await rejection(recordRpcCycle({ filePath, errors: 1, total: 10, at }));

      expect(err, `at=${String(at)}`).to.be.instanceOf(Error);
      expect(err.message).to.include("at must be a finite timestamp");
      expect(fs.existsSync(filePath), `at=${String(at)}`).to.equal(false);
    }
  });

  it("returns ok when the RPC error rate is below threshold", async function () {
    const filePath = path.join(guardDir, "rpc_errors.json");
    await recordRpcCycle({ filePath, errors: 1, total: 10, at: 1000 });
    await recordRpcCycle({ filePath, errors: 0, total: 10, at: 2000 });
    const result = await checkRpcErrorRate({ filePath, threshold: 0.5, now: 3000 });
    expect(result.ok).to.equal(true);
    expect(result.rate).to.equal(0.05);
    expect(result.samples).to.equal(2);
  });

  it("opens the breaker when the RPC error rate exceeds threshold", async function () {
    const filePath = path.join(guardDir, "rpc_errors.json");
    await recordRpcCycle({ filePath, errors: 8, total: 10, at: 1000 });
    await recordRpcCycle({ filePath, errors: 9, total: 10, at: 2000 });
    const result = await checkRpcErrorRate({ filePath, threshold: 0.5, now: 3000 });
    expect(result.ok).to.equal(false);
    expect(result.rate).to.equal(0.85);
    expect(result.error).to.include("RPC error rate");
    expect(result.error).to.include("85%");
  });

  it("rejects errors greater than total as STATE_FILE_SCHEMA_INVALID", async function () {
    const filePath = path.join(guardDir, "rpc_errors.json");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ version: 1, cycles: [{ errors: 11, total: 10, at: 1000 }] })}\n`,
      "utf8"
    );

    const err = await rejection(checkRpcErrorRate({ filePath, threshold: 0.5, now: 2000 }));

    expect(err).to.be.instanceOf(Error);
    expect(err.code).to.equal("STATE_FILE_SCHEMA_INVALID");
    expect(err.message).to.include(`STATE_FILE_SCHEMA_INVALID: ${filePath}`);
    expect(err.message).to.include("errors must not exceed total");
  });

  it("accepts errors equal to total from persisted state", async function () {
    const filePath = path.join(guardDir, "rpc_errors.json");
    fs.writeFileSync(
      filePath,
      `${JSON.stringify({ version: 1, cycles: [{ errors: 10, total: 10, at: 1000 }] })}\n`,
      "utf8"
    );

    const result = await checkRpcErrorRate({ filePath, threshold: 0.5, now: 2000 });

    expect(result.ok).to.equal(false);
    expect(result.rate).to.equal(1);
    expect(result.samples).to.equal(1);
  });

  it("returns ok on missing file (fail-open)", async function () {
    const filePath = path.join(guardDir, "missing.json");
    const result = await checkRpcErrorRate({ filePath, threshold: 0.5 });
    expect(result.ok).to.equal(true);
    expect(result.rate).to.equal(0);
    expect(result.samples).to.equal(0);
  });

  it("opens checkCircuitBreaker when the RPC error rate exceeds threshold", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    const rpcErrorsPath = path.join(guardDir, "rpc_errors.json");
    await recordRpcCycle({ filePath: rpcErrorsPath, errors: 9, total: 10, at: 1000 });
    await recordRpcCycle({ filePath: rpcErrorsPath, errors: 9, total: 10, at: 2000 });
    const result = await checkCircuitBreaker({
      filePath,
      rpcErrorsPath,
      rpcErrorRateWindowSize: 10,
      rpcErrorRateThreshold: 0.5,
      now: 3000,
    });
    expect(result.ok).to.equal(false);
    expect(result.error).to.include("RPC error rate");
  });
});

describe("bot/guards gasHistory", function () {
  let guardDir;

  beforeEach(function () {
    guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-gas-history-"));
  });

  afterEach(function () {
    fs.rmSync(guardDir, { recursive: true, force: true });
  });

  it("records a gas sample and truncates to windowSize", async function () {
    const filePath = path.join(guardDir, "gas_history.json");
    for (let i = 1; i <= 5; i += 1) {
      await recordGasSample({
        filePath,
        gasPriceWei: BigInt(i) * 1_000_000_000n,
        at: 1000 + i,
        windowSize: 3,
      });
    }
    const state = await readGasHistory({ filePath });
    expect(state.version).to.equal(1);
    expect(state.samples).to.have.length(3);
    expect(state.samples.map((s) => s.gasPriceWei)).to.deep.equal([
      "3000000000",
      "4000000000",
      "5000000000",
    ]);
  });

  it("returns ok when there are fewer than minSamples", async function () {
    const filePath = path.join(guardDir, "gas_history.json");
    await recordGasSample({ filePath, gasPriceWei: 1_000_000_000n, at: 1000 });
    await recordGasSample({ filePath, gasPriceWei: 1_100_000_000n, at: 2000 });
    const result = await checkGasAnomaly({ filePath, minSamples: 5, now: 3000 });
    expect(result.ok).to.equal(true);
    expect(result.reason).to.equal("insufficient samples");
    expect(result.samples).to.equal(2);
  });

  it("returns ok when the last sample is below multiplier x median", async function () {
    const filePath = path.join(guardDir, "gas_history.json");
    for (let i = 1; i <= 5; i += 1) {
      await recordGasSample({
        filePath,
        gasPriceWei: 1_000_000_000n,
        at: 1000 + i,
      });
    }
    const result = await checkGasAnomaly({ filePath, multiplier: 3, minSamples: 5, now: 3000 });
    expect(result.ok).to.equal(true);
    expect(result.median).to.equal("1000000000");
    expect(result.last).to.equal("1000000000");
  });

  it("opens when the last sample exceeds multiplier x median", async function () {
    const filePath = path.join(guardDir, "gas_history.json");
    for (let i = 1; i <= 4; i += 1) {
      await recordGasSample({
        filePath,
        gasPriceWei: 1_000_000_000n,
        at: 1000 + i,
      });
    }
    await recordGasSample({ filePath, gasPriceWei: 5_000_000_000n, at: 2000 });
    const result = await checkGasAnomaly({ filePath, multiplier: 3, minSamples: 5, now: 3000 });
    expect(result.ok).to.equal(false);
    expect(result.median).to.equal("1000000000");
    expect(result.last).to.equal("5000000000");
  });

  it("compares the latest sample, not an old spike, to the median", async function () {
    const filePath = path.join(guardDir, "gas_history.json");
    await recordGasSample({ filePath, gasPriceWei: 5_000_000_000n, at: 1000 });
    for (let i = 1; i <= 4; i += 1) {
      await recordGasSample({ filePath, gasPriceWei: 1_000_000_000n, at: 1000 + i });
    }
    const result = await checkGasAnomaly({ filePath, multiplier: 3, minSamples: 5, now: 3000 });
    expect(result.ok).to.equal(true);
    expect(result.median).to.equal("1000000000");
    expect(result.last).to.equal("1000000000");
  });

  it("returns ok on missing file (fail-open)", async function () {
    const filePath = path.join(guardDir, "missing.json");
    const result = await checkGasAnomaly({ filePath, minSamples: 5 });
    expect(result.ok).to.equal(true);
    expect(result.reason).to.equal("insufficient samples");
    expect(result.samples).to.equal(0);
  });

  it("opens checkCircuitBreaker when the gas price exceeds multiplier x median", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    const gasHistoryPath = path.join(guardDir, "gas_history.json");
    for (let i = 1; i <= 4; i += 1) {
      await recordGasSample({ filePath: gasHistoryPath, gasPriceWei: 1_000_000_000n, at: 1000 + i });
    }
    await recordGasSample({ filePath: gasHistoryPath, gasPriceWei: 10_000_000_000n, at: 2000 });
    const result = await checkCircuitBreaker({
      filePath,
      gasHistoryPath,
      gasAnomalyWindowSize: 20,
      gasAnomalyMultiplier: 3,
      gasAnomalyMinSamples: 5,
      now: 3000,
    });
    expect(result.ok).to.equal(false);
    expect(result.error).to.include("gas price anomaly");
  });

  it("keeps checkCircuitBreaker closed when the gas price is below multiplier x median", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    const gasHistoryPath = path.join(guardDir, "gas_history.json");
    for (let i = 1; i <= 5; i += 1) {
      await recordGasSample({ filePath: gasHistoryPath, gasPriceWei: 1_000_000_000n, at: 1000 + i });
    }
    const result = await checkCircuitBreaker({
      filePath,
      gasHistoryPath,
      gasAnomalyWindowSize: 20,
      gasAnomalyMultiplier: 3,
      gasAnomalyMinSamples: 5,
      now: 3000,
    });
    expect(result.ok).to.equal(true);
  });
});

describe("bot/guards circuit breaker fail-closed (M1-bis)", function () {
  let guardDir;
  let paths;

  beforeEach(function () {
    guardDir = fs.mkdtempSync(path.join(os.tmpdir(), "flash-arb-guards-m1-bis-"));
    paths = {
      breaker: path.join(guardDir, "circuit_breaker.json"),
      gasSpent: path.join(guardDir, "gas_spent.json"),
      rpcErrors: path.join(guardDir, "rpc_errors.json"),
      gasHistory: path.join(guardDir, "gas_history.json"),
      journal: path.join(guardDir, "executions.json"),
    };
  });

  afterEach(function () {
    fs.rmSync(guardDir, { recursive: true, force: true });
  });

  function breakerOptions(overrides = {}) {
    return {
      filePath: paths.breaker,
      gasSpentPath: paths.gasSpent,
      rpcErrorsPath: paths.rpcErrors,
      gasHistoryPath: paths.gasHistory,
      executionJournalPath: paths.journal,
      now: Date.parse("2026-11-02T12:00:00.000Z"),
      ...overrides,
    };
  }

  async function rejection(promise) {
    try {
      await promise;
      return null;
    } catch (err) {
      return err;
    }
  }

  const corruptFiles = [
    ["rpc_errors.json", "rpcErrors"],
    ["gas_history.json", "gasHistory"],
    ["gas_spent.json", "gasSpent"],
    ["executions.json", "journal"],
  ];

  for (const [label, key] of corruptFiles) {
    it(`fails closed when ${label} contains corrupt JSON`, async function () {
      fs.writeFileSync(paths[key], "{not valid json", "utf8");

      const err = await rejection(checkCircuitBreaker(breakerOptions()));

      expect(err, `${label} should block the breaker`).to.be.instanceOf(Error);
      expect(err.message).to.include("STATE_FILE_CORRUPT");
      expect(err.message).to.include(paths[key]);
    });
  }

  it("fails closed on an unreadable state file (EACCES)", async function () {
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      this.skip();
    }
    fs.writeFileSync(paths.rpcErrors, `${JSON.stringify({ version: 1, cycles: [] })}\n`, "utf8");
    fs.chmodSync(paths.rpcErrors, 0o000);

    const err = await rejection(checkCircuitBreaker(breakerOptions()));

    expect(err).to.be.instanceOf(Error);
    expect(err.code).to.equal("EACCES");
    expect(err.message).to.include("STATE_FILE_UNREADABLE");
    expect(err.message).to.include(paths.rpcErrors);
  });

  it("fails closed when the execution journal cannot be read (EISDIR)", async function () {
    fs.mkdirSync(paths.journal);

    const err = await rejection(checkCircuitBreaker(breakerOptions()));

    expect(err).to.be.instanceOf(Error);
    expect(err.code).to.equal("EISDIR");
    expect(err.message).to.include("STATE_FILE_UNREADABLE");
    expect(err.message).to.include(paths.journal);
  });

  it("keeps the fallback when every state file is missing", async function () {
    const result = await checkCircuitBreaker(breakerOptions());

    expect(result.ok).to.equal(true);
    expect(result.consecutiveFailures).to.equal(0);
    expect(result.openUntil).to.equal(null);
  });

  it("normalizes a missing openUntil to null for legacy state files", async function () {
    fs.writeFileSync(paths.breaker, `${JSON.stringify({ consecutiveFailures: 2 })}\n`, "utf8");

    const state = await readCircuitBreaker({ filePath: paths.breaker });

    expect(state).to.deep.equal({ consecutiveFailures: 2, openUntil: null });
  });

  it("keeps the documented fail-open for an invalid rpc_errors schema", async function () {
    fs.writeFileSync(
      paths.rpcErrors,
      `${JSON.stringify({ version: 1, cycles: "not-an-array" })}\n`,
      "utf8"
    );

    const result = await checkCircuitBreaker(breakerOptions());

    expect(result.ok).to.equal(true);
  });

  it("keeps the documented fail-open for an invalid gas_history schema", async function () {
    fs.writeFileSync(
      paths.gasHistory,
      `${JSON.stringify({ version: 1, samples: "not-an-array" })}\n`,
      "utf8"
    );

    const result = await checkCircuitBreaker(breakerOptions());

    expect(result.ok).to.equal(true);
  });

  it("keeps the documented fail-open for malformed rpc_errors entries", async function () {
    fs.writeFileSync(
      paths.rpcErrors,
      `${JSON.stringify({ version: 1, cycles: [null] })}\n`,
      "utf8"
    );

    const result = await checkCircuitBreaker(breakerOptions());

    expect(result.ok).to.equal(true);
  });

  it("keeps the documented fail-open for rpc_errors cycles with errors greater than total", async function () {
    fs.writeFileSync(
      paths.rpcErrors,
      `${JSON.stringify({ version: 1, cycles: [{ errors: 2, total: 1, at: 1000 }] })}\n`,
      "utf8"
    );

    const result = await checkCircuitBreaker(breakerOptions());

    expect(result.ok).to.equal(true);
  });

  it("keeps the documented fail-open for malformed gas_history samples", async function () {
    const samples = Array.from({ length: 5 }, (_, index) => ({
      gasPriceWei: "not-a-number",
      at: 1000 + index,
    }));
    fs.writeFileSync(
      paths.gasHistory,
      `${JSON.stringify({ version: 1, samples })}\n`,
      "utf8"
    );

    const result = await checkCircuitBreaker(breakerOptions());

    expect(result.ok).to.equal(true);
  });

  it("fails closed on an invalid executions journal schema", async function () {
    fs.writeFileSync(
      paths.journal,
      `${JSON.stringify({ version: 1, records: [] })}\n`,
      "utf8"
    );

    const err = await rejection(checkCircuitBreaker(breakerOptions()));

    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.include(`STATE_FILE_CORRUPT: ${paths.journal}`);
  });

  it("fails closed on an invalid circuit_breaker schema", async function () {
    fs.writeFileSync(
      paths.breaker,
      `${JSON.stringify({ consecutiveFailures: "five", openUntil: null })}\n`,
      "utf8"
    );

    const err = await rejection(checkCircuitBreaker(breakerOptions()));

    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.include(`STATE_FILE_CORRUPT: ${paths.breaker}`);
  });

  it("fails closed on an invalid gas_spent schema", async function () {
    fs.writeFileSync(
      paths.gasSpent,
      `${JSON.stringify({ date: "not-a-date", gasSpentWei: "1" })}\n`,
      "utf8"
    );

    const err = await rejection(checkCircuitBreaker(breakerOptions()));

    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.include(`STATE_FILE_CORRUPT: ${paths.gasSpent}`);
  });

  it("fails closed with STATE_FILE_CORRUPT when openUntil is outside the Date range", async function () {
    fs.writeFileSync(
      paths.breaker,
      `${JSON.stringify({ consecutiveFailures: 0, openUntil: 1e20 })}\n`,
      "utf8"
    );

    const err = await rejection(checkCircuitBreaker(breakerOptions()));

    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.include(`STATE_FILE_CORRUPT: ${paths.breaker}`);
    expect(err.message).to.not.include("Invalid time value");
  });

  it("fails closed when gas_spent contains an impossible calendar date", async function () {
    fs.writeFileSync(
      paths.gasSpent,
      `${JSON.stringify({ date: "2026-02-31", gasSpentWei: "1" })}\n`,
      "utf8"
    );

    const err = await rejection(checkCircuitBreaker(breakerOptions()));

    expect(err).to.be.instanceOf(Error);
    expect(err.message).to.include(`STATE_FILE_CORRUPT: ${paths.gasSpent}`);
  });

  it("does not mask an unexpected RPC error-rate failure", async function () {
    fs.writeFileSync(
      paths.rpcErrors,
      `${JSON.stringify({ version: 1, cycles: [{ errors: 0, total: 1, at: 1000 }] })}\n`,
      "utf8"
    );

    const err = await rejection(
      checkCircuitBreaker(breakerOptions({ rpcErrorRateWindowSize: 1n }))
    );

    expect(err, "non-schema failure should propagate").to.be.instanceOf(Error);
    expect(err.message).to.not.include("STATE_FILE_SCHEMA_INVALID");
  });

  it("does not mask an unexpected gas-anomaly failure", async function () {
    const samples = Array.from({ length: 5 }, (_, index) => ({
      gasPriceWei: "1000000000",
      at: 1000 + index,
    }));
    fs.writeFileSync(
      paths.gasHistory,
      `${JSON.stringify({ version: 1, samples })}\n`,
      "utf8"
    );

    const err = await rejection(
      checkCircuitBreaker(breakerOptions({ gasAnomalyMultiplier: 1.5 }))
    );

    expect(err, "non-schema failure should propagate").to.be.instanceOf(Error);
    expect(err.message).to.not.include("STATE_FILE_SCHEMA_INVALID");
  });
});
