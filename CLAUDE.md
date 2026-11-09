# dubber-mcp

MCP server for Dubber's API Store (call recording, compliance, Dub.Point telecom
integration). SDK: `@wyre-ai/node-dubber` (WYRE-AI/node-dubber). Build contract and scope
decisions: `docs/DESIGN.md`.

## Learnings - 2026-09-28

- **No downloadable spec.** developer.dubber.net's `/io-docs` is an interactive
  Mashery/Apigee-style console (request examples, not a Swagger/OpenAPI JSON export). Every
  endpoint path and method in this repo and in node-dubber was read directly off that
  console's method list plus support.dubber.net's "Dubber API Getting Started Guide" — two
  independent real sources, not invented. Response-body *shapes* beyond the one worked
  example the console renders were not independently verifiable; `node-dubber`'s
  `src/types/index.ts` types only what was actually visible and leaves the rest open.
- **The OAuth grant is `password`, and it's not a human password.** `client_id`/
  `client_secret` are the Mashery application key/secret from developer.dubber.net;
  `username`/`password` are the *separate* Dubber Auth ID / Dubber Auth Token pair from the
  Dubber portal's API tab. The interactive console also lists client_credentials and
  authorization_code as grant options, but only password is documented in the official
  guide, so only password shipped.
- **Base URL is region-scoped with no safe single default.** `https://api.dubber.net/<region>/v1`
  — `sandbox` is the free self-serve region; production regions exist (`us` confirmed via a
  third-party integration guide, "Australian production environment" mentioned in Dubber's
  own guide without an exact segment) but this repo deliberately defaults to `sandbox` rather
  than guessing a production region, since shipping against the wrong one silently talks to
  the wrong tenant.
- **Nothing here has been live-verified against a real Dubber account.** No sandbox
  credentials were available while building this. Every handler/resource pairing was tested
  against MSW mocks built from the documented request/response shapes, not a live call. The
  first real integration test against an actual sandbox account is a follow-up, not done here.
- **Fleet conventions**: `@wyre-ai` scope, `ghcr.io/wyre-ai`, WYRE-AI/reusable-workflows
  release caller, SDK v2 dual-era serving from day one (no v1 debt to migrate later), the
  standard s2s-verify (`X-Gateway-S2S`) wrapper, no `deploy:` job (conduit-only vendor).
- **`server.json`'s `description` really is capped at 100 chars.** The first release
  (v1.0.0) shipped a 107-char description and failed "Publish to MCP Registry" at the
  Validate server.json step — Docker image and npm/semantic-release still succeeded (it's a
  separately gated job), so the fix was a one-line `fix:` commit (v1.0.1) to re-trigger.
  Matches the documented gotcha in `mcp-registry-publish-gating`; count the string before
  writing it, don't eyeball it.
- **The reusable workflow's "Verify registry listing" step visibly hangs after a
  successful publish** — the job sat "in progress" for ~90s after `curl
  https://registry.modelcontextprotocol.io/v0/servers?search=io.github.WYRE-AI/dubber-mcp`
  already showed the listing live (`status: "active"`, correct version, correct OCI
  digest). It did complete green on its own; this is a known gotcha (see the kpn-mcp
  journal for the same note), not a real failure — check the registry directly rather than
  assuming a stuck job means the publish failed.
- **CI verified fully green end-to-end**, not just pushed-and-hoped: v1.0.1 — Build/Lint/Test,
  Release (semantic-release), Docker build+push, MCPB pack step (no-op, this repo ships no
  bundle), Security Scan, and Publish to MCP Registry all ✓. `gh run view <id> --repo
  WYRE-AI/dubber-mcp` before assuming otherwise.
- **Not yet done**: registering `dubber` in conduit's `vendor-config.ts` and
  `azure/vendor-fleet.conduit-prod.bicepparam` (mcp-vendor-scaffolding §3), a marketplace
  plugin entry (§4), and any live call against a real Dubber sandbox account (see above —
  everything here is MSW-mock-verified, not live-verified).

## Learnings - 2026-11-09

- **node-dubber's HTTP layer can't meet the fleet transport contract** (it uses bare `fetch`:
  redirect-follow, unbounded reads, no dot-segment check, token mint follows redirects with
  the client secret in the body). Rather than fork the SDK, `src/dubber-api.ts` passes its
  own `GuardedHttp` (one `request(path, options)` method) to node-dubber's exported
  resource classes. The SDK keeps owning paths/params; this repo owns every byte on the
  wire. node-dubber types the constructor arg as its `HttpClient` class (private fields),
  hence the single `as unknown as HttpClient` cast.
- **`encodeURIComponent("..")` is still `..`**, and `new URL()` then normalizes it away
  (`/recordings/..` → `/<region>/v1/`). Encoding alone is not traversal protection: ids
  are validated (`requireId`) AND the built URL's pathname must equal the expected path.
