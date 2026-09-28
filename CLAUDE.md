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
