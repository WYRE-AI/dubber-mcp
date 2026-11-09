/**
 * HTTP transport fail-closed auth (CWE-306).
 *
 * Startup requires a real CONDUIT_S2S_SECRET. Empty and known placeholders
 * refuse to listen. MCP_ALLOW_INSECURE_DEV=1 is the empty-secret bypass: it
 * binds 127.0.0.1 even when MCP_HTTP_HOST is a wider address.
 * /mcp rejects a missing or invalid X-Gateway-S2S header.
 * AUTH_MODE=gateway rejects requests that omit vendor credential headers
 * and must not fall back to DUBBER_* in process.env.
 */
import { createHmac, randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Every call this process makes to the Dubber API, recorded by a fetch stub.
 * Requests to the local test server pass through to the real fetch.
 */
const outbound: Array<{ url: string; body: string }> = [];
const realFetch = globalThis.fetch;
vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (url.startsWith("http://127.0.0.1")) return realFetch(input, init);
  outbound.push({ url, body: typeof init?.body === "string" ? init.body : "" });
  return new Response(JSON.stringify({ access_token: "tok-from-mock", expires_in: 240 }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

const { startHttpTransport } = await import("../index.js");
const { clearTokenCache } = await import("../dubber-api.js");
const { resetGatewayLock } = await import("../config.js");

// Generated per run: a committed fixture would be a publicly known secret that passes the checks.
const S2S_SECRET = randomBytes(32).toString("hex");
const ENV_CLIENT_ID = "env-client-id-must-not-be-used";
const ENV_CLIENT_SECRET = "env-client-secret-must-not-be-used";
const ENV_AUTH_ID = "env-auth-id-must-not-be-used";
const ENV_AUTH_TOKEN = "env-auth-token-must-not-be-used";

const PLACEHOLDERS = [
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
] as const;

const ENV_KEYS = [
  "CONDUIT_S2S_SECRET",
  "MCP_ALLOW_INSECURE_DEV",
  "MCP_HTTP_PORT",
  "MCP_HTTP_HOST",
  "AUTH_MODE",
  "DUBBER_CLIENT_ID",
  "DUBBER_CLIENT_SECRET",
  "DUBBER_AUTH_ID",
  "DUBBER_AUTH_TOKEN",
  "DUBBER_REGION",
  "DUBBER_BASE_URL",
  "DUBBER_TOOL_TIERS",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
] as const;

const savedEnv = new Map<string, string | undefined>();
const servers: Server[] = [];

function mintS2sHeader(secret: string, unixSeconds = Math.floor(Date.now() / 1000)): string {
  const message = `t=${unixSeconds}`;
  const hex = createHmac("sha256", secret).update(message).digest("hex");
  return `${message},v1=${hex}`;
}

function captureStderr(): { text: () => string; restore: () => void } {
  const lines: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    return true;
  });
  return {
    text: () => lines.join(""),
    restore: () => spy.mockRestore(),
  };
}

function stubExit(): void {
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit:${String(code)}`);
  }) as typeof process.exit);
}

interface HttpResult {
  status: number;
  body: string;
  contentType: string;
}

function mcpHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...extra,
  };
}

async function sendHttp(options: {
  port: number;
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResult> {
  const response = await fetch(`http://127.0.0.1:${options.port}${options.path}`, {
    method: options.method ?? "GET",
    headers: options.headers,
    body: options.body,
  });
  return {
    status: response.status,
    body: await response.text(),
    contentType: response.headers.get("content-type") ?? "",
  };
}

function parseJson(result: HttpResult): unknown {
  const eventStream = result.contentType.includes("text/event-stream");
  if (eventStream || result.body.includes("\ndata:")) {
    const dataLines = result.body.split("\n").filter((line) => line.startsWith("data:"));
    const last = dataLines[dataLines.length - 1];
    if (!last) throw new Error(`No data frame in SSE body: ${result.body}`);
    return JSON.parse(last.slice("data:".length).trim());
  }
  return JSON.parse(result.body);
}

async function listen(): Promise<{ port: number; address: string }> {
  const server = await startHttpTransport();
  servers.push(server);
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    throw new Error("HTTP server did not bind a TCP port");
  }
  return { port: bound.port, address: bound.address };
}