- **AsyncLocalStorage survives the v2 SDK's `createMcpHandler` → factory path.** Wrapping
  `handleMcpRequest(req, res)` in `runInRequestScope` is enough for the factory and the
  logger to see that request's credentials; the http-s2s-auth test proves header creds
  reach the token mint.
- **Conduit derives tiers from annotations** (`destructiveHint` → admin, `readOnlyHint` →
  read, else write; `src/access/first-party-default.test.ts`). Superseded the same day: the
  server is now read-only (see the next entry), so every tool is `read`.
- **The reusable release workflow supplies an `npmrc` BuildKit secret** (style 3 in
  `mcp-server-release.yml`), so the Dockerfile mounts it instead of taking a
  `GITHUB_TOKEN` build arg; no workflow change was needed.

## Learnings - 2026-11-09 (review fixes)

- **The server is read-only, per the fleet template contract.** All 21 write/admin tools are
  deleted (not just hidden behind `DUBBER_TOOL_TIERS`), `ALL_TIERS = ["read"]`, and
  `DUBBER_TOOL_TIERS=write` refuses to start. Most of those tools were wrong against Dubber's
  docs anyway (`notifications_create` sent `url`/`event` instead of `post_url`/`event_type`;
  `accounts_create` sent `group_id`/`timezone` instead of `group`/`time_zone`; `users_create`
  sent an undocumented `name`; the multipart upload sent `{}` to `complete_upload`). If writes
  come back, build them from the official samples with fetch-level tests, as separate PRs.
- **Conduit follow-up before any repin (prod pins v1.0.1, 37 tools):** in the Conduit repo,
  update `tests/mcp/manifests/container-tools.json` (16 tools, including the new
  `dubber_recordings_get_link` and `dubber_groups_list_unidentified_dub_points`), prune the
  dubber write/admin rows and the renamed/removed read rows in
  `src/proxy/result-cache.ts` (~4172-4214), and drop the dubber entries in
  `src/access/tool-naming-exceptions.ts` (~1260-1265). Do not move PR #2248 to this image
  without that.
- **Dubber's sample token lives 240 s** (Authorization_by_Password). A fixed 30-minute refresh
  margin meant every call minted, against a ~500 tokens/24 h cap. The margin is now
  half the lifetime (≤30 min, ≥5 s) and a missing `expires_in` means 24 h. Test fixtures use
  240, not 86400, so this can't hide again.
- **Dubber rate-limits with 403, not 429** (codes 1021 QPS, 1022 daily, 1024; or an "Over
  Rate Limit" message). `rateLimitOf()` in `dubber-api.ts` classifies them; without it the
  error read as a permissions problem.
- **Endpoints node-dubber 1.1.0 gets wrong or lacks**: `groups.listUnidentifiedRecordings`
  calls an undocumented path (the real one is `/groups/:id/unidentified_dub_points`), and
  `users.list` sends no `count`/`page` (Dubber defaults to 20). Both go through
  `DubberApi.request` (the guarded transport) instead. `notifications.listUnclaimed` releases
  held messages, so it is not exposed at all.
- **`dubber_recordings_get_link` is its own tool** so Conduit can disable audio links without
  disabling reads. `listener` is attributed by Dubber; the description says to pass only the
  requester's own email. Not live-verified whether Dubber writes an audit event for it.
- **The fleet's reusable `mcp-server-ci.yml` does not fit this repo yet**: its docker-smoke
  npmrc maps only `@wyre-technology`, and the Dockerfile mounts that file over `/app/.npmrc`,
  so `@wyre-ai/node-dubber` would not resolve; it also runs `npm ci` without
  `--ignore-scripts`. `ci.yml` copies its process.env credential-mutation guard instead.

## Learnings - 2026-11-09 (review round 2)

- **`maxToolInputElements` (the GHSA-46jr-4wx8-v453 cap) is an `McpServer` option only.** The
  low-level `Server` used here has no such option and this server never schema-validates tool
  arguments, so the SDK bump (server/core 2.4.0, node 2.1.2, zod 4.6.7) is the whole fix.
- **Dubber answers 401 for "no access to this resource" too** (HTTP_Responses page; e.g.
  unidentified dub points need a group-level token). Only a 401 on a *cached* token re-mints;
  re-minting after a fresh token's 401 spent the ~500 mints/day budget.
- **Output cap: trim lists by item, never cut the JSON.** `listResult` (handlers/results.ts)
  drops items from the end and lets each tool rewrite its paging fields; the string cut in
  `mcp-server.ts` runs after redaction and only for a lone oversized item. Paging fields are
  serialized ahead of the list so even that cut keeps them.
- **Still not live-verified** (no sandbox credentials): the recordings sort key (the scan's
  early stop assumes newest first by `start_time` and says so), and whether
  `/notifications/:id` or `/accounts/notifications/:id` is the live path (the docs page shows
  both; the code uses the documented `/notifications/:id`).
- **Fleet follow-up, not this repo:** `wyre-technology/.github` `mcp-assert.yml` (pinned here at
  `06856d54`) runs plain `npm ci` and checks out without `persist-credentials: false`.
