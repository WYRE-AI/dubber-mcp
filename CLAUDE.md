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
- **Not yet done**: registering `dubber` in conduit's `vendor-config.ts` and
  `azure/vendor-fleet.conduit-prod.bicepparam` (mcp-vendor-scaffolding §3), a marketplace
  plugin entry (§4), and confirming the actual Docker/CI release pipeline goes fully green
  end-to-end (Release workflow was pushed but not watched to completion when this was
  written — verify `gh run list --repo WYRE-AI/dubber-mcp` before assuming it shipped).