const statusCall = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "dubber_test_connection", arguments: {} },
});

const toolsList = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {},
});

const gatewayHeaders = {
  "x-dubber-client-id": "header-client-id",
  "x-dubber-client-secret": "header-client-secret",
  "x-dubber-auth-id": "header-auth-id",
  "x-dubber-auth-token": "header-auth-token",
  "x-dubber-region": "us",
};

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
});

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  process.env.MCP_HTTP_PORT = "0";
  process.env.MCP_HTTP_HOST = "127.0.0.1";
  process.env.LOG_LEVEL = "error";
  delete process.env.CONDUIT_S2S_SECRET;
  delete process.env.MCP_ALLOW_INSECURE_DEV;
  delete process.env.AUTH_MODE;
  delete process.env.DUBBER_CLIENT_ID;
  delete process.env.DUBBER_CLIENT_SECRET;
  delete process.env.DUBBER_AUTH_ID;
  delete process.env.DUBBER_AUTH_TOKEN;
  delete process.env.DUBBER_REGION;
  delete process.env.DUBBER_BASE_URL;
  delete process.env.DUBBER_TOOL_TIERS;
  outbound.length = 0;
  clearTokenCache();
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetGatewayLock();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
  // The image default. (AUTH_MODE=env additionally requires DUBBER_* at startup; tested below.)
  beforeEach(() => {
    process.env.AUTH_MODE = "gateway";
  });

  it("refuses to start when CONDUIT_S2S_SECRET is empty", async () => {
    const logs = captureStderr();
    stubExit();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("Refusing to start HTTP transport");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("refuses to start when CONDUIT_S2S_SECRET is whitespace", async () => {
    process.env.CONDUIT_S2S_SECRET = "   ";
    const logs = captureStderr();
    stubExit();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("CONDUIT_S2S_SECRET is empty");
    } finally {
      logs.restore();
    }
  });

  it("still refuses when MCP_ALLOW_INSECURE_DEV is not exactly 1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "true";
    const logs = captureStderr();
    stubExit();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      expect(logs.text()).toContain("Refusing to start HTTP transport");
    } finally {
      logs.restore();
    }
  });

  it.each(PLACEHOLDERS)("refuses the placeholder %s even with the dev bypass", async (placeholder) => {
    process.env.CONDUIT_S2S_SECRET = `  ${placeholder.toUpperCase()}  `;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const logs = captureStderr();
    stubExit();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      const text = logs.text();
      expect(text).toContain("known placeholder");
      expect(text).not.toContain(`  ${placeholder.toUpperCase()}  `);
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("allows startup with a warning when MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    delete process.env.MCP_HTTP_HOST;
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      const text = logs.text();
      expect(text).toContain("SECURITY WARNING");
      expect(text).toContain("CONDUIT_S2S_SECRET is empty");
      expect(text).toContain("MCP_ALLOW_INSECURE_DEV=1");
      expect(text).toContain("127.0.0.1");
      expect(text).not.toContain("not a loopback address");
      expect(text).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it.each(["0.0.0.0", "10.1.2.3"])(
    "forces 127.0.0.1 when the dev bypass is set and MCP_HTTP_HOST is %s",
    async (host) => {
      process.env.MCP_ALLOW_INSECURE_DEV = "1";
      process.env.MCP_HTTP_HOST = host;
      const logs = captureStderr();
      try {
        const server = await listen();
        expect(server.address).toBe("127.0.0.1");
        const text = logs.text();
        expect(text).toContain(`MCP_HTTP_HOST=${host} is not a loopback address`);
        expect(text).toContain("Binding 127.0.0.1 only");
        expect(text).toContain("SECURITY WARNING");
        expect(text).not.toContain(S2S_SECRET);
      } finally {
        logs.restore();
      }
    }
  );

  it("forces 127.0.0.1 when the dev bypass host is localhost", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "localhost";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("127.0.0.1");
      expect(logs.text()).toContain("SECURITY WARNING");
      expect(logs.text()).not.toContain("not a loopback address");
    } finally {
      logs.restore();
    }
  });

  it("honors a non-loopback MCP_HTTP_HOST when CONDUIT_S2S_SECRET is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    process.env.MCP_HTTP_HOST = "0.0.0.0";
    const logs = captureStderr();
    try {
      const server = await listen();
      expect(server.address).toBe("0.0.0.0");
      expect(logs.text()).not.toContain("not a loopback address");
      expect(logs.text()).not.toContain("SECURITY WARNING");
      expect(logs.text()).not.toContain(S2S_SECRET);
    } finally {
      logs.restore();
    }
  });

  it("keeps the historical 0.0.0.0 bind when a secret is set and MCP_HTTP_HOST is unset", async () => {
    delete process.env.MCP_HTTP_HOST;
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    const server = await listen();
    expect(server.address).toBe("0.0.0.0");
  });

  it("honors MCP_HTTP_HOST when a secret is set", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.MCP_HTTP_HOST = "127.0.0.1";
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const server = await listen();
    expect(server.address).toBe("127.0.0.1");
  });
});

