/**
 * Process configuration: tool tiers, AUTH_MODE, the fixed Dubber origin and
 * its region allowlist, and upstream limits. Side-effect free.
 */

/**
 * Every tool in this server is read-only, so `read` is the only tier: there
 * is no write or admin code to enable. DUBBER_TOOL_TIERS=write (or admin)
 * refuses to start. The tier machinery matches the rest of the fleet so
 * Conduit's tier contract behaves the same here.
 */
export type ToolTier = "read";

export const ALL_TIERS: readonly ToolTier[] = ["read"];

export const DEFAULT_TIERS: readonly ToolTier[] = ["read"];

export const TOOL_TIERS_ENV = "DUBBER_TOOL_TIERS";

/** Unset or blank means DEFAULT_TIERS. An unknown entry throws so a typo fails loudly at startup. */
export function parseToolTiers(raw: string | undefined): ReadonlySet<ToolTier> {
  const tiers = new Set<ToolTier>();
  for (const part of (raw ?? "").split(",")) {
    const value = part.trim().toLowerCase();
    if (!value) continue;
    if (!(ALL_TIERS as readonly string[]).includes(value)) {
      throw new Error(`Invalid ${TOOL_TIERS_ENV} entry "${value}". Allowed: ${ALL_TIERS.join(", ")}.`);
    }
    tiers.add(value as ToolTier);
  }
  return tiers.size > 0 ? tiers : new Set(DEFAULT_TIERS);
}

export function configuredTiers(): ReadonlySet<ToolTier> {
  return parseToolTiers(process.env[TOOL_TIERS_ENV]);
}

/**
 * Optional header that narrows (never widens) the enabled tiers for one
 * request. Accepted for fleet parity; Conduit does not send it yet.
 */
export const TOOL_TIERS_HEADER = "x-conduit-tool-tiers";

/**
 * Intersects the configured tiers with a per-request tier header. Unknown or
 * not-configured entries are dropped, so the header can only remove tiers.
 * A present header that names no configured tier (including an empty one)
 * yields an empty set (no tools), not the configured default.
 */
export function narrowTiers(configured: ReadonlySet<ToolTier>, header: string | undefined): ReadonlySet<ToolTier> {
  if (header === undefined) return configured;
  const requested = new Set(
    header
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)
  );
  return new Set(ALL_TIERS.filter((t) => configured.has(t) && requested.has(t)));
}

export type AuthMode = "gateway" | "env";

/** The single AUTH_MODE parser (trimmed, case-insensitive). Unset or blank is `env`; anything else unknown throws. */
export function parseAuthMode(raw: string | undefined): AuthMode {
  const value = (raw ?? "").trim().toLowerCase() || "env";
  if (value !== "gateway" && value !== "env") {
    throw new Error(`AUTH_MODE must be "gateway" or "env" (got "${(raw ?? "").trim()}").`);
  }
  return value;
}

let gatewayLocked = false;

/** Called once the HTTP server starts in gateway mode. Irreversible for the process lifetime. */
export function lockGatewayMode(): void {
  gatewayLocked = true;
}

/** Test-only. */
export function resetGatewayLock(): void {
  gatewayLocked = false;
}

/** Fails closed: an unparseable AUTH_MODE counts as gateway, so env credentials are never used by mistake. */
export function isGatewayMode(): boolean {
  if (gatewayLocked) return true;
  try {
    return parseAuthMode(process.env.AUTH_MODE) === "gateway";
  } catch {
    return true;
  }
}

/** The only host this server ever calls. There is no base-URL setting. */
export const DUBBER_ORIGIN = "https://api.dubber.net";

/**
 * Region path segments on api.dubber.net (`/<region>/v1`). Mirrors Conduit's
 * DUBBER_VALID_REGIONS; the region is checked against this list before it is
 * put into any URL.
 */
export const DUBBER_REGIONS = ["sandbox", "us", "au", "eu", "uk"] as const;
export type DubberRegion = (typeof DUBBER_REGIONS)[number];
export const DEFAULT_REGION: DubberRegion = "sandbox";

export function isDubberRegion(value: string): value is DubberRegion {
  return (DUBBER_REGIONS as readonly string[]).includes(value);
}

/** Upper bound on any upstream response body, enforced while streaming. */
export const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;

/** Per-request upstream timeout. */
export const REQUEST_TIMEOUT_MS = 30_000;
