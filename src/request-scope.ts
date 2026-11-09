/**
 * Per-request scope for the HTTP transport. The gateway credentials and the
 * effective tool tiers of one /mcp request live here for exactly the
 * duration of that request, so the MCP server factory and the logger see
 * only that request's values. Nothing is shared between requests.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolTier } from "./config.js";
import type { DubberCredentials } from "./credentials.js";

export interface RequestScope {
  /** Gateway mode: from this request's X-Dubber-* headers. Undefined in env mode. */
  credentials?: DubberCredentials;
  /** Configured tiers narrowed by this request's X-Conduit-Tool-Tiers header. */
  tiers: ReadonlySet<ToolTier>;
}

const store = new AsyncLocalStorage<RequestScope>();

export function runInRequestScope<T>(scope: RequestScope, fn: () => T): T {
  return store.run(scope, fn);
}

export function currentRequestScope(): RequestScope | undefined {
  return store.getStore();
}
