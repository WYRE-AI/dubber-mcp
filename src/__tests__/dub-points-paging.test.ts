/**
 * WYREAI-567: dubber_dub_points_list reads every page by default, against the
 * REAL guarded client (dubber-api.ts transport + node-dubber resources) with
 * only `fetch` mocked. The fake Dubber pages with `count` (default 20, max 100)
 * and `page`, either 0-based or 1-based (Dubber does not document which).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_RESPONSE_CHARS } from "../config.js";
import { createDubberApi, type DubberApi } from "../dubber-api.js";
import { handleToolCall } from "../handlers/index.js";
import type { ToolResult } from "../handlers/results.js";

const BASE_URL = "https://api.dubber.net/sandbox/v1";
const ACCOUNT = "acc-1";

interface Fake {
  requests: URL[];
  rateLimitOnRequest?: number;
}

function install(total: number, opts: { oneBased?: boolean; ignorePage?: boolean; pad?: string } = {}): Fake {
  const all = Array.from({ length: total }, (_, i) => ({
    id: `dp-${String(i).padStart(4, "0")}`,
    user: `${BASE_URL}/users/u-${i % 3}`,
    ...(opts.pad ? { notes: opts.pad } : {}),
  }));
  const state: Fake = { requests: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/token")) return json({ access_token: "tok", expires_in: 240, token_type: "Bearer" });
      expect(url.origin + url.pathname).toBe(`${BASE_URL}/accounts/${ACCOUNT}/dub_points`);
      state.requests.push(url);
      if (state.requests.length === state.rateLimitOnRequest) {
        return json({ code: 1021, message: "Queries Per Second Limit" }, 403);
      }
      const user = url.searchParams.get("user");
      const rows = user ? all.filter((r) => r.user.endsWith(`/users/${user}`)) : all;
      const count = Math.min(Number(url.searchParams.get("count") ?? 20), 100);
      const rawPage = url.searchParams.get("page");
      let index = rawPage === null || opts.ignorePage ? 0 : Number(rawPage);
      if (opts.oneBased && rawPage !== null && !opts.ignorePage) index = Math.max(0, index - 1);
      return json({ self: url.href, dub_points: rows.slice(index * count, index * count + count) });
    })
  );
  return state;
}

let seq = 0;
function client(): DubberApi {
  seq += 1;
  return createDubberApi({
    clientId: `dp-test-client-${seq}`,
    clientSecret: "fake-secret",
    authId: "fake-auth-id",
    authToken: "fake-auth-token",
    region: "sandbox",
  });
}

interface Body {
  dub_points: { id: string }[];
  returned: number;
  allPages?: boolean;
  hasMore: boolean;
  nextOffset: number | null;
  requests: number;
  scanCapReached: boolean;
  rateLimited?: boolean;
  rateLimitCode?: number;
  rateLimitStatus?: number;
  note?: string;
}

async function call(args: Record<string, unknown>): Promise<{ result: ToolResult; body: Body }> {
  const result = (await handleToolCall(client(), "dubber_dub_points_list", { accountId: ACCOUNT, ...args })) as ToolResult;
  const first = result.content[0]!;
  const text = first.type === "text" ? first.text : "";
  return { result, body: result.isError ? ({} as Body) : (JSON.parse(text) as Body) };
}

const ids = (b: Body) => b.dub_points.map((d) => d.id);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => `dp-${String(from + i).padStart(4, "0")}`);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("dubber_dub_points_list reads every page by default", () => {
  it.each([
    ["0-based", false],
    ["1-based", true],
  ])("returns all 250 dub points (%s pages), not the first 20", async (_label, oneBased) => {
    const fake = install(250, { oneBased });
    const { body } = await call({ limit: 1000 });
    expect(ids(body)).toEqual(range(0, 250));
    expect(body).toMatchObject({ allPages: true, returned: 250, hasMore: false, nextOffset: null, scanCapReached: false });
    for (const url of fake.requests) expect(url.searchParams.get("count")).toBe("100");
    expect(fake.requests[0]!.searchParams.has("page")).toBe(false);
    expect(fake.requests.slice(1).map((u) => u.searchParams.get("page"))).toEqual(oneBased ? ["1", "2", "3"] : ["1", "2"]);
  });

  it("default limit is 200 and nextOffset continues without gaps or repeats", async () => {
    install(250);
    const first = await call({});
    expect(ids(first.body)).toEqual(range(0, 200));
    expect(first.body).toMatchObject({ hasMore: true, nextOffset: 200 });
    expect(first.body.note).toContain("offset=200");
    const second = await call({ offset: first.body.nextOffset });
    expect(ids(second.body)).toEqual(range(200, 250));
    expect(second.body).toMatchObject({ hasMore: false, nextOffset: null });
  });

  it("stops after the first short page", async () => {
    const fake = install(7);
    const { body } = await call({});
    expect(body).toMatchObject({ returned: 7, hasMore: false, requests: 1 });
    expect(fake.requests).toHaveLength(1);
  });

  it("passes userId through on every page", async () => {
    const fake = install(450);
    const { body } = await call({ userId: "u-1" });
    expect(body.returned).toBe(150);
    for (const url of fake.requests) expect(url.searchParams.get("user")).toBe("u-1");
  });

  it("stops at the request cap and says how to read further pages", async () => {
    const fake = install(1500);
    const { body } = await call({ limit: 1000 });
    expect(fake.requests).toHaveLength(10);
    // 1,000 small items exceed the response cap, so the result is trimmed; the cap note survives.
    expect(body).toMatchObject({ hasMore: true, scanCapReached: true, requests: 10, nextOffset: body.returned });
    expect(ids(body)).toEqual(range(0, body.returned));
    expect(body.note).toContain("Scan cap reached");
    expect(body.note).toContain("page=10");
  });

  it("stops when Dubber ignores page (no new ids) instead of looping", async () => {
    const fake = install(300, { ignorePage: true });
    const { body } = await call({ limit: 1000 });
    expect(fake.requests).toHaveLength(3); // no page, page=1 (may repeat), page=2 -> no progress
    expect(body).toMatchObject({ returned: 100, hasMore: true });
    expect(body.note).toContain("no new dub points");
  });

  it("a rate limit after the first page keeps what was read and gives nextOffset", async () => {
    const fake = install(450);
    fake.rateLimitOnRequest = 3;
    const { body } = await call({ limit: 1000 });
    expect(body).toMatchObject({
      returned: 200,
      hasMore: true,
      nextOffset: 200,
      rateLimited: true,
      rateLimitCode: 1021,
      rateLimitStatus: 403,
    });
    expect(body.note).toContain("rate limit (code 1021)");
    expect(body.note?.match(/offset=\d+/g)).toEqual(["offset=200"]);
  });

  it("a trimmed rate-limited result gives only the trimmed continuation offset", async () => {
    const fake = install(450, { pad: "x".repeat(1_000) });
    fake.rateLimitOnRequest = 3;
    const { body } = await call({ limit: 1000 });
    const kept = body.returned;
    expect(kept).toBeLessThan(200);
    expect(body).toMatchObject({ hasMore: true, nextOffset: kept, rateLimited: true, rateLimitCode: 1021 });
    expect(body.note?.match(/offset=\d+/g)).toEqual([`offset=${kept}`]);
    expect(body.note).toContain("rate limit (code 1021)");
  });

  it("after the request cap with every scanned item returned, nextOffset is null and the note points past the scan", async () => {
    install(1500);
    const { body } = await call({ offset: 950, limit: 50 });
    expect(ids(body)).toEqual(range(950, 1000));
    expect(body).toMatchObject({ hasMore: true, nextOffset: null, scanCapReached: true });
    expect(body.note).toContain("page=10");
    expect(body.note).not.toMatch(/offset=/);
  });

  it("a rate limit on the first request is an error", async () => {
    const fake = install(450);
    fake.rateLimitOnRequest = 1;
    const { result } = await call({});
    expect(result.isError).toBe(true);
  });

  it("trims an over-long result from the end and points nextOffset at the first dropped item", async () => {
    install(300, { pad: "x".repeat(1_000) });
    const { result, body } = await call({ limit: 300 });
    const out = (result.content[0] as { text: string }).text;
    expect(out.length).toBeLessThanOrEqual(MAX_RESPONSE_CHARS);
    const kept = body.returned;
    expect(kept).toBeLessThan(300);
    expect(ids(body)).toEqual(range(0, kept));
    expect(body).toMatchObject({ hasMore: true, nextOffset: kept });
    expect(body.note).toContain(`offset=${kept}`);
  });

  it("page keeps the one-raw-page mode", async () => {
    const fake = install(250);
    const { body } = await call({ page: 2, count: 50 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.search).toBe("?count=50&page=2");
    expect(body).toMatchObject({ returned: 50, count: 50, page: 2, hasMore: true });
  });

  it.each([
    [{ count: 50 }, 'Argument "count" only applies with "page"'],
    [{ page: 1, limit: 10 }, 'Argument "limit" cannot be combined with "page"'],
    [{ page: 1, offset: 10 }, 'Argument "offset" cannot be combined with "page"'],
    [{ limit: 0 }, 'Argument "limit"'],
    [{ limit: 1001 }, 'Argument "limit"'],
    [{ offset: -1 }, 'Argument "offset"'],
  ])("rejects %j before any request", async (args, message) => {
    const fake = install(10);
    const { result } = await call(args);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain(message);
    expect(fake.requests).toEqual([]);
  });
});
