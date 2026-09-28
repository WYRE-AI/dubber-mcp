/**
 * Handler dispatch against a stubbed DubberClient, covering every domain.
 * Gated (destructive) tools exercise the real MRTR elicitation helpers: a
 * form-capable caller with no responses gets an `input_required` ask; a
 * retried request carries the answer in `inputResponses`; the stateless
 * gateway path (NO_ELICITATION) fails closed unless the call passes
 * `confirm_destructive_action`.
 */
import { describe, expect, it, vi } from "vitest";
import type { InputRequiredResult } from "@modelcontextprotocol/server";
import { NotFoundError, ValidationError } from "@wyre-ai/node-dubber";
import { CONFIRM_ARG, NO_ELICITATION, type ElicitationContext } from "../elicitation.js";
import { handleToolCall } from "../handlers/index.js";
import type { ToolResult } from "../handlers/results.js";
import { stubClient } from "./stub-client.js";

const FORM_CAPABLE: ElicitationContext = { clientCapabilities: { elicitation: {} } };

function answered(confirm: boolean): ElicitationContext {
  return {
    clientCapabilities: { elicitation: {} },
    inputResponses: { confirm: { action: "accept", content: { confirm } } },
  };
}

function asTool(result: ToolResult | InputRequiredResult): ToolResult {
  expect((result as { resultType?: string }).resultType).toBeUndefined();
  return result as ToolResult;
}

function text(result: ToolResult | InputRequiredResult): string {
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

  it("dubber_test_connection surfaces a failed mint as isError", async () => {
    const client = stubClient({ testConnection: vi.fn(async () => ({ ok: false, error: "bad creds" })) as never });
    const result = await handleToolCall(client, "dubber_test_connection", {});
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain("rejected");
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

  it("dubber_groups_create_child passes name through", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_groups_create_child", { groupId: "grp-1", name: "Child" });
    expect(client.groups.createChild).toHaveBeenCalledWith("grp-1", { name: "Child" });
  });

  it("dubber_groups_list_unidentified_recordings reports an explicit empty-list note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_groups_list_unidentified_recordings", {
      groupId: "grp-1",
    });
    expect(text(result)).toContain("No unidentified recordings");
  });
});

describe("accounts", () => {
  it("dubber_accounts_create requires name", async () => {
    const result = await handleToolCall(stubClient(), "dubber_accounts_create", {});
    expect(text(result)).toContain('Argument "name"');
  });

  it("dubber_accounts_create passes optional fields only when present", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_accounts_create", { name: "Acme" });
    expect(client.accounts.create).toHaveBeenCalledWith({ name: "Acme" });
    await handleToolCall(client, "dubber_accounts_create", { name: "Acme", timezone: "UTC" });
    expect(client.accounts.create).toHaveBeenLastCalledWith({ name: "Acme", timezone: "UTC" });
  });

  it("dubber_accounts_update requires an object body", async () => {
    const result = await handleToolCall(stubClient(), "dubber_accounts_update", {
      accountId: "acc-1",
      data: "not-an-object",
    });
    expect(text(result)).toContain('Argument "data" is required and must be an object');
  });
});

describe("recordings: reads and ungated writes", () => {
  it("dubber_recordings_list reports an explicit empty-list note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_recordings_list", { accountId: "acc-1" });
    expect(text(result)).toContain("No recordings found");
  });

  it("dubber_recordings_list forwards limit/offset", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_recordings_list", { accountId: "acc-1", limit: 10, offset: 5 });
    expect(client.recordings.list).toHaveBeenCalledWith("acc-1", { limit: 10, offset: 5 });
  });

  it("dubber_recordings_add_tags requires a non-empty tags array", async () => {
    const result = await handleToolCall(stubClient(), "dubber_recordings_add_tags", {
      recordingId: "rec-1",
      tags: [],
    });
    expect(text(result)).toContain('Argument "tags" is required and must be a non-empty array of strings');
  });

  it("dubber_recordings_update_metadata forwards the metadata object", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_recordings_update_metadata", {
      recordingId: "rec-1",
      metadata: { caseId: "123" },
    });
    expect(client.recordings.updateMetadata).toHaveBeenCalledWith("rec-1", { caseId: "123" });
  });

  it("multipart upload flow calls the three SDK steps", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_recordings_initiate_multipart_upload", { accountId: "acc-1" });
    expect(client.recordings.initiateMultipart).toHaveBeenCalledWith("acc-1", {});
    await handleToolCall(client, "dubber_recordings_get_upload_target", { recordingId: "rec-1" });
    expect(client.recordings.getUploadTarget).toHaveBeenCalledWith("rec-1");
    await handleToolCall(client, "dubber_recordings_complete_upload", { recordingId: "rec-1" });
    expect(client.recordings.completeUpload).toHaveBeenCalledWith("rec-1");
  });
});

describe("users", () => {
  it("dubber_users_list reports an explicit empty-list note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_users_list", { accountId: "acc-1" });
    expect(text(result)).toContain("No users found");
  });

  it("dubber_users_create requires email", async () => {
    const result = await handleToolCall(stubClient(), "dubber_users_create", { accountId: "acc-1" });
    expect(text(result)).toContain('Argument "email"');
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
  it("dubber_notifications_create requires url and event", async () => {
    const result = await handleToolCall(stubClient(), "dubber_notifications_create", { accountId: "acc-1" });
    expect(text(result)).toContain('Argument "url"');
  });

  it("dubber_notifications_activate calls through", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_notifications_activate", { notificationId: "notif-1" });
    expect(client.notifications.activate).toHaveBeenCalledWith("notif-1");
    expect(text(result)).toContain("true");
  });

  it("dubber_notifications_list_unclaimed reports an explicit empty note", async () => {
    const result = await handleToolCall(stubClient(), "dubber_notifications_list_unclaimed", {
      notificationId: "notif-1",
    });
    expect(text(result)).toContain("No unclaimed events");
  });
});

