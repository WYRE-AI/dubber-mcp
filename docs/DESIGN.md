# Dubber MCP — design contract

## 1. Scope

### 1.1 What ships

A flat, read-only, 16-tool MCP surface over the Dubber API Store's call-recording
platform. Every tool is `readOnlyHint: true` and sends only GETs; `read` is the only tier.

- **Core** (1): `dubber_test_connection`.
- **Groups** (2): `dubber_groups_get`, `dubber_groups_list_unidentified_dub_points`
  (`GET /groups/:id/unidentified_dub_points`, response key `unidentified_dub_points`; Dubber
  requires a group-level token).
- **Accounts** (1): `dubber_accounts_get`.
- **Recordings** (4): `dubber_recordings_list`, `dubber_recordings_get`,
  `dubber_recordings_get_link`, `dubber_recordings_get_waveform`.
- **Users** (2): `dubber_users_list` (one page: `count` ≤100, `page`), `dubber_users_get`.
- **Profile** (1): `dubber_profile_get`.
- **Notifications** (2): `dubber_notifications_list`, `dubber_notifications_get`.
- **Dub.Point** (3): `dubber_dub_points_list` (one page, optional `user`),
  `dubber_dub_points_get`, `dubber_dub_points_find` (the four documented lookup keys only).

### 1.2 What does NOT ship, and why

- **Every write and admin tool** (21 in v1.0.x: create/update/delete for accounts, users,
  recordings, tags, metadata, notifications and dub points; child groups; the multipart
  upload flow; token revocation). This server follows the fleet's read-only template
  contract: with no write code compiled in, no setting can turn writes on and a
  prompt-injected caller cannot, for example, subscribe a webhook to an account's recording
  events. A review against Dubber's docs also found most of them sent the wrong fields
  (`notifications_create`, `accounts_create`, `users_create`), hit an undocumented endpoint
  (`groups_create_unidentified_recording`), or could not complete (the multipart upload).
- **`dubber_notifications_list_unclaimed`.** `GET /notifications/:id/unclaimed` answers
  `unclaimed_messages_released: N`, i.e. it re-queues held messages: a side effect, so not a
  read.
- **`query` on `dubber_recordings_list`.** Get_Account_Recordings does not document it;
  Dubber ignores unknown params, so a "filtered" call could quietly return everything.
- **A recording-download-as-binary tool.** `GuardedHttp` refuses binary responses and ignores
  per-request headers; wire both (and a resource result) before exposing
  `recordings.download()`.
- **Group-scoped notifications** and **OAuth client_credentials / authorization_code
  grants**: not needed for the read surface; only the documented password grant is used.

## 2. Credentials

Four values, all required:

| Field | Source | Sent as (gateway mode) | Env var |
|---|---|---|---|
| Mashery application key | developer.dubber.net app registration | `X-Dubber-Client-Id` | `DUBBER_CLIENT_ID` |
| Mashery application secret | developer.dubber.net app registration | `X-Dubber-Client-Secret` | `DUBBER_CLIENT_SECRET` |
| Dubber Auth ID | Dubber portal → API tab | `X-Dubber-Auth-Id` | `DUBBER_AUTH_ID` |
| Dubber Auth Token | Dubber portal → API tab | `X-Dubber-Auth-Token` | `DUBBER_AUTH_TOKEN` |

