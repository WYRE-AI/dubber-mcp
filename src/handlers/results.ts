/** Shared tool-result helpers, the handler signature, and argument validation. */
import { MAX_RESPONSE_CHARS } from "../config.js";
import type { DubberApi } from "../dubber-api.js";
import { redactValue } from "../redact.js";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; mimeType: string; blob: string } };

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * Every domain handler has this shape. Handlers may throw (ToolInputError,
 * DubberError, …): the dispatcher in handlers/index.ts turns every throw
 * into an isError result, so nothing ever escapes to the transport.
 */
export type ToolHandler = (client: DubberApi, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * JSON tool output. Values under credential-named keys are redacted; mcp-server.ts then redacts
 * the credentials in use and truncates anything still over MAX_RESPONSE_CHARS.
 */
export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(redactValue(value), null, 2) }] };
}

/** The note a trimmed list carries; `next` says how to get the rest. */
export function trimNote(kept: number, total: number, next: string): string {
  return `Only the first ${kept} of ${total} items fit the ${MAX_RESPONSE_CHARS}-character response limit. ${next}`;
}

/**
 * JSON output for a result that carries a list under `key`: `{ returned, ...fields, [key]: items }`.
 * Over MAX_RESPONSE_CHARS, items are dropped from the END of the list until it fits (the JSON is
 * never cut, so the paging fields survive), and `onTrim(kept, total)` supplies the fields that
 * change (hasMore, a cursor, a note). One item is always kept; a lone oversized item is truncated
 * as text by mcp-server.ts, after redaction, with the paging fields ahead of it.
 */
export function listResult(
  fields: Record<string, unknown>,
  key: string,
  items: unknown[],
  onTrim: (kept: unknown[], total: number) => Record<string, unknown>
): ToolResult {
  const render = (kept: unknown[], changed: Record<string, unknown> = {}): string =>
    JSON.stringify(redactValue({ returned: kept.length, ...fields, ...changed, [key]: kept }), null, 2);
  const full = render(items);
  if (full.length <= MAX_RESPONSE_CHARS || items.length <= 1) return textResult(full);
  const trimmed = (count: number) => {
    const kept = items.slice(0, count);
    return render(kept, onTrim(kept, items.length));
  };
  // The longest prefix that fits; each try serializes the result once.
  let lo = 1;
  let hi = items.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (trimmed(mid).length <= MAX_RESPONSE_CHARS) lo = mid;
    else hi = mid - 1;
  }
  return textResult(trimmed(lo));
}

export function textResult(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Thrown for invalid tool arguments; the dispatcher maps it to isError. */
export class ToolInputError extends Error {}

export function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`Argument "${key}" is required and must be a non-empty string.`);
  }
  return value;
}

const MAX_ID_LENGTH = 256;

/**
 * A Dubber ID that becomes one URL path segment. Rejects anything that could
 * change which endpoint is hit: empty, `.`, `..`, `/` or `\`, percent-encoded
 * separators or dots, and control characters. node-dubber percent-encodes
 * the returned value, and dubber-api.ts checks the final URL path again.
 */
export function requireId(args: Record<string, unknown>, key: string): string {
  const value = requireString(args, key).trim();
  if (
    value.length > MAX_ID_LENGTH ||
    value === "." ||
    value === ".." ||
    /[/\\]/.test(value) ||
    /%(2f|5c|2e)/i.test(value) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ToolInputError(
      `Argument "${key}" must be a single ID (1-${MAX_ID_LENGTH} characters) without ".", "..", "/", "\\", ` +
        "encoded separators, or control characters."
    );
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ToolInputError(`Argument "${key}" must be a string.`);
  }
  return value;
}

export function optionalInteger(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const num = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isInteger(num)) {
    throw new ToolInputError(`Argument "${key}" must be an integer.`);
  }
  return num;
}

/** Optional integer in [min, max]; ToolInputError otherwise. */
export function optionalIntegerInRange(
  args: Record<string, unknown>,
  key: string,
  min: number,
  max: number
): number | undefined {
  const value = optionalInteger(args, key);
  if (value !== undefined && (value < min || value > max)) {
    throw new ToolInputError(
      `Argument "${key}" must be an integer between ${min} and ${max === Infinity ? "infinity" : max}; got ${value}.`
    );
  }
  return value;
}

export function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Argument "${key}" is required and must be an object.`);
  }
  return value as Record<string, unknown>;
}
