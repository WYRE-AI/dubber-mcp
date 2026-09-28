/**
 * The complete Dubber tool surface — FLAT (no router).
 *
 * Deterministic ordering rule: `TOOLS` is one module-scope array, assembled
 * from the domain modules below in a fixed order. `tools/list` returns this
 * array by reference for every request, every era, every caller. Never
 * sorted at runtime, never filtered per-session, never varied by
 * credentials.
 *
 * Hand-written JSON Schema (no zod). Destructive (D) and high-impact (S)
 * tools follow fleet convention §2.7b: a "⚠ DESTRUCTIVE" / "⚠ HIGH-IMPACT"
 * description prefix, inline annotations, CONFIRM_ARG_PROPERTY in the
 * schema, and a description ending "Confirm with the user before invoking."
 */
import type { Tool } from "@modelcontextprotocol/server";
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
