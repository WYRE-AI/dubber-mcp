/** Tool-surface contract tests: count, names, order, schemas, warnings, annotations. */
import { describe, expect, it } from "vitest";
import { ALL_TIERS } from "../config.js";
import { CONFIRM_ARG } from "../elicitation.js";
import { TOOLS, TOOL_NAMES, toolTier, toolsForTiers } from "../tools/index.js";

/** docs/DESIGN.md §1.1 order — the single source of truth for the surface. */
const EXPECTED_ORDER = [
  "dubber_test_connection",
  "dubber_groups_get",
  "dubber_groups_create_child",
  "dubber_groups_list_unidentified_recordings",
  "dubber_groups_create_unidentified_recording",
  "dubber_accounts_create",
  "dubber_accounts_get",
  "dubber_accounts_update",
  "dubber_recordings_list",
  "dubber_recordings_create",
  "dubber_recordings_get",
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

/** Gated tools with their exact description prefix. */
const GATED: Record<string, string> = {
  dubber_recordings_delete: "⚠ DESTRUCTIVE — IRREVERSIBLE.",
  dubber_recordings_delete_tags: "⚠ HIGH-IMPACT.",
  dubber_users_delete: "⚠ DESTRUCTIVE — IRREVERSIBLE.",
  dubber_notifications_delete: "⚠ HIGH-IMPACT.",
  dubber_oauth_revoke_token: "⚠ HIGH-IMPACT.",
};

/** Tier A (irreversible) within GATED — the rest are Tier B (reversible-with-impact). */
const TIER_A = new Set(["dubber_recordings_delete", "dubber_users_delete"]);

/** Ungated writes: mutate state but don't need per-call confirmation. */
const UNGATED_WRITES = new Set([
  "dubber_groups_create_child",
  "dubber_groups_create_unidentified_recording",
  "dubber_accounts_create",
  "dubber_accounts_update",
  "dubber_recordings_create",
  "dubber_recordings_update_metadata",
  "dubber_recordings_add_tags",
  "dubber_recordings_initiate_multipart_upload",
  // A GET, but its result is a credential to write audio: write tier.
  "dubber_recordings_get_upload_target",
  "dubber_recordings_complete_upload",
  "dubber_users_create",
  "dubber_users_update",
  "dubber_notifications_create",
  "dubber_notifications_update",
  "dubber_notifications_activate",
  "dubber_dub_points_create",
]);

function tool(name: string) {
  const found = TOOLS.find((t) => t.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

function schemaOf(name: string) {
  return tool(name).inputSchema as {
    properties?: Record<string, { type?: string }>;
    required?: string[];
  };
}

describe("tool surface", () => {
  it("has exactly 37 tools in the DESIGN.md order", () => {
    expect(TOOLS).toHaveLength(37);
    expect(TOOL_NAMES).toEqual(EXPECTED_ORDER);
  });

  it("every name matches ^dubber_[a-z_]+$", () => {
    for (const name of TOOL_NAMES) expect(name).toMatch(/^dubber_[a-z_]+$/);
  });

  it("returns the same array for the same tiers, in TOOLS order", () => {
    const all = new Set(ALL_TIERS);
    expect(toolsForTiers(all)).toEqual(TOOLS);
    expect(toolsForTiers(new Set(["read"]))).toBe(toolsForTiers(new Set(["read"])));
  });

  it("every tool has a description and an object inputSchema", () => {
    for (const t of TOOLS) {
      expect(t.description, t.name).toBeTruthy();
      expect(t.inputSchema.type, t.name).toBe("object");
    }
  });

  it("gated tools carry the exact prefix and the confirm suffix", () => {
    for (const [name, prefix] of Object.entries(GATED)) {
      expect(tool(name).description!.startsWith(prefix), name).toBe(true);
      expect(tool(name).description, name).toMatch(/Confirm with the user before invoking\.$/u);
    }
  });

  it("gated tools declare the optional non-interactive confirmation argument", () => {
    for (const name of Object.keys(GATED)) {
      const schema = schemaOf(name);
      // Without this the fail-closed gate would be unsatisfiable: a gateway
      // caller cannot pass an argument the schema never advertises.
      expect(schema.properties?.[CONFIRM_ARG]?.type, name).toBe("boolean");
      // Optional on purpose — interactive clients confirm by prompt instead.
      expect(schema.required ?? [], name).not.toContain(CONFIRM_ARG);
    }
  });

  it("gated tools carry destructiveHint; Tier A is non-idempotent, Tier B is idempotent", () => {
    for (const name of Object.keys(GATED)) {
      expect(tool(name).annotations, name).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: true,
        idempotentHint: !TIER_A.has(name),
      });
    }
  });

  it("ungated writes are annotated readOnlyHint:false with no destructive warning", () => {
    for (const name of UNGATED_WRITES) {
      expect(tool(name).annotations?.readOnlyHint, name).toBe(false);
      expect(tool(name).annotations?.destructiveHint, name).not.toBe(true);
      expect(tool(name).description, name).not.toContain("⚠");
      expect(schemaOf(name).properties?.[CONFIRM_ARG], name).toBeUndefined();
    }
  });

  it("read tools are read-only, open-world and carry no warning", () => {
    const reads = EXPECTED_ORDER.filter((n) => !(n in GATED) && !UNGATED_WRITES.has(n));
    for (const name of reads) {
      expect(tool(name).annotations, name).toMatchObject({
        readOnlyHint: true,
        openWorldHint: true,
      });
      expect(tool(name).description, name).not.toContain("⚠");
      expect(schemaOf(name).properties?.[CONFIRM_ARG], name).toBeUndefined();
    }
  });

  it("tiers follow Conduit's annotation rule: 16 read, 16 write, 5 admin", () => {
    const reads = EXPECTED_ORDER.filter((n) => !(n in GATED) && !UNGATED_WRITES.has(n));
    for (const name of reads) expect(toolTier(tool(name)), name).toBe("read");
    for (const name of UNGATED_WRITES) expect(toolTier(tool(name)), name).toBe("write");
    for (const name of Object.keys(GATED)) expect(toolTier(tool(name)), name).toBe("admin");
    expect([reads.length, UNGATED_WRITES.size, Object.keys(GATED).length]).toEqual([16, 16, 5]);
  });

  it("dubber_recordings_get documents the signed recording link as a secret", () => {
    const t = tool("dubber_recordings_get");
    expect(Object.keys(schemaOf("dubber_recordings_get").properties ?? {})).toEqual([
      "recordingId",
      "listener",
      "contentDisposition",
    ]);
    expect(t.description).toMatch(/recording_url/);
    expect(t.description).toMatch(/never logs or caches/);
  });

  it("required arguments match the design table for a representative sample", () => {
    const required = (name: string) => [...(schemaOf(name).required ?? [])].sort();
    expect(required("dubber_test_connection")).toEqual([]);
    expect(required("dubber_groups_get")).toEqual(["groupId"]);
    expect(required("dubber_accounts_create")).toEqual(["name"]);
    expect(required("dubber_accounts_update")).toEqual(["accountId", "data"]);
    expect(required("dubber_recordings_list")).toEqual(["accountId"]);
    expect(required("dubber_recordings_get")).toEqual(["recordingId"]);
    expect(required("dubber_recordings_delete")).toEqual(["recordingId"]);
    expect(required("dubber_recordings_add_tags")).toEqual(["recordingId", "tags"]);
    expect(required("dubber_users_create")).toEqual(["accountId", "email"]);
    expect(required("dubber_users_delete")).toEqual(["userId"]);
    expect(required("dubber_profile_get")).toEqual([]);
    expect(required("dubber_notifications_create")).toEqual(["accountId", "event", "url"]);
    expect(required("dubber_dub_points_find")).toEqual(["query"]);
    expect(required("dubber_oauth_revoke_token")).toEqual([]);
  });
});
