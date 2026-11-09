/**
 * Stderr-only logger. stdout is reserved for the MCP JSON-RPC channel in
 * stdio mode, so every log line goes to stderr regardless of transport.
 *
 * Every line is redacted as a whole (message and metadata): the env-mode
 * credentials, the S2S secret, the per-request gateway credentials in scope
 * and their access token, bearer tokens, and signed-URL signatures.
 */
import { secretsInUse } from "../dubber-api.js";
import { redactLogText } from "../redact.js";
import { currentRequestScope } from "../request-scope.js";

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): number {
  const raw = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
  return LEVELS[raw] ?? LEVELS.info;
}

function knownSecrets(): (string | undefined)[] {
  const env = process.env;
  return [
    env.CONDUIT_S2S_SECRET?.trim(),
    env.DUBBER_CLIENT_ID?.trim(),
    env.DUBBER_CLIENT_SECRET?.trim(),
    env.DUBBER_AUTH_TOKEN?.trim(),
    ...secretsInUse(currentRequestScope()?.credentials),
  ];
}

function write(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < currentLevel()) return;
  const line = JSON.stringify({
    level,
    message,
    ...(meta ?? {}),
    timestamp: new Date().toISOString(),
  });
  process.stderr.write(`${redactLogText(line, knownSecrets())}\n`);
}

export const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => write("debug", message, meta),
  info: (message: string, meta?: Record<string, unknown>) => write("info", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write("warn", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write("error", message, meta),
};
