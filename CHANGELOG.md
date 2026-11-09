# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `dubber_recordings_get_link` returns Dubber's pre-signed `recording_url` for a required
  `listener` (WYREAI-567 item 2), with optional `contentDisposition`. The link is never logged
  or cached.
- `dubber_groups_list_unidentified_dub_points` (Dubber's documented
  `GET /groups/:id/unidentified_dub_points`).
- `dubber_users_list` takes `count`/`page`; `dubber_dub_points_list` takes `userId`/`count`/`page`.
  Both report `hasMore` when a full page comes back, instead of silently stopping at Dubber's
  default 20.
- `DUBBER_TOOL_TIERS` (only `read` is valid) and an optional `X-Conduit-Tool-Tiers` header that
  can only narrow (not yet sent by Conduit).
- `dubber_recordings_list` returns what it read plus `rateLimited: true` and a resumable
  `nextCursor` when Dubber rate-limits after the first page.
- CI guard against assigning request credentials to `process.env`.
- Optional `MCP_ALLOWED_HOSTS` Host-header allowlist (fleet parity with anthropic-admin-mcp),
  checked before the S2S gate. Under `MCP_ALLOW_INSECURE_DEV=1` it defaults to
  `localhost,127.0.0.1`, so a DNS-rebinding web page cannot call a local dev server.
- Guarded Dubber transport: fixed `https://api.dubber.net` origin, exact-path check on every
  URL, GET-only with no body (node-dubber's write methods are refused before any request),
  redirects refused, 4 MiB bounded reads, vendor request ids in errors.
- Secrets are also redacted in their JSON-escaped form.
- Redacting logger and tool output; per-request AsyncLocalStorage credential scope.
- `npm run lint:destructive`, a stdio leg in `npm run smoke`, `mcp-assert` evals, gitleaks
  scanning, and CODEOWNERS.

### Changed

- **Breaking:** the server is read-only: 16 tools, all `readOnlyHint: true`.
  `DUBBER_TOOL_TIERS` values other than `read` refuse to start.
- **Breaking:** `dubber_recordings_get` no longer takes `listener`; use
  `dubber_recordings_get_link`.
- **Breaking:** `dubber_dub_points_find` accepts only `external_type`, `service_provider`,
  `external_group` and `external_identifier`.
- **Breaking:** a blank or repeated `X-Dubber-Region` header is a 401 instead of defaulting to
  `sandbox`.
- **Breaking:** `CONDUIT_S2S_SECRET` must be at least 32 characters and not a repeated
  pattern; an unknown `AUTH_MODE` or `DUBBER_TOOL_TIERS` entry refuses to start;
  `AUTH_MODE=env` HTTP refuses to start without `DUBBER_*` credentials.
- Tokens are reused for 90% of their lifetime (at most until 30 minutes before expiry), and a
  missing `expires_in` counts as 24 h. Previously any token living under 30 minutes, such as
  Dubber's 240 s sample token, was minted again on every call; at half its lifetime it would
  still have exceeded Dubber's ~500 mints a day under continuous use.
- Dubber's 403 rate limits (codes 1021/1022/1024, or Mashery's own over-QPS / over-rate 403s
  identified by `X-Mashery-Error-Code` / `X-Error-Detail-Header`) are reported as rate limits,
  not as missing access.
- `/health` and MCP `serverInfo` report the `package.json` version instead of a hardcoded
  `1.0.0`.
- `dubber_recordings_get_waveform` says it returns a short-lived pre-signed `waveform_url`;
  `dubber_recordings_get` no longer claims to return tags.
- `dubber_recordings_list` scans at most 10 Dubber requests (1,000 recordings) per call, down
  from 25.
- The access token in use is redacted from tool output and logs.
- `CONDUIT_S2S_SECRET` values starting `s2s-test` refuse to start; the tests generate their
  secret per run instead of committing one.
