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
import { MAX_RESPONSE_CHARS } from "../config.js";
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
/** Dubber's documented Authorization_by_Password sample returns expires_in: 240. */
let tokenBody: Record<string, unknown>;
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
    if (req.url.pathname.endsWith("/token")) return json(tokenBody);
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
  tokenBody = { access_token: ACCESS_TOKEN, token_type: "bearer", expires_in: 240 };
  clearTokenCache();
  installFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it("re-mints once after a 401 on a cached token, then gives up", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_profile_get", {}); // caches the token
    sent = [];
    respond = () => json({ message: "expired" }, 401);
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_profile_get", {});
    expect(sent.map((s) => s.url.pathname)).toEqual(["/au/v1/profile", "/au/v1/token", "/au/v1/profile"]);
    expect(text(result)).toContain("Dubber error (HTTP 401)");
  });

  it("does not re-mint after a 401 on a token minted for this call, and keeps it cached", async () => {
    // Dubber also answers 401 for "no access to this resource"; a second mint would only spend its ~500/day budget.
    respond = () => json({ message: "Not authorized to make this request." }, 401);
    const api = createDubberApi(CREDS);
    const result = await handleToolCall(api, "dubber_groups_list_unidentified_dub_points", { groupId: "g-1" });
    expect(sent.map((s) => s.url.pathname)).toEqual(["/au/v1/token", "/au/v1/groups/g-1/unidentified_dub_points"]);
    expect(text(result)).toContain("Dubber error (HTTP 401)");
    sent = [];
    respond = () => json({ id: "ok" });
    await handleToolCall(api, "dubber_profile_get", {});
    expect(sent.map((s) => s.url.pathname)).toEqual(["/au/v1/profile"]);
  });

  it("says a 401 can mean bad credentials or a token without access to the resource", async () => {
    respond = () => json({ message: "Not authorized to make this request." }, 401);
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_profile_get", {});
    expect(text(result)).toContain("either the credentials are wrong");
    expect(text(result)).toContain("group-level token");
  });
});

describe("dubber_test_connection", () => {
  it("contacts Dubber even when a token is cached", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_profile_get", {}); // caches the token
    sent = [];
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_test_connection", {});
    expect(sent.map((s) => `${s.method} ${s.url.pathname}`)).toEqual(["GET /au/v1/profile"]);
    expect((result as ToolResult).isError).toBeFalsy();
  });

  it("reports failure when the cached token and a fresh one are both refused", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_profile_get", {}); // caches the token
    sent = [];
    respond = () => json({ message: "revoked" }, 401);
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_test_connection", {});
    expect(sent.map((s) => s.url.pathname)).toEqual(["/au/v1/profile", "/au/v1/token", "/au/v1/profile"]);
    expect((result as ToolResult).isError).toBe(true);
    expect(text(result)).toContain("Dubber connection check failed");
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

  it("passes the documented dub point lookup keys through as query params, URL-encoded", async () => {
    respond = () => json({ dub_points: [{ id: "dp-1" }] });
    await handleToolCall(createDubberApi(CREDS), "dubber_dub_points_find", {
      query: { external_type: "broadworks", external_identifier: "a&b=c" },
    });
    expect(sent[1]!.url.pathname).toBe("/au/v1/dub_points/find");
    expect(Object.fromEntries(sent[1]!.url.searchParams)).toEqual({ external_type: "broadworks", external_identifier: "a&b=c" });
  });

  it.each([
    [{ external_id: "x" }, '"query.external_id" is not a Dubber dub point lookup key'],
    [{ external_type: { b: 1 } }, '"query.external_type" must be a string'],
    [{}, '"query" needs at least one of'],
  ])("dubber_dub_points_find rejects %j before any request", async (query, message) => {
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_dub_points_find", { query });
    expect(text(result)).toContain(message);
    expect(sent).toEqual([]);
  });
});

