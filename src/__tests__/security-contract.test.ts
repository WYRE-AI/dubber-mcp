/**
 * The fleet template's security contract, exercised against the REAL guarded
 * transport (dubber-api.ts) with only `fetch` stubbed. No network.
 *
 * - exact auth: password-grant token mint, then `Authorization: Bearer` only
 * - fixed origin + exact path; traversal ids rejected; ids percent-encoded
 * - redirects refused (token mint and API calls); bounded response bodies
 * - vendor errors keep status, message and request id; secrets redacted
 * - every read-tier tool sends only GET requests (plus the token mint)
 * - one end-to-end read over the real MCP serving stack, incl. the signed
 *   recording link, which reaches the caller but never the logs
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createMcpHandler, type McpHttpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { buildUrl, clearTokenCache, createDubberApi } from "../dubber-api.js";
import type { DubberCredentials } from "../credentials.js";
import { handleToolCall } from "../handlers/index.js";
import type { ToolResult } from "../handlers/results.js";
import { makeMcpServerFactory } from "../mcp-server.js";
import { redactLogText, redactText } from "../redact.js";
import { toolsForTiers } from "../tools/index.js";

const CREDS: DubberCredentials = {
  clientId: "test-client-id-0001",
  clientSecret: "test-client-secret-0001",
  authId: "test-auth-id-0001",
  authToken: "test-auth-token-0001",
  region: "au",
};
const BASE = "https://api.dubber.net/au/v1";
const ACCESS_TOKEN = "test-access-token-0001";
const SIGNED_URL =
  "https://dubber-recordings.s3.amazonaws.com/rec-1.mp3?AWSAccessKeyId=AKIATESTNOTREAL&Expires=1382496769&Signature=test-signature-not-real";

interface Sent {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
  redirect?: RequestInit["redirect"];
}

type Responder = (req: Sent) => Response;

let sent: Sent[] = [];
let respond: Responder;
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Token mint succeeds; everything else is answered by `respond`. */
function installFetch(): void {
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (href.startsWith("http://127.0.0.1")) return realFetch(input, init);
    const req: Sent = {
      method: init.method ?? "GET",
      url: new URL(href),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? init.body : "",
      redirect: init.redirect,
    };
    sent.push(req);
    if (req.url.pathname.endsWith("/token")) return json({ access_token: ACCESS_TOKEN, expires_in: 86400 });
    return respond(req);
  });
}

function text(result: unknown): string {
  const first = (result as ToolResult).content[0]!;
  return first.type === "text" ? first.text : "";
}

beforeEach(() => {
  sent = [];
  respond = () => json({ id: "ok" });
  clearTokenCache();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth headers", () => {
  it("mints with the password grant, then sends only Authorization: Bearer", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_accounts_get", { accountId: "acc-1" });
    expect(sent.map((s) => `${s.method} ${s.url.href}`)).toEqual([
      `POST ${BASE}/token`,
      `GET ${BASE}/accounts/acc-1`,
    ]);
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body))).toEqual({
      grant_type: "password",
      client_id: CREDS.clientId,
      client_secret: CREDS.clientSecret,
      username: CREDS.authId,
      password: CREDS.authToken,
    });
    expect(sent[1]!.headers).toEqual({ accept: "application/json", authorization: `Bearer ${ACCESS_TOKEN}` });
    // No credential ever travels in an API request's URL or body.
    for (const value of Object.values(CREDS).slice(0, 4)) expect(sent[1]!.url.href).not.toContain(value);
  });

  it("re-mints once after a 401, then gives up", async () => {
    respond = () => json({ message: "expired" }, 401);
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_profile_get", {});
    expect(sent.map((s) => s.url.pathname)).toEqual(["/au/v1/token", "/au/v1/profile", "/au/v1/token", "/au/v1/profile"]);
    expect(text(result)).toContain("Dubber error (HTTP 401)");
  });
});

