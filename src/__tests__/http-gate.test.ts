/**
 * HTTP-layer 401 gate + routing tests.
 *
 * Mirrors the routing in src/index.ts using the REAL credential resolver
 * (resolveGatewayCredentials) so header-name drift fails here. The full
 * end-to-end proof (real createMcpHandler serving both eras) lives in
 * scripts/smoke-dual-era.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import {
  GATEWAY_HEADERS,
  REQUIRED_GATEWAY_HEADERS,
  resolveGatewayCredentials,
} from "../mcp-server.js";

function createGateServer(isGatewayMode: boolean): http.Server {
  return http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Access-Control-Allow-Headers",
      ["Content-Type", "Accept", "Authorization", "Mcp-Session-Id", ...GATEWAY_HEADERS].join(", ")
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (url.pathname === "/mcp") {
      if (isGatewayMode) {
        const { error } = resolveGatewayCredentials(
          (name) => req.headers[name] as string | undefined
        );
        if (error) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: `Unauthorized: ${error}`,
                data: { required: REQUIRED_GATEWAY_HEADERS },
              },
              id: null,
            })
          );
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "mcp-endpoint-reached" }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {}
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method: options.method || "GET", headers: options.headers },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const FULL_HEADERS = {
  "X-Dubber-Client-Id": "id",
  "X-Dubber-Client-Secret": "secret",
  "X-Dubber-Auth-Id": "auth-id",
  "X-Dubber-Auth-Token": "auth-token",
};

describe("gateway-mode HTTP gate", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = createGateServer(true);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        port = typeof addr === "object" && addr ? addr.port : 0;
        resolve();
      });
    });
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("/health is shallow and unauthenticated", async () => {
    const res = await request(port, "/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).status).toBe("ok");
  });

  it("missing credential headers → 401 JSON-RPC -32001 naming the required headers", async () => {
    const res = await request(port, "/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error.code).toBe(-32001);
    expect(body.error.data.required).toEqual([
      "X-Dubber-Client-Id",
      "X-Dubber-Client-Secret",
      "X-Dubber-Auth-Id",
      "X-Dubber-Auth-Token",
    ]);
  });

  it("a partial credential set is still 401 (never falls through to env)", async () => {
    const res = await request(port, "/mcp", {
      method: "POST",
      headers: { "X-Dubber-Client-Id": "id" },
    });
    expect(res.status).toBe(401);
  });

  it("three of four required headers is still 401", async () => {
    const threeOfFour = {
      "X-Dubber-Client-Id": FULL_HEADERS["X-Dubber-Client-Id"],
      "X-Dubber-Client-Secret": FULL_HEADERS["X-Dubber-Client-Secret"],
      "X-Dubber-Auth-Id": FULL_HEADERS["X-Dubber-Auth-Id"],
    };
    const res = await request(port, "/mcp", { method: "POST", headers: threeOfFour });
    expect(res.status).toBe(401);
  });

  it("the complete credential set reaches the MCP handler", async () => {
    const res = await request(port, "/mcp", { method: "POST", headers: FULL_HEADERS });
    expect(res.status).toBe(200);
  });

  it("CORS allow-headers include all X-Dubber-* names; OPTIONS answers 204", async () => {
    const res = await request(port, "/mcp", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    const allow = String(res.headers["access-control-allow-headers"]);
    for (const header of GATEWAY_HEADERS) expect(allow).toContain(header);
  });

  it("unknown paths 404 with the endpoint listing", async () => {
    const res = await request(port, "/nope");
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body).endpoints).toEqual(["/mcp", "/health"]);
  });
});
