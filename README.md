# dubber-mcp

MCP server for [Dubber](https://developer.dubber.net/) — call recording upload/retrieval,
compliance metadata and tags, group/account/user management, REST-hook (webhook)
notifications, and Dub.Point telecom-system (e.g. BroadWorks) integration.

Built on the MCP **2026-07-28** spec via the split v2 SDK
(`@modelcontextprotocol/server` / `/node` / `/client` `^2.0.0-beta.5`) with **dual-era
serving**: one shared `McpServerFactory` behind `createMcpHandler({ legacy: 'stateless' })`
answers both 2025-era `initialize`-handshake clients (the WYRE gateway today) and modern
2026-07-28 envelope clients, with an identical, deterministic 37-tool surface for every
caller. Ships as a GHCR container only (no MCPB bundle). The Dubber client is
[`@wyre-ai/node-dubber`](https://github.com/WYRE-AI/node-dubber).

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
| `DUBBER_REGION` (optional, default `sandbox`) | `X-Dubber-Region` | Selects `api.dubber.net/<region>/v1` |
| `DUBBER_BASE_URL` (optional) | none (deliberately) | Env-mode-only full override |

In gateway mode a request missing any of the four required headers is answered `401`
(JSON-RPC error `-32001`) before the MCP handler runs. It never falls through to env
credentials — a header-controlled base URL is likewise refused entirely (env-mode only), so
a caller can never redirect client secrets to another host.

When `CONDUIT_S2S_SECRET` is set (conduit provisions this sidecar's own derived subkey),
every request except `/health` must also carry a valid `X-Gateway-S2S` HMAC header signed
by the gateway, or it is answered `401`. This stops a compromised sibling sidecar from
impersonating the gateway. Unset, the check is off (the fleet's dormant default).

## Running

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages auth for @wyre-ai/*
npm install
npm run build
node dist/index.js                        # stdio (default)
MCP_TRANSPORT=http node dist/index.js     # HTTP on :8080 (/mcp, /health)
npm run smoke                             # proves both protocol eras serve the same tools
```

Docker (linux/amd64 per fleet law):

```bash
docker build --platform linux/amd64 --build-arg GITHUB_TOKEN=$(gh auth token) -t dubber-mcp .
docker run -p 8080:8080 \
  -e DUBBER_CLIENT_ID=... -e DUBBER_CLIENT_SECRET=... \
  -e DUBBER_AUTH_ID=... -e DUBBER_AUTH_TOKEN=... \
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
