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
 * - no automatic retries, except one token refresh after a 401.
 *
 * Tokens are cached per credential set for their lifetime (Dubber allows
 * about 500 calls per token per 24 h, so minting per call is not an option).
 */
import { createHash } from "node:crypto";
import {
  AccountsResource,
  DubberError,
  DubPointsResource,
  GroupsResource,
  NotificationsResource,
  ProfileResource,
  RecordingsResource,
  TokenCache,
  UsersResource,
  parseDubberError,
  type DubberToken,
  type HttpClient,
  type RequestOptions,
} from "@wyre-ai/node-dubber";
import { DUBBER_ORIGIN, MAX_UPSTREAM_BYTES, REQUEST_TIMEOUT_MS } from "./config.js";
import type { DubberCredentials } from "./credentials.js";

/** A DubberError that also carries the vendor's request id, when one was sent. */
export type DubberApiError = DubberError & { requestId?: string };

/** Response headers that may carry a vendor request id (Mashery fronts the API). */
const REQUEST_ID_HEADERS = ["x-request-id", "x-mashery-message-id", "x-amzn-requestid"];

const EXPIRY_MARGIN_MS = 30 * 60_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

const tokenCache = new TokenCache();
const inFlight = new Map<string, Promise<DubberToken>>();

/** Test-only. */
export function clearTokenCache(): void {
  tokenCache.clear();
  inFlight.clear();
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

async function vendorError(res: Response): Promise<DubberApiError> {
  const body = parseBody(await readBounded(res, MAX_ERROR_BODY_BYTES).catch(() => ""));
  const error: DubberApiError = parseDubberError(res.status, body, res.headers);
  const requestId = REQUEST_ID_HEADERS.map((h) => res.headers.get(h)).find((v) => v);
  if (requestId) error.requestId = requestId;
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
  const token: DubberToken = {
    accessToken,
    expiresAt: Date.now() + (Number(body?.["expires_in"]) || 0) * 1000,
  };
  tokenCache.set(key, token);
  return token;
}

/** Cached token while still valid (with a margin), otherwise one shared mint. */
async function getToken(creds: DubberCredentials): Promise<DubberToken> {
  const key = cacheKey(creds);
  const cached = tokenCache.get(key);
  if (cached && Date.now() < cached.expiresAt - EXPIRY_MARGIN_MS) return cached;
  let pending = inFlight.get(key);
  if (!pending) {
    pending = mint(creds, key).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  return pending;
}

/** The subset of node-dubber's HttpClient that its resource classes call. */
class GuardedHttp {
  constructor(private readonly creds: DubberCredentials) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = "GET", params, body, responseType = "json" } = options;
    if (responseType !== "json") throw new DubberError("Binary Dubber responses are not supported.", 0, undefined);
    const url = buildUrl(this.creds, path, params);
    for (let attempt = 0; ; attempt++) {
      const token = await getToken(this.creds);
      const res = await send(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          Authorization: `Bearer ${token.accessToken}`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        // The cached token may have been revoked or expired early: mint once more.
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
}

/** The client handed to tool handlers. Same resource surface as node-dubber's DubberClient. */
export interface DubberApi {
  groups: GroupsResource;
  accounts: AccountsResource;
  recordings: RecordingsResource;
  users: UsersResource;
  profile: ProfileResource;
  notifications: NotificationsResource;
  dubPoints: DubPointsResource;
  testConnection(): Promise<ConnectionTestResult>;
  revokeToken(): Promise<void>;
}

export function createDubberApi(creds: DubberCredentials): DubberApi {
  // node-dubber types the constructor argument as its HttpClient class; the
  // resources only ever call request(), which GuardedHttp implements.
  const http = new GuardedHttp(creds) as unknown as HttpClient;
  return {
    groups: new GroupsResource(http),
    accounts: new AccountsResource(http),
    recordings: new RecordingsResource(http),
    users: new UsersResource(http),
    profile: new ProfileResource(http),
    notifications: new NotificationsResource(http),
    dubPoints: new DubPointsResource(http),

    async testConnection() {
      try {
        await getToken(creds);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    /** Dubber's `POST /revoke` (RFC 7009 shape; see node-dubber's revokeToken). */
    async revokeToken() {
      const token = await getToken(creds);
      const res = await send(buildUrl(creds, "/revoke"), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: token.accessToken,
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
        }).toString(),
      });
      if (!res.ok) throw await vendorError(res);
      await res.body?.cancel().catch(() => undefined);
      tokenCache.delete(cacheKey(creds));
    },
  };
}
