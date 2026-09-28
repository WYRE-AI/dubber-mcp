/**
 * tools/call dispatch. The SDK client is bound per request by the caller
 * (mcp-server.ts); this module maps tool names to handlers and normalizes
 * every failure into an isError text result — errors are never thrown out.
 *
 * The handler map is merged from the domain modules. A duplicate name, or a
 * tool in TOOLS without a handler, throws at module load so a wiring mistake
 * fails every test instead of surfacing as "Unknown tool" in production.
 */
import type { InputRequiredResult } from "@modelcontextprotocol/server";
import {
  AuthenticationError,
  DubberError,
  ForbiddenError,
  RateLimitError,
  type DubberClient,
} from "@wyre-ai/node-dubber";
import { NO_ELICITATION, type ElicitationContext } from "../elicitation.js";
import { TOOLS } from "../tools/index.js";
import { ACCOUNTS_HANDLERS } from "./accounts.js";
import { CORE_HANDLERS } from "./core.js";
import { DUB_POINTS_HANDLERS } from "./dub-points.js";
import { GROUPS_HANDLERS } from "./groups.js";
import { NOTIFICATIONS_HANDLERS } from "./notifications.js";
import { OAUTH_HANDLERS } from "./oauth.js";
import { PROFILE_HANDLERS } from "./profile.js";
import { RECORDINGS_HANDLERS } from "./recordings.js";
import { errorResult, ToolInputError, type ToolHandler, type ToolResult } from "./results.js";
import { USERS_HANDLERS } from "./users.js";

function mergeHandlers(maps: Array<Record<string, ToolHandler>>): Record<string, ToolHandler> {
  const merged: Record<string, ToolHandler> = {};
  for (const map of maps) {
    for (const [name, handler] of Object.entries(map)) {
      if (Object.hasOwn(merged, name)) throw new Error(`Duplicate handler for tool "${name}".`);
      merged[name] = handler;
    }
  }
  return merged;
}

const HANDLERS = mergeHandlers([
  CORE_HANDLERS,
  GROUPS_HANDLERS,
  ACCOUNTS_HANDLERS,
  RECORDINGS_HANDLERS,
  USERS_HANDLERS,
  PROFILE_HANDLERS,
  NOTIFICATIONS_HANDLERS,
  DUB_POINTS_HANDLERS,
  OAUTH_HANDLERS,
]);

for (const tool of TOOLS) {
  if (!Object.hasOwn(HANDLERS, tool.name)) {
    throw new Error(`Tool "${tool.name}" has no handler.`);
  }
}

/** `Dubber error (HTTP {status}): {message}`. Built only from the parsed error — never from the request. */
export function describeDubberError(error: DubberError): string {
  let text = `Dubber error (HTTP ${error.statusCode}): ${error.message}`;
  if (error instanceof RateLimitError) text += ` Rate limited; retry after ${error.retryAfter}s.`;
  if (error instanceof AuthenticationError) {
    text += " Check DUBBER_CLIENT_ID/SECRET and DUBBER_AUTH_ID/TOKEN.";
  }
  if (error instanceof ForbiddenError) {
    text += " The credentials may lack access to this account/group.";
  }
  return text;
}

export async function handleToolCall(
  client: DubberClient,
  name: string,
  args: Record<string, unknown>,
  elicitation: ElicitationContext = NO_ELICITATION
): Promise<ToolResult | InputRequiredResult> {
  if (!Object.hasOwn(HANDLERS, name)) {
    return errorResult(`Unknown tool: ${name}`);
  }
  try {
    return await HANDLERS[name](client, args, elicitation);
  } catch (error) {
    if (error instanceof ToolInputError) {
      return errorResult(`Invalid arguments for ${name}: ${error.message}`);
    }
    if (error instanceof DubberError) {
      return errorResult(describeDubberError(error));
    }
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Error calling ${name}: ${message}`);
  }
}
