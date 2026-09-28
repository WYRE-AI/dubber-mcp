/** Shared tool-result helpers, the handler signature, and argument validation. */
import type { InputRequiredResult } from "@modelcontextprotocol/server";
import type { DubberClient } from "@wyre-ai/node-dubber";
import type { ElicitationContext } from "../elicitation.js";

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
export type ToolHandler = (
  client: DubberClient,
  args: Record<string, unknown>,
  elicitation: ElicitationContext
) => Promise<ToolResult | InputRequiredResult>;

export function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
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

export function requireObject(args: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = args[key];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Argument "${key}" is required and must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function optionalObject(
  args: Record<string, unknown>,
  key: string
): Record<string, unknown> | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ToolInputError(`Argument "${key}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

export function requireStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((v) => typeof v === "string")) {
    throw new ToolInputError(`Argument "${key}" is required and must be a non-empty array of strings.`);
  }
  return value as string[];
}
