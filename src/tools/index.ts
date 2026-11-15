/**
 * The complete Dubber tool surface: FLAT (no router) and READ-ONLY.
 *
 * Deterministic ordering rule: `TOOLS` is one module-scope array, assembled
 * from the domain modules below in a fixed order. `tools/list` returns it
 * whole when the `read` tier is enabled, and nothing otherwise (an empty
 * X-Conduit-Tool-Tiers header). Never sorted at runtime, never filtered
 * per-session, never varied by credentials.
 *
 * Every tool is annotated readOnlyHint: true and sends only GET requests
 * (tests/tools.test.ts and security-contract.test.ts enforce both). Hand-
 * written JSON Schema (no zod).
 */
import type { Tool } from "@modelcontextprotocol/server";
import type { ToolTier } from "../config.js";
import { ACCOUNTS_TOOLS } from "./accounts.js";
import { CORE_TOOLS } from "./core.js";
import { DUB_POINTS_TOOLS } from "./dub-points.js";
import { GROUPS_TOOLS } from "./groups.js";
import { NOTIFICATIONS_TOOLS } from "./notifications.js";
import { PROFILE_TOOLS } from "./profile.js";
import { RECORDINGS_TOOLS } from "./recordings.js";
import { USERS_TOOLS } from "./users.js";

export const TOOLS: Tool[] = [
  ...CORE_TOOLS,
  ...GROUPS_TOOLS,
  ...ACCOUNTS_TOOLS,
  ...RECORDINGS_TOOLS,
  ...USERS_TOOLS,
  ...PROFILE_TOOLS,
  ...NOTIFICATIONS_TOOLS,
  ...DUB_POINTS_TOOLS,
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

const NO_TOOLS: Tool[] = [];

/** The tools enabled for a tier set: all of them for `read`, none otherwise. Same array every time. */
export function toolsForTiers(tiers: ReadonlySet<ToolTier>): Tool[] {
  return tiers.has("read") ? TOOLS : NO_TOOLS;
}
