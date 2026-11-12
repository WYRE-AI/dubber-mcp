/**
 * The only path to the Dubber API.
 *
 * node-dubber's resource classes still build each endpoint's path and query
 * (and validate their params), but every byte goes through the guarded
 * transport below instead of the SDK's own fetch:
 * - the origin is the constant https://api.dubber.net and the region comes
 *   from a fixed allowlist; every built URL is checked to be exactly
 *   `/<region>/v1<path>` on that origin, so a dot-segment or an encoded
 *   separator can never reach another endpoint;
 * - redirect: "manual", and any 3xx is an error (secrets are never re-sent);
 * - response bodies are bounded while streaming (4 MiB);
 * - vendor errors keep the HTTP status, the vendor message and a request id;
 * - no automatic retries, except one token refresh after a 401 on a cached
 *   token, and that at most once per 10 minutes per credential set (Dubber
 *   also answers 401 for "no access to this resource", and caps mints, so a
 *   401 on a token minted for this call, or inside the window, is final);
 * - GET only, with no body: the read-only guarantee lives here, not only in
 *   the handlers (node-dubber's resources also expose write methods). The
 *   token mint is the one POST and calls send() directly.
 *
 * Tokens are cached per credential set and reused for 90% of their lifetime
 * (at most until 30 minutes before expiry). Dubber's Getting Started guide
 * caps tokens at about 500 per 24 h and says to store them, so minting per
 * call is not an option: even its 240 s sample token is reused for 216 s,
 * which keeps continuous use at about 400 mints a day.
 */
import { createHash } from "node:crypto";
import {
  AccountsResource,
  DubberError,
  DubPointsResource,
  GroupsResource,
  NotificationsResource,
  ProfileResource,
  RateLimitError,
  RecordingsResource,
  TokenCache,
  UsersResource,
  parseDubberError,
  type DubberToken,
  type HttpClient,
  type RequestOptions,
} from "@wyre-ai/node-dubber";
import { DUBBER_ORIGIN, MAX_UPSTREAM_BYTES, REQUEST_TIMEOUT_MS } from "./config.js";
import { secretsOf, type DubberCredentials } from "./credentials.js";

/**
 * A DubberError that also carries the vendor's request id and Mashery's own
 * rejection reason (X-Mashery-Error-Code / X-Error-Detail-Header), when sent.
 */
export type DubberApiError = DubberError & { requestId?: string; masheryError?: string };

/** Response headers that may carry a vendor request id (Mashery fronts the API). */
const REQUEST_ID_HEADERS = ["x-request-id", "x-mashery-message-id", "x-amzn-requestid"];

/** Mashery rejects at its own layer with these headers and an HTML or plain-text body. */
const MASHERY_ERROR_HEADERS = ["x-mashery-error-code", "x-error-detail-header"];

/** Refresh margin bounds: a tenth of the token's lifetime, but no more than 30 min and no less than 5 s. */
const MAX_EXPIRY_MARGIN_MS = 30 * 60_000;
const MIN_EXPIRY_MARGIN_MS = 5_000;
/** Dubber's documented token lifetime, used when a mint response omits expires_in. */
const DEFAULT_TOKEN_LIFETIME_S = 24 * 60 * 60;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** At most one 401-triggered re-mint per credential cache entry in this window (Dubber caps mints at ~500/24 h). */
const REMINT_WINDOW_MS = 10 * 60_000;

const tokenCache = new TokenCache();
const inFlight = new Map<string, Promise<DubberToken>>();
/** When each cache entry last re-minted because of a 401. */
const lastRemintAt = new Map<string, number>();

/** Test-only. */
export function clearTokenCache(): void {
  tokenCache.clear();
  inFlight.clear();
  lastRemintAt.clear();
}

/** True, and starts the window, when this cache entry has not re-minted after a 401 in the last 10 minutes. */
function takeRemint(key: string): boolean {
  const now = Date.now();
  const last = lastRemintAt.get(key);
  if (last !== undefined && now - last < REMINT_WINDOW_MS) return false;
  lastRemintAt.set(key, now);
  return true;
}

export function basePath(creds: DubberCredentials): string {
  return `/${creds.region}/v1`;
}

/**
 * Builds the request URL and refuses anything that does not land exactly on
 * `https://api.dubber.net/<region>/v1<path>`. `path` must already carry
 * percent-encoded path parameters (node-dubber encodes them).
 */
