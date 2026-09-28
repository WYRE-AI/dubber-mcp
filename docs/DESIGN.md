# Dubber MCP — design contract

## 1. Scope

### 1.1 What shipped in v1

A flat, 30-tool MCP surface over the Dubber API Store's call-recording and
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

30 tools is comfortably inside the "flat, no router" band the fleet's
`mcp-vendor-scaffolding` skill recommends (≤~25 as a rule of thumb, not a
hard cutoff) — kept flat for a simpler client experience rather than adding
router indirection for a surface this size.

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
selects the `https://api.dubber.net/<region>/v1` host. `DUBBER_BASE_URL` is
an env-mode-only full override (never accepted from a gateway header — a
caller-chosen base URL would make the server send secrets to, and fetch
from, any host).

Unlike kpn-mcp's dual-realm (gateway + MSM) credential shape, Dubber has one
token realm and one credential set — no optional/paired-fallback logic
needed here.

## 3. Auth mechanics

POST `{baseUrl}/token`, `application/x-www-form-urlencoded`, body
`grant_type=password&client_id=...&client_secret=...&username={authId}&password={authToken}`.
Response carries `access_token`, `token_type`, `expires_in`, `refresh_token`.
This client re-mints via the same password grant on expiry rather than using
the refresh token — Dubber's refresh-grant contract isn't documented
anywhere verifiable, matching node-kpn's existing choice under the same
constraint. See `node-dubber`'s `src/auth.ts` for the full rationale.

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