describe("fixed origin, exact path, path parameters", () => {
  it.each(["..", ".", "a/b", "a\\b", "%2e%2e", "%2F", "a\u0000b", "x".repeat(257)])(
    "rejects the id %j before any request",
    async (bad) => {
      const result = await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get", { recordingId: bad });
      expect((result as ToolResult).isError).toBe(true);
      expect(text(result)).toContain('Argument "recordingId" must be a single ID');
      expect(sent).toEqual([]);
    }
  );

  it("percent-encodes an id that is allowed", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_users_get", { userId: "user 1+é?#" });
    expect(sent[1]!.url.pathname).toBe("/au/v1/users/user%201%2B%C3%A9%3F%23");
    expect(sent[1]!.url.search).toBe("");
  });

  it("refuses any URL that does not land exactly on the expected path", () => {
    expect(buildUrl(CREDS, "/accounts/a%20b").href).toBe(`${BASE}/accounts/a%20b`);
    for (const path of ["/recordings/..", "/recordings/./x", "/a/../../us/v1/x"]) {
      expect(() => buildUrl(CREDS, path), path).toThrow("Refusing to call a path outside the Dubber API.");
    }
    // A scheme-relative-looking path is still just a path under the region prefix.
    expect(buildUrl(CREDS, "//evil.example/x").origin).toBe("https://api.dubber.net");
  });

  it("passes pagination and filter params through as query params, never auto-paging dub points", async () => {
    respond = () => json({ dub_points: [{ id: "dp-1" }] });
    await handleToolCall(createDubberApi(CREDS), "dubber_dub_points_find", { query: { external_id: "a&b=c", n: 2 } });
    expect(sent[1]!.url.pathname).toBe("/au/v1/dub_points/find");
    expect(Object.fromEntries(sent[1]!.url.searchParams)).toEqual({ external_id: "a&b=c", n: "2" });
    const nested = await handleToolCall(createDubberApi(CREDS), "dubber_dub_points_find", { query: { a: { b: 1 } } });
    expect(text(nested)).toContain('"query.a" must be a string, number, or boolean');
  });
});

describe("redirects and response size", () => {
  it("never follows a redirect on an API call", async () => {
    respond = () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_groups_get", { groupId: "g-1" });
    expect(sent[1]!.redirect).toBe("manual");
    expect(text(result)).toContain("redirect (HTTP 302); refusing to follow it");
    expect(sent.some((s) => s.url.hostname !== "api.dubber.net")).toBe(false);
  });

  it("never follows a redirect on the token mint (the client secret is in its body)", async () => {
    vi.stubGlobal("fetch", async (_input: unknown, init: RequestInit = {}) => {
      expect(init.redirect).toBe("manual");
      return new Response(null, { status: 307, headers: { location: "https://evil.example/token" } });
    });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_test_connection", {});
    expect(text(result)).toContain("refusing to follow it");
  });

  it("refuses a response body over 4 MiB", async () => {
    respond = () => new Response("x".repeat(4 * 1024 * 1024 + 1), { status: 200 });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_profile_get", {});
    expect(text(result)).toContain("response exceeded 4194304 bytes");
  });
});

describe("error mapping", () => {
  it("keeps status, vendor message, retry hint and request id", async () => {
    respond = () =>
      json({ message: "Too many requests" }, 429, { "retry-after": "17", "x-mashery-message-id": "mash-req-42" });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_accounts_get", { accountId: "acc-1" });
    expect(text(result)).toBe(
      "Dubber error (HTTP 429): Too many requests Rate limited; retry after 17s. (request id: mash-req-42)"
    );
  });

  it("maps 404 with the vendor's message", async () => {
    respond = () => json({ error: { message: "Recording not found" } }, 404, { "x-request-id": "req-404" });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get", { recordingId: "r-9" });
    expect(text(result)).toBe("Dubber error (HTTP 404): Recording not found (request id: req-404)");
  });
});

describe("redaction", () => {
  it("removes known secrets, bearer tokens and credential-named keys", () => {
    const out = redactText(`echo ${CREDS.clientSecret} Bearer ${ACCESS_TOKEN}`, [CREDS.clientSecret]);
    expect(out).toBe("echo [REDACTED] [REDACTED]");
  });

  it("strips signed-URL signatures from log lines only", () => {
    const logged = redactLogText(`url=${SIGNED_URL}`);
    expect(logged).not.toContain("test-signature-not-real");
    expect(logged).not.toContain("AKIATESTNOTREAL");
    expect(redactText(SIGNED_URL)).toBe(SIGNED_URL);
  });
});

describe("read tier is truly read-only", () => {
  const ARGS: Record<string, Record<string, unknown>> = {
    dubber_groups_get: { groupId: "g-1" },
    dubber_groups_list_unidentified_recordings: { groupId: "g-1" },
    dubber_accounts_get: { accountId: "a-1" },
    dubber_recordings_list: { accountId: "a-1", limit: 1 },
    dubber_recordings_get: { recordingId: "r-1", listener: "listener@example.com" },
    dubber_recordings_get_waveform: { recordingId: "r-1" },
    dubber_users_list: { accountId: "a-1" },
    dubber_users_get: { userId: "u-1" },
    dubber_notifications_list: { accountId: "a-1" },
    dubber_notifications_get: { notificationId: "n-1" },
    dubber_notifications_list_unclaimed: { notificationId: "n-1" },
    dubber_dub_points_list: { accountId: "a-1" },
    dubber_dub_points_get: { dubPointId: "d-1" },
    dubber_dub_points_find: { query: { external_id: "x" } },
  };

  it("every read tool sends only GET requests besides the token mint", async () => {
    respond = () => json([]);
    for (const tool of toolsForTiers(new Set(["read"]))) {
      sent = [];
      clearTokenCache();
      const result = await handleToolCall(createDubberApi(CREDS), tool.name, ARGS[tool.name] ?? {});
      expect((result as ToolResult).isError, `${tool.name}: ${text(result)}`).toBeFalsy();
      const apiCalls = sent.filter((s) => !s.url.pathname.endsWith("/token"));
      for (const call of apiCalls) expect(call.method, tool.name).toBe("GET");
      if (!["dubber_test_connection"].includes(tool.name)) expect(apiCalls.length, tool.name).toBeGreaterThan(0);
    }
  });
});

