/**
 * WYREAI-567: dubber_recordings_list against the REAL guarded client
 * (dubber-api.ts transport + node-dubber resources + token cache) with only
 * `fetch` mocked. The fake Dubber honours the documented count/before_id/
 * dub_point/team and, like the real API, silently IGNORES anything else
 * (limit, offset, page, query, ...). Tokens use Dubber's sample 240 s lifetime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDubberApi, type DubberApi } from "../dubber-api.js";
import { handleToolCall } from "../handlers/index.js";
import type { ToolResult } from "../handlers/results.js";

const BASE_URL = "https://api.dubber.net/sandbox/v1";
const ACCOUNT = "acc-1";
const STEP_MS = 15 * 60_000;
// Melbourne is on daylight time (+11:00) in late October.
// Newest recording: Sun 25 Oct 2026 23:45 +11:00; each older one is 15 minutes earlier.
const NEWEST_MS = Date.parse("2026-10-25T23:45:00+11:00");
// Mon 19 Oct 00:00 +11:00 .. Sat 24 Oct 00:00 +11:00 (exclusive) = Mon–Fri.
const WEEK_FROM = "2026-10-19T00:00:00+11:00";
const WEEK_TO = "2026-10-24T00:00:00+11:00";

interface FakeRec {
  id: string;
  to: string;
  dub_point: string;
  team: string;
  start_time: string;
  ms: number;
}

/** RFC 2822 in +1100, e.g. "Mon, 19 Oct 2026 09:00:00 +1100". */
function rfc2822(ms: number): string {
  return new Date(ms + 11 * 3_600_000).toUTCString().replace("GMT", "+1100");
}

function dataset(n: number): FakeRec[] {
  return Array.from({ length: n }, (_, i) => {
    const ms = NEWEST_MS - i * STEP_MS;
    // 4 dub points (i % 4) in 2 teams: dp-0,dp-1 -> team-a; dp-2,dp-3 -> team-b.
    const dp = i % 4;
    return {
      id: `rec-${String(i).padStart(5, "0")}`,
      to: i % 2 ? "+61400000001" : "+61400000002",
      dub_point: `dp-${dp}`,
      team: dp < 2 ? "team-a" : "team-b",
      start_time: rfc2822(ms),
      ms,
    };
  });
}

interface FakeDubber {
  requests: URL[];
  tokenCalls: number;
  /** 1-based recordings request number that answers Dubber's 403 rate limit instead. */
  rateLimitOnRequest?: number;
}

function installFakeDubber(all: FakeRec[]): FakeDubber {
  const state: FakeDubber = { requests: [], tokenCalls: 0 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      if (url.pathname.endsWith("/token")) {
        expect(init?.method).toBe("POST");
        state.tokenCalls += 1;
        return json({ access_token: "tok", expires_in: 240, token_type: "Bearer" });
      }
      expect(url.origin + url.pathname).toBe(`${BASE_URL}/accounts/${ACCOUNT}/recordings`);
      state.requests.push(url);
      if (state.requests.length === state.rateLimitOnRequest) {
        return new Response(JSON.stringify({ code: 1021, message: "Queries Per Second Limit" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        });
      }
      let rows = all;
      const beforeId = url.searchParams.get("before_id");
      const afterId = url.searchParams.get("after_id");
      if (beforeId) rows = rows.slice(rows.findIndex((r) => r.id === beforeId) + 1);
      if (afterId) rows = rows.slice(0, rows.findIndex((r) => r.id === afterId));
      const dubPoint = url.searchParams.get("dub_point");
      const team = url.searchParams.get("team");
      if (dubPoint) rows = rows.filter((r) => r.dub_point === dubPoint);
      if (team) rows = rows.filter((r) => r.team === team);
      const count = Math.min(Number(url.searchParams.get("count") ?? 20), 100);
      // limit / offset / page / query / anything else: silently ignored, like Dubber.
      return json({ self: url.href, recordings: rows.slice(0, count).map(({ ms: _ms, ...r }) => r) });
    })
  );
  return state;
}

let seq = 0;
function realClient(): DubberApi {
  seq += 1;
  return createDubberApi({
    clientId: `test-client-${seq}`, // unique -> unique token-cache key, no cross-test leakage
    clientSecret: "fake-secret",
    authId: "fake-auth-id",
    authToken: "fake-auth-token",
    region: "sandbox",
  });
}

