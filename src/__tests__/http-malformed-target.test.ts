/**
 * An unauthenticated request with a malformed request target or Host header
 * must never take the process down. Routing used to build a URL object from
 * req.url and Host before /health, the Host allowlist and the S2S gate; a
 * target such as "//[" made the URL constructor throw inside an async handler,
 * and the unhandled rejection exited Node.
 */
import { randomBytes } from "node:crypto";
import net from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startHttpTransport } from "../index.js";
import { resetGatewayLock } from "../config.js";

const S2S_SECRET = randomBytes(32).toString("hex");
const ENV_KEYS = ["CONDUIT_S2S_SECRET", "MCP_HTTP_PORT", "MCP_HTTP_HOST", "MCP_ALLOWED_HOSTS", "AUTH_MODE"] as const;

const savedEnv = new Map<string, string | undefined>();
let server: Server;
let port: number;
let unhandled: unknown[];
const onUnhandled = (reason: unknown) => unhandled.push(reason);

/** Send raw bytes, return everything the server wrote before it closed the socket. A hang is a failure. */
function rawRequest(text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let received = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no answer and no close within 2s for: ${JSON.stringify(text)}`));
    }, 2000);
    socket.on("data", (chunk) => (received += chunk.toString("utf8")));
    socket.on("error", () => undefined); // a reset counts as a closed socket
    socket.on("close", () => {
      clearTimeout(timer);
      resolve(received);
    });
    socket.write(text);
  });
}

function statusOf(response: string): number | undefined {
  const match = /^HTTP\/1\.1 (\d{3}) /.exec(response);
  return match ? Number(match[1]) : undefined;
}

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
  process.env.AUTH_MODE = "gateway";
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  delete process.env.MCP_ALLOWED_HOSTS;
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
  server = await startHttpTransport();
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("HTTP server did not bind a TCP port");
  port = bound.port;
});

afterEach(async () => {
  process.off("unhandledRejection", onUnhandled);
  resetGatewayLock();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("malformed request targets and Host headers", () => {
  it.each(["//[", "//", "http://["])("target %s is refused and the process survives", async (target) => {
    const response = await rawRequest(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    // An HTTP error response, or a closed socket with nothing written.
    if (response !== "") expect(statusOf(response)).toBeGreaterThanOrEqual(400);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it("Host: [ on /health does not crash the process", async () => {
    const response = await rawRequest("GET /health HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n");
    if (response !== "") expect(statusOf(response)).toBeGreaterThanOrEqual(200);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).toEqual([]);
  });

  it("Host: [ on /mcp is refused at the S2S gate", async () => {
    const response = await rawRequest("POST /mcp HTTP/1.1\r\nHost: [\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    expect(statusOf(response)).toBe(401);
    expect(unhandled).toEqual([]);
  });

  it("a query string does not change routing", async () => {
    const health = await fetch(`http://127.0.0.1:${port}/health?probe=1`);
    expect(health.status).toBe(200);
    const unknown = await fetch(`http://127.0.0.1:${port}/nope?x=/health`);
    expect(unknown.status).toBe(401);
  });
});