describe("the transport is GET-only", () => {
  it("refuses node-dubber's write methods before any request (no token mint either)", async () => {
    const api = createDubberApi(CREDS);
    await expect(api.recordings.delete("x")).rejects.toThrow("Only GET requests");
    await expect(api.users.delete("u-1")).rejects.toThrow("Only GET requests");
    expect(sent).toEqual([]);
  });

  it.each([
    [{ method: "DELETE" }],
    [{ method: "POST" }],
    [{ body: { a: 1 } }],
  ])("refuses a raw request with %j", async (options) => {
    await expect(createDubberApi(CREDS).request("/recordings/r-1", options as never)).rejects.toThrow(
      "Only GET requests"
    );
    expect(sent).toEqual([]);
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

  it.each([
    [{ code: 1021, message: "Queries Per Second Limit" }, "rate limit (code 1021)", "retry in a few seconds"],
    [{ error: { code: 1024, message: "Rate Limit Exceeded" } }, "rate limit (code 1024)", "retry in a few seconds"],
    [{ code: 1022, message: "Account Rate Limit" }, "daily rate limit (code 1022)", "used up"],
    [{ message: "Account Over Rate Limit" }, "rate limit", "retry in a few seconds"],
  ])("maps Dubber's 403 rate limit %j to a rate-limit message, not an access hint", async (body, kind, hint) => {
    respond = () => json(body, 403);
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_accounts_get", { accountId: "acc-1" });
    expect(text(result)).toContain(kind);
    expect(text(result)).toContain(hint);
    expect(text(result)).not.toContain("lack access");
  });

  it.each([
    ["ERR_403_DEVELOPER_OVER_QPS", "Over Queries Per Second", "rate limit", "retry in a few seconds"],
    ["ERR_403_DEVELOPER_OVER_RATE", "Over Rate", "daily rate limit", "used up"],
    [undefined, "Over Queries Per Second", "rate limit", "retry in a few seconds"],
  ])("maps Mashery's own 403 (%s, HTML body) to a rate-limit message", async (code, detail, kind, hint) => {
    respond = () =>
      new Response("<h1>Developer Over Qps</h1>", {
        status: 403,
        headers: {
          "content-type": "text/html",
          ...(code ? { "x-mashery-error-code": code } : {}),
          "x-error-detail-header": detail,
        },
      });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_accounts_get", { accountId: "acc-1" });
    expect(text(result)).toContain(kind);
    expect(text(result)).toContain(hint);
    expect(text(result)).not.toContain("lack access");
  });

  it("keeps the access hint on a plain 403", async () => {
    respond = () => json({ message: "Forbidden" }, 403);
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_accounts_get", { accountId: "acc-1" });
    expect(text(result)).toBe("Dubber error (HTTP 403): Forbidden The credentials may lack access to this account/group.");
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

  it("removes a known secret that appears JSON-escaped", () => {
    const secret = 'se"cr\\et-0001';
    const out = redactText(JSON.stringify({ message: `bad secret ${secret}` }), [secret]);
    expect(out).toBe(JSON.stringify({ message: "bad secret [REDACTED]" }));
  });

  it("strips signed-URL signatures from log lines only", () => {
    const logged = redactLogText(`url=${SIGNED_URL}`);
    expect(logged).not.toContain("test-signature-not-real");
    expect(logged).not.toContain("AKIATESTNOTREAL");
    expect(redactText(SIGNED_URL)).toBe(SIGNED_URL);
  });
});

describe("every tool sends exactly the documented request (real transport, fetch stubbed)", () => {
  /** [args, expected "METHOD path?query" lines after the token mint]. Bodies must be empty. */
  const EXPECTED: Record<string, [Record<string, unknown>, string[]]> = {
    dubber_test_connection: [{}, ["GET /au/v1/profile"]],
    dubber_groups_get: [{ groupId: "g-1" }, ["GET /au/v1/groups/g-1"]],
    dubber_groups_list_unidentified_dub_points: [{ groupId: "g-1" }, ["GET /au/v1/groups/g-1/unidentified_dub_points"]],
    dubber_accounts_get: [{ accountId: "a-1" }, ["GET /au/v1/accounts/a-1"]],
    dubber_recordings_list: [{ accountId: "a-1", limit: 1 }, ["GET /au/v1/accounts/a-1/recordings?count=100"]],
    dubber_recordings_get: [{ recordingId: "r-1" }, ["GET /au/v1/recordings/r-1"]],
    dubber_recordings_get_link: [
      { recordingId: "r-1", listener: "l@example.com" },
      ["GET /au/v1/recordings/r-1?listener=l%40example.com"],
    ],
    dubber_recordings_get_waveform: [{ recordingId: "r-1" }, ["GET /au/v1/recordings/r-1/waveform"]],
    dubber_users_list: [{ accountId: "a-1" }, ["GET /au/v1/accounts/a-1/users?count=100"]],
    dubber_users_get: [{ userId: "u-1" }, ["GET /au/v1/users/u-1"]],
    dubber_profile_get: [{}, ["GET /au/v1/profile"]],
    dubber_notifications_list: [{ accountId: "a-1" }, ["GET /au/v1/accounts/a-1/notifications"]],
    dubber_notifications_get: [{ notificationId: "n-1" }, ["GET /au/v1/notifications/n-1"]],
    dubber_dub_points_list: [{ accountId: "a-1" }, ["GET /au/v1/accounts/a-1/dub_points?count=100"]],
    dubber_dub_points_get: [{ dubPointId: "d-1" }, ["GET /au/v1/dub_points/d-1"]],
    dubber_dub_points_find: [
      { query: { external_type: "broadworks", external_identifier: "u@x" } },
      ["GET /au/v1/dub_points/find?external_type=broadworks&external_identifier=u%40x"],
    ],
  };

  it("covers every tool", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(toolsForTiers(new Set(["read"])).map((t) => t.name).sort());
  });

  it.each(Object.entries(EXPECTED))("%s", async (name, [args, expected]) => {
    respond = () => json([]);
    const result = await handleToolCall(createDubberApi(CREDS), name, args);
    expect((result as ToolResult).isError, text(result)).toBeFalsy();
    const apiCalls = sent.filter((s) => !s.url.pathname.endsWith("/token"));
    expect(apiCalls.map((c) => `${c.method} ${c.url.pathname}${c.url.search}`)).toEqual(expected);
    for (const call of apiCalls) expect(call.body, name).toBe("");
  });
});

describe("list tools page explicitly and say when more exist", () => {
  it("dubber_groups_list_unidentified_dub_points unwraps Dubber's unidentified_dub_points key", async () => {
    respond = () => json({ self: "x", unidentified_dub_points: [{ id: "udp-1" }] });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_groups_list_unidentified_dub_points", {
      groupId: "g-1",
    });
    expect(JSON.parse(text(result))).toEqual({ unidentified_dub_points: [{ id: "udp-1" }], returned: 1 });
  });

  it("dubber_users_list sends count and page and flags a full page as hasMore", async () => {
    respond = () => json({ users: Array.from({ length: 50 }, (_, i) => ({ id: `u-${i}` })) });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_users_list", {
      accountId: "a-1",
      count: 50,
      page: 2,
    });
    expect(sent[1]!.url.search).toBe("?count=50&page=2");
    const body = JSON.parse(text(result));
    expect(body).toMatchObject({ returned: 50, count: 50, page: 2, hasMore: true });
    expect(body.users).toHaveLength(50);
    expect(body.note).toContain("page");
  });

  it("dubber_users_list reports hasMore=false on a short page", async () => {
    respond = () => json({ users: [{ id: "u-1" }] });
    const body = JSON.parse(text(await handleToolCall(createDubberApi(CREDS), "dubber_users_list", { accountId: "a-1" })));
    expect(body).toMatchObject({ returned: 1, count: 100, page: null, hasMore: false });
  });

  it("dubber_dub_points_list filters by user and pages", async () => {
    respond = () => json({ dub_points: Array.from({ length: 20 }, (_, i) => ({ id: `dp-${i}` })) });
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_dub_points_list", {
      accountId: "a-1",
      userId: "u-7",
      count: 20,
      page: 1,
    });
    expect(sent[1]!.url.search).toBe("?user=u-7&count=20&page=1");
    expect(JSON.parse(text(result))).toMatchObject({ returned: 20, hasMore: true });
  });

  it.each([
    ["dubber_users_list", { count: 0 }, 'Argument "count"'],
    ["dubber_users_list", { count: 101 }, 'Argument "count"'],
    ["dubber_users_list", { page: -1 }, 'Argument "page"'],
    ["dubber_dub_points_list", { userId: "../x" }, 'Argument "userId"'],
  ])("%s rejects %j before any request", async (name, extra, message) => {
    const result = await handleToolCall(createDubberApi(CREDS), name, { accountId: "a-1", ...extra });
    expect(text(result)).toContain(message);
    expect(sent).toEqual([]);
  });
});

