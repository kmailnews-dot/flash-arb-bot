const { expect } = require("chai");
const { ethers } = require("ethers");
const net = require("net");
const http = require("http");
const https = require("https");
const {
  socksConnect,
  validateProxyConfig,
  createProxyAgent,
  createJsonRpcProvider,
} = require("../bot/netproxy");

describe("bot/netproxy", function () {
  describe("validateProxyConfig", function () {
    it("is a strict no-op when proxyUrl is unset", function () {
      for (const proxyUrl of [undefined, null, ""]) {
        expect(() => validateProxyConfig({ rpcUrl: "https://example.invalid/rpc", proxyUrl })).to.not.throw();
      }
    });

    it("rejects a WebSocket RPC URL when a proxy is set (fail-closed)", function () {
      expect(() =>
        validateProxyConfig({ rpcUrl: "wss://example.invalid/ws", proxyUrl: "socks5h://127.0.0.1:9050" })
      ).to.throw(/only supported for http\(s\) RPC URLs/);
    });

    it("rejects non-SOCKS5 proxy schemes", function () {
      expect(() =>
        validateProxyConfig({ rpcUrl: "https://example.invalid/rpc", proxyUrl: "http://127.0.0.1:8080" })
      ).to.throw(/socks5:\/\/ or socks5h:\/\//);
    });

    it("rejects a proxy URL without host or port", function () {
      expect(() =>
        validateProxyConfig({ rpcUrl: "https://example.invalid/rpc", proxyUrl: "socks5h://" })
      ).to.throw(/host and port/);
    });
  });

  describe("createProxyAgent / createJsonRpcProvider", function () {
    it("returns null and a plain JsonRpcProvider when proxyUrl is unset", function () {
      expect(createProxyAgent({ rpcUrl: "https://example.invalid/rpc", proxyUrl: null })).to.equal(null);
      const provider = createJsonRpcProvider({ rpcUrl: "https://example.invalid/rpc", proxyUrl: null });
      expect(provider).to.be.instanceOf(ethers.JsonRpcProvider);
    });

    it("builds a keepAlive tunnel agent and a FetchRequest-based provider when set", function () {
      const agent = createProxyAgent({
        rpcUrl: "https://example.invalid/rpc",
        proxyUrl: "socks5h://127.0.0.1:9050",
      });
      expect(agent).to.be.instanceOf(https.Agent);
      expect(agent.keepAlive).to.equal(true);
      expect(typeof agent.createConnection).to.equal("function");

      const provider = createJsonRpcProvider({
        rpcUrl: "https://example.invalid/rpc",
        proxyUrl: "socks5h://127.0.0.1:9050",
      });
      expect(provider).to.be.instanceOf(ethers.JsonRpcProvider);
      provider.destroy();
    });

    it("rejects a non-SOCKS5 proxy scheme at provider creation", function () {
      expect(() =>
        createProxyAgent({ rpcUrl: "https://example.invalid/rpc", proxyUrl: "socks4://127.0.0.1:9050" })
      ).to.throw(/socks5:\/\/ or socks5h:\/\//);
    });

    it("tunnels an HTTP request through a local SOCKS5 proxy (end-to-end, no Tor)", async function () {
      // Serveur HTTP local qui répond du JSON-RPC factice.
      const server = http.createServer((req, resp) => {
        resp.writeHead(200, { "content-type": "application/json" });
        resp.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
      });
      const httpPort = await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });

      // Faux proxy SOCKS5 : salutation, puis CONNECT vers le serveur TLS local et pipe.
      const proxy = net.createServer((client) => {
        let stage = 0;
        client.on("data", (chunk) => {
          if (stage === 0) {
            if (chunk.length < 2) return;
            stage = 1;
            client.write(Buffer.from([0x05, 0x00]));
            return;
          }
          if (stage !== 1 || chunk.length < 7) return;
          stage = 2;
          const atyp = chunk[3];
          let host;
          let offset;
          if (atyp === 0x03) {
            const len = chunk[4];
            host = chunk.subarray(5, 5 + len).toString("ascii");
            offset = 5 + len;
          } else if (atyp === 0x01) {
            host = `${chunk[4]}.${chunk[5]}.${chunk[6]}.${chunk[7]}`;
            offset = 8;
          } else {
            client.destroy();
            return;
          }
          const port = (chunk[offset] << 8) | chunk[offset + 1];
          if (chunk[0] !== 0x05 || chunk[1] !== 0x01 || host !== "127.0.0.1") {
            client.destroy();
            return;
          }
          const upstream = net.connect(port, "127.0.0.1", () => {
            client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.once("error", () => client.destroy());
        });
      });
      const proxyPort = await new Promise((resolve, reject) => {
        proxy.once("error", reject);
        proxy.listen(0, "127.0.0.1", () => resolve(proxy.address().port));
      });

      try {
        const agent = createProxyAgent({
          rpcUrl: `http://127.0.0.1:${httpPort}`,
          proxyUrl: `socks5h://127.0.0.1:${proxyPort}`,
        });
        expect(agent).to.be.instanceOf(http.Agent);

        const result = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("timeout")), 5000);
          const req = http.request(
            { host: "127.0.0.1", port: httpPort, path: "/", method: "POST", agent },
            (resp) => {
              let body = "";
              resp.on("data", (c) => (body += c));
              resp.on("end", () => {
                clearTimeout(timer);
                resolve({ statusCode: resp.statusCode, body });
              });
            }
          );
          req.on("error", (e) => {
            clearTimeout(timer);
            reject(e);
          });
          req.end();
        });
        expect(result.statusCode).to.equal(200);
        expect(JSON.parse(result.body).result).to.equal("0x1");
      } finally {
        proxy.close();
        server.close();
      }
    });
  });
});
