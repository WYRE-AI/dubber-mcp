/**
 * Dubber credentials: the four required values plus a region from the fixed
 * allowlist. There is no base URL: the host is always api.dubber.net.
 */
import { DEFAULT_REGION, DUBBER_REGIONS, isDubberRegion, type DubberRegion } from "./config.js";

export interface DubberCredentials {
  clientId: string;
  clientSecret: string;
  authId: string;
  authToken: string;
  region: DubberRegion;
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
 * success or `{ error }` naming exactly what is wrong. Never echoes a value.
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
  // Absent means the default; present but blank (or a repeated header) is an error, never a silent default.
  const normalizedRegion = region === undefined ? DEFAULT_REGION : region.trim().toLowerCase();
  if (!isDubberRegion(normalizedRegion)) {
    return { error: `Invalid Dubber region (X-Dubber-Region / DUBBER_REGION). Allowed: ${DUBBER_REGIONS.join(", ")}.` };
  }
  return {
    creds: {
      clientId: clientId as string,
      clientSecret: clientSecret as string,
      authId: authId as string,
      authToken: authToken as string,
      region: normalizedRegion,
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

/** Resolve env-mode credentials from DUBBER_* environment variables. Never called in gateway mode. */
export function resolveEnvCredentials(
  env: Record<string, string | undefined> = process.env
): { creds?: DubberCredentials; error?: string } {
  return buildCredentials(
    env.DUBBER_CLIENT_ID?.trim(),
    env.DUBBER_CLIENT_SECRET?.trim(),
    env.DUBBER_AUTH_ID?.trim(),
    env.DUBBER_AUTH_TOKEN?.trim(),
    env.DUBBER_REGION?.trim() || undefined
  );
}

/** Credential values that must never appear in tool output or logs (dubber-api's secretsInUse adds the access token). */
export function secretsOf(creds: DubberCredentials | undefined): string[] {
  return creds ? [creds.clientId, creds.clientSecret, creds.authToken] : [];
}