export function buildUrl(creds: DubberCredentials, path: string, params?: RequestOptions["params"]): URL {
  const expectedPath = `${basePath(creds)}${path.startsWith("/") ? path : `/${path}`}`;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) query.append(key, String(value));
  }
  const qs = query.toString();
  const url = new URL(`${expectedPath}${qs ? `?${qs}` : ""}`, DUBBER_ORIGIN);
  if (url.origin !== DUBBER_ORIGIN || url.pathname !== expectedPath) {
    throw new DubberError("Refusing to call a path outside the Dubber API.", 0, undefined);
  }
  return url;
}

async function send(url: URL, init: RequestInit): Promise<Response> {
  const label = `${init.method ?? "GET"} ${url.pathname}`;
  let res: Response;
  try {
    res = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new DubberError(
      aborted ? `Dubber API request ${label} timed out.` : `Could not reach the Dubber API for ${label} (network error).`,
      0,
      undefined
    );
  }
  if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
    await res.body?.cancel().catch(() => undefined);
    throw new DubberError(`Dubber API answered ${label} with a redirect (HTTP ${res.status}); refusing to follow it.`, res.status, undefined);
  }
  return res;
}

/** Reads a body as text, cancelling the stream as soon as it exceeds maxBytes. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const tooLarge = () =>
    new DubberError(`Dubber API response exceeded ${maxBytes} bytes; narrow the request.`, res.status, undefined);
  const declared = Number.parseInt(res.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseBody(text: string): unknown {
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Dubber rate-limits with HTTP 403, not 429 (HTTP_Responses: "403 Account
 * Over Rate Limit"; API Error Dictionary: 1021 Queries Per Second Limit,
 * 1022 Account Rate Limit (daily), 1024 Rate Limit Exceeded). Mashery, in
 * front of Dubber, can also answer 403 itself, naming the reason only in
 * headers (ERR_403_DEVELOPER_OVER_QPS / "Over Queries Per Second", or
 * ERR_403_DEVELOPER_OVER_RATE / "Over Rate"). "retry" means wait a few
 * seconds; "daily" means the account's daily quota is used up.
 */
export type RateLimitKind = { kind: "retry" | "daily"; code?: number };

const RETRY_CODES = new Set([1021, 1024]);
const DAILY_CODE = 1022;

function errorCode(body: unknown): number | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const nested = b["error"] && typeof b["error"] === "object" ? (b["error"] as Record<string, unknown>)["code"] : undefined;
  const raw = b["code"] ?? nested;
  const code = typeof raw === "string" ? Number.parseInt(raw, 10) : raw;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

export function rateLimitOf(error: unknown): RateLimitKind | undefined {
  if (error instanceof RateLimitError) return { kind: "retry" };
  if (!(error instanceof DubberError) || error.statusCode !== 403) return undefined;
  const code = errorCode(error.response);
  if (code === DAILY_CODE) return { kind: "daily", code };
  if (code !== undefined && RETRY_CODES.has(code)) return { kind: "retry", code };
  const mashery = (error as DubberApiError).masheryError ?? "";
  if (/OVER_QPS|Over Queries Per Second/i.test(mashery)) return { kind: "retry" };
  if (/OVER_RATE|Over Rate/i.test(mashery)) return { kind: "daily" };
  return /rate limit|per second limit/i.test(error.message) ? { kind: "retry" } : undefined;
}

async function vendorError(res: Response): Promise<DubberApiError> {
  const body = parseBody(await readBounded(res, MAX_ERROR_BODY_BYTES).catch(() => ""));
  const error: DubberApiError = parseDubberError(res.status, body, res.headers);
  const requestId = REQUEST_ID_HEADERS.map((h) => res.headers.get(h)).find((v) => v);
  if (requestId) error.requestId = requestId;
  const mashery = MASHERY_ERROR_HEADERS.map((h) => res.headers.get(h)).filter((v) => v);
  if (mashery.length > 0) error.masheryError = mashery.join(" ");
  return error;
}

function cacheKey(creds: DubberCredentials): string {
  return createHash("sha256")
    .update([creds.region, creds.clientId, creds.clientSecret, creds.authId, creds.authToken].join("\n"))
    .digest("hex");
}

async function mint(creds: DubberCredentials, key: string): Promise<DubberToken> {
  const res = await send(buildUrl(creds, "/token"), {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      username: creds.authId,
      password: creds.authToken,
    }).toString(),
  });
  if (!res.ok) throw await vendorError(res);
  const body = parseBody(await readBounded(res, MAX_ERROR_BODY_BYTES)) as Record<string, unknown> | undefined;
  const accessToken = body?.["access_token"];
  if (typeof accessToken !== "string" || accessToken === "") {
    throw new DubberError("Dubber token endpoint returned no access_token.", res.status, undefined);
  }
  const expiresIn = Number(body?.["expires_in"]);
  const lifetimeMs = (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_TOKEN_LIFETIME_S) * 1000;
  const marginMs = Math.max(MIN_EXPIRY_MARGIN_MS, Math.min(MAX_EXPIRY_MARGIN_MS, lifetimeMs / 10));
  // expiresAt here is when this server stops reusing the token, not Dubber's hard expiry.
  const token: DubberToken = { accessToken, expiresAt: Date.now() + lifetimeMs - marginMs };
  tokenCache.set(key, token);
  return token;
}

