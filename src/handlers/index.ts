/**
 * tools/call dispatch. The SDK client is bound per request by the caller
 * (mcp-server.ts); this module maps tool names to handlers and normalizes
 * every failure into an isError text result — errors are never thrown out.
 *
 * The handler map is merged from the domain modules. A duplicate name, or a
 * tool in TOOLS without a handler, throws at module load so a wiring mistake
 * fails every test instead of surfacing as "Unknown tool" in production.
 */
import { AuthenticationError, DubberError, ForbiddenError, RateLimitError } from "@wyre-ai/node-dubber";
import { rateLimitOf, type DubberApi, type DubberApiError } from "../dubber-api.js";
import { logger } from "../utils/logger.js";
import { TOOLS } from "../tools/index.js";
import { ACCOUNTS_HANDLERS } from "./accounts.js";
import { CORE_HANDLERS } from "./core.js";
import { DUB_POINTS_HANDLERS } from "./dub-points.js";
import { GROUPS_HANDLERS } from "./groups.js";
import { NOTIFICATIONS_HANDLERS } from "./notifications.js";
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
]);

for (const tool of TOOLS) {
  if (!Object.hasOwn(HANDLERS, tool.name)) {
    throw new Error(`Tool "${tool.name}" has no handler.`);
  }
}

const MAX_VENDOR_MESSAGE = 1000;

/**
 * `Dubber error (HTTP {status}): {message}` plus a hint and the vendor
 * request id. Built only from the parsed error — never from the request.
 */
export function describeDubberError(error: DubberApiError): string {
  let text = `Dubber error (HTTP ${error.statusCode}): ${error.message.slice(0, MAX_VENDOR_MESSAGE)}`;
  const rateLimit = rateLimitOf(error);
  const code = rateLimit?.code === undefined ? "" : ` (code ${rateLimit.code})`;
  if (error instanceof RateLimitError) {
    text += ` Rate limited; retry after ${error.retryAfter}s.`;
  } else if (rateLimit?.kind === "daily") {
    text += ` Dubber daily rate limit${code}: this account's quota for today is used up; retrying now will not help.`;
  } else if (rateLimit) {
    text += ` Dubber rate limit${code}: too many requests; retry in a few seconds.`;
  } else if (error instanceof ForbiddenError) {
    text += " The credentials may lack access to this account/group.";
  }
  if (error instanceof AuthenticationError) {
    text +=
      " Dubber answers 401 when either the credentials are wrong (Client ID/Secret, Auth ID/Token) or the token " +
      "has no access to this resource (for example, unidentified dub points need a group-level token).";
  }
  if (error.requestId) text += ` (request id: ${error.requestId})`;
  return text;
}

export async function handleToolCall(
  client: DubberApi,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  if (!Object.hasOwn(HANDLERS, name)) {
    return errorResult(`Unknown tool: ${name}`);
  }
  try {
    return await HANDLERS[name](client, args);
  } catch (error) {
    // Tool name, status and request id only — never arguments or bodies.
    logger.warn("Tool call failed", {
      tool: name,
      errorType: error instanceof Error ? error.constructor.name : typeof error,
      ...(error instanceof DubberError
        ? { status: error.statusCode, requestId: (error as DubberApiError).requestId }
        : {}),
    });
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