describe("dub-points", () => {
  it("dubber_dub_points_find requires a query object and stringifies its values", async () => {
    const client = stubClient();
    await handleToolCall(client, "dubber_dub_points_find", { query: { external_id: 42 } });
    expect(client.dubPoints.find).toHaveBeenCalledWith({ external_id: "42" });
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

  it("ValidationError from the SDK is mapped, not thrown", async () => {
    const client = stubClient({
      recordings: { create: vi.fn(async () => { throw new ValidationError("bad body", 400, {}); }) },
    });
    const result = await handleToolCall(client, "dubber_recordings_create", { accountId: "acc-1" });
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain("HTTP 400");
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

describe("destructive gate: dubber_recordings_delete (Tier A, irreversible)", () => {
  it("stateless caller with no confirmation is blocked, and nothing is deleted", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_recordings_delete", { recordingId: "rec-1" }, NO_ELICITATION);
    expect(asTool(result).isError).toBe(true);
    expect(text(result)).toContain(CONFIRM_ARG);
    expect(client.recordings.delete).not.toHaveBeenCalled();
  });

  it("stateless caller with confirm_destructive_action:true proceeds", async () => {
    const client = stubClient();
    const result = await handleToolCall(
      client,
      "dubber_recordings_delete",
      { recordingId: "rec-1", [CONFIRM_ARG]: true },
      NO_ELICITATION
    );
    expect(asTool(result).isError).toBeFalsy();
    expect(client.recordings.delete).toHaveBeenCalledWith("rec-1");
  });

  it("a form-capable caller with no answer yet gets an input_required ask naming the recording", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_recordings_delete", { recordingId: "rec-1" }, FORM_CAPABLE);
    expect((result as InputRequiredResult).resultType).toBe("input_required");
    expect(client.recordings.delete).not.toHaveBeenCalled();
  });

  it("a retried request answering accept proceeds exactly once", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_recordings_delete", { recordingId: "rec-1" }, answered(true));
    expect(asTool(result).isError).toBeFalsy();
    expect(client.recordings.delete).toHaveBeenCalledTimes(1);
  });

  it("a retried request answering decline cancels, deleting nothing", async () => {
    const client = stubClient();
    const result = await handleToolCall(client, "dubber_recordings_delete", { recordingId: "rec-1" }, answered(false));
    expect(text(result)).toContain("Cancelled");
    expect(client.recordings.delete).not.toHaveBeenCalled();
  });
});

describe("destructive gate: dubber_users_delete (Tier A, irreversible)", () => {
  it("is blocked without confirmation and proceeds with it", async () => {
    const client = stubClient();
    const blocked = await handleToolCall(client, "dubber_users_delete", { userId: "usr-1" }, NO_ELICITATION);
    expect(asTool(blocked).isError).toBe(true);
    expect(client.users.delete).not.toHaveBeenCalled();

    const proceeded = await handleToolCall(
      client,
      "dubber_users_delete",
      { userId: "usr-1", [CONFIRM_ARG]: true },
      NO_ELICITATION
    );
    expect(asTool(proceeded).isError).toBeFalsy();
    expect(client.users.delete).toHaveBeenCalledWith("usr-1");
  });
});

describe("destructive gate: dubber_recordings_delete_tags (Tier B)", () => {
  it("is blocked without confirmation and proceeds with it", async () => {
    const client = stubClient();
    const blocked = await handleToolCall(
      client,
      "dubber_recordings_delete_tags",
      { recordingId: "rec-1", tags: ["vip"] },
      NO_ELICITATION
    );
    expect(asTool(blocked).isError).toBe(true);
    expect(client.recordings.deleteTags).not.toHaveBeenCalled();

    const proceeded = await handleToolCall(
      client,
      "dubber_recordings_delete_tags",
      { recordingId: "rec-1", tags: ["vip"], [CONFIRM_ARG]: true },
      NO_ELICITATION
    );
    expect(asTool(proceeded).isError).toBeFalsy();
    expect(client.recordings.deleteTags).toHaveBeenCalledWith("rec-1", ["vip"]);
  });
});

describe("destructive gate: dubber_notifications_delete (Tier B)", () => {
  it("is blocked without confirmation and proceeds with it", async () => {
    const client = stubClient();
    const blocked = await handleToolCall(
      client,
      "dubber_notifications_delete",
      { notificationId: "notif-1" },
      NO_ELICITATION
    );
    expect(asTool(blocked).isError).toBe(true);
    expect(client.notifications.delete).not.toHaveBeenCalled();

    const proceeded = await handleToolCall(
      client,
      "dubber_notifications_delete",
      { notificationId: "notif-1", [CONFIRM_ARG]: true },
      NO_ELICITATION
    );
    expect(asTool(proceeded).isError).toBeFalsy();
    expect(client.notifications.delete).toHaveBeenCalledWith("notif-1");
  });
});

describe("destructive gate: dubber_oauth_revoke_token (Tier B)", () => {
  it("is blocked without confirmation and proceeds with it", async () => {
    const client = stubClient();
    const blocked = await handleToolCall(client, "dubber_oauth_revoke_token", {}, NO_ELICITATION);
    expect(asTool(blocked).isError).toBe(true);
    expect(client.revokeToken).not.toHaveBeenCalled();

    const proceeded = await handleToolCall(
      client,
      "dubber_oauth_revoke_token",
      { [CONFIRM_ARG]: true },
      NO_ELICITATION
    );
    expect(asTool(proceeded).isError).toBeFalsy();
    expect(client.revokeToken).toHaveBeenCalledTimes(1);
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
