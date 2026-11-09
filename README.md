# dubber-mcp

Read-only MCP server for [Dubber](https://developer.dubber.net/): call recordings and their
audio links, groups, accounts, users, REST-hook (webhook) subscriptions, and Dub.Point
telecom-system (e.g. BroadWorks) recording sources. No tool changes anything in Dubber.

Built on the MCP **2026-07-28** spec via the split v2 SDK
(`@modelcontextprotocol/server` / `/node` / `/client` `^2.0.0-beta.5`) with **dual-era
serving**: one shared `McpServerFactory` behind `createMcpHandler({ legacy: 'stateless' })`
answers both 2025-era `initialize`-handshake clients (the WYRE gateway today) and modern
2026-07-28 envelope clients, with the same deterministic tool surface for every caller.
Ships as a GHCR container only (no MCPB bundle). Endpoint paths come from
[`@wyre-ai/node-dubber`](https://github.com/WYRE-AI/node-dubber); every request goes
through this server's own guarded transport (see [Security](#security)).

## Read-only

Every tool is annotated `readOnlyHint: true` and sends only `GET` requests (plus the token
mint); the tests assert each tool's exact request. `read` is the only tool tier, so
`DUBBER_TOOL_TIERS` accepts only `read` and anything else refuses to start. An
`X-Conduit-Tool-Tiers` request header can only narrow (an empty header means no tools); Conduit
does not send it yet.

## Tools (16, flat)

- **Core**: `dubber_test_connection`.
- **Groups**: `dubber_groups_get`, `dubber_groups_list_unidentified_dub_points` (needs a
  group-level API token).
- **Accounts**: `dubber_accounts_get`.
- **Recordings**: `dubber_recordings_list` (newest first with `limit` 1–500, `offset`,
  `cursor`, `dubPointId`/`teamId`, and a `start_time` window — see
  [Listing recordings](#listing-recordings-and-time-windows)), `dubber_recordings_get`,
  `dubber_recordings_get_link` (signed audio link — see [Recording links](#recording-links)),
  `dubber_recordings_get_waveform`.
- **Users**: `dubber_users_list` (one page: `count` 1–100, `page`), `dubber_users_get`.
- **Profile**: `dubber_profile_get`.
- **Notifications** (REST hooks): `dubber_notifications_list`, `dubber_notifications_get`.
- **Dub.Point**: `dubber_dub_points_list` (one page, optional `userId`), `dubber_dub_points_get`,
  `dubber_dub_points_find` (`external_type`, `service_provider`, `external_group`,
  `external_identifier`).

List tools that page (`users`, `dub_points`) return `{ <items>, returned, count, page, hasMore }`;
`hasMore` is true when a full page came back.

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
values count as missing; a blank or repeated `X-Dubber-Region` is also a `401` (only an absent
one defaults to `sandbox`).

`/health` and `/healthz` stay unauthenticated and do not read credentials. The stdio
transport does not use `CONDUIT_S2S_SECRET`.

| Variable | Required | Description |
|---|---|---|
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty, a known placeholder (`changeme`, `secret`, `replace-me`, `replace-with-a-real-secret`, and the other example values), shorter than 32 characters, or a repeated pattern. Generate one with `openssl rand -hex 32`. Compose will not start without it. The value is never logged. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning, does not enforce `X-Gateway-S2S`, and binds `127.0.0.1` only. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) is ignored and the override is logged. A known placeholder secret still refuses to start. |
| `MCP_HTTP_HOST` | No | Bind address when a real `CONDUIT_S2S_SECRET` is set. Unset keeps `0.0.0.0`, the historical container bind. The image and Compose set `0.0.0.0` inside the container. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |
| `AUTH_MODE` | No | `gateway` (Docker image and Compose) or `env`. Gateway mode requires the four `X-Dubber-*` credential headers on each `/mcp` request and never falls back to `DUBBER_*`. `env` uses those variables only after S2S auth succeeds, and HTTP refuses to start in `env` mode without them. Unset means `env` (stdio and single-tenant HTTP outside the image). Any other value refuses to start. |
| `DUBBER_TOOL_TIERS` | No | `read` (the default and only tier). See [Read-only](#read-only). Any other entry refuses to start. |

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

## Listing recordings and time windows

Dubber's recordings endpoint documents only `count` (max 100), `page`, a `before_id` cursor,
`dub_point` and `team` — no `limit`/`offset`, no date filter and no search, and it silently
ignores unknown params (so this server offers no `query` input: an ignored filter would
quietly return every recording). `dubber_recordings_list` therefore pages Dubber itself (`count=100`, chaining
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
- Each call makes at most 10 Dubber requests (1,000 recordings scanned). If that cap,
  `limit`, or Dubber's rate limit stops the scan early, `hasMore` is true and `nextCursor` is
  set: call again with `cursor=<nextCursor>`, `offset=<remainingOffset>` (0 unless the scan
  stopped while still skipping) and the same filters to continue with no gaps or duplicates.
  `scanCapReached` says the cap was the reason; `rateLimited` says a rate limit was (wait a few
  seconds first). A rate limit on the first page is an error. With `startTimeFrom` set, the scan
  stops once a whole page of recordings starts before it.
- Result: `{ recordings, returned, hasMore, nextCursor, remainingOffset, scanned, requests, scanCapReached,
  rateLimited?, filters, note }`.

## Recording links

`dubber_recordings_get_link` calls Dubber's Get Recording Link and returns the recording plus
`recording_url`, a pre-signed link to the MP3. It is its own tool, separate from
`dubber_recordings_get`, so the gateway can enable plain reads without audio links.

- `listener` (required): the email of the Dubber user who will listen. Dubber checks that this
  user can access the recording and may attribute the access to them in its audit trail, so it
  must be the person who asked, never someone else. This server never defaults or invents one.
- `contentDisposition` (optional): `inline`, `attachment`, or `attachment;filename=<name>.mp3`
  (mp3 only).

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
- **Errors** keep the HTTP status, Dubber's message (capped), and the vendor request id when
  one is sent. Dubber rate-limits with `403` (error codes 1021/1024: retry in a few seconds;
  1022: the account's daily quota is used up), which is reported as a rate limit, not as missing
  access.
- **Redaction.** Tool output is redacted by credential key names and by exact match on the
  credentials and access token in use. Every log line is redacted for the S2S secret, env and
  per-request credentials and their access token, bearer tokens, and signed-URL signatures. Logs carry tool names, status and
  request ids only, never arguments or results.
- **Tokens** are cached per credential set and reused for the first half of their lifetime
  (at most until 30 minutes before expiry; a missing `expires_in` counts as Dubber's documented
  24 h). Dubber caps tokens at about 500 per 24 h and its sample token lives 240 s, so minting
  per call is not an option. After a 401 on a cached token, the server mints once more; a 401
  on a token minted for that call is returned as is (Dubber also uses 401 for "no access to
  this resource"). Nothing else is retried.
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