- `X-Dubber-Region` / `DUBBER_REGION` must be `sandbox`, `us`, `au`, `eu`, or `uk`.
- Path IDs containing `.`/`..`, separators, encoded separators or control characters are
  rejected before any request.
- `@wyre-ai/node-dubber` bumped to `^1.1.0`; Node.js 22+ required.
- The Docker build takes GitHub Packages auth as a BuildKit secret (`npmrc`) instead of a
  `GITHUB_TOKEN` build arg, and pins the base image by digest.
- CI installs with `--ignore-scripts` and checks out with `persist-credentials: false`; the
  release workflow is pinned to reusable-workflows `508ef4d` with `fail-on-severity:
  HIGH,CRITICAL`.

- A 401 re-mints the token only when the token was taken from the cache. A 401 on a token
  minted for the same call is returned as is and the token stays cached: Dubber also answers
  401 for "no access to this resource", and re-minting spent its ~500 mints/day budget.
- The 401 hint says the cause can be wrong credentials or a token without access to the
  resource (such as unidentified dub points, which need a group-level token).
- Key-name redaction also covers generic credential names: any key ending in `token`, `key`,
  `secret` or `password` (such as `token`, `api_key`, `signing_key`, `hmac_key`,
  `webhook_secret`), plus `hmac`. Ids, `token_type` and `recording_url` are still returned.
- Tool output is capped at 60,000 characters, after redaction. List results drop items from
  the end and keep their paging fields (`dubber_recordings_list` resumes from a `nextCursor` at
  the last recording kept); anything else is cut with a `[truncated: ...]` marker.
- **Breaking:** `dubber_dub_points_find`, `dubber_groups_list_unidentified_dub_points` and
  `dubber_notifications_list` return `{ returned, <list> }` instead of a bare array, so a
  trimmed result can say so.
- `dubber_test_connection` makes one authenticated `GET /profile` instead of only checking for
  a token, so a cached token for revoked credentials no longer reports success.

### Removed

- `DUBBER_BASE_URL`. The host is always `https://api.dubber.net`.
- CORS headers (`Access-Control-Allow-Origin: *`) and the pre-auth `OPTIONS` 204. Only Conduit
  calls this server; an `OPTIONS` request now meets the S2S gate like any other.
- Every write and admin tool (21): `dubber_groups_create_child`,
  `dubber_groups_create_unidentified_recording`, `dubber_accounts_create`,
  `dubber_accounts_update`, `dubber_recordings_create`, `dubber_recordings_delete`,
  `dubber_recordings_update_metadata`, `dubber_recordings_add_tags`,
  `dubber_recordings_delete_tags`, `dubber_recordings_initiate_multipart_upload`,
  `dubber_recordings_get_upload_target`, `dubber_recordings_complete_upload`,
  `dubber_users_create`, `dubber_users_update`, `dubber_users_delete`,
  `dubber_notifications_create`, `dubber_notifications_update`,
  `dubber_notifications_activate`, `dubber_notifications_delete`, `dubber_dub_points_create`,
  `dubber_oauth_revoke_token`; and destructive-action elicitation with them.
- `dubber_notifications_list_unclaimed`: Dubber's endpoint releases held messages, so it is
  not a read.
- `dubber_groups_list_unidentified_recordings`: it called an undocumented endpoint; replaced by
  `dubber_groups_list_unidentified_dub_points`.
- The undocumented `query` input on `dubber_recordings_list`.

### Security

- `@modelcontextprotocol/server` (and `core`) bumped to `^2.4.0`, `@modelcontextprotocol/node`
  to `^2.1.2`, and the lockfile moved to `zod` 4.6.7 and `hono` 4.13.17. This clears
  GHSA-jm63-cq47-j5jp, GHSA-46jr-4wx8-v453, GHSA-rvq5-wwqv-78pq and GHSA-mrhx-c7xc-m3w5
  (`npm audit --omit=dev`: 0 vulnerabilities), which would otherwise fail the release's
  HIGH/CRITICAL image scan.

Entries below this line are written by semantic-release from commit history.