describe("dubber_recordings_get recording link (WYREAI-567 item 2)", () => {
  it("sends listener and content_disposition, URL-encoded", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get", {
      recordingId: "r-1",
      listener: "first.last+calls@example.com",
      contentDisposition: "attachment;filename=call 1.mp3",
    });
    expect(sent[1]!.url.search).toBe(
      "?listener=first.last%2Bcalls%40example.com&content_disposition=attachment%3Bfilename%3Dcall+1.mp3"
    );
  });

  it("sends no query string without listener", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get", { recordingId: "r-1" });
    expect(sent[1]!.url.href).toBe(`${BASE}/recordings/r-1`);
  });

  it.each([
    [{ listener: "not-an-email" }, '"listener" must be the email address'],
    [{ contentDisposition: "inline" }, 'pass "listener" too'],
    [{ listener: "a@example.com", contentDisposition: "attachment;filename=x.wav" }, '"contentDisposition" must be'],
    [{ listener: "a@example.com", contentDisposition: "inline\r\nX-Evil: 1" }, '"contentDisposition" must be'],
  ])("rejects %j before any request", async (extra, message) => {
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get", { recordingId: "r-1", ...extra });
    expect(text(result)).toContain(message);
    expect(sent).toEqual([]);
  });
});

describe("one mocked end-to-end read over the real MCP serving stack", () => {
  let mcpHandler: McpHttpHandler;
  let server: http.Server;
  let base: string;
  const ENV = {
    DUBBER_CLIENT_ID: CREDS.clientId,
    DUBBER_CLIENT_SECRET: CREDS.clientSecret,
    DUBBER_AUTH_ID: CREDS.authId,
    DUBBER_AUTH_TOKEN: CREDS.authToken,
    DUBBER_REGION: "au",
    LOG_LEVEL: "debug",
  };

  beforeAll(async () => {
    Object.assign(process.env, ENV);
    mcpHandler = createMcpHandler(makeMcpServerFactory(), { legacy: "stateless" });
    const handle = toNodeHandler(mcpHandler);
    server = http.createServer((req, res) => void handle(req as never, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(async () => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    await mcpHandler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; logs: string }> {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
    const client = new Client({ name: "security-e2e", version: "0.0.0" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const result = await client.callTool({ name, arguments: args });
      const content = result.content as Array<{ text?: string }>;
      return { text: content[0]?.text ?? "", logs: lines.join("") };
    } finally {
      await client.close();
      spy.mockRestore();
    }
  }

  it("returns recording_url to the caller and keeps it, and every credential, out of the logs", async () => {
    respond = () =>
      json({ id: "r-1", start_time: "Sun, 28 Jul 2013 12:42:10 +1000", recording_url: SIGNED_URL });
    const { text: out, logs } = await callTool("dubber_recordings_get", {
      recordingId: "r-1",
      listener: "listener@example.com",
    });
    expect(JSON.parse(out)).toMatchObject({ id: "r-1", recording_url: SIGNED_URL });
    expect(sent.map((s) => `${s.method} ${s.url.origin}${s.url.pathname}`)).toEqual([
      `POST ${BASE}/token`,
      `GET ${BASE}/recordings/r-1`,
    ]);
    expect(logs).toContain("Tool call received");
    for (const secret of [SIGNED_URL, "test-signature-not-real", ACCESS_TOKEN, CREDS.clientSecret, CREDS.authToken]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("redacts a credential that a vendor error echoes back, in the tool output and the logs", async () => {
    respond = () => json({ message: `bad client_secret ${CREDS.clientSecret} for ${CREDS.authToken}` }, 400);
    const { text: out, logs } = await callTool("dubber_accounts_get", { accountId: "acc-1" });
    expect(out).toBe("Dubber error (HTTP 400): bad client_secret [REDACTED] for [REDACTED]");
    expect(logs).not.toContain(CREDS.clientSecret);
    expect(logs).not.toContain(CREDS.authToken);
  });
});