describe("HTTP /mcp authentication", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.DUBBER_CLIENT_ID = ENV_CLIENT_ID;
    process.env.DUBBER_CLIENT_SECRET = ENV_CLIENT_SECRET;
    process.env.DUBBER_AUTH_ID = ENV_AUTH_ID;
    process.env.DUBBER_AUTH_TOKEN = ENV_AUTH_TOKEN;
    process.env.DUBBER_REGION = "eu";
  });

  it("returns 401 when the S2S header is missing or invalid and does not log the secret", async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const missing = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders(gatewayHeaders),
        body: statusCall,
      });
      const invalid = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          ...gatewayHeaders,
          "x-gateway-s2s": mintS2sHeader("wrong-secret"),
        }),
        body: statusCall,
      });

      expect(missing.status).toBe(401);
      expect(invalid.status).toBe(401);
      expect(missing.body).toContain("X-Gateway-S2S");
      expect(invalid.body).toContain("X-Gateway-S2S");
      for (const body of [missing.body, invalid.body, logs.text()]) {
        expect(body).not.toContain(S2S_SECRET);
        expect(body).not.toContain(ENV_CLIENT_ID);
        expect(body).not.toContain(ENV_CLIENT_SECRET);
        expect(body).not.toContain(ENV_AUTH_TOKEN);
      }
      expect(outbound).toEqual([]);
    } finally {
      logs.restore();
    }
  });

  it("returns 401 in gateway mode without credential headers and does not use env credentials", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: statusCall,
    });
    const body = parseJson(response) as {
      error?: { code?: number; message?: string; data?: { required?: string[] } };
    };

    expect(response.status).toBe(401);
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toContain("Missing credentials");
    expect(body.error?.message).toContain("X-Dubber-Client-Id");
    expect(body.error?.data?.required).toEqual([
      "X-Dubber-Client-Id",
      "X-Dubber-Client-Secret",
      "X-Dubber-Auth-Id",
      "X-Dubber-Auth-Token",
    ]);
    expect(response.body).not.toContain(ENV_CLIENT_ID);
    expect(response.body).not.toContain(ENV_CLIENT_SECRET);
    expect(response.body).not.toContain(ENV_AUTH_TOKEN);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain("eu");
    expect(outbound).toEqual([]);

    const partial = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-dubber-client-id": "header-client-id",
        "x-dubber-client-secret": "   ",
        "x-dubber-auth-id": "header-auth-id",
        "x-dubber-auth-token": "header-auth-token",
      }),
      body: statusCall,
    });
    expect(partial.status).toBe(401);
    expect(outbound).toEqual([]);
  });

  it("rejects a gateway credential header sent more than once", async () => {
    const server = await listen();
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: "/mcp",
          method: "POST",
          headers: {
            ...mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
            // Two separate header lines; Node would join them as "a, b".
            "x-dubber-client-id": ["header-client-id", "other-client-id"],
            "x-dubber-client-secret": "header-client-secret",
            "x-dubber-auth-id": "header-auth-id",
            "x-dubber-auth-token": "header-auth-token",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode ?? 0));
        },
      );
      req.on("error", reject);
      req.end(statusCall);
    });
    expect(status).toBe(401);
    expect(outbound).toEqual([]);
  });

  it.each([
    ["repeated", ["us", "au"]],
    ["blank", "   "],
  ])("rejects an X-Dubber-Region header that is %s instead of defaulting to sandbox", async (_label, region) => {
    const server = await listen();
    const { request } = await import("node:http");
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: "/mcp",
          method: "POST",
          headers: {
            ...mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
            ...gatewayHeaders,
            "x-dubber-region": region,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += String(chunk)));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(statusCall);
    });
    expect(result.status).toBe(401);
    expect(result.body).toContain("Invalid Dubber region");
    expect(outbound).toEqual([]);
  });

  it("accepts a valid S2S header plus credential headers and uses those credentials", async () => {
    const logs = captureStderr();
    try {
      const server = await listen();
      const response = await sendHttp({
        port: server.port,
        method: "POST",
        path: "/mcp",
        headers: mcpHeaders({
          "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
          ...gatewayHeaders,
        }),
        body: statusCall,
      });
      const payload = parseJson(response) as {
        result?: { content?: Array<{ text?: string }> };
      };
      const text = payload.result?.content?.[0]?.text ?? "";

      expect(response.status).toBe(200);
      expect(text).toContain('"ok": true');
      expect(response.body).not.toContain(S2S_SECRET);
      expect(response.body).not.toContain(ENV_CLIENT_ID);
      expect(response.body).not.toContain(ENV_CLIENT_SECRET);
      expect(response.body).not.toContain(ENV_AUTH_TOKEN);
      expect(logs.text()).not.toContain(S2S_SECRET);
      // Exactly one token mint, on the header region, with the header credentials (never env),
      // then the connection check's GET /profile.
      expect(outbound.map((o) => o.url)).toEqual([
        "https://api.dubber.net/us/v1/token",
        "https://api.dubber.net/us/v1/profile",
      ]);
      expect(Object.fromEntries(new URLSearchParams(outbound[0]!.body))).toEqual({
        grant_type: "password",
        client_id: "header-client-id",
        client_secret: "header-client-secret",
        username: "header-auth-id",
        password: "header-auth-token",
      });
    } finally {
      logs.restore();
    }
  });

  it("still enforces S2S when a real secret is set alongside MCP_ALLOW_INSECURE_DEV=1", async () => {
    process.env.MCP_ALLOW_INSECURE_DEV = "1";
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(gatewayHeaders),
      body: toolsList,
    });
    expect(response.status).toBe(401);
    expect(response.body).toContain("X-Gateway-S2S");
    expect(outbound).toEqual([]);
  });

  it("sends no CORS headers and answers OPTIONS only after the S2S gate", async () => {
    const server = await listen();
    const preflight = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.status).toBe(401);
    const post = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "POST",
      headers: mcpHeaders({ origin: "https://evil.example", "x-gateway-s2s": mintS2sHeader(S2S_SECRET), ...gatewayHeaders }),
      body: toolsList,
    });
    expect(post.status).toBe(200);
    for (const res of [preflight, post]) {
      for (const name of res.headers.keys()) expect(name).not.toMatch(/^access-control-/);
    }
  });

  it("serves /health without authentication and without reading credentials", async () => {
    const server = await listen();
    const response = await sendHttp({ port: server.port, path: "/health" });
    const body = parseJson(response) as { status?: string; authMode?: string };
    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.authMode).toBe("gateway");
    const healthz = await sendHttp({ port: server.port, path: "/healthz" });
    expect(healthz.status).toBe(200);
    expect(response.body).not.toContain(S2S_SECRET);
    expect(response.body).not.toContain(ENV_CLIENT_ID);
    expect(response.body).not.toContain(ENV_CLIENT_SECRET);
    expect(healthz.body).not.toContain(ENV_CLIENT_SECRET);
    expect(outbound).toEqual([]);
  });

  it("requires S2S in env mode and then does not demand gateway credential headers", async () => {
    process.env.AUTH_MODE = "env";
    const server = await listen();
    const missing = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders(),
      body: toolsList,
    });
    expect(missing.status).toBe(401);
    expect(missing.body).toContain("X-Gateway-S2S");

    const accepted = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET) }),
      body: toolsList,
    });
    const payload = parseJson(accepted) as { result?: { tools?: unknown[] } };
    expect(accepted.status).toBe(200);
    expect(payload.result?.tools?.length).toBeGreaterThan(0);
    expect(outbound).toEqual([]);
    expect(accepted.body).not.toContain(ENV_CLIENT_SECRET);
    expect(accepted.body).not.toContain(S2S_SECRET);
  });
});

