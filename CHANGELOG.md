# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `dubber_recordings_get` takes optional `listener` and `contentDisposition` and returns
  Dubber's pre-signed `recording_url` (WYREAI-567 item 2). The link is never logged or cached.
- Tool tiers (`read`, `write`, `admin`) derived from tool annotations, selected with
  `DUBBER_TOOL_TIERS` and narrowed per request by Conduit's `X-Conduit-Tool-Tiers` header.
- Guarded Dubber transport: fixed `https://api.dubber.net` origin, exact-path check on every
  URL, redirects refused, 4 MiB bounded reads, vendor request ids in errors.
- Redacting logger and tool output; per-request AsyncLocalStorage credential scope.
- `npm run lint:destructive`, a stdio leg in `npm run smoke`, `mcp-assert` evals, gitleaks
  scanning, and CODEOWNERS.

### Changed

- **Breaking:** the default tool surface is the 16 read tools. Set
  `DUBBER_TOOL_TIERS=read,write,admin` for all 37.
- **Breaking:** `CONDUIT_S2S_SECRET` must be at least 32 characters and not a repeated
  pattern; an unknown `AUTH_MODE` or `DUBBER_TOOL_TIERS` entry refuses to start;
  `AUTH_MODE=env` HTTP refuses to start without `DUBBER_*` credentials.
- `dubber_recordings_get_upload_target` is now write tier (`readOnlyHint: false`): its
  result grants upload access.
- `X-Dubber-Region` / `DUBBER_REGION` must be `sandbox`, `us`, `au`, `eu`, or `uk`.
- Path IDs containing `.`/`..`, separators, encoded separators or control characters are
  rejected before any request.
- `@wyre-ai/node-dubber` bumped to `^1.1.0`; Node.js 22+ required.
- The Docker build takes GitHub Packages auth as a BuildKit secret (`npmrc`) instead of a
  `GITHUB_TOKEN` build arg, and pins the base image by digest.
- CI installs with `--ignore-scripts` and checks out with `persist-credentials: false`; the
  release workflow is pinned to reusable-workflows `508ef4d` with `fail-on-severity:
  HIGH,CRITICAL`.

### Removed

- `DUBBER_BASE_URL`. The host is always `https://api.dubber.net`.

Entries below this line are written by semantic-release from commit history.