interface ListResult {
  recordings: { id: string }[];
  returned: number;
  hasMore: boolean;
  nextCursor: string | null;
  remainingOffset: number;
  scanned: number;
  requests: number;
  scanCapReached: boolean;
  rateLimited?: boolean;
  note?: string;
  filters: Record<string, unknown>;
}

async function list(client: DubberApi, args: Record<string, unknown>): Promise<ListResult> {
  const result = (await handleToolCall(client, "dubber_recordings_list", { accountId: ACCOUNT, ...args })) as ToolResult;
  const first = result.content[0]!;
  if (result.isError) throw new Error(first.type === "text" ? first.text : "tool error");
  return JSON.parse(first.type === "text" ? first.text : "{}") as ListResult;
}

const ids = (r: ListResult) => r.recordings.map((x) => x.id);

describe("dubber_recordings_list paging (real guarded client, mocked fetch)", () => {
  let all: FakeRec[];
  let fake: FakeDubber;

  beforeEach(() => {
    all = dataset(1000);
    fake = installFakeDubber(all);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("never sends limit/offset (or any undocumented param) to Dubber", async () => {
    const client = realClient();
    await list(client, { limit: 250, offset: 40, startTimeFrom: WEEK_FROM });
    expect(fake.requests.length).toBeGreaterThan(0);
    for (const url of fake.requests) {
      expect(url.searchParams.has("limit")).toBe(false);
      expect(url.searchParams.has("offset")).toBe(false);
      expect(url.searchParams.has("page")).toBe(false);
      expect(url.searchParams.get("count")).toBe("100");
      expect([...url.searchParams.keys()].every((k) => ["count", "before_id"].includes(k))).toBe(true);
    }
    expect(fake.requests[0]!.searchParams.has("before_id")).toBe(false);
  });

  it("dubPointId + time window + paging past 100 returns exactly that dub point's recordings", async () => {
    const from = Date.parse(WEEK_FROM);
    const to = Date.parse(WEEK_TO);
    const expected = all.filter((x) => x.dub_point === "dp-1" && x.ms >= from && x.ms < to).map((x) => x.id);
    expect(expected.length).toBe(120); // 480 in window / 4 dub points
    const client = realClient();
    const seen: string[] = [];
    let cursor: string | undefined;
    let first: ListResult | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const r = await list(client, {
        dubPointId: " dp-1 ",
        startTimeFrom: WEEK_FROM,
        startTimeTo: WEEK_TO,
        limit: 50,
        ...(cursor ? { cursor } : {}),
      });
      first ??= r;
      seen.push(...ids(r));
      if (!r.hasMore) break;
      cursor = r.nextCursor!;
    }
    expect(seen).toEqual(expected);
    expect(first!.filters["dubPointId"]).toBe("dp-1");
    expect(first!.filters["teamId"]).toBeNull();
    // The week spans well over 100 recordings of the account, so paging crossed Dubber pages.
    expect(fake.requests.length).toBeGreaterThan(3);
    for (const url of fake.requests) {
      expect(url.searchParams.get("dub_point")).toBe("dp-1");
      expect(url.searchParams.has("team")).toBe(false);
    }
  });

  it("every page request of a multi-page call carries dub_point", async () => {
    const r = await list(realClient(), { dubPointId: "dp-2", limit: 250 });
    expect(r.requests).toBeGreaterThan(1);
    expect(fake.requests).toHaveLength(r.requests);
    for (const url of fake.requests) expect(url.searchParams.get("dub_point")).toBe("dp-2");
    expect(ids(r)).toEqual(all.filter((x) => x.dub_point === "dp-2").slice(0, 250).map((x) => x.id));
  });

  it("teamId filters by team, sends team on every page, and echoes it", async () => {
    const r = await list(realClient(), { teamId: "team-b", limit: 300 });
    expect(ids(r)).toEqual(all.filter((x) => x.team === "team-b").slice(0, 300).map((x) => x.id));
    expect(r.filters["teamId"]).toBe("team-b");
    expect(r.filters["dubPointId"]).toBeNull();
    expect(r.requests).toBeGreaterThan(1);
    for (const url of fake.requests) {
      expect(url.searchParams.get("team")).toBe("team-b");
      expect(url.searchParams.has("dub_point")).toBe(false);
    }
  });

  it("rejects dubPointId together with teamId, and empty values, without fetching", async () => {
    const client = realClient();
    const both = (await handleToolCall(client, "dubber_recordings_list", {
      accountId: ACCOUNT,
      dubPointId: "dp-1",
      teamId: "team-a",
    })) as ToolResult;
    expect(both.isError).toBe(true);
    expect(JSON.stringify(both.content)).toContain("cannot be combined");
    for (const args of [{ dubPointId: "  " }, { teamId: "" }]) {
      const r = (await handleToolCall(client, "dubber_recordings_list", { accountId: ACCOUNT, ...args })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r.content)).toContain("non-empty");
    }
    expect(fake.requests).toHaveLength(0);
    expect(fake.tokenCalls).toBe(0);
  });

  it("returns the newest N for limit alone (not just Dubber's default 20)", async () => {
    const r = await list(realClient(), { limit: 150 });
    expect(ids(r)).toEqual(all.slice(0, 150).map((x) => x.id));
    expect(r.requests).toBe(2);
  });

  it("offset 40 and offset 400 return different, exact pages", async () => {
    const client = realClient();
    const a = await list(client, { offset: 40, limit: 10 });
    const b = await list(client, { offset: 400, limit: 10 });
    expect(ids(a)).toEqual(all.slice(40, 50).map((x) => x.id));
    expect(ids(b)).toEqual(all.slice(400, 410).map((x) => x.id));
    expect(ids(a)).not.toEqual(ids(b));
    expect(a.requests).toBe(1);
    expect(b.requests).toBe(5);
  });

  it("limit 250 across a Mon–Fri window returns exactly the recordings in the window", async () => {
    const from = Date.parse(WEEK_FROM);
    const to = Date.parse(WEEK_TO);
    const inWindow = all.filter((x) => x.ms >= from && x.ms < to);
    expect(inWindow.length).toBe(480); // 5 days * 96 per day
    const r = await list(realClient(), { startTimeFrom: WEEK_FROM, startTimeTo: WEEK_TO, limit: 250 });
    expect(ids(r)).toEqual(inWindow.slice(0, 250).map((x) => x.id));
    expect(r.hasMore).toBe(true);
    expect(r.nextCursor).toBe(inWindow[249]!.id);

    // All 480 do not fit the response cap: the result is trimmed and the cursor resumes exactly.
    const window = { startTimeFrom: WEEK_FROM, startTimeTo: WEEK_TO, limit: 500 };
    let page = await list(realClient(), window);
    // Stops once an entire page is older than the window instead of scanning all 1,000.
    expect(page.requests).toBeLessThan(10);
    expect(ids(page).length).toBeLessThan(480);
    const seen = ids(page);
    for (let guard = 0; page.hasMore && guard < 5; guard++) {
      page = await list(realClient(), { ...window, cursor: page.nextCursor, offset: page.remainingOffset });
      seen.push(...ids(page));
    }
    expect(seen).toEqual(inWindow.map((x) => x.id));
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it("a date-only startTimeTo includes that whole (UTC) day; date-time is exclusive", async () => {
    const dayStart = Date.parse("2026-10-23T00:00:00Z");
    const expected = all.filter((x) => x.ms >= dayStart && x.ms < dayStart + 86_400_000).map((x) => x.id);
    const dateOnly = await list(realClient(), { startTimeFrom: "2026-10-23", startTimeTo: "2026-10-23", limit: 500 });
    expect(ids(dateOnly)).toEqual(expected);
    const exclusive = await list(realClient(), {
      startTimeFrom: "2026-10-23T00:00:00Z",
      startTimeTo: "2026-10-24T00:00:00Z",
      limit: 500,
    });
    expect(ids(exclusive)).toEqual(expected);
  });

  describe("bounds without a UTC offset", () => {
    const UTC_NOTE = "had no UTC offset and were interpreted as UTC (see filters)";

    it("a date-only bound is read as UTC (not Melbourne time) and says so", async () => {
      // 2026-10-23 UTC is 11:00 on the 23rd to 11:00 on the 24th in Melbourne, so it differs from the local day.
      const r = await list(realClient(), { startTimeFrom: "2026-10-23", startTimeTo: "2026-10-23", limit: 500 });
      expect(r.filters["startTimeFrom"]).toBe("2026-10-23T00:00:00.000Z");
      expect(r.filters["startTimeToExclusive"]).toBe("2026-10-24T00:00:00.000Z");
      expect(r.note).toContain("startTimeFrom/startTimeTo");
      expect(r.note).toContain(UTC_NOTE);
      expect(r.note).toContain("pass an explicit offset such as +11:00 for a local-time window.");
    });

    it("a date-time without an offset says so", async () => {
      const r = await list(realClient(), { startTimeFrom: "2026-10-23T09:00:00", limit: 5 });
      expect(r.filters["startTimeFrom"]).toBe("2026-10-23T09:00:00.000Z");
      expect(r.note).toContain(UTC_NOTE);
    });

    it("one offsetless bound is enough, even next to an explicit one", async () => {
      const r = await list(realClient(), { startTimeFrom: WEEK_FROM, startTimeTo: "2026-10-24", limit: 5 });
      expect(r.note).toContain(UTC_NOTE);
    });

    it("the note is kept when the result is trimmed to fit the response limit", async () => {
      const r = await list(realClient(), { startTimeFrom: "2026-10-19", startTimeTo: "2026-10-24", limit: 500 });
      expect(r.hasMore).toBe(true);
      expect(r.note).toContain("response limit");
      expect(r.note).toContain(UTC_NOTE);
    });

    it.each([
      ["a numeric offset", { startTimeFrom: WEEK_FROM, startTimeTo: WEEK_TO }],
      ["Z", { startTimeFrom: "2026-10-23T00:00:00Z", startTimeTo: "2026-10-24T00:00:00z" }],
    ])("%s adds no note", async (_label, bounds) => {
      const r = await list(realClient(), { ...bounds, limit: 5 });
      expect(r.note ?? "").not.toContain("UTC offset");
    });
  });

  it("rejects the removed query argument and names the filters that replace it, without fetching", async () => {
    const result = (await handleToolCall(realClient(), "dubber_recordings_list", {
      accountId: ACCOUNT,
      query: "6140",
    })) as ToolResult;
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("query");
    expect(text).toContain("was removed");
    for (const replacement of ["dubPointId", "teamId", "startTimeFrom", "startTimeTo"]) {
      expect(text).toContain(replacement);
    }
    expect(fake.requests).toHaveLength(0);
    expect(fake.tokenCalls).toBe(0);
  });

  it("nextCursor resumes with no gaps or duplicates (unfiltered)", async () => {
    const client = realClient();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const r = await list(client, { limit: 130, ...(cursor ? { cursor } : {}) });
      seen.push(...ids(r));
      if (!r.hasMore) break;
      expect(r.nextCursor).not.toBeNull();
      cursor = r.nextCursor!;
    }
    expect(seen).toEqual(all.map((x) => x.id));
  });

  it("nextCursor resumes with no gaps or duplicates (time window + team)", async () => {
    const client = realClient();
    const from = Date.parse(WEEK_FROM);
    const to = Date.parse(WEEK_TO);
    const expected = all.filter((x) => x.ms >= from && x.ms < to && x.team === "team-a").map((x) => x.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const r = await list(client, {
        limit: 77,
        teamId: "team-a",
        startTimeFrom: WEEK_FROM,
        startTimeTo: WEEK_TO,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(r));
      if (!r.hasMore) break;
      cursor = r.nextCursor!;
    }
    expect(seen).toEqual(expected);
  });

  it("offset skips matching recordings only, not the ones filtered out", async () => {
    const from = Date.parse(WEEK_FROM);
    const to = Date.parse(WEEK_TO);
    const inWindow = all.filter((x) => x.ms >= from && x.ms < to);
    const r = await list(realClient(), { startTimeFrom: WEEK_FROM, startTimeTo: WEEK_TO, offset: 100, limit: 5 });
    expect(ids(r)).toEqual(inWindow.slice(100, 105).map((x) => x.id));
  });

  it("stopping early at a page older than startTimeFrom names the assumed order and a cursor to look further back", async () => {
    // all[0..50] match; page 2 (all[100..199]) is entirely older, so the scan stops there.
    const r = await list(realClient(), { startTimeFrom: new Date(all[50]!.ms).toISOString(), limit: 500 });
    expect(r.returned).toBe(51);
    expect(r.requests).toBe(2);
    expect(r.hasMore).toBe(false);
    expect(r.nextCursor).toBeNull();
    expect(r.note).toContain("newest first by start_time");
    expect(r.note).toContain(`cursor="${all[199]!.id}"`);
  });

  it("reports an empty window and counts unparseable start_time", async () => {
    all[3]!.start_time = "not a date";
    const r = await list(realClient(), { startTimeFrom: "2030-01-01", limit: 10 });
    expect(r.returned).toBe(0);
    expect(r.note).toContain("No recordings found");
    // everything is older than 2030 -> first page is entirely before `from`... except the unparseable one
    expect(r.requests).toBeGreaterThanOrEqual(2);
  });

  it("caps a call at 10 Dubber requests and resumes via nextCursor", async () => {
    all = dataset(1500);
    fake = installFakeDubber(all);
    const client = realClient();
    // Matches nothing, and no recording is "before from", so the scan can't end early.
    const first = await list(client, { startTimeTo: "2000-01-01", limit: 10 });
    expect(first.requests).toBe(10);
    expect(first.scanned).toBe(1000);
    expect(first.scanCapReached).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.returned).toBe(0);
    expect(first.nextCursor).toBe(all[999]!.id);
    expect(first.note).toContain(first.nextCursor!);
    expect(fake.requests).toHaveLength(10);

    // Continue: the remaining 500 take 5 full pages + 1 empty page.
    const second = await list(client, { startTimeTo: "2000-01-01", limit: 10, cursor: first.nextCursor! });
    expect(second.requests).toBe(6); // 5 full pages, then an empty one
    expect(second.scanned).toBe(500);
    expect(second.scanCapReached).toBe(false);
    expect(second.hasMore).toBe(false);
  });

  it("cap hit with matches collects them and resumes without loss", async () => {
    all = dataset(1500);
    fake = installFakeDubber(all);
    const client = realClient();
    // offset beyond the first 1,000 forces the scan cap before anything is returned.
    const first = await list(client, { offset: 1200, limit: 50 });
    expect(first.scanCapReached).toBe(true);
    expect(first.returned).toBe(0);
    // 1,000 of the 1,200 were skipped; the caller must resume with the remaining 200.
    expect(first.remainingOffset).toBe(200);
    expect(first.note).toContain('offset=200');
    const second = await list(client, { offset: first.remainingOffset, limit: 50, cursor: first.nextCursor! });
    expect(second.remainingOffset).toBe(0);
    expect(ids(second)).toEqual(all.slice(1200, 1250).map((x) => x.id));
  });

  it("a rate limit after the first page returns what was collected plus a resumable cursor", async () => {
    fake.rateLimitOnRequest = 3;
    const client = realClient();
    const first = await list(client, { limit: 400 });
    expect(first.requests).toBe(2);
    expect(ids(first)).toEqual(all.slice(0, 200).map((x) => x.id));
    expect(first).toMatchObject({ hasMore: true, nextCursor: all[199]!.id, remainingOffset: 0, rateLimited: true });
    expect(first.note).toContain("rate limit");
    expect(first.note).toContain(`cursor="${all[199]!.id}"`);

    fake.rateLimitOnRequest = undefined;
    const second = await list(client, { limit: 200, cursor: first.nextCursor! });
    expect(ids(second)).toEqual(all.slice(200, 400).map((x) => x.id));
  });

  it("a rate limit on the first page is an error, not an empty list", async () => {
    fake.rateLimitOnRequest = 1;
    const result = (await handleToolCall(realClient(), "dubber_recordings_list", { accountId: ACCOUNT })) as ToolResult;
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("rate limit (code 1021)");
  });

  it("mints a single token for the whole multi-page call", async () => {
    await list(realClient(), { limit: 500 });
    expect(fake.tokenCalls).toBe(1);
  });
});