describe(`tool output is capped at ${MAX_RESPONSE_CHARS} characters without losing the paging fields`, () => {
  const PAD = "x".repeat(1_000);

  it("dubber_recordings_list drops recordings from the end and points nextCursor at the last one kept", async () => {
    let served = 0;
    respond = () => json(Array.from({ length: 100 }, () => ({ id: `r-${served++}`, notes: PAD })));
    const out = text(await handleToolCall(createDubberApi(CREDS), "dubber_recordings_list", { accountId: "a-1", limit: 500 }));
    expect(out.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const body = JSON.parse(out);
    const kept = body.recordings.length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(500);
    expect(body).toMatchObject({ returned: kept, hasMore: true, nextCursor: `r-${kept - 1}`, remainingOffset: 0 });
    expect(body.note).toContain(`cursor="r-${kept - 1}"`);
    expect(body.filters).toMatchObject({ limit: 500 });
  });

  it.each([
    ["dubber_users_list", "users", { users: Array.from({ length: 100 }, (_, i) => ({ id: `u-${i}`, notes: PAD })) }],
    ["dubber_dub_points_list", "dub_points", { dub_points: Array.from({ length: 100 }, (_, i) => ({ id: `d-${i}`, notes: PAD })) }],
  ])("%s keeps count/page and says to ask for a smaller count", async (name, key, payload) => {
    respond = () => json(payload);
    const out = text(await handleToolCall(createDubberApi(CREDS), name, { accountId: "a-1", count: 100, page: 3 }));
    expect(out.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const body = JSON.parse(out);
    expect(body[key].length).toBeLessThan(100);
    expect(body).toMatchObject({ returned: body[key].length, count: 100, page: 3, hasMore: true });
    expect(body.note).toContain("smaller count");
  });

  it.each([
    ["dubber_dub_points_find", "dub_points", { query: { external_identifier: "u@x" } }],
    ["dubber_groups_list_unidentified_dub_points", "unidentified_dub_points", { groupId: "g-1" }],
    ["dubber_notifications_list", "notifications", { accountId: "a-1" }],
  ])("%s drops items from the end and says so", async (name, key, args) => {
    respond = () => json(Array.from({ length: 200 }, (_, i) => ({ id: `n-${i}`, notes: PAD })));
    const out = text(await handleToolCall(createDubberApi(CREDS), name, args));
    expect(out.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const body = JSON.parse(out);
    expect(body[key].length).toBeLessThan(200);
    expect(body.returned).toBe(body[key].length);
    expect(body.note).toContain(`of 200`);
  });

  it("leaves a result that fits untouched", async () => {
    respond = () => json({ users: [{ id: "u-1" }] });
    const body = JSON.parse(text(await handleToolCall(createDubberApi(CREDS), "dubber_users_list", { accountId: "a-1" })));
    expect(body).toEqual({ users: [{ id: "u-1" }], returned: 1, count: 100, page: null, hasMore: false });
  });
});

describe("token lifetime (Dubber's sample token lives 240 s)", () => {
  it("mints once for many calls within the token's lifetime", async () => {
    const api = createDubberApi(CREDS);
    for (let i = 0; i < 3; i++) await handleToolCall(api, "dubber_profile_get", {});
    expect(sent.filter((s) => s.url.pathname.endsWith("/token"))).toHaveLength(1);
  });

  it("reuses a 240 s token for 90% of its life (216 s), so continuous use stays under 500 mints a day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-09T00:00:00Z"));
    const api = createDubberApi(CREDS);
    await handleToolCall(api, "dubber_profile_get", {});
    vi.setSystemTime(new Date("2026-11-09T00:03:30Z"));
    await handleToolCall(api, "dubber_profile_get", {});
    expect(sent.filter((s) => s.url.pathname.endsWith("/token"))).toHaveLength(1);
    vi.setSystemTime(new Date("2026-11-09T00:03:40Z"));
    await handleToolCall(api, "dubber_profile_get", {});
    expect(sent.filter((s) => s.url.pathname.endsWith("/token"))).toHaveLength(2);
    expect(Math.ceil(86_400 / 216)).toBeLessThan(500);
  });

  it("treats a missing expires_in as Dubber's documented 24 h, not zero", async () => {
    tokenBody = { access_token: ACCESS_TOKEN };
    const api = createDubberApi(CREDS);
    for (let i = 0; i < 3; i++) await handleToolCall(api, "dubber_profile_get", {});
    expect(sent.filter((s) => s.url.pathname.endsWith("/token"))).toHaveLength(1);
  });
});

