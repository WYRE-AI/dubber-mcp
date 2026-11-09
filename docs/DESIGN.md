# Dubber MCP — design contract

## 1. Scope

### 1.1 What shipped in v1

A flat, 37-tool MCP surface over the Dubber API Store's call-recording and
compliance platform, spanning every documented endpoint category:

- **Groups** (4 tools): hierarchy navigation, child-group creation, and
  group-scoped unidentified/unclaimed recordings.
- **Accounts** (3 tools): create/get/update.
- **Recordings** (11 tools): list/create/get/delete, metadata, tags
  (add/remove), waveform, and the full multipart-upload flow
  (initiate/get-upload-target/complete) for large audio files.
- **Users** (5 tools): list/create/get/update/delete on an account.
- **Profile** (1 tool): the authenticated user/application's own profile.
- **Notifications** (7 tools): REST-hook (webhook) subscription
  create/list/get/update/activate/delete, plus unclaimed-event listing.
- **Dub.Point** (4 tools): telecom-system (e.g. BroadWorks) connection
  create/list/get/find.
- **OAuth** (1 tool): token revocation.
- **Core** (1 tool): `dubber_test_connection`.

37 tools is above the "flat, no router" rule-of-thumb (≤~25) the fleet's
`mcp-vendor-scaffolding` skill suggests, but it's a suggestion, not a hard
cutoff — kept flat anyway for a simpler client experience rather than adding
router indirection, since the category boundaries above are already clean
enough that a router wouldn't meaningfully reduce per-call cognitive load.

### 1.2 What did NOT ship, and why

- **Group-scoped notifications** (`POST/GET /groups/:group_id/notifications`,
  documented alongside the account-scoped variant). Only the account-scoped
  half shipped — the two are functionally identical REST-hook operations at
  a different scope, and covering both would have doubled the notification
  tool count for a scope variant that's likely rarer in practice. Add
  `dubber_notifications_list_by_group` / `..._create_by_group` if a real
  workflow needs it.
- **A dedicated recording-download-as-binary tool.** The SDK
  (`client.recordings.download()`) supports it — `GET /recordings/:id`
  content-negotiated to raw audio — but no MCP tool exposes it yet, since
  MCP tool results are JSON/text by convention here and this repo doesn't
  yet have a pattern (matching kpn-mcp's PDF-invoice precedent:
  `{ type: "resource", resource: { uri, mimeType, blob } }`) proven against
  a live Dubber account. Wire it once verified.
- **OAuth client_credentials / authorization_code grants.** The interactive
  `/io-docs` console lists them as options, but the official Getting Started
  Guide (support.dubber.net) only documents the password grant (Mashery
  key/secret as `client_id`/`client_secret`, Dubber Auth ID/Token as
  `username`/`password`). Only the documented, verified grant shipped.

## 2. Credentials

Four values, all required:

| Field | Source | Sent as (gateway mode) | Env var |
|---|---|---|---|
| Mashery application key | developer.dubber.net app registration | `X-Dubber-Client-Id` | `DUBBER_CLIENT_ID` |
| Mashery application secret | developer.dubber.net app registration | `X-Dubber-Client-Secret` | `DUBBER_CLIENT_SECRET` |
| Dubber Auth ID | Dubber portal → API tab | `X-Dubber-Auth-Id` | `DUBBER_AUTH_ID` |
| Dubber Auth Token | Dubber portal → API tab | `X-Dubber-Auth-Token` | `DUBBER_AUTH_TOKEN` |

Optional: `region` (`X-Dubber-Region` / `DUBBER_REGION`, default `sandbox`) —
selects the path segment in `https://api.dubber.net/<region>/v1` and must be
one of `sandbox`, `us`, `au`, `eu`, `uk` (Conduit's `DUBBER_VALID_REGIONS`).
There is no base-URL input of any kind: the origin is a constant.

### 2.1 Transport security contract (fleet template)

node-dubber's resource classes build each endpoint's path and query, but no
request uses the SDK's own `fetch`. `src/dubber-api.ts` is the only path to
Dubber: fixed origin plus an exact-path check on every built URL,
`redirect: "manual"` with every 3xx refused (including the token mint, whose
body carries the client secret), 4 MiB bounded reads, vendor request ids on
errors, no automatic retries except one re-mint after a 401, and a
per-credential token cache (Dubber allows ~500 calls per token per 24 h).
Path IDs are validated in the handlers (`requireId`) before node-dubber
percent-encodes them.

Tool tiers (`read` / `write` / `admin`) are derived from annotations the way
Conduit derives them (destructiveHint → admin, readOnlyHint → read, else
write). `DUBBER_TOOL_TIERS` defaults to `read` (16 tools);
`read,write,admin` enables all 37. `X-Conduit-Tool-Tiers` can only narrow,
and an empty header means zero tools. `dubber_recordings_get_upload_target`
is a GET but write tier: its result is a credential to upload audio.

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

`GET /accounts/:id/recordings` supports only `count` (≤100), `page` (≤5 pages), `before_id`,
`after_id`, `query`, `dub_point`, `team`; it has no limit/offset and no date filter, and
ignores unknown params. `dubber_recordings_list` (name unchanged) keeps `limit` (≤500,
default 100) and `offset` with real semantics by walking the newest-first list with
`count=100` + `before_id`, skipping `offset` matches, collecting `limit`. `startTimeFrom`
(inclusive) / `startTimeTo` (exclusive; date-only = whole UTC day) filter on `start_time`
(RFC 2822) server-side. Bounds: 25 Dubber requests (2,500 scanned) per call, then
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
directly. Tool count stays 37.

### Recording link (WYREAI-567 item 2)

`dubber_recordings_get` takes optional `listener` (email of a Dubber user with access to the
recording) and `contentDisposition` (`inline` | `attachment` | `attachment;filename=<name>.mp3`,
requires `listener`), sent as Dubber's `listener` / `content_disposition` query params
(Get Recording Link, developer.dubber.net). The response then carries `recording_url`, a
pre-signed S3 link with an `Expires` query param. It is a bearer secret: returned to the
caller, never logged (the logger strips signed-URL signatures) and never cached. No
listener is ever defaulted or invented. The tool stays read tier.

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
wrapper, and the §2.7b destructive-tool warning convention (5 tools:
`dubber_recordings_delete`, `dubber_recordings_delete_tags`,
`dubber_users_delete`, `dubber_notifications_delete`,
`dubber_oauth_revoke_token` — recording deletion is the only Tier A
irreversible action; the rest are Tier B reversible-with-real-impact).

No `deploy:` job — Dubber is conduit-only (see release.yml's header
comment), matching kpn-mcp, connectwise-cpq-mcp, scalepad-mcp and clio-mcp.
Registering the vendor in conduit's `vendor-config.ts` and
`azure/vendor-fleet.conduit-prod.bicepparam` (mcp-vendor-scaffolding §3) is
a follow-up step in the `conduit` repo, not part of this one.
