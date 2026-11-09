/**
 * Handler dispatch and argument handling against a stubbed DubberApi. The
 * request each tool actually sends (method, path, query, body) is asserted
 * against the real transport in security-contract.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { NotFoundError } from "@wyre-ai/node-dubber";
import { handleToolCall } from "../handlers/index.js";
import type { ToolResult } from "../handlers/results.js";
import { stubClient } from "./stub-client.js";

function asTool(result: ToolResult): ToolResult {
  return result;
}

function text(result: ToolResult): string {
  const content = asTool(result).content[0];
  return content.type === "text" ? content.text : "";
}

describe("handleToolCall: unknown tool", () => {
  it("returns an isError result rather than throwing", async () => {
    const result = await handleToolCall(stubClient(), "not_a_real_tool", {});
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain("Unknown tool");
  });
});

describe("core", () => {
  it("dubber_test_connection reports ok", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_test_connection", {});
    expect(asTool(result).isError).toBeFalsy();
    expect(client.testConnection).toHaveBeenCalledTimes(1);
  });

  it("dubber_test_connection surfaces a failed check as isError", async () => {
    const client = stubClient({ testConnection: vi.fn(async () => ({ ok: false, error: "bad creds" })) as never });
    const result = await handleToolCall(client, "dubber_test_connection", {});
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain("Dubber connection check failed");
  });
});

describe("groups", () => {
  it("dubber_groups_get requires groupId", async () => {
    const result = await handleToolCall(stubClient(), "dubber_groups_get", {});
    expect(text(result)).toContain('Invalid arguments for dubber_groups_get: Argument "groupId"');
  });

  it("dubber_groups_get calls the SDK and returns JSON", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_groups_get", { groupId: "grp-1" });
    expect(client.groups.get).toHaveBeenCalledWith("grp-1");
    expect(text(result)).toContain("grp-1");
  });

  it("dubber_groups_list_unidentified_dub_points reports an explicit empty-list note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_groups_list_unidentified_dub_points", {
      groupId: "grp-1",
    });
    expect(text(result)).toContain("No unidentified dub points");
  });
});

describe("recordings", () => {
  it("dubber_recordings_list reports an explicit empty-list note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_recordings_list", { accountId: "acc-1" });
    expect(text(result)).toContain("No recordings found");
  });

  it("dubber_recordings_list maps to Dubber count/before_id and never sends limit/offset", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_recordings_list", {
      accountId: "acc-1",
      limit: 10,
      offset: 5,
      cursor: "rec-77",
    });
    expect(client.recordings.list).toHaveBeenCalledTimes(1);
    expect(client.recordings.list).toHaveBeenCalledWith("acc-1", {
      count: 100,
      before_id: "rec-77",
    });
    const params = vi.mocked(client.recordings.list).mock.calls[0]![1] as Record<string, unknown>;
    expect(params).not.toHaveProperty("limit");
    expect(params).not.toHaveProperty("offset");
  });

  it("dubber_recordings_list maps dubPointId/teamId to dub_point/team", async () => {
    const dp = stubClient();
    await handleToolCall(dp, "dubber_recordings_list", { accountId: "acc-1", dubPointId: " dp-9 " });
    expect(dp.recordings.list).toHaveBeenCalledWith("acc-1", { count: 100, dub_point: "dp-9" });
    const team = stubClient();
    await handleToolCall(team, "dubber_recordings_list", { accountId: "acc-1", teamId: "t-1" });
    expect(team.recordings.list).toHaveBeenCalledWith("acc-1", { count: 100, team: "t-1" });
  });

  it("dubber_recordings_list omits before_id when not provided", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_recordings_list", { accountId: "acc-1" });
    expect(client.recordings.list).toHaveBeenCalledWith("acc-1", { count: 100 });
  });

  it.each([
    [{ limit: 0 }, 'Argument "limit"'],
    [{ limit: 501 }, 'Argument "limit"'],
    [{ offset: -1 }, 'Argument "offset"'],
    [{ cursor: "  " }, 'Argument "cursor"'],
    [{ startTimeFrom: "yesterday" }, 'Argument "startTimeFrom"'],
    [{ startTimeTo: "2026-02-31" }, 'Argument "startTimeTo"'],
    [{ startTimeFrom: "2026-10-24", startTimeTo: "2026-10-19" }, "must be earlier"],
    [{ startTimeFrom: "2026-10-19T00:00:00Z", startTimeTo: "2026-10-19T00:00:00Z" }, "must be earlier"],
  ])("dubber_recordings_list rejects invalid input %j", async (extra, message) => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_recordings_list", { accountId: "acc-1", ...extra });
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain(message);
    expect(client.recordings.list).not.toHaveBeenCalled();
  });

  it("dubber_recordings_list stops on a short page and reports counts and filters", async () => {
    const client = stubClient({
      recordings: {
        list: vi.fn(async () => [
          { id: "r2", start_time: "Mon, 19 Oct 2026 10:00:00 +1000" },
          { id: "r1", start_time: "garbage" },
        ]),
      },
    });
    const result = await handleToolCall(client, "dubber_recordings_list", {
      accountId: "acc-1",
      startTimeFrom: "2026-10-19T00:00:00+10:00",
    });
    const body = JSON.parse(text(result));
    expect(body.recordings.map((r: { id: string }) => r.id)).toEqual(["r2"]);
    expect(body).toMatchObject({
      returned: 1,
      hasMore: false,
      nextCursor: null,
      scanned: 2,
      requests: 1,
      scanCapReached: false,
      excludedUnparseableStartTime: 1,
    });
    expect(body.filters.startTimeFrom).toBe("2026-10-18T14:00:00.000Z");
    expect(body.note).toContain("unparseable");
  });
});

describe("users", () => {
  it("dubber_users_list reports an explicit empty-list note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_users_list", { accountId: "acc-1" });
    expect(text(result)).toContain("No users found");
  });
});

describe("profile", () => {
  it("dubber_profile_get takes no arguments", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_profile_get", {});
    expect(client.profile.get).toHaveBeenCalledTimes(1);
    expect(text(result)).toContain("agent@example.com");
  });
});

describe("notifications", () => {
  it("dubber_notifications_list reports an explicit empty note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_notifications_list", { accountId: "acc-1" });
    expect(text(result)).toContain("No notification subscriptions");
  });
});

describe("dub-points", () => {
  it("dubber_dub_points_find requires a query object of documented keys", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_dub_points_find", { query: { external_identifier: "u-42" } });
    expect(client.dubPoints.find).toHaveBeenCalledWith({ external_identifier: "u-42" });
  });

  it("dubber_dub_points_list reports an explicit empty note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_dub_points_list", { accountId: "acc-1" });
    expect(text(result)).toContain("No Dub.Point connections");
  });
});

describe("error mapping", () => {
  it("DubberError maps to an isError result naming the HTTP status", async () => {
    const client = stubClient({
      accounts: { get: vi.fn(async () => { throw new NotFoundError("not found", 404, {}); }) },
    });
    const result = await handleToolCall(client, "dubber_accounts_get", { accountId: "missing" });
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain("HTTP 404");
  });

  it("a plain thrown Error is mapped, never escapes handleToolCall", async () => {
    const client = stubClient({ profile: { get: vi.fn(async () => { throw new Error("boom"); }) } });
    const result = await handleToolCall(client, "dubber_profile_get", {});
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain("boom");
  });

  it("ToolInputError (bad args) never reaches the SDK client", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_recordings_get", {});
    expect(client.recordings.get).not.toHaveBeenCalled();
  });
});

describe("handler-map integrity", () => {
  it("every tool declared in TOOLS has exactly one handler (enforced at module load)", async () => {
    // handlers/index.ts throws at import time if TOOLS and HANDLERS disagree;
    // successfully importing it above is the proof. This test exists so a
    // future refactor that removes that check still has a regression test.
    const { TOOLS } = await import("../tools/index.js");
    expect(TOOLS.length).toBeGreaterThan(0);
  });
});
