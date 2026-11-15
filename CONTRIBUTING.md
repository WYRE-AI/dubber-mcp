# Contributing to dubber-mcp

Thanks for helping improve the Dubber MCP server.

## Development setup

```bash
export NODE_AUTH_TOKEN=$(gh auth token)   # GitHub Packages registry auth
npm install
```

## Workflow

- `npm run build`: tsc build to `dist/`.
- `npm test`: vitest suite. Handler tests use `src/__tests__/stub-client.ts`; transport and
  end-to-end tests stub `fetch`. Nothing touches the network.
- `npm run lint`: eslint plus the destructive-warning gate; `npm run typecheck`: `tsc --noEmit`.
- `npm run lint:destructive`: the destructive-warning convention gate alone.
- `npm run smoke`: dual-era serving, gateway 401 gate, and stdio proof (run after build).

All of the above must pass before a PR is merged. The build contract is `docs/DESIGN.md`;
if code and design disagree, fix one of them in the same PR.

## Invariants (do not break)

- **Stateless tool surface**: `tools/list` must return the same tools in the same order for
  every caller with the same tiers. No sessions, no per-user variance, no runtime sorting.
  `read` is the only tier; an empty `X-Conduit-Tool-Tiers` header means no tools.
- **Never `legacy: 'reject'`** on `createMcpHandler`: it turns away every 2025-era client.
- **401 gate before the handler** in gateway mode; never fall through to env credentials.
- **No base URL at all.** The origin is `https://api.dubber.net`; the region is allowlisted.
- **Every Dubber request goes through `src/dubber-api.ts`** (exact-path check, no
  redirects, bounded reads). Never call the SDK's `DubberClient` or `fetch` directly.
- **Path IDs use `requireId`**, never `requireString`.
- **Read-only server.** Every tool is `readOnlyHint: true` and sends only GETs (plus the
  token mint); `security-contract.test.ts` asserts each tool's exact method, path and query.
  Do not add a tool that changes Dubber state, or whose result grants write access (e.g. an
  upload URL), or an endpoint with side effects on GET (e.g. releasing unclaimed
  notifications).
- Every handler returns `isError` results and never throws; empty results are `isError`
  with an explicit "no X found" message.
- `/health` stays shallow and unauthenticated. Logs never contain tool arguments, results
  or credentials.

## A note on the API surface

Dubber does not publish a downloadable OpenAPI/JSON-Schema spec. Every endpoint path here
was verified against the live `/io-docs` console and the official Getting Started Guide —
response-body shapes were not independently verifiable, so `node-dubber`'s
`src/types/index.ts` types only the fields actually visible in the console's examples.
Widen them from real responses as this server gets exercised against a live account, rather
than assuming they're complete.

## Commit messages

This repo releases via semantic-release; commit messages must follow
[Conventional Commits](https://www.conventionalcommits.org/):

- `fix:`: patch release
- `feat:`: minor release
- `feat!:` / `BREAKING CHANGE:`: major release
- `docs:`, `test:`, `chore:`, `refactor:`: no release
