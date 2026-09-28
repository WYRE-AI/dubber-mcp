/**
 * Shared MCP server factory for Dubber.
 *
 * This module is **side-effect free** (importing it never starts a transport)
 * so it can be reused by every entrypoint. One factory serves BOTH protocol
 * eras via the v2 SDK serving entries: legacy 2025-era clients (classic
 * `initialize` handshake) statelessly per request, and modern 2026-07-28
 * envelope clients natively.
 *
 * Statelessness is a protocol invariant here: `tools/list` returns the same
 * module-scope TOOLS array (by reference, deterministic order) for every
 * caller, every era, every request. No sessions, no per-user variance.
 */
import { Server } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { DubberClient, DEFAULT_REGION } from "@wyre-ai/node-dubber";
import { handleToolCall } from "./handlers/index.js";
import { errorResult } from "./handlers/results.js";
import { TOOLS } from "./tools/index.js";
import { logger } from "./utils/logger.js";

export const SERVER_NAME = "dubber-mcp";
export const SERVER_VERSION = "1.0.0";

export interface DubberCredentials {
  clientId: string;
  clientSecret: string;
  authId: string;
  authToken: string;
  /** Default {@link DEFAULT_REGION} ("sandbox") when unset. */
  region?: string;
  /**
   * Env mode only. Never read from a header: a caller-chosen base URL would
   * make the server send client secrets to (and fetch from) any host.
   */
  baseUrl?: string;
}

/** Exact gateway header names — lowercased by Node on receipt. */
export const GATEWAY_HEADERS = [
  "X-Dubber-Client-Id",
  "X-Dubber-Client-Secret",
  "X-Dubber-Auth-Id",
  "X-Dubber-Auth-Token",
  "X-Dubber-Region",
] as const;

export const REQUIRED_GATEWAY_HEADERS = [
  "X-Dubber-Client-Id",
  "X-Dubber-Client-Secret",
  "X-Dubber-Auth-Id",
  "X-Dubber-Auth-Token",
] as const;

/**
 * Build validated credentials from raw values. Returns `{ creds }` on
 * success or `{ error }` naming exactly what is wrong. Shared by every
 * transport (env vars, Node HTTP gateway headers).
 */
export function buildCredentials(
  clientId: string | undefined,
  clientSecret: string | undefined,
  authId: string | undefined,
  authToken: string | undefined,
  region?: string
): { creds?: DubberCredentials; error?: string } {
  const missing: string[] = [];
  if (!clientId) missing.push("X-Dubber-Client-Id");
  if (!clientSecret) missing.push("X-Dubber-Client-Secret");
  if (!authId) missing.push("X-Dubber-Auth-Id");
  if (!authToken) missing.push("X-Dubber-Auth-Token");
  if (missing.length > 0) {
    return {
      error:
        `Missing credentials: ${missing.join(", ")} ` +
        "(or DUBBER_CLIENT_ID / DUBBER_CLIENT_SECRET / DUBBER_AUTH_ID / DUBBER_AUTH_TOKEN in env mode)",
    };
  }
  return {
    creds: {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      authId: authId as string,
      authToken: authToken as string,
      region: region || DEFAULT_REGION,
    },
  };
}

/** Resolve per-request gateway credentials from a (lowercased) header accessor. */
export function resolveGatewayCredentials(
  getHeader: (lowerName: string) => string | undefined
): { creds?: DubberCredentials; error?: string } {
  return buildCredentials(
    getHeader("x-dubber-client-id"),
    getHeader("x-dubber-client-secret"),
    getHeader("x-dubber-auth-id"),
    getHeader("x-dubber-auth-token"),
    getHeader("x-dubber-region")
  );
}

/** Resolve env-mode credentials from DUBBER_* environment variables. */
export function resolveEnvCredentials(
  env: Record<string, string | undefined> = process.env
): { creds?: DubberCredentials; error?: string } {
  const result = buildCredentials(
    env.DUBBER_CLIENT_ID,
    env.DUBBER_CLIENT_SECRET,
    env.DUBBER_AUTH_ID,
    env.DUBBER_AUTH_TOKEN,
    env.DUBBER_REGION
  );
  if (result.creds && env.DUBBER_BASE_URL) result.creds.baseUrl = env.DUBBER_BASE_URL;
  return result;
}

/**
 * Bind createMcpServer into the McpServerFactory shape the v2 HTTP serving
 * entry (createMcpHandler) consumes. The factory runs once per HTTP request —
 * the fresh-instance-per-request stateless idiom — for BOTH protocol eras.
 *
 * In gateway mode the request's headers are read from ctx.requestInfo,
 * keeping credentials bound per request. Missing headers are answered 401 by
 * the HTTP layer BEFORE serving ever starts — the factory itself never
 * throws (a throwing factory would surface as a 500).
 */
export function makeMcpServerFactory(options: { gatewayMode: boolean }): McpServerFactory {
  return (ctx) => {
    if (options.gatewayMode) {
      const { creds } = resolveGatewayCredentials(
        (name) => ctx.requestInfo?.headers.get(name) ?? undefined
      );
      return createMcpServer(creds);
    }
    const { creds } = resolveEnvCredentials();
    return createMcpServer(creds);
  };
}

// ── Pure request-handler bodies (exported for tests) ───────────────────────

export function listToolsResult(): { tools: typeof TOOLS } {
  // By reference, never rebuilt/sorted/filtered — deterministic for every caller.
  return { tools: TOOLS };
}

/**
 * Create a fresh MCP server. Called once for stdio, per-request for HTTP.
 * Credentials may be absent (e.g. env mode without vars): `tools/list` still
 * serves the full deterministic surface; `tools/call` answers a clear
 * isError result instead of throwing.
 */
export function createMcpServer(credentials?: DubberCredentials): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  // Built lazily on the first tools/call.
  let client: DubberClient | undefined;

  server.setRequestHandler("tools/list", async () => listToolsResult());

  server.setRequestHandler("tools/call", async (request, ctx) => {
    const { name, arguments: args } = request.params;
    // Tool name only — never arguments or results (recordings may carry PII).
    logger.debug("Tool call received", { tool: name });

    if (!credentials) {
      return errorResult(
        "Missing Dubber credentials. Set DUBBER_CLIENT_ID / DUBBER_CLIENT_SECRET / " +
          "DUBBER_AUTH_ID / DUBBER_AUTH_TOKEN (env mode) or send the X-Dubber-Client-Id / " +
          "X-Dubber-Client-Secret / X-Dubber-Auth-Id / X-Dubber-Auth-Token gateway headers."
      );
    }
    try {
      client ??= new DubberClient(credentials);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(`Invalid Dubber credentials: ${message}`);
    }

    return handleToolCall(client, name, (args ?? {}) as Record<string, unknown>, {
      clientCapabilities: server.getClientCapabilities(),
      inputResponses: ctx.mcpReq.inputResponses,
    });
  });

  return server;
}
