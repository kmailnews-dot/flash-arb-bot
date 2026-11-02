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
  recordFailure,
  recordSuccess,
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

    const open = await checkCircuitBreaker({ filePath: breakerPath, now });
    expect(open.ok).to.equal(false);
    expect(open.error).to.include("CIRCUIT_BREAKER_OPEN");

    const state = JSON.parse(fs.readFileSync(breakerPath, "utf8"));
    expect(state.consecutiveFailures).to.equal(5);
    expect(state.openUntil).to.equal(now + 60 * 60_000);

    const stillOpen = await checkCircuitBreaker({ filePath: breakerPath, now: now + 1000 });
    expect(stillOpen.ok).to.equal(false);

    const afterCooldown = await checkCircuitBreaker({
      filePath: breakerPath,
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
      executionJournalPath: path.join(guardDir, "missing.json"),
    });

    expect(result.ok).to.equal(true);
    expect(result.revertRate).to.equal(0);
    expect(result.unknownRate).to.equal(0);
  });

  it("throws on an invalid revertRateWindowSize", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({ filePath, revertRateWindowSize: 0 })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
    await expect(
      checkCircuitBreaker({ filePath, revertRateWindowSize: -1 })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
  });

  it("throws on an invalid revertRateThreshold", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({ filePath, revertRateThreshold: NaN })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
  });

  it("throws on an invalid unknownRateWindowSize", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({ filePath, unknownRateWindowSize: 0 })
    ).to.be.rejectedWith("INVALID_CIRCUIT_BREAKER_CONFIG");
  });

  it("throws on an invalid unknownRateThreshold", async function () {
    const filePath = path.join(guardDir, "circuit_breaker.json");
    await expect(
      checkCircuitBreaker({ filePath, unknownRateThreshold: NaN })
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
