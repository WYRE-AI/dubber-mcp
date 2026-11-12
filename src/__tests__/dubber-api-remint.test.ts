/**
 * Dubber caps token mints at about 500 per 24 hours, so a 401 on a cached
 * token may trigger at most one re-mint per 10 minutes per credential set.
 * Only `fetch` is mocked; the clock is faked so the window can be crossed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearTokenCache, createDubberApi, type DubberApi } from "../dubber-api.js";

const REMINT_WINDOW_MS = 10 * 60_000;

let mints: number;
/** Statuses the next GET /profile calls answer with, in order; 200 once the queue is empty. */
let profileStatuses: number[];
let profileCalls: number;
/** Access tokens Dubber has revoked: every call carrying one answers 401. */
let revokedTokens: Set<string>;
let api: DubberApi;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
  clearTokenCache();
  mints = 0;
  profileStatuses = [];
  profileCalls = 0;
  revokedTokens = new Set();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.pathname.endsWith("/token")) {
        mints += 1;
        // A 24 h lifetime keeps the cached token valid across the whole test: only a 401 can re-mint.
        return new Response(JSON.stringify({ access_token: `tok-${mints}`, expires_in: 86_400 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      profileCalls += 1;
      const bearer = (init?.headers as Record<string, string> | undefined)?.["Authorization"]?.replace("Bearer ", "");
      const revoked = bearer !== undefined && revokedTokens.has(bearer);
      const status = revoked ? 401 : (profileStatuses.shift() ?? 200);
      return new Response(JSON.stringify(status === 200 ? { ok: true } : { message: "Unauthorized" }), {
        status,
        headers: { "content-type": "application/json" },
      });
    })
  );
  api = createDubberApi({
    clientId: "remint-client",
    clientSecret: "remint-secret",
    authId: "remint-auth-id",
    authToken: "remint-auth-token",
    region: "sandbox",
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("401 on a cached token", () => {
  it("re-mints and retries once, then refuses to re-mint again inside 10 minutes", async () => {
    await api.request("/profile");
    expect(mints).toBe(1);

    // First 401 on the cached token: mint once more and retry.
    profileStatuses = [401, 200];
    await expect(api.request("/profile")).resolves.toEqual({ ok: true });
    expect(mints).toBe(2);

    // A second 401 inside the window is returned as it is, with no mint and no retry.
    vi.advanceTimersByTime(60_000);
    profileStatuses = [401];
    const callsBefore = profileCalls;
    await expect(api.request("/profile")).rejects.toMatchObject({ statusCode: 401 });
    expect(mints).toBe(2);
    expect(profileCalls - callsBefore).toBe(1);

    // Once the window has passed, a 401 re-mints again.
    vi.advanceTimersByTime(REMINT_WINDOW_MS);
    profileStatuses = [401, 200];
    await expect(api.request("/profile")).resolves.toEqual({ ok: true });
    expect(mints).toBe(3);
  });

  it("lets concurrent calls on the same revoked token share one re-mint instead of failing", async () => {
    await api.request("/profile");
    expect(mints).toBe(1);

    revokedTokens.add("tok-1");
    const results = await Promise.allSettled([api.request("/profile"), api.request("/profile"), api.request("/profile")]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(mints).toBe(2);
  });

  it("keeps the window per credential set", async () => {
    const other = createDubberApi({
      clientId: "other-client",
      clientSecret: "remint-secret",
      authId: "remint-auth-id",
      authToken: "remint-auth-token",
      region: "sandbox",
    });
    await api.request("/profile");
    await other.request("/profile");
    expect(mints).toBe(2);

    profileStatuses = [401, 200];
    await api.request("/profile");
    profileStatuses = [401, 200];
    await other.request("/profile");
    expect(mints).toBe(4);
  });

  it("still applies the window to sets inside it after the tracking map is swept", async () => {
    const apiFor = (n: number) =>
      createDubberApi({
        clientId: `sweep-client-${n}`,
        clientSecret: "remint-secret",
        authId: "remint-auth-id",
        authToken: "remint-auth-token",
        region: "sandbox",
      });
    /** Mints for set n, then spends its one 401 re-mint. */
    const useUpRemint = async (n: number) => {
      const set = apiFor(n);
      await set.request("/profile");
      profileStatuses = [401, 200];
      await set.request("/profile");
    };

    // 1000 sets fill the tracking map: the first 500 at 0 min, the next 500 at 6 min.
    for (let n = 0; n < 500; n++) await useUpRemint(n);
    vi.advanceTimersByTime(6 * 60_000);
    for (let n = 500; n < 1000; n++) await useUpRemint(n);

    // At 11 min the first 500 are outside the window and the next 500 are inside it.
    // One more set makes the map sweep the expired entries.
    vi.advanceTimersByTime(5 * 60_000);
    await useUpRemint(1000);

    // A set inside the window still gets its 401 back, with no mint.
    const inside = apiFor(999);
    const mintsBefore = mints;
    profileStatuses = [401];
    await expect(inside.request("/profile")).rejects.toMatchObject({ statusCode: 401 });
    expect(mints).toBe(mintsBefore);

    // Once its window has passed it re-mints once.
    vi.advanceTimersByTime(REMINT_WINDOW_MS);
    profileStatuses = [401, 200];
    await expect(inside.request("/profile")).resolves.toEqual({ ok: true });
    expect(mints).toBe(mintsBefore + 1);
  }, 30_000);

  it("does not change normal expiry-driven refresh", async () => {
    await api.request("/profile");
    // Past the 24 h lifetime: the next call mints because the token expired, not because of a 401.
    vi.advanceTimersByTime(25 * 60 * 60_000);
    await api.request("/profile");
    expect(mints).toBe(2);
  });
});
