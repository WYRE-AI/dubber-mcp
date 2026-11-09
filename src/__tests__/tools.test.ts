/** Tool-surface contract tests: count, names, order, schemas, annotations, the read-only contract. */
import { describe, expect, it } from "vitest";
import { ALL_TIERS, DEFAULT_TIERS, parseToolTiers } from "../config.js";
import { TOOLS, TOOL_NAMES, toolsForTiers } from "../tools/index.js";

/** docs/DESIGN.md §1.1 order — the single source of truth for the surface. */
const EXPECTED_ORDER = [
  "dubber_test_connection",
  "dubber_groups_get",
  "dubber_groups_list_unidentified_dub_points",
  "dubber_accounts_get",
  "dubber_recordings_list",
  "dubber_recordings_get",
  "dubber_recordings_get_link",
  "dubber_recordings_get_waveform",
  "dubber_users_list",
  "dubber_users_get",
  "dubber_profile_get",
  "dubber_notifications_list",
  "dubber_notifications_get",
  "dubber_dub_points_list",
  "dubber_dub_points_get",
  "dubber_dub_points_find",
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
  it("has exactly 16 tools in the DESIGN.md order", () => {
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

describe("read-only contract", () => {
  it("every tool is annotated read-only and open-world, never destructive, with no warning", () => {
    for (const t of TOOLS) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: true, openWorldHint: true });
      expect(t.annotations?.destructiveHint, t.name).not.toBe(true);
      expect(t.description, t.name).not.toContain("⚠");
    }
  });

  it("read is the only tier: write/admin fail at startup instead of enabling anything", () => {
    expect(ALL_TIERS).toEqual(["read"]);
    expect(DEFAULT_TIERS).toEqual(["read"]);
    for (const raw of ["write", "admin", "read,write", "read,write,admin"]) {
      expect(() => parseToolTiers(raw), raw).toThrow("Invalid DUBBER_TOOL_TIERS entry");
    }
    expect(toolsForTiers(parseToolTiers("read"))).toEqual(TOOLS);
    expect(toolsForTiers(new Set())).toEqual([]);
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
