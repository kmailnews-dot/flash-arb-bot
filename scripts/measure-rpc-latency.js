#!/usr/bin/env node
"use strict";

/// Mesure la latence RPC selon trois modes, pour decider si le routage Tor est viable :
///   direct      — chemin actuel du bot (ethers JsonRpcProvider sans agent)
///   tor-fresh   — SOCKS5 Tor, connexion re-etablie a chaque appel (comportement
///                 par defaut d'un agent non-keepalive, comme geturl.js d'ethers)
///   tor-ka      — SOCKS5 Tor, tunnel reutilise (keepAlive=true)
///
/// Semantique socks5h : le nom d'hote cible est resolu PAR LE PROXY (Tor),
/// jamais localement — le script n'ecrit pas le hostname dans le paquet de
/// salutation, seulement dans le CONNECT.
///
/// Outil de mesure pur : ne modifie aucun etat du bot, n'ecrit pas dans logs/.
/// N'affiche jamais l'URL RPC (elle peut contenir une cle d'API).
///
/// Usage : node scripts/measure-rpc-latency.js [N_ECHANTILLONS_PAR_MODE]

const net = require("net");
const tls = require("tls");
const http = require("http");
const https = require("https");
require("dotenv").config();
const { ethers } = require("ethers");

const RPC_URL = process.env.ARBITRUM_RPC_URL;
if (!RPC_URL) {
  console.error("ARBITRUM_RPC_URL manquant (.env).");
  process.exit(2);
}
const N = Math.max(3, Number(process.argv[2] || 15));
const SOCKS_HOST = "127.0.0.1";
const SOCKS_PORT = Number(process.env.TOR_SOCKS_PORT || 9050);
const HANDSHAKE_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 30_000;

function parseTarget(urlStr) {
  const u = new URL(urlStr);
  const isHttps = u.protocol === "https:";
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`schema RPC non supporte pour ce script : ${u.protocol} (ws non mesure ici)`);
  }
  return {
    isHttps,
    host: u.hostname,
    port: Number(u.port) || (isHttps ? 443 : 80),
  };
}

/// Handshake SOCKS5 minimal (pas d'auth), CONNECT vers host:port.
/// Resolu par le proxy : le target host est envoye comme nom de domaine (atyp=3).
function socksConnect({ host, port, timeoutMs = HANDSHAKE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: SOCKS_HOST, port: SOCKS_PORT });
    let buf = Buffer.alloc(0);
    let stage = 0;
    let timer = null;
    const fail = (msg) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(msg));
    };
    timer = setTimeout(() => fail("SOCKS: timeout handshake"), timeoutMs);
    socket.on("error", (e) => fail(`SOCKS: ${e.message}`));
    socket.on("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail("SOCKS: salutation refusee");
        stage = 1;
        buf = buf.subarray(2);
        const hb = Buffer.from(host, "ascii");
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
            hb,
            Buffer.from([(port >> 8) & 0xff, port & 0xff]),
          ])
        );
      } else if (stage === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? buf[4] : -1;
        if (addrLen < 0) return fail(`SOCKS: atyp inconnu (${atyp})`);
        const total = 4 + (atyp === 0x03 ? 1 : 0) + addrLen + 2;
        if (buf.length < total) return;
        clearTimeout(timer);
        if (buf[1] !== 0x00) return fail(`SOCKS: CONNECT rejete (code ${buf[1]})`);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        resolve(socket);
      }
    });
  });
}

/// Agent http(s) dont chaque connexion passe par CONNECT SOCKS5 puis (si https) TLS.
/// C'est le mecanisme exact qui serait integre au bot via
/// ethers.FetchRequest.createGetUrl({ agent }).
function makeTunnelAgent(target, { keepAlive }) {
  const Ctor = target.isHttps ? https.Agent : http.Agent;
  const agent = new Ctor({ keepAlive });
  agent.createConnection = (options, cb) => {
    socksConnect({ host: target.host, port: target.port })
      .then((sock) => {
        if (!target.isHttps) return cb(null, sock);
        const tlsSock = tls.connect({
          socket: sock,
          servername: target.host,
          rejectUnauthorized: true,
        });
        tlsSock.once("error", (e) => cb(e));
        tlsSock.once("secureConnect", () => cb(null, tlsSock));
      })
      .catch((e) => cb(e));
  };
  return agent;
}

function makeRequest() {
  const req = new ethers.FetchRequest(RPC_URL);
  req.method = "POST";
  req.setHeader("content-type", "application/json");
  req.body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "eth_blockNumber",
    params: [],
  });
  req.timeout = CALL_TIMEOUT_MS;
  return req;
}

async function timedCall() {
  const t0 = process.hrtime.bigint();
  const resp = await makeRequest().send();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (resp.statusCode !== 200) throw new Error(`HTTP ${resp.statusCode}`);
  const body = JSON.parse(resp.bodyText);
  if (body.error) throw new Error(`RPC error: ${body.error.message}`);
  if (typeof body.result !== "string") throw new Error("reponse invalide");
  return ms;
}

function percentiles(times) {
  const s = [...times].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  return { min: s[0], p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}

async function measureMode(label, n) {
  const times = [];
  let errors = 0;
  for (let i = 0; i < n; i += 1) {
    try {
      times.push(await timedCall());
    } catch (err) {
      errors += 1;
      if (errors <= 2) console.error(`  [${label}] erreur echantillon: ${err.message}`);
    }
  }
  const st = times.length > 0 ? percentiles(times) : null;
  return { label, n, errors, ok: times.length, ...st };
}

async function main() {
  const target = parseTarget(RPC_URL);
  console.log(
    `cible RPC: schema=${target.isHttps ? "https" : "http"} port=${target.port} ` +
      `(hostname omis), N=${N}/mode, socks5h://${SOCKS_HOST}:${SOCKS_PORT}`
  );

  // 1) direct — en premier, avant tout registerGetUrl (global au process).
  const results = [await measureMode("direct", N)];

  // 2) tor-fresh : nouvel agent sans keepAlive, connexion complete par appel.
  ethers.FetchRequest.registerGetUrl(
    ethers.FetchRequest.createGetUrlFunc({ agent: makeTunnelAgent(target, { keepAlive: false }) })
  );
  results.push(await measureMode("tor-fresh", N));

  // 3) tor-ka : tunnel reutilise entre les appels.
  ethers.FetchRequest.registerGetUrl(
    ethers.FetchRequest.createGetUrlFunc({ agent: makeTunnelAgent(target, { keepAlive: true }) })
  );
  results.push(await measureMode("tor-ka", N));

  console.log("\nmode        ok/err   min      p50      p95      max   (ms)");
  for (const r of results) {
    if (!r.p50) {
      console.log(`${r.label.padEnd(12)} 0/${r.n}      (aucun appel reussi)`);
      continue;
    }
    console.log(
      `${r.label.padEnd(12)} ${String(r.ok).padStart(3)}/${r.errors} ` +
        `${r.min.toFixed(0).padStart(8)} ${r.p50.toFixed(0).padStart(8)} ` +
        `${r.p95.toFixed(0).padStart(8)} ${r.max.toFixed(0).padStart(8)}`
    );
  }
  console.log(
    "\nNote: tor-fresh inclut CONNECT SOCKS5 + handshake TLS par appel ; " +
      "tor-ka mesure le RTT d'un tunnel existant. Les quotes reelles (eth_call) " +
      "s'ajoutent au RTT, leur difference relative est comparable."
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`FATAL: ${err.message}`);
    process.exit(1);
  });
