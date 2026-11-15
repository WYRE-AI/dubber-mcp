/** Tool-surface contract tests: count, names, order, schemas, annotations, the read-only contract. */
import { describe, expect, it } from "vitest";
import { ALL_TIERS, DEFAULT_TIERS, parseToolTiers, type ToolTier } from "../config.js";
import { CONFIRM_ARG } from "../elicitation.js";
import { TOOLS, TOOL_NAMES, toolTier, toolsForTiers } from "../tools/index.js";

/**
 * The v1.1.0 surface (37 tools, same order) plus the two read tools added in v2:
 * dubber_groups_list_unidentified_dub_points and dubber_recordings_get_link.
 */
const EXPECTED_ORDER = [
  "dubber_test_connection",
  "dubber_groups_get",
  "dubber_groups_list_unidentified_dub_points",
  "dubber_groups_create_child",
  "dubber_groups_list_unidentified_recordings",
  "dubber_groups_create_unidentified_recording",
  "dubber_accounts_create",
  "dubber_accounts_get",
  "dubber_accounts_update",
  "dubber_recordings_list",
  "dubber_recordings_create",
  "dubber_recordings_get",
  "dubber_recordings_get_link",
  "dubber_recordings_get_waveform",
  "dubber_recordings_delete",
  "dubber_recordings_update_metadata",
  "dubber_recordings_add_tags",
  "dubber_recordings_delete_tags",
  "dubber_recordings_initiate_multipart_upload",
  "dubber_recordings_get_upload_target",
  "dubber_recordings_complete_upload",
  "dubber_users_list",
  "dubber_users_create",
  "dubber_users_get",
  "dubber_users_update",
  "dubber_users_delete",
  "dubber_profile_get",
  "dubber_notifications_list",
  "dubber_notifications_create",
  "dubber_notifications_get",
  "dubber_notifications_update",
  "dubber_notifications_activate",
  "dubber_notifications_list_unclaimed",
  "dubber_notifications_delete",
  "dubber_dub_points_list",
  "dubber_dub_points_create",
  "dubber_dub_points_get",
  "dubber_dub_points_find",
  "dubber_oauth_revoke_token",
];

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function schemaOf(name: string) {
  return tool(name).inputSchema as {
    properties?: Record<string, { type?: string; properties?: Record<string, unknown>; additionalProperties?: unknown }>;
    required?: string[];
  };
}

describe("tool surface", () => {
  it("has the 39 tools: v1.1.0's 37 in order plus the two new read tools", () => {
    expect(TOOL_NAMES).toEqual(EXPECTED_ORDER);
  });

  it("every name matches ^dubber_[a-z_]+$", () => {
    for (const name of TOOL_NAMES) expect(name).toMatch(/^dubber_[a-z_]+$/);
  });

  it("every tool has a description and an object inputSchema", () => {
    for (const t of TOOLS) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });
});

/**
 * Tiers derived from annotations (Conduit's rule). Write/admin tools keep their
 * v1.1.0 annotations exactly; every tool not listed here is read.
 */
const NON_READ_TIERS: Record<string, ToolTier> = {
  dubber_groups_create_child: "write",
  dubber_groups_create_unidentified_recording: "write",
  dubber_accounts_create: "write",
  dubber_accounts_update: "write",
  dubber_recordings_create: "write",
  dubber_recordings_delete: "admin",
  dubber_recordings_update_metadata: "write",
  dubber_recordings_add_tags: "write",
  dubber_recordings_delete_tags: "admin",
  dubber_recordings_initiate_multipart_upload: "write",
  dubber_recordings_complete_upload: "write",
  dubber_users_create: "write",
  dubber_users_update: "write",
  dubber_users_delete: "admin",
  dubber_notifications_create: "write",
  dubber_notifications_update: "write",
  dubber_notifications_activate: "write",
  dubber_notifications_delete: "admin",
  dubber_dub_points_create: "write",
  dubber_oauth_revoke_token: "admin",
};

