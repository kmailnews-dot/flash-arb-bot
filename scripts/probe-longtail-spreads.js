#!/usr/bin/env node
"use strict";

/// Sonde longtail READ-ONLY : mesure l'écart brut (bps) d'un aller-retour
/// WETH -> intermédiaire -> WETH sur des routes V2/V3 supportées par le
/// contrat gelé (DexKind.V2 / DexKind.V3 uniquement, FlashArbExecutor.sol:142).
///
/// Aucune écriture, aucun état du bot modifié (pas de scans.jsonl, pas de guards).
/// Réutilise quoteLeg() de bot/prices.js et les routers déjà présents dans .env.
///
/// Sortie : bps bruts par taille. Candidat viable si gross > premium(5) + fees + 60
/// (plancher longtail minProfitBps [60,100], bot/config.js PROFILE_BOUNDS).

require("dotenv").config();
const { ethers } = require("ethers");
const { quoteLeg } = require("../bot/prices");

const RPC_URL = process.env.ARBITRUM_RPC_URL;
if (!RPC_URL) {
  console.error("ARBITRUM_RPC_URL manquant (.env).");
  process.exit(2);
}

// WETH vérifié dans le dépôt (test/ForkArbitrum.test.js:5).
const WETH = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
// QuoterV2 : adresse vérifiée par le bot lui-même (ETH_USD_ROUTE_JSON, .env).
const QUOTER_V2 =
  (() => {
    try {
      const route = JSON.parse(process.env.ETH_USD_ROUTE_JSON);
      if (route && route.kind === "V3" && route.quoter) return route.quoter;
    } catch {}
    return "0x61fFE014Bf18ABF3d1a19B7BB06CB4f4bCf0B21e"; // QuoterV2 Arbitrum
  })();

// Routers extraits du .env (déjà utilisés par le bot, bot/config.js loadPairs).
const envRouters = (() => {
  try {
    const pairs = JSON.parse(process.env.PAIRS_CONFIG_JSON);
    const routers = new Set();
    for (const p of pairs) {
      for (const leg of [p.legOut, p.legBack]) if (leg.kind === "V2") routers.add(leg.router);
    }
    return [...routers];
  } catch {
    return [];
  }
})();

// Candidats longtail : intermédiaire + frais V3 essayés. Adresses vérifiées
// on-chain (symbol/decimals) avant toute quote ; candidat sauté si mismatch.
const CANDIDATES = [
  { symbol: "USD₮0", addr: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", decimals: 6, v3Fees: [500] },
  { symbol: "DAI", addr: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", decimals: 18, v3Fees: [100] },
  { symbol: "ARB", addr: "0x912CE59144191C1204E64559FE8253a0e49E6548", decimals: 18, v3Fees: [500, 3000] },
  { symbol: "WBTC", addr: "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", decimals: 8, v3Fees: [3000] },
];

const SIZES_WETH = ["0.01", "0.05", "0.1", "0.5"];
const PREMIUM_BPS = 5;
const V2_FEE_BPS = 30;
const LONGTAIL_MIN_GROSS_BPS = PREMIUM_BPS + V2_FEE_BPS + 5 + 60; // ex: V3 500 = 100

async function tryQuote(provider, leg, tokenIn, amountIn) {
  try {
    return { ok: true, amount: await quoteLeg(provider, leg, tokenIn, amountIn) };
  } catch (err) {
    return { ok: false, error: err?.shortMessage || err?.message || String(err) };
  }
}

async function verifyToken(provider, cand) {
  const token = new ethers.Contract(
    cand.addr,
    ["function symbol() view returns (string)", "function decimals() view returns (uint8)"],
    provider
  );
  const [symbol, decimals] = await Promise.all([token.symbol(), token.decimals()]);
  return { symbol, decimals: Number(decimals) };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const blockNumber = await provider.getBlockNumber();
  console.log(`bloc=${blockNumber} routers V2 (env): ${envRouters.length}`);
  console.log(`seuil candidat : gross > ${LONGTAIL_MIN_GROSS_BPS} bps (premium 5 + V2 30 + V3 + plancher 60)\n`);

  // Vérifie le QuoterV2 avec un quote WETH -> USDC (1000 USDC, fee 500) comme canari.
  const USDC = JSON.parse(process.env.PAIRS_CONFIG_JSON)[0].borrowedToken.address;
  const canary = await tryQuote(
    provider,
    { kind: "V3", tokenOut: USDC, v3Fee: 500, quoter: QUOTER_V2 },
    WETH,
    ethers.parseUnits("1", 18)
  );
  if (!canary.ok) {
    console.error(`QuoterV2 canari a échoué: ${canary.error} — adresses à vérifier, arrêt.`);
    process.exit(1);
  }

  let anyViable = false;
  for (const cand of CANDIDATES) {
    const info = await verifyToken(provider, cand);
    if (info.symbol !== cand.symbol || info.decimals !== cand.decimals) {
      console.log(`${cand.symbol}: SKIP (on-chain symbol=${info.symbol} decimals=${info.decimals})`);
      continue;
    }
    for (const router of envRouters) {
      for (const v3Fee of cand.v3Fees) {
        for (const dir of ["V2→V3", "V3→V2"]) {
          const mid = cand.addr;
          const legA =
            dir === "V2→V3"
              ? { kind: "V2", router, tokenOut: mid }
              : { kind: "V3", tokenOut: mid, v3Fee, quoter: QUOTER_V2 };
          const legB =
            dir === "V2→V3"
              ? { kind: "V3", tokenOut: WETH, v3Fee, quoter: QUOTER_V2 }
              : { kind: "V2", router, tokenOut: WETH };
          const feeTotal = PREMIUM_BPS + V2_FEE_BPS + v3Fee / 100;
          const lines = [];
          let viable = false;
          for (const size of SIZES_WETH) {
            const amountIn = ethers.parseUnits(size, 18);
            const a = await tryQuote(provider, legA, WETH, amountIn);
            if (!a.ok) {
              lines.push(`${size}:ERR(${a.error.slice(0, 40)})`);
              continue;
            }
            const b = await tryQuote(provider, legB, mid, a.amount);
            if (!b.ok) {
              lines.push(`${size}:ERR2(${b.error.slice(0, 40)})`);
              continue;
            }
            const grossBps = ((Number(b.amount) - Number(amountIn)) / Number(amountIn)) * 10_000;
            lines.push(`${size}:${grossBps.toFixed(1)}`);
            if (grossBps > LONGTAIL_MIN_GROSS_BPS) viable = true;
          }
          console.log(
            `WETH/${cand.symbol} ${dir} fee${v3Fee} (${feeTotal.toFixed(0)} bps): ${lines.join("  ")}` +
              (viable ? "  <<< VIABLE" : "")
          );
          anyViable = anyViable || viable;
        }
      }
    }
  }
  console.log(anyViable ? "\n≥1 route viable : proposer PAIRS_CONFIG_JSON." : "\nAucune route viable au seuil longtail.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`FATAL: ${err?.shortMessage || err?.message || err}`);
    process.exit(1);
  });
