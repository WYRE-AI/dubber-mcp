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
let api: DubberApi;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-12T00:00:00Z"));
  clearTokenCache();
  mints = 0;
  profileStatuses = [];
  profileCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
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
      const status = profileStatuses.shift() ?? 200;
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

  it("does not change normal expiry-driven refresh", async () => {
    await api.request("/profile");
    // Past the 24 h lifetime: the next call mints because the token expired, not because of a 401.
    vi.advanceTimersByTime(25 * 60 * 60_000);
    await api.request("/profile");
    expect(mints).toBe(2);
  });
});
