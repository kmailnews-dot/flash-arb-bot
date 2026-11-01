const { expect } = require("chai");
const { createNonceManager } = require("../bot/nonce");

function makeProvider({ initial = 7, pending = null } = {}) {
  let current = initial;
  const calls = [];
  return {
    calls,
    async getTransactionCount(_address, tag) {
      calls.push(tag);
      const value = current;
      if (pending !== null) {
        current = pending;
      }
      return value;
    },
  };
}

describe("bot/nonce createNonceManager", function () {
  it("reads provider.getTransactionCount(address, pending) on the first next()", async function () {
    const provider = makeProvider({ initial: 7 });
    const manager = await createNonceManager({ provider, address: "0xabc" });
    const nonce = await manager.next();
    expect(nonce).to.equal(7);
    expect(provider.calls).to.deep.equal(["pending"]);
  });

  it("increments without re-reading on successive next() calls", async function () {
    const provider = makeProvider({ initial: 7 });
    const manager = await createNonceManager({ provider, address: "0xabc" });
    expect(await manager.next()).to.equal(7);
    expect(await manager.next()).to.equal(8);
    expect(await manager.next()).to.equal(9);
    expect(provider.calls).to.deep.equal(["pending"]);
  });

  it("reset() re-reads the pending nonce", async function () {
    const provider = makeProvider({ initial: 7, pending: 12 });
    const manager = await createNonceManager({ provider, address: "0xabc" });
    expect(await manager.next()).to.equal(7);
    await manager.reset();
    expect(await manager.next()).to.equal(12);
    expect(provider.calls).to.deep.equal(["pending", "pending"]);
  });

  it("next({ forceRefresh: true }) re-reads the pending nonce", async function () {
    const provider = makeProvider({ initial: 7, pending: 12 });
    const manager = await createNonceManager({ provider, address: "0xabc" });
    expect(await manager.next()).to.equal(7);
    expect(await manager.next({ forceRefresh: true })).to.equal(12);
    expect(provider.calls).to.deep.equal(["pending", "pending"]);
  });

  it("peek() returns null before the first next() and the current value after", async function () {
    const provider = makeProvider({ initial: 7 });
    const manager = await createNonceManager({ provider, address: "0xabc" });
    expect(manager.peek()).to.equal(null);
    await manager.next();
    expect(manager.peek()).to.equal(8);
  });

  it("bump() computes maxFeePerGas = current + bumpGwei and maxPriorityFeePerGas = bumpGwei / 2", async function () {
    const provider = makeProvider();
    const manager = await createNonceManager({ provider, address: "0xabc" });
    const out = manager.bump({
      currentMaxFeePerGas: 100n,
      bumpGwei: 10n,
    });
    expect(out.maxFeePerGas).to.equal(110n);
    expect(out.maxPriorityFeePerGas).to.equal(5n);
  });

  it("bump() throws when maxFeePerGas exceeds maxFeePerGasCap", async function () {
    const provider = makeProvider();
    const manager = await createNonceManager({ provider, address: "0xabc" });
    expect(() =>
      manager.bump({
        currentMaxFeePerGas: 100n,
        bumpGwei: 20n,
        maxFeePerGasCap: 110n,
      })
    ).to.throw(/exceeds cap/);
  });

  it("two simultaneous next() calls return two different nonces", async function () {
    const provider = makeProvider({ initial: 7 });
    const manager = await createNonceManager({ provider, address: "0xabc" });
    const [a, b] = await Promise.all([manager.next(), manager.next()]);
    expect(a).to.not.equal(b);
    expect([a, b].sort()).to.deep.equal([7, 8]);
  });

  it("a provider error on the first next() propagates and leaves the cache empty", async function () {
    const provider = {
      calls: [],
      async getTransactionCount() {
        this.calls.push("pending");
        throw new Error("RPC unavailable");
      },
    };
    const manager = await createNonceManager({ provider, address: "0xabc" });
    await expect(manager.next()).to.be.rejectedWith("RPC unavailable");
    expect(manager.peek()).to.equal(null);
  });
});