/** Cached token until its refresh time (`cached: true`), otherwise one shared mint. */
async function getToken(creds: DubberCredentials): Promise<{ token: DubberToken; cached: boolean }> {
  const key = cacheKey(creds);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return { token: cached, cached: true };
  let pending = inFlight.get(key);
  if (!pending) {
    pending = mint(creds, key).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return { token: await pending, cached: false };
}

/** Values that must never appear in tool output or logs: the credentials and the access token in use. */
export function secretsInUse(creds: DubberCredentials | undefined): string[] {
  if (!creds) return [];
  const token = tokenCache.get(cacheKey(creds))?.accessToken;
  return token ? [...secretsOf(creds), token] : secretsOf(creds);
}

/**
 * The subset of node-dubber's HttpClient that its resource classes call.
 * Only JSON GET requests without a body are allowed, so node-dubber's write
 * methods (recordings.delete, users.delete, ...) fail here before any
 * request. RequestOptions.headers is ignored and responseType "binary" is
 * refused, so a future audio download tool (recordings.download sends
 * Accept: audio/*) needs both added here.
 */
class GuardedHttp {
  constructor(private readonly creds: DubberCredentials) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", params, body, responseType = "json" } = options;
    if (method !== "GET" || body !== undefined) {
      throw new DubberError(`Only GET requests without a body reach the Dubber API; refused ${method} ${path}.`, 0, undefined);
    }
    if (responseType !== "json") throw new DubberError("Binary Dubber responses are not supported.", 0, undefined);
    const url = buildUrl(this.creds, path, params);
    for (let attempt = 0; ; attempt++) {
      const { token, cached } = await getToken(this.creds);
      const res = await send(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: `Bearer ${token.accessToken}` },
      });
      if (res.status === 401 && cached && attempt === 0 && takeRemint(cacheKey(this.creds))) {
        // A cached token may have been revoked or expired early: mint once more, but at most
        // once per 10 minutes, because Dubber answers 401 for plain "no access" too and caps mints.
        // A token minted for this call is kept: its 401 is an access answer.
        await res.body?.cancel().catch(() => undefined);
        tokenCache.delete(cacheKey(this.creds));
        continue;
      }
      if (!res.ok) throw await vendorError(res);
      return parseBody(await readBounded(res, MAX_UPSTREAM_BYTES)) as T;
    }
  }
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  status?: number;
  requestId?: string;
}

/**
 * The client handed to tool handlers: node-dubber's resource classes, plus
 * the guarded `request` for documented endpoints node-dubber does not cover
 * (or covers without their paging params).
 */
export interface DubberApi {
  groups: GroupsResource;
  accounts: AccountsResource;
  recordings: RecordingsResource;
  users: UsersResource;
  profile: ProfileResource;
  notifications: NotificationsResource;
  dubPoints: DubPointsResource;
  request<T>(path: string, options?: RequestOptions): Promise<T>;
  testConnection(): Promise<ConnectionTestResult>;
}

export function createDubberApi(creds: DubberCredentials): DubberApi {
  // node-dubber types the constructor argument as its HttpClient class; the
  // resources only ever call request(), which GuardedHttp implements.
  const guarded = new GuardedHttp(creds);
  const http = guarded as unknown as HttpClient;
  return {
    groups: new GroupsResource(http),
    accounts: new AccountsResource(http),
    recordings: new RecordingsResource(http),
    users: new UsersResource(http),
    profile: new ProfileResource(http),
    notifications: new NotificationsResource(http),
    dubPoints: new DubPointsResource(http),
    request: <T>(path: string, options?: RequestOptions) => guarded.request<T>(path, options),

    /** GET /profile, so a cached token is checked against Dubber too (and re-minted once on a 401). */
    async testConnection() {
      try {
        await guarded.request("/profile");
        return { ok: true };
      } catch (err) {
        if (err instanceof DubberError) {
          const e = err as DubberApiError;
          return {
            ok: false,
            error: e.message,
            ...(e.statusCode ? { status: e.statusCode } : {}),
            ...(e.requestId ? { requestId: e.requestId } : {}),
          };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
