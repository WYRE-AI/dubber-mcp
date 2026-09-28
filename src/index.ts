#!/usr/bin/env node
/**
 * Dubber MCP server — flat tool surface over groups, accounts, recordings,
 * users, profile, notifications (REST hooks), Dub.Point, and OAuth.
 *
 * Transports:
 * - stdio (default): local Claude Desktop / CLI usage. `serveStdio` owns the
 *   era decision: a 2025-era `initialize` pins the connection legacy; modern
 *   2026-07-28 envelope openings are served natively.
 * - http: hosted deployment. `createMcpHandler({ legacy: 'stateless' })` is
 *   the dual-era posture — 2025-era traffic answered per-request statelessly,
 *   modern envelope traffic natively. NEVER `legacy: 'reject'`.
 *
 * Credentials via environment variables (env mode):
 * - DUBBER_CLIENT_ID / DUBBER_CLIENT_SECRET (required; Mashery app key/secret)
 * - DUBBER_AUTH_ID / DUBBER_AUTH_TOKEN (required; Dubber portal API tab)
 * - DUBBER_REGION (optional; default "sandbox")
 * - DUBBER_BASE_URL (optional; env mode only, overrides region)
 * Or via gateway headers (AUTH_MODE=gateway):
 * - X-Dubber-Client-Id / X-Dubber-Client-Secret (required)
 * - X-Dubber-Auth-Id / X-Dubber-Auth-Token (required)
 * - X-Dubber-Region (optional; default "sandbox")
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  GATEWAY_HEADERS,
  REQUIRED_GATEWAY_HEADERS,
  SERVER_VERSION,
  createMcpServer,
  makeMcpServerFactory,
  resolveEnvCredentials,
  resolveGatewayCredentials,
} from "./mcp-server.js";
import { logger } from "./utils/logger.js";
import { verifyS2sHeader, S2S_HEADER } from "./s2s-verify.js";

const S2S_SECRET = process.env.CONDUIT_S2S_SECRET || "";

const CORS_ALLOW_HEADERS = [
  "Content-Type",
  "Accept",
  "Authorization",
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  ...GATEWAY_HEADERS,
].join(", ");

/** stdio (default). Fresh server per process; env-mode credentials. */
function startStdioTransport(): void {
  serveStdio(() => createMcpServer(resolveEnvCredentials().creds), {
    onerror: (error) => logger.error("stdio serving error", { error: error.message }),
  });
  logger.info("Dubber MCP server running on stdio");
}

async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const isGatewayMode = process.env.AUTH_MODE === "gateway";

  const mcpHandler = createMcpHandler(makeMcpServerFactory({ gatewayMode: isGatewayMode }), {
    legacy: "stateless",
    onerror: (error) => logger.error("MCP serving error", { error: error.message }),
  });
  const handleMcpRequest = toNodeHandler(mcpHandler, {
    onerror: (error) => logger.error("MCP request adapter error", { error: error.message }),
  });

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS for claude.ai custom connectors — set on every response, before routing.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS, DELETE");
    res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
    res.setHeader("Access-Control-Max-Age", "86400");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // Health endpoint — shallow, unauthenticated liveness probe. Must NOT
    // touch credentials or any upstream: in gateway mode credentials only
    // arrive per-request via headers, so a credential check here would
    // always fail and crash-loop the container.
    if (url.pathname === "/health" || url.pathname === "/healthz") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          version: SERVER_VERSION,
          mcpTransport: "http",
          authMode: isGatewayMode ? "gateway" : "env",
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    if (S2S_SECRET && !verifyS2sHeader(req.headers[S2S_HEADER] as string | undefined, S2S_SECRET)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
        })
      );
      return;
    }

    if (url.pathname === "/mcp") {
      // 401 gate: reject unauthenticated gateway traffic BEFORE serving —
      // falling through to env-configured credentials would serve the
      // operator's tenant data to whoever asked (cross-tenant leak).
      if (isGatewayMode) {
        const { error } = resolveGatewayCredentials(
          (name) => req.headers[name] as string | undefined
        );
        if (error) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: {
                code: -32001,
                message: `Unauthorized: ${error}`,
                data: { required: REQUIRED_GATEWAY_HEADERS },
              },
              id: null,
            })
          );
          return;
        }
      }

      // Per-request credential binding happens inside the factory (it reads
      // the gateway headers from ctx.requestInfo on every request).
      await handleMcpRequest(req, res);
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found", endpoints: ["/mcp", "/health"] }));
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      logger.info(`Dubber MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env"}`);
      resolve();
    });
  });

  const shutdown = async () => {
    logger.info("Shutting down Dubber MCP server...");
    await mcpHandler.close();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const transportType = process.env.MCP_TRANSPORT || "stdio";
  logger.info("Starting Dubber MCP server", {
    transport: transportType,
    nodeVersion: process.version,
  });

  if (transportType === "http") {
    await startHttpTransport();
  } else {
    startStdioTransport();
  }
}

main().catch((error) => {
  logger.error("Fatal startup error", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