Optional: `region` (`X-Dubber-Region` / `DUBBER_REGION`, default `sandbox` only when absent;
a blank or repeated header is a 401) —
selects the path segment in `https://api.dubber.net/<region>/v1` and must be
one of `sandbox`, `us`, `au`, `eu`, `uk` (Conduit's `DUBBER_VALID_REGIONS`).
There is no base-URL input of any kind: the origin is a constant.

### 2.1 Transport security contract (fleet template)

node-dubber's resource classes build each endpoint's path and query, but no
request uses the SDK's own `fetch`. `src/dubber-api.ts` is the only path to
Dubber: fixed origin plus an exact-path check on every built URL,
`redirect: "manual"` with every 3xx refused (including the token mint, whose
body carries the client secret), 4 MiB bounded reads, vendor request ids on
errors, no automatic retries except one re-mint after a 401 on a cached token, GET-only requests
with no body (node-dubber's write methods are refused before any request), and a
per-credential token cache (Dubber caps tokens at ~500 per 24 h). A token is reused for
90% of its lifetime (≤30 min margin, ≥5 s; no `expires_in` = 24 h), so Dubber's 240 s sample
tokens are minted at most every 216 s (~400 a day), not per call. Dubber's 403 rate limits
(codes 1021/1022/1024, or Mashery's `X-Mashery-Error-Code` / `X-Error-Detail-Header`
over-QPS and over-rate rejections) are reported as rate limits, not access errors.
Path IDs are validated in the handlers (`requireId`) before node-dubber
percent-encodes them.

`read` is the only tool tier. `DUBBER_TOOL_TIERS` accepts only `read` (anything else
refuses to start). `X-Conduit-Tool-Tiers` can only narrow, and an empty header means zero
tools; Conduit does not send it yet.

Unlike kpn-mcp's dual-realm (gateway + MSM) credential shape, Dubber has one
token realm and one credential set — no optional/paired-fallback logic
needed here.

## 3. Auth mechanics

POST `https://api.dubber.net/<region>/v1/token`, `application/x-www-form-urlencoded`, body
`grant_type=password&client_id=...&client_secret=...&username={authId}&password={authToken}`.
Response carries `access_token`, `token_type`, `expires_in`, `refresh_token`.
This client re-mints via the same password grant on expiry rather than using
the refresh token — Dubber's refresh-grant contract isn't documented
anywhere verifiable, matching node-kpn's existing choice under the same
constraint. See `node-dubber`'s `src/auth.ts` for the full rationale.

### Recordings list paging (WYREAI-567)

`GET /accounts/:id/recordings` documents only `count` (≤100), `page`, `before_id`,
`dub_point`, `team`; it has no limit/offset, no date filter and no search, and ignores
unknown params. `dubber_recordings_list` (name unchanged) keeps `limit` (≤500,
default 100) and `offset` with real semantics by walking the newest-first list with
`count=100` + `before_id`, skipping `offset` matches, collecting `limit`. `startTimeFrom`
(inclusive) / `startTimeTo` (exclusive; date-only = whole UTC day) filter on `start_time`
(RFC 2822) server-side. Bounds: 10 Dubber requests (1,000 scanned) per call, then
`scanCapReached` + `nextCursor` (last examined recording id, used as `before_id`) +
`remainingOffset` (offset still unskipped at stop time, 0 once skipping finished); continue with
`cursor=nextCursor` and `offset=remainingOffset`. The scan
also ends on an empty/short page, or — with `startTimeFrom` — a page whose recordings all
start before it (start_time order within the list isn't guaranteed, hence whole-page). The
`dubPointId` / `teamId` inputs map to Dubber's `dub_point` / `team`, are sent on every page request
(same cursor ⇒ same value) and echoed in `filters`; blank values or both together are a
`ToolInputError` (Dubber forbids combining them). There is no user filter on recordings: resolve a
user's dub points via `dubber_dub_points_list` (`user` URL ends `/users/<USER_ID>`), one call per
dub point. node-dubber >= 1.1.0 types these params, so `fetchRecordingsPage` passes them
directly. A Dubber rate limit after the first page ends the scan with the recordings read so
far, `rateLimited: true` and a `nextCursor` to resume from; on the first page it is an error.

### Recording link (WYREAI-567 item 2)

`dubber_recordings_get_link` takes `listener` (required: the email of the Dubber user asking
for the link) and optional `contentDisposition` (`inline` | `attachment` |
`attachment;filename=<name>.mp3`), sent as Dubber's `listener` / `content_disposition` query
params (Get Recording Link, developer.dubber.net). The response carries `recording_url`, a
pre-signed S3 link with an `Expires` query param. It is a bearer secret: returned to the
caller, never logged (the logger strips signed-URL signatures) and never cached. Dubber
authorizes the link for `listener` and may attribute the access to that user, so no
listener is ever defaulted or invented, and the description tells the model to pass only
the requester's own email. It is a separate tool from `dubber_recordings_get` so Conduit
can enable plain reads without audio links.

## 4. API-surface confidence

Dubber does not publish a downloadable OpenAPI/Swagger spec. Every endpoint
path and the auth flow were verified against two independent real sources:
the live `/io-docs` interactive console (method list + the one worked
request/response example it renders) and the official Getting Started Guide
at support.dubber.net (auth flow, base URLs, token lifetime, rate limit).
Full response-body **shapes** were not independently verifiable from static
content — `node-dubber`'s `src/types/index.ts` types the fields actually
visible in the console's examples and leaves the rest open via an index
signature. Treat this as a documented floor, not an asserted ceiling.

## 5. Fleet conventions followed

`@wyre-ai` scope, `ghcr.io/wyre-ai`, WYRE-AI/reusable-workflows release
caller, MCP SDK v2 with dual-era (`legacy: 'stateless'`) serving from day
one (no v1→v2 migration debt), the standard s2s-verify (`X-Gateway-S2S`)
wrapper, and the read-only template contract (`read` the only tier; the §2.7b
destructive-warning lint still runs and finds no destructive tools).

No `deploy:` job — Dubber is conduit-only (see release.yml's header
comment), matching kpn-mcp, connectwise-cpq-mcp, scalepad-mcp and clio-mcp.
Registering the vendor in conduit's `vendor-config.ts` and
`azure/vendor-fleet.conduit-prod.bicepparam` (mcp-vendor-scaffolding §3) is
a follow-up step in the `conduit` repo, not part of this one.