describe("HTTP startup: fail closed on weak or inconsistent configuration", () => {
  async function refused(): Promise<string> {
    const logs = captureStderr();
    stubExit();
    try {
      await expect(startHttpTransport()).rejects.toThrow("process.exit:1");
      return logs.text();
    } finally {
      logs.restore();
    }
  }

  it.each([
    ["shorter than 32 characters", "Zq8Lw2Kx9Mv3Nb6Pc1"],
    ["a repeated character pattern", "abcdabcdabcdabcdabcdabcdabcdabcdabcd"],
    ["too few distinct characters", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"],
    ["looks like a placeholder", "s2s-test-7Hq2Lw9Zr4Kx8Mv3Nb6Pc1Td5Fg0Yj"],
  ])("refuses a CONDUIT_S2S_SECRET that is %s, without logging it", async (problem, secret) => {
    process.env.CONDUIT_S2S_SECRET = secret;
    const text = await refused();
    expect(text).toContain(problem);
    expect(text).not.toContain(secret);
  });

  it("refuses an unknown AUTH_MODE instead of falling back to env credentials", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "Gateway-ish";
    expect(await refused()).toContain("AUTH_MODE must be");
  });

  it("refuses AUTH_MODE=env without DUBBER_* credentials", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "env";
    expect(await refused()).toContain("AUTH_MODE=env requires DUBBER_* credentials");
  });

  it.each(["write", "read,write,admin"])("refuses DUBBER_TOOL_TIERS=%s: this server is read-only", async (tiers) => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.DUBBER_TOOL_TIERS = tiers;
    expect(await refused()).toContain("Invalid DUBBER_TOOL_TIERS entry");
  });

  it("refuses a DUBBER_TOOL_TIERS typo", async () => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
    process.env.DUBBER_TOOL_TIERS = "read,wirte";
    expect(await refused()).toContain("Invalid DUBBER_TOOL_TIERS entry");
  });
});

