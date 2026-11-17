"use strict";

/// Proxy SOCKS5 minimal (sans dépendance) + fabrique de provider JSON-RPC.
///
/// Désactivé par défaut : `RPC_PROXY_URL` non défini → `createJsonRpcProvider`
/// produit exactement `new ethers.JsonRpcProvider(rpcUrl)` (aucun changement
/// de comportement, aucun test impacté — AGENTS.md §2).
///
/// Sémantique socks5h : le nom d'hôte RPC est résolu PAR LE PROXY (Tor),
/// jamais localement. Aucune valeur de cette config n'est loggée.
///
/// Mesure (2026-11-16, scripts/measure-rpc-latency.js, N=25, 0 erreur) :
/// Tor n'est viable qu'avec réutilisation du tunnel (keepAlive) :
/// direct p50/p95 = 208/233 ms ; connexion neuve = 559/995 ms (rejeté) ;
/// tunnel réutilisé = 217/598 ms.

const net = require("net");
const tls = require("tls");
const http = require("http");
const https = require("https");
const { ethers } = require("ethers");

const HANDSHAKE_TIMEOUT_MS = 10_000;

/// Handshake SOCKS5 minimal (sans authentification), CONNECT vers targetHost:targetPort.
function socksConnect({
  proxyHost,
  proxyPort,
  targetHost,
  targetPort,
  timeoutMs = HANDSHAKE_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    let buf = Buffer.alloc(0);
    let stage = 0;
    const fail = (msg) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(msg));
    };
    const timer = setTimeout(() => fail("SOCKS: handshake timeout"), timeoutMs);
    socket.on("error", (e) => fail(`SOCKS: ${e.message}`));
    socket.on("connect", () => socket.write(Buffer.from([0x05, 0x01, 0x00])));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 0x05 || buf[1] !== 0x00) return fail("SOCKS: greeting refused");
        stage = 1;
        buf = buf.subarray(2);
        const hb = Buffer.from(targetHost, "ascii");
        socket.write(
          Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hb.length]),
            hb,
            Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
          ])
        );
      } else if (stage === 1) {
        if (buf.length < 5) return;
        const atyp = buf[3];
        const addrLen = atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : atyp === 0x03 ? buf[4] : -1;
        if (addrLen < 0) return fail(`SOCKS: unknown atyp (${atyp})`);
        const total = 4 + (atyp === 0x03 ? 1 : 0) + addrLen + 2;
        if (buf.length < total) return;
        clearTimeout(timer);
        if (buf[1] !== 0x00) return fail(`SOCKS: CONNECT refused (code ${buf[1]})`);
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        resolve(socket);
      }
    });
  });
}

/// Validation fail-closed, appelée au chargement de config quand RPC_PROXY_URL est défini.
/// `proxyUrl` null/undefined : no-op strict (chemin historique).
function validateProxyConfig({ rpcUrl, proxyUrl }) {
  if (proxyUrl === undefined || proxyUrl === null || proxyUrl === "") return;
  const target = new URL(rpcUrl);
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    throw new Error(
      `RPC_PROXY_URL is only supported for http(s) RPC URLs (got ${target.protocol}). ` +
        "WebSocket RPC via SOCKS5 is not supported; unset RPC_PROXY_URL or use an http(s) RPC URL."
    );
  }
  const proxy = new URL(proxyUrl);
  if (proxy.protocol !== "socks5:" && proxy.protocol !== "socks5h:") {
    throw new Error(`RPC_PROXY_URL must use the socks5:// or socks5h:// scheme (got ${proxy.protocol}).`);
  }
  if (!proxy.hostname || !proxy.port) {
    throw new Error("RPC_PROXY_URL must include an explicit host and port.");
  }
}

/// Agent http(s) dont chaque connexion passe par CONNECT SOCKS5 puis (si https) TLS.
/// keepAlive=true est obligatoire : mesuré, Tor n'est viable qu'avec tunnel réutilisé.
/// `rejectUnauthorized` n'est exposé que pour les tests (faux TLS local), défaut strict.
function createProxyAgent({ rpcUrl, proxyUrl, rejectUnauthorized = true }) {
  const agent = null;
  if (proxyUrl === undefined || proxyUrl === null || proxyUrl === "") return agent;
  validateProxyConfig({ rpcUrl, proxyUrl });
  const target = new URL(rpcUrl);
  const proxy = new URL(proxyUrl);
  const isHttps = target.protocol === "https:";
  const Ctor = isHttps ? https.Agent : http.Agent;
  const tunnelAgent = new Ctor({ keepAlive: true });
  tunnelAgent.createConnection = (options, cb) => {
    socksConnect({
      proxyHost: proxy.hostname,
      proxyPort: Number(proxy.port),
      targetHost: target.hostname,
      targetPort: Number(target.port) || (isHttps ? 443 : 80),
    })
      .then((sock) => {
        if (!isHttps) return cb(null, sock);
        const tlsSock = tls.connect({
          socket: sock,
          servername: target.hostname,
          rejectUnauthorized,
        });
        tlsSock.once("error", (e) => cb(e));
        tlsSock.once("secureConnect", () => cb(null, tlsSock));
      })
      .catch(cb);
  };
  return tunnelAgent;
}

/// Fabrique unique des providers JSON-RPC http(s) du bot.
/// proxyUrl non défini → strictement équivalent à `new ethers.JsonRpcProvider(rpcUrl)`.
///
/// `chainId` défini → réseau statique : ethers ne refait plus un `eth_chainId`
/// avant chaque `eth_call` (mesuré : +1 RPC et ~1 aller-retour par quote).
/// L'appelant doit alors vérifier le chainId réel une fois via `eth_chainId`
/// (bot/index.js et checkChainId le font), sinon le contrôle serait fictif.
function createJsonRpcProvider({ rpcUrl, proxyUrl, chainId }) {
  const network = Number.isInteger(chainId) && chainId > 0 ? chainId : null;
  const options = network === null ? undefined : { staticNetwork: true };
  if (proxyUrl === undefined || proxyUrl === null || proxyUrl === "") {
    return network === null
      ? new ethers.JsonRpcProvider(rpcUrl)
      : new ethers.JsonRpcProvider(rpcUrl, network, options);
  }
  const agent = createProxyAgent({ rpcUrl, proxyUrl });
  // registerGetUrl est global au process : acceptable, la config est chargée une
  // seule fois par process (config.js) et l'agent est dédié à l'URL RPC.
  ethers.FetchRequest.registerGetUrl(ethers.FetchRequest.createGetUrlFunc({ agent }));
  const request = new ethers.FetchRequest(rpcUrl);
  return network === null
    ? new ethers.JsonRpcProvider(request)
    : new ethers.JsonRpcProvider(request, network, options);
}

module.exports = {
  HANDSHAKE_TIMEOUT_MS,
  socksConnect,
  validateProxyConfig,
  createProxyAgent,
  createJsonRpcProvider,
};
