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
 *
 * HTTP transport refuses to start unless CONDUIT_S2S_SECRET is set to a
 * value that is not a known placeholder. MCP_ALLOW_INSECURE_DEV=1 is a
 * local-only escape hatch for an empty secret: it logs a warning, does not
 * enforce X-Gateway-S2S, and listens on 127.0.0.1 only. A configured secret
 * honors MCP_HTTP_HOST (default 0.0.0.0 when unset). /health and /healthz
 * stay unauthenticated and do not read credentials. stdio does not use S2S.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
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

/**
 * Public example values. A copied placeholder must not verify as a real secret,
 * including when MCP_ALLOW_INSECURE_DEV=1 is also set.
 */
const KNOWN_PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-real-secret",
  "your-s2s-secret",
  "your-secret",
  "changeme",
  "change-me",
  "placeholder",
  "secret",
  "example",
  "replace-me",
  "s2s-secret",
]);

const LOOPBACK_HOST = "127.0.0.1";

const MISSING_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is empty. " +
  "Set CONDUIT_S2S_SECRET to the gateway-provisioned secret (openssl rand -hex 32), " +
  "or set MCP_ALLOW_INSECURE_DEV=1 for local development only.";

const PLACEHOLDER_S2S_SECRET_ERROR =
  "Refusing to start HTTP transport: CONDUIT_S2S_SECRET is a known placeholder. " +
  "Generate a secret with `openssl rand -hex 32` and set CONDUIT_S2S_SECRET to that value.";

const INSECURE_DEV_WARNING =
  "SECURITY WARNING: CONDUIT_S2S_SECRET is empty and MCP_ALLOW_INSECURE_DEV=1. " +
  "HTTP /mcp is starting with service-to-service authentication DISABLED, bound to 127.0.0.1 only. " +
  "Local development only; do not expose this port.";

const S2S_UNAUTHORIZED = {
  error:
    "Missing or invalid X-Gateway-S2S header: this endpoint only accepts requests signed by the gateway.",
};

function refuseStart(message: string): never {
  logger.error(message);
  process.exit(1);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 127.0.0.1, the rest of 127.0.0.0/8, localhost, and ::1. */
function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[(.+)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  const bare = normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
  const parts = bare.split(".");
  if (parts.length !== 4) return false;
  if (parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return false;
  return parts[0] === "127";
}

/**
 * Fail closed. A known placeholder is never a configured secret, including
 * when MCP_ALLOW_INSECURE_DEV=1 is also set. Empty is the only case the dev
 * flag may bypass, and that bypass does not check X-Gateway-S2S.
 * The secret value is never written to logs.
 */
function resolveHttpS2sSecret(): { secret: string; insecureDev: boolean } {
  const raw = (process.env.CONDUIT_S2S_SECRET ?? "").trim();
  if (raw && KNOWN_PLACEHOLDER_SECRETS.has(raw.toLowerCase())) {
    refuseStart(PLACEHOLDER_S2S_SECRET_ERROR);
  }
  if (raw) return { secret: raw, insecureDev: false };
  if (process.env.MCP_ALLOW_INSECURE_DEV === "1") {
    return { secret: "", insecureDev: true };
  }
  refuseStart(MISSING_S2S_SECRET_ERROR);
}

/**
 * No real secret: force 127.0.0.1, even when MCP_HTTP_HOST is a wider address
 * such as the image default 0.0.0.0. A configured secret honors MCP_HTTP_HOST;
 * unset stays 0.0.0.0 so existing container deploys keep their bind.
 */
function resolveBindHost(s2sSecret: string): string {
  const configured = (process.env.MCP_HTTP_HOST ?? "").trim();
  if (s2sSecret) return configured || "0.0.0.0";
  if (configured && !isLoopbackBindHost(configured)) {
    logger.error(
      `WARNING: MCP_HTTP_HOST=${configured} is not a loopback address. ` +
        "MCP_ALLOW_INSECURE_DEV=1 without CONDUIT_S2S_SECRET cannot listen there. " +
        `Binding ${LOOPBACK_HOST} only.`
    );
  }
  return LOOPBACK_HOST;
}

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

export async function startHttpTransport(): Promise<HttpServer> {
  const { secret: s2sSecret, insecureDev } = resolveHttpS2sSecret();
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = resolveBindHost(s2sSecret);
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

    // Empty s2sSecret is only reachable when MCP_ALLOW_INSECURE_DEV=1; startup
    // refuses otherwise. A configured secret is always enforced, before any
    // credential extraction.
    if (s2sSecret && !verifyS2sHeader(headerValue(req.headers[S2S_HEADER]), s2sSecret)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify(S2S_UNAUTHORIZED));
      return;
    }

    if (url.pathname === "/mcp") {
      // 401 gate: reject unauthenticated gateway traffic BEFORE serving —
      // falling through to env-configured credentials would serve the
      // operator's tenant data to whoever asked (cross-tenant leak).
      // Blank or repeated headers count as missing.
      if (isGatewayMode) {
        const { error } = resolveGatewayCredentials((name) => headerValue(req.headers[name]));
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

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    httpServer.once("error", onError);
    httpServer.listen(port, host, () => {
      httpServer.off("error", onError);
      if (insecureDev) {
        // error level so a raised LOG_LEVEL cannot hide the bypass.
        // Logged only after the loopback bind is accepted.
        logger.error(INSECURE_DEV_WARNING);
      }
      logger.info(`Dubber MCP server listening on http://${host}:${port}/mcp`);
      logger.info(`Health check available at http://${host}:${port}/health`);
      logger.info(`Authentication mode: ${isGatewayMode ? "gateway (header-based)" : "env"}`);
      resolve();
    });
  });

  let handlerClosed = false;
  const closeHandler = async () => {
    if (handlerClosed) return;
    handlerClosed = true;
    await mcpHandler.close();
  };
  httpServer.on("close", () => {
    void closeHandler().catch((error) => {
      logger.error("Error closing MCP handler", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });

  if (process.env.VITEST !== "true") {
    const shutdown = async () => {
      logger.info("Shutting down Dubber MCP server...");
      await closeHandler();
      if (httpServer.listening) {
        await new Promise<void>((resolve, reject) => {
          httpServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
      process.exit(0);
    };
    const onSignal = () => {
      void shutdown().catch((error) => {
        logger.error("Shutdown error", {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
  }

  return httpServer;
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

// Vitest imports this module to call startHttpTransport. Skip the CLI
// entrypoint there. `node dist/index.js` still starts stdio or HTTP.
if (process.env.VITEST !== "true") {
  main().catch((error) => {
    logger.error("Fatal startup error", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exit(1);
  });
}
