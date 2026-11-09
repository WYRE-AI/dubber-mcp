/**
 * Shared MCP server factory for Dubber.
 *
 * This module is **side-effect free** (importing it never starts a transport)
 * so it can be reused by every entrypoint. One factory serves BOTH protocol
 * eras via the v2 SDK serving entries: legacy 2025-era clients (classic
 * `initialize` handshake) statelessly per request, and modern 2026-07-28
 * envelope clients natively.
 *
 * `tools/list` returns the enabled tiers' slice of TOOLS (toolsForTiers):
 * deterministic order, the same array for the same tiers, never varied by
 * credentials. A tool outside the enabled tiers is answered exactly like an
 * unknown tool.
 */
import { Server } from "@modelcontextprotocol/server";
import type { McpServerFactory } from "@modelcontextprotocol/server";
import { configuredTiers, isGatewayMode, type ToolTier } from "./config.js";
import { resolveEnvCredentials, type DubberCredentials } from "./credentials.js";
import { createDubberApi, secretsInUse, type DubberApi } from "./dubber-api.js";
import { handleToolCall } from "./handlers/index.js";
import { errorResult, type ToolResult } from "./handlers/results.js";
import { redactText } from "./redact.js";
import { currentRequestScope } from "./request-scope.js";
import { toolsForTiers } from "./tools/index.js";
import { logger } from "./utils/logger.js";
import { VERSION } from "./version.js";

export {
  buildCredentials,
  GATEWAY_HEADERS,
  REQUIRED_GATEWAY_HEADERS,
  resolveEnvCredentials,
  resolveGatewayCredentials,
  type DubberCredentials,
} from "./credentials.js";

export const SERVER_NAME = "dubber-mcp";
export const SERVER_VERSION = VERSION;

/**
 * The McpServerFactory consumed by both transports. The factory runs once
 * per HTTP request (stateless) and once per stdio process.
 *
 * Gateway mode: credentials come ONLY from the request scope, which index.ts
 * fills from this request's X-Dubber-* headers. The process environment is
 * never read. Missing headers are answered 401 by the HTTP layer before
 * serving starts; the factory itself never throws.
 */
export function makeMcpServerFactory(): McpServerFactory {
  return () => {
    const scope = currentRequestScope();
    const tiers = scope?.tiers ?? configuredTiers();
    const credentials = isGatewayMode() ? scope?.credentials : resolveEnvCredentials().creds;
    return createMcpServer(credentials, tiers);
  };
}

function redactResult(result: ToolResult, secrets: string[]): ToolResult {
  return {
    ...result,
    content: result.content.map((c) => (c.type === "text" ? { ...c, text: redactText(c.text, secrets) } : c)),
  };
}

/**
 * Create a fresh MCP server. Credentials may be absent (e.g. env mode
 * without vars): `tools/list` still serves the enabled tools; `tools/call`
 * answers a clear isError result instead of throwing.
 */
export function createMcpServer(
  credentials?: DubberCredentials,
  tiers: ReadonlySet<ToolTier> = configuredTiers()
): Server {
  const server = new Server({ name: SERVER_NAME, version: SERVER_VERSION }, { capabilities: { tools: {} } });
  const tools = toolsForTiers(tiers);
  const enabled = new Set(tools.map((t) => t.name));

  // Built lazily on the first tools/call.
  let client: DubberApi | undefined;

  server.setRequestHandler("tools/list", async () => ({ tools }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: args } = request.params;
    // Tool name only — never arguments or results (recordings carry PII and signed links).
    logger.debug("Tool call received", { tool: name });

    if (!enabled.has(name)) return errorResult(`Unknown tool: ${name}`);
    if (!credentials) {
      return errorResult(
        "Missing Dubber credentials. Send the X-Dubber-Client-Id / X-Dubber-Client-Secret / " +
          "X-Dubber-Auth-Id / X-Dubber-Auth-Token gateway headers, or (env mode) set DUBBER_CLIENT_ID / " +
          "DUBBER_CLIENT_SECRET / DUBBER_AUTH_ID / DUBBER_AUTH_TOKEN."
      );
    }
    client ??= createDubberApi(credentials);

    const result = await handleToolCall(client, name, (args ?? {}) as Record<string, unknown>);
    // The credentials and the access token minted for them (a vendor error may echo either).
    return redactResult(result, secretsInUse(credentials));
  });

  return server;
}