describe("HTTP tool tiers (X-Conduit-Tool-Tiers)", () => {
  beforeEach(() => {
    process.env.CONDUIT_S2S_SECRET = S2S_SECRET;
    process.env.AUTH_MODE = "gateway";
  });

  async function listedTools(port: number, extra: Record<string, string> = {}): Promise<{ name: string }[]> {
    const response = await sendHttp({
      port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({ "x-gateway-s2s": mintS2sHeader(S2S_SECRET), ...gatewayHeaders, ...extra }),
      body: toolsList,
    });
    expect(response.status).toBe(200);
    return (parseJson(response) as { result: { tools: { name: string }[] } }).result.tools;
  }

  it("defaults to the 16 read tools, all annotated read-only", async () => {
    const server = await listen();
    const tools = (await listedTools(server.port)) as { name: string; annotations?: { readOnlyHint?: boolean } }[];
    expect(tools).toHaveLength(16);
    for (const t of tools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  it("an empty header narrows to zero tools; the header can never widen", async () => {
    const server = await listen();
    expect(await listedTools(server.port, { "x-conduit-tool-tiers": "" })).toHaveLength(0);
    expect(await listedTools(server.port, { "x-conduit-tool-tiers": "write,admin" })).toHaveLength(0);
    expect(await listedTools(server.port, { "x-conduit-tool-tiers": "read,write,admin" })).toHaveLength(16);
  });

  it("a tool outside the request's tiers is answered as unknown, before any Dubber call", async () => {
    const server = await listen();
    const response = await sendHttp({
      port: server.port,
      method: "POST",
      path: "/mcp",
      headers: mcpHeaders({
        "x-gateway-s2s": mintS2sHeader(S2S_SECRET),
        "x-conduit-tool-tiers": "",
        ...gatewayHeaders,
      }),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "dubber_profile_get", arguments: {} },
      }),
    });
    const text = (parseJson(response) as { result: { content: { text: string }[] } }).result.content[0]!.text;
    expect(text).toBe("Unknown tool: dubber_profile_get");
    expect(outbound).toEqual([]);
  });
});