describe("dubber_recordings_get_link recording link (WYREAI-567 item 2)", () => {
  it("sends listener and content_disposition, URL-encoded", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get_link", {
      recordingId: "r-1",
      listener: "first.last+calls@example.com",
      contentDisposition: "attachment;filename=call 1.mp3",
    });
    expect(sent[1]!.url.search).toBe(
      "?listener=first.last%2Bcalls%40example.com&content_disposition=attachment%3Bfilename%3Dcall+1.mp3"
    );
  });

  it("dubber_recordings_get never asks for a link, even when listener is passed", async () => {
    await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get", { recordingId: "r-1", listener: "l@example.com" });
    expect(sent[1]!.url.href).toBe(`${BASE}/recordings/r-1`);
  });

  it.each([
    [{ listener: "not-an-email" }, '"listener" must be the email address'],
    [{ contentDisposition: "inline" }, 'Argument "listener" is required'],
    [{ listener: "a@example.com", contentDisposition: "attachment;filename=x.wav" }, '"contentDisposition" must be'],
    [{ listener: "a@example.com", contentDisposition: "inline\r\nX-Evil: 1" }, '"contentDisposition" must be'],
  ])("rejects %j before any request", async (extra, message) => {
    const result = await handleToolCall(createDubberApi(CREDS), "dubber_recordings_get_link", { recordingId: "r-1", ...extra });
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
    const { text: out, logs } = await callTool("dubber_recordings_get_link", {
      recordingId: "r-1",
      listener: "listener@example.com",
    });
    expect(JSON.parse(out)).toMatchObject({ id: "r-1", recording_url: SIGNED_URL });
    expect(sent.map((s) => `${s.method} ${s.url.origin}${s.url.pathname}`)).toEqual([
      `POST ${BASE}/token`,
      `GET ${BASE}/recordings/r-1`,
    ]);
    expect(sent[1]!.url.searchParams.get("listener")).toBe("listener@example.com");
    expect(logs).toContain("Tool call received");
    for (const secret of [SIGNED_URL, "test-signature-not-real", ACCESS_TOKEN, CREDS.clientSecret, CREDS.authToken]) {
      expect(logs).not.toContain(secret);
    }
  });

  it("redacts, then truncates a single oversized result, so no partial secret survives the cut", async () => {
    // The client secret straddles the cut point: redacted first, it cannot leave a prefix behind.
    const pad = "y".repeat(MAX_RESPONSE_CHARS - 40);
    respond = () => json({ id: "u-1", notes: `${pad}${CREDS.clientSecret}${"z".repeat(5_000)}` });
    const { text: out } = await callTool("dubber_users_get", { userId: "u-1" });
    expect(out.length).toBeLessThan(MAX_RESPONSE_CHARS + 300);
    expect(out).toContain("[truncated:");
    expect(out).not.toContain(CREDS.clientSecret.slice(0, 8));
  });

  it("redacts a credential that a vendor error echoes back, in the tool output and the logs", async () => {
    respond = () => json({ message: `bad client_secret ${CREDS.clientSecret} for ${CREDS.authToken}` }, 400);
    const { text: out, logs } = await callTool("dubber_accounts_get", { accountId: "acc-1" });
    expect(out).toBe("Dubber error (HTTP 400): bad client_secret [REDACTED] for [REDACTED]");
    expect(logs).not.toContain(CREDS.clientSecret);
    expect(logs).not.toContain(CREDS.authToken);
  });

  it("redacts the minted (opaque, non-JWT) access token when a vendor error echoes it", async () => {
    respond = () => json({ message: `token ${ACCESS_TOKEN} is not valid for this account` }, 400);
    const { text: out, logs } = await callTool("dubber_accounts_get", { accountId: "acc-1" });
    expect(out).toBe("Dubber error (HTTP 400): token [REDACTED] is not valid for this account");
    expect(logs).not.toContain(ACCESS_TOKEN);
  });
});
