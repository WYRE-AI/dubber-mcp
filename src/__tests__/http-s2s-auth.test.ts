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
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const constructed = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
}));

vi.mock("@wyre-ai/node-dubber", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@wyre-ai/node-dubber")>();
  return {
    ...actual,
    DubberClient: class {
      constructor(config: Record<string, unknown>) {
        constructed.configs.push(config);
      }
      testConnection(): Promise<{ ok: boolean }> {
        return Promise.resolve({ ok: true });
      }
    },
  };
});

const { startHttpTransport } = await import("../index.js");

const S2S_SECRET = "s2s-do-not-log-7f3a";
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
  constructed.configs.length = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (servers.length > 0) {
    const server = servers.pop();
    if (!server?.listening) continue;
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

describe("HTTP startup", () => {
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
      expect(constructed.configs).toEqual([]);
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
    expect(constructed.configs).toEqual([]);

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
    expect(constructed.configs).toEqual([]);
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
    expect(constructed.configs).toEqual([]);
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
      expect(constructed.configs).toEqual([
        {
          clientId: "header-client-id",
          clientSecret: "header-client-secret",
          authId: "header-auth-id",
          authToken: "header-auth-token",
          region: "us",
        },
      ]);
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
    expect(constructed.configs).toEqual([]);
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
    expect(constructed.configs).toEqual([]);
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
    expect(constructed.configs).toEqual([]);
    expect(accepted.body).not.toContain(ENV_CLIENT_SECRET);
    expect(accepted.body).not.toContain(S2S_SECRET);
  });
});
