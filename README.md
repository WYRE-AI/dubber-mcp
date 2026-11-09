# dubber-mcp

MCP server for [Dubber](https://developer.dubber.net/) — call recording upload/retrieval,
compliance metadata and tags, group/account/user management, REST-hook (webhook)
notifications, and Dub.Point telecom-system (e.g. BroadWorks) integration.

Built on the MCP **2026-07-28** spec via the split v2 SDK
(`@modelcontextprotocol/server` / `/node` / `/client` `^2.0.0-beta.5`) with **dual-era
serving**: one shared `McpServerFactory` behind `createMcpHandler({ legacy: 'stateless' })`
answers both 2025-era `initialize`-handshake clients (the WYRE gateway today) and modern
2026-07-28 envelope clients, with the same deterministic tool surface for every caller.
Ships as a GHCR container only (no MCPB bundle). Endpoint paths come from
[`@wyre-ai/node-dubber`](https://github.com/WYRE-AI/node-dubber); every request goes
through this server's own guarded transport (see [Security](#security)).

## Tool tiers

Each tool has a tier, derived from its annotations the same way Conduit derives it:
`destructiveHint` → `admin`, `readOnlyHint` → `read`, anything else → `write`.

| `DUBBER_TOOL_TIERS` | Tools |
|---|---|
| `read` (default, and the image default) | 16 read-only tools |
| `read,write` | 32 |
| `read,write,admin` | all 37 |

Conduit's `X-Conduit-Tool-Tiers` request header can only narrow this set. An empty header
means no tools. A tool outside the enabled tiers is answered as `Unknown tool`.

`dubber_recordings_get_upload_target` is a GET, but its result is a credential to upload
audio, so it is `write` tier.

## Tools (37, flat)

- **Core**: `dubber_test_connection`.
- **Groups**: `dubber_groups_get`, `dubber_groups_create_child`,
  `dubber_groups_list_unidentified_recordings`, `dubber_groups_create_unidentified_recording`.
- **Accounts**: `dubber_accounts_create`, `dubber_accounts_get`, `dubber_accounts_update`.
- **Recordings**: `dubber_recordings_list`, `dubber_recordings_create`, `dubber_recordings_get`,
  `dubber_recordings_get_waveform`, `dubber_recordings_update_metadata`,
  `dubber_recordings_add_tags`, `dubber_recordings_initiate_multipart_upload`,
  `dubber_recordings_get_upload_target`, `dubber_recordings_complete_upload`.
  Gated: `dubber_recordings_delete` (⚠ DESTRUCTIVE), `dubber_recordings_delete_tags`
  (⚠ HIGH-IMPACT).
  `dubber_recordings_list` lists newest first with `limit` (1–500, default 100), `offset`,
  `cursor`, `query`, `dubPointId`/`teamId`, and a `start_time` window — see
  [Listing recordings](#listing-recordings-and-time-windows).
  `dubber_recordings_get` returns a recording link when given `listener` — see
  [Recording links](#recording-links).
- **Users**: `dubber_users_list`, `dubber_users_create`, `dubber_users_get`,
  `dubber_users_update`. Gated: `dubber_users_delete` (⚠ DESTRUCTIVE).
- **Profile**: `dubber_profile_get`.
- **Notifications** (REST hooks): `dubber_notifications_list`, `dubber_notifications_create`,
  `dubber_notifications_get`, `dubber_notifications_update`, `dubber_notifications_activate`,
  `dubber_notifications_list_unclaimed`. Gated: `dubber_notifications_delete` (⚠ HIGH-IMPACT).
- **Dub.Point**: `dubber_dub_points_list`, `dubber_dub_points_create`, `dubber_dub_points_get`,
  `dubber_dub_points_find`.
- **OAuth**: gated `dubber_oauth_revoke_token` (⚠ HIGH-IMPACT).

## Credentials

Four values, all required — none of them a human login (see "Vendor quirks" below).

| Env var (env mode) | Gateway header (`AUTH_MODE=gateway`) | Source |
|---|---|---|
| `DUBBER_CLIENT_ID` | `X-Dubber-Client-Id` | Mashery application key (developer.dubber.net) |
| `DUBBER_CLIENT_SECRET` | `X-Dubber-Client-Secret` | Mashery application secret |
| `DUBBER_AUTH_ID` | `X-Dubber-Auth-Id` | Dubber portal → API tab |
| `DUBBER_AUTH_TOKEN` | `X-Dubber-Auth-Token` | Dubber portal → API tab |
| `DUBBER_REGION` (optional, default `sandbox`) | `X-Dubber-Region` | `sandbox`, `us`, `au`, `eu`, or `uk`: selects `api.dubber.net/<region>/v1` |

There is no base-URL setting: the host is always `https://api.dubber.net`, and any other
region value is rejected (a `401` in gateway mode). In gateway mode a request missing any of
the four required headers is answered `401` (JSON-RPC error `-32001`) before the MCP handler
runs. Gateway mode never reads `DUBBER_*` from the environment. Blank or repeated header
values count as missing.

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio
transport does not use `CONDUIT_S2S_SECRET`.

| Variable | Required | Description |
|---|---|---|
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty, a known placeholder (`changeme`, `secret`, `replace-me`, `replace-with-a-real-secret`, and the other example values), shorter than 32 characters, or a repeated pattern. Generate one with `openssl rand -hex 32`. Compose will not start without it. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored and the override is logged. A known placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps `0.0.0.0`, the historical container bind. The image and Compose set `0.0.0.0` inside the container. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose) or `env`. Gateway mode requires the four `X-Dubber-*` credential headers on each `/mcp` request and never falls back to `DUBBER_*`. `env` uses those variables only after S2S auth succeeds, and HTTP refuses to start in `env` mode without them. Unset means `env` (stdio and single-tenant HTTP outside the image). Any other value refuses to start. |
| `DUBBER_TOOL_TIERS` | No | Comma-separated tiers: `read` (default), `write`, `admin`. See [Tool tiers](#tool-tiers). An unknown entry refuses to start. |

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every request except `/health` and
`/healthz` must include `X-Gateway-S2S`. The check is `verifyS2sHeader` in
[`src/s2s-verify.ts`](src/s2s-verify.ts): the header value is `t=<unix seconds>,v1=<hex>`,
where the hex is HMAC-SHA256 of the literal string `t=<unix seconds>` keyed with
`CONDUIT_S2S_SECRET` (64 lowercase hex characters). The timestamp must be within 300
seconds of the server clock. A missing or invalid header is HTTP 401, before vendor
credentials are read.

```bash
TS=$(date +%s)
SIG=$(printf 't=%s' "$TS" | openssl dgst -sha256 -hmac "$CONDUIT_S2S_SECRET" -hex | awk '{print $NF}')
curl -sS http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "X-Gateway-S2S: t=${TS},v1=${SIG}" \
  -H "X-Dubber-Client-Id: $DUBBER_CLIENT_ID" \
  -H "X-Dubber-Client-Secret: $DUBBER_CLIENT_SECRET" \
  -H "X-Dubber-Auth-Id: $DUBBER_AUTH_ID" \
  -H "X-Dubber-Auth-Token: $DUBBER_AUTH_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

In `AUTH_MODE=gateway`, `/mcp` also requires `X-Dubber-Client-Id`, `X-Dubber-Client-Secret`,
`X-Dubber-Auth-Id`, and `X-Dubber-Auth-Token` (`X-Dubber-Region` is optional). Those headers
are the only credential source for that request. `AUTH_MODE=env` still requires the signed
`X-Gateway-S2S` header, then uses `DUBBER_*` from the environment.

## Running

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages auth for @wyre-ai/*
npm install
npm run build
node dist/index.js                        # stdio (default)
# HTTP refuses to start until CONDUIT_S2S_SECRET is set
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" MCP_TRANSPORT=http node dist/index.js
# Local HTTP only, without a service-to-service secret (always binds 127.0.0.1)
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 node dist/index.js
npm run smoke                             # proves both protocol eras serve the same tools
```

Docker (linux/amd64 per fleet law). The image listens on `0.0.0.0` inside the container
(`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=gateway`. Publish the port on loopback and
pass a real S2S secret. In gateway mode, Dubber credentials arrive on each request as
headers; they are not read from the environment.

```bash
# GitHub Packages auth is a BuildKit secret, never a build arg or image layer.
printf '@wyre-ai:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$(gh auth token)" > /tmp/dubber.npmrc
docker build --platform linux/amd64 --secret id=npmrc,src=/tmp/dubber.npmrc -t dubber-mcp .
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -p 127.0.0.1:8080:8080 \
  dubber-mcp
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset. The gateway service sets
`AUTH_MODE=gateway`, does not inject `DUBBER_CLIENT_ID`, `DUBBER_CLIENT_SECRET`,
`DUBBER_AUTH_ID`, or `DUBBER_AUTH_TOKEN`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

Single-tenant HTTP (`AUTH_MODE=env`) still requires the S2S secret, then uses the
`DUBBER_*` variables. It is separate from the gateway Compose service above.

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=env \
  -e DUBBER_CLIENT_ID=... -e DUBBER_CLIENT_SECRET=... \
  -e DUBBER_AUTH_ID=... -e DUBBER_AUTH_TOKEN=... \
  -p 127.0.0.1:8080:8080 \
  dubber-mcp
```

## Elicitation and destructive-action consent

Every gated tool asks before acting. Elicitation rides the SDK v2 MRTR seam: handlers
return `input_required` results that 2026-07-28 clients fulfil and retry, and that the
SDK's legacy shim fulfils server-side for 2025-era stateful connections (stdio). All reads
and the confirmation happen before the single mutating Dubber call.

Callers that cannot be prompted (including stateless legacy HTTP requests, which is how the
WYRE Conduit gateway connects) fail closed: gated tools refuse to run unless the call passes
`"confirm_destructive_action": true`. That argument is consulted only when no prompt is
possible and never skips a confirmation an interactive user would have seen.

## Listing recordings and time windows

Dubber's recordings endpoint has only `count` (max 100), `page` (max 5 pages), a `before_id`
cursor and `query` — no `limit`/`offset` and no date filter, and it silently ignores unknown
params. `dubber_recordings_list` therefore pages Dubber itself (`count=100`, chaining
`before_id`) and applies the rest server-side:

- `limit` (1–500, default 100): max matching recordings returned. `offset` (≥0): matching
  recordings (newest first) to skip.
- `startTimeFrom` (inclusive) / `startTimeTo` (exclusive for date-times; a date-only value
  includes the whole day): ISO 8601, no offset = UTC. They filter on each recording's
  `start_time` after fetching; recordings with an unparseable `start_time` are excluded and
  counted in `excludedUnparseableStartTime`. Weekly pull in Melbourne daylight time (AEDT, +11:00), Mon–Fri:
  `startTimeFrom=2026-10-19T00:00:00+11:00`, `startTimeTo=2026-10-24T00:00:00+11:00`, `limit=500`.
- `dubPointId` / `teamId` (optional, trimmed, non-empty; sent as Dubber's `dub_point` / `team` on
  every page request and echoed in `filters`): one dub point or one team per call — Dubber
  forbids combining them, so passing both is an error. Dubber has no direct user filter on
  recordings: for one technician's week, find their dub point id(s) with `dubber_dub_points_list`
  (each dub point's `user` is a URL ending in `/users/<USER_ID>`), then call once per dub point.
  A `cursor` must be reused with the SAME `dubPointId`/`teamId`.
- Each call makes at most 25 Dubber requests (2,500 recordings scanned). If that cap or
  `limit` stops the scan early, `hasMore` is true and `nextCursor` is set: call again with
  `cursor=<nextCursor>`, `offset=<remainingOffset>` (0 unless the scan cap hit while still
  skipping) and the same filters to continue with no gaps or duplicates.
  `scanCapReached` says whether the cap was the reason. With `startTimeFrom` set, the scan
  stops once a whole page of recordings starts before it.
- Result: `{ recordings, returned, hasMore, nextCursor, remainingOffset, scanned, requests, scanCapReached,
  filters, note }`.

## Recording links

`dubber_recordings_get` takes two optional inputs from Dubber's Get Recording Link endpoint:

- `listener`: the email of a Dubber user who can access the recording. With it, the response
  also carries `recording_url`, a pre-signed link to the MP3. Dubber rejects a listener
  without access. This server never defaults or invents a listener.
- `contentDisposition`: `inline`, `attachment`, or `attachment;filename=<name>.mp3` (mp3
  only). It requires `listener`.

`recording_url` is a bearer secret: anyone holding it can download the call audio until it
expires (its `Expires` query parameter is a Unix timestamp). This server returns it to the
caller only. It never logs it (the logger strips signed-URL signatures) and never caches it.

## Security

The fleet template contract, as implemented here:

- **Fixed host.** Every request goes through `src/dubber-api.ts`: the origin is the constant
  `https://api.dubber.net`, the region is allowlisted, and every built URL must be exactly
  `/<region>/v1<path>`. Path IDs are rejected if they are empty, `.`, `..`, contain `/` or
  `\`, encoded separators or control characters, then percent-encoded.
- **No redirects.** `redirect: "manual"`; any 3xx is an error, including on the token mint
  that carries the client secret.
- **Bounded reads.** Response bodies are capped at 4 MiB while streaming.
- **Errors** keep the HTTP status, Dubber's message (capped), a retry hint on 429, and the
  vendor request id when one is sent.
- **Redaction.** Tool output is redacted by credential key names and by exact match on the
  credentials in use. Every log line is redacted for the S2S secret, env and per-request
  credentials, bearer tokens, and signed-URL signatures. Logs carry tool names, status and
  request ids only, never arguments or results.
- **Tokens** are cached per credential set for their lifetime (Dubber allows about 500 calls
  per token per 24 h). After a 401, the server mints once more; nothing else is retried.
- **Per-request scope.** In gateway mode the X-Dubber-* credentials and the effective tiers
  live in an AsyncLocalStorage scope for exactly one request.

## Vendor quirks encoded here

- **Password-grant auth with no human password.** `username`/`password` on the OAuth token
  request are the Dubber Auth ID / Dubber Auth Token pair from the portal's API tab, not a
  person's login. See `docs/DESIGN.md` §3.
- **Region-scoped hosts, no single production default.** `sandbox` is free/self-serve;
  production is `https://api.dubber.net/<region>/v1` for a region confirmed with Dubber —
  shipping against the wrong one silently talks to the wrong tenant.
- **No downloadable API spec.** Every endpoint and the auth flow were verified against the
  live `/io-docs` console and the official Getting Started Guide; full response-body shapes
  are a documented best-effort floor in `node-dubber`'s `src/types/index.ts`, not an
  asserted ceiling. See `docs/DESIGN.md` §4 and `CONTRIBUTING.md`.
- **No refresh-token flow implemented.** Dubber's response carries a `refresh_token`, but
  its contract isn't documented anywhere verifiable — this client just re-mints via the same
  password grant on expiry, matching node-kpn's existing choice under the same constraint.

## License

Apache-2.0 © WYRE Technology
