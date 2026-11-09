/**
 * The complete Dubber tool surface — FLAT (no router).
 *
 * Deterministic ordering rule: `TOOLS` is one module-scope array, assembled
 * from the domain modules below in a fixed order. `tools/list` returns the
 * enabled tiers' slice of it (toolsForTiers), in this order. Never sorted at
 * runtime, never filtered per-session, never varied by credentials. Only
 * DUBBER_TOOL_TIERS and Conduit's X-Conduit-Tool-Tiers header (which can only
 * narrow) choose the tiers.
 *
 * Hand-written JSON Schema (no zod). Destructive (D) and high-impact (S)
 * tools follow fleet convention §2.7b: a "⚠ DESTRUCTIVE" / "⚠ HIGH-IMPACT"
 * description prefix, inline annotations, CONFIRM_ARG_PROPERTY in the
 * schema, and a description ending "Confirm with the user before invoking."
 */
import type { Tool } from "@modelcontextprotocol/server";
import { ALL_TIERS, type ToolTier } from "../config.js";
import { ACCOUNTS_TOOLS } from "./accounts.js";
import { CORE_TOOLS } from "./core.js";
import { DUB_POINTS_TOOLS } from "./dub-points.js";
import { GROUPS_TOOLS } from "./groups.js";
import { NOTIFICATIONS_TOOLS } from "./notifications.js";
import { OAUTH_TOOLS } from "./oauth.js";
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
  ...OAUTH_TOOLS,
];

export const TOOL_NAMES = TOOLS.map((tool) => tool.name);

/**
 * A tool's tier, derived from its annotations exactly as Conduit derives it:
 * destructiveHint -> admin, readOnlyHint -> read, anything else -> write.
 */
export function toolTier(tool: Tool): ToolTier {
  if (tool.annotations?.destructiveHint === true) return "admin";
  if (tool.annotations?.readOnlyHint === true) return "read";
  return "write";
}

const toolsByTierKey = new Map<string, Tool[]>();

/**
 * The tools enabled for a tier set, in TOOLS order. Cached per tier set, so
 * every request with the same tiers gets the same array (deterministic
 * tools/list for every caller and both protocol eras).
 */
export function toolsForTiers(tiers: ReadonlySet<ToolTier>): Tool[] {
  const key = ALL_TIERS.filter((t) => tiers.has(t)).join(",");
  let tools = toolsByTierKey.get(key);
  if (!tools) {
    tools = TOOLS.filter((tool) => tiers.has(toolTier(tool)));
    toolsByTierKey.set(key, tools);
  }
  return tools;
}