describe("tool tiers", () => {
  it("every tool's tier matches v1.1.0 (the two new tools are read)", () => {
    for (const t of TOOLS) expect(toolTier(t), t.name).toBe(NON_READ_TIERS[t.name] ?? "read");
  });

  it("read tools are annotated read-only and open-world, with no warning", () => {
    for (const t of TOOLS.filter((x) => toolTier(x) === "read")) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(t.description, t.name).not.toContain("⚠");
    }
  });

  it("destructive tools carry the warning prefix and the confirm argument", () => {
    for (const t of TOOLS.filter((x) => x.annotations?.destructiveHint === true)) {
      expect(t.description, t.name).toMatch(/^⚠ (DESTRUCTIVE|HIGH-IMPACT)/);
      expect(Object.keys((t.inputSchema as { properties?: object }).properties ?? {}), t.name).toContain(CONFIRM_ARG);
    }
  });

  it("every tier is enabled by default; DUBBER_TOOL_TIERS narrows", () => {
    expect(ALL_TIERS).toEqual(["read", "write", "admin"]);
    expect(DEFAULT_TIERS).toEqual(["read", "write", "admin"]);
    expect(toolsForTiers(parseToolTiers(undefined))).toEqual(TOOLS);
    expect(toolsForTiers(parseToolTiers("read")).map((t) => t.name)).toEqual(
      TOOL_NAMES.filter((n) => !(n in NON_READ_TIERS))
    );
    expect(toolsForTiers(new Set())).toEqual([]);
    expect(() => parseToolTiers("superuser")).toThrow("Invalid DUBBER_TOOL_TIERS entry");
  });
});

describe("schemas", () => {
  it("dubber_recordings_get returns details only; the signed link is its own tool", () => {
    expect(Object.keys(schemaOf("dubber_recordings_get").properties ?? {})).toEqual(["recordingId"]);
    const link = tool("dubber_recordings_get_link");
    expect(Object.keys(schemaOf("dubber_recordings_get_link").properties ?? {})).toEqual([
      "recordingId",
      "listener",
      "contentDisposition",
    ]);
    expect([...(schemaOf("dubber_recordings_get_link").required ?? [])].sort()).toEqual(["listener", "recordingId"]);
    expect(link.description).toMatch(/recording_url/);
    expect(link.description).toMatch(/bearer/i);
    // Dubber may record the listen against the listener's identity.
    expect(link.description).toMatch(/attribut/i);
  });

  it("list tools expose Dubber's documented paging params", () => {
    expect(Object.keys(schemaOf("dubber_users_list").properties ?? {})).toEqual(["accountId", "count", "page"]);
    expect(Object.keys(schemaOf("dubber_dub_points_list").properties ?? {})).toEqual([
      "accountId",
      "userId",
      "limit",
      "offset",
      "count",
      "page",
    ]);
  });

  it("dubber_recordings_list has no undocumented query param", () => {
    expect(schemaOf("dubber_recordings_list").properties).not.toHaveProperty("query");
  });

  it("dubber_dub_points_find declares exactly Dubber's four documented lookup keys", () => {
    const query = schemaOf("dubber_dub_points_find").properties?.["query"];
    expect(Object.keys(query?.properties ?? {})).toEqual([
      "external_type",
      "service_provider",
      "external_group",
      "external_identifier",
    ]);
    expect(query?.additionalProperties).toBe(false);
  });

  it("required arguments", () => {
    const required = (name: string) => [...(schemaOf(name).required ?? [])].sort();
    expect(required("dubber_test_connection")).toEqual([]);
    expect(required("dubber_groups_get")).toEqual(["groupId"]);
    expect(required("dubber_groups_list_unidentified_dub_points")).toEqual(["groupId"]);
    expect(required("dubber_recordings_list")).toEqual(["accountId"]);
    expect(required("dubber_recordings_get")).toEqual(["recordingId"]);
    expect(required("dubber_users_list")).toEqual(["accountId"]);
    expect(required("dubber_profile_get")).toEqual([]);
    expect(required("dubber_dub_points_find")).toEqual(["query"]);
  });
});

describe("descriptions match Dubber's documented responses", () => {
  it("dubber_recordings_get does not promise tags (Get_Recordings_Details has none)", () => {
    expect(tool("dubber_recordings_get").description).not.toContain("tags");
  });

  it("dubber_recordings_get_waveform warns that waveform_url is a short-lived bearer link", () => {
    const description = tool("dubber_recordings_get_waveform").description ?? "";
    expect(description).toContain("waveform_url");
    expect(description).toMatch(/pre-signed/);
    expect(description).toMatch(/do not share/i);
  });
});
