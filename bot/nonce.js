// bot/nonce.js
//
// Gestionnaire de nonce isolé pour F-05-C (ADR docs/adr/0001-nonce-manager.md).
//
// Ce module ne fait AUCUNE I/O en dehors de provider.getTransactionCount.
// Il est neutre vis-à-vis de config.dryRun : c'est bot/execute.js qui
// décidera de l'activer ou non (option C de l'ADR).

/// Crée un gestionnaire de nonce pour (provider, address).
///
/// Retourne un objet avec :
///   next({ forceRefresh = false }) -> Promise<number>
///   peek() -> number | null
///   reset() -> Promise<void>
///   bump({ currentMaxFeePerGas, bumpGwei, maxFeePerGasCap }) ->
///     { maxFeePerGas, maxPriorityFeePerGas }
///
/// Invariants :
///   - next() lit provider.getTransactionCount(address, "pending")
///     au premier appel, puis incrémente le cache.
///   - reset() et next({ forceRefresh: true }) relisent le pending.
///   - bump() est pure arithmétique sur des bigints.
async function createNonceManager({ provider, address }) {
  if (!provider || typeof provider.getTransactionCount !== "function") {
    throw new Error("createNonceManager: provider.getTransactionCount is required");
  }
  if (!address || typeof address !== "string") {
    throw new Error("createNonceManager: address is required");
  }

  let cachedNonce = null;

  async function refresh() {
    const pending = await provider.getTransactionCount(address, "pending");
    if (!Number.isInteger(pending) || pending < 0) {
      throw new Error(`createNonceManager: invalid nonce ${pending} from provider`);
    }
    cachedNonce = pending;
  }

  async function next({ forceRefresh = false } = {}) {
    if (cachedNonce === null || forceRefresh) {
      await refresh();
    }
    const value = cachedNonce;
    cachedNonce += 1;
    return value;
  }

  function peek() {
    return cachedNonce;
  }

  async function reset() {
    await refresh();
  }

  function bump({ currentMaxFeePerGas, bumpGwei, maxFeePerGasCap }) {
    if (typeof currentMaxFeePerGas !== "bigint" || currentMaxFeePerGas < 0n) {
      throw new Error("bump: currentMaxFeePerGas must be a non-negative bigint");
    }
    if (typeof bumpGwei !== "bigint" || bumpGwei <= 0n) {
      throw new Error("bump: bumpGwei must be a positive bigint");
    }
    const maxFeePerGas = currentMaxFeePerGas + bumpGwei;
    if (maxFeePerGasCap !== undefined && maxFeePerGasCap !== null) {
      if (typeof maxFeePerGasCap !== "bigint" || maxFeePerGasCap < 0n) {
        throw new Error("bump: maxFeePerGasCap must be a non-negative bigint");
      }
      if (maxFeePerGas > maxFeePerGasCap) {
        throw new Error(
          `bump: maxFeePerGas ${maxFeePerGas} exceeds cap ${maxFeePerGasCap}`
        );
      }
    }
    const maxPriorityFeePerGas = bumpGwei / 2n;
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  return { next, peek, reset, bump };
}

module.exports = { createNonceManager };
