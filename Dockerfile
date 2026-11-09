# Multi-stage build. linux/amd64 per fleet law. GitHub Packages auth for the
# @wyre-ai/* SDK is a BuildKit secret, never a build arg or image layer:
#   printf '@wyre-ai:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$(gh auth token)" > /tmp/dubber.npmrc
#   docker build --platform linux/amd64 --secret id=npmrc,src=/tmp/dubber.npmrc -t dubber-mcp .
# The release workflow (WYRE-AI/reusable-workflows mcp-server-release.yml)
# supplies the same `npmrc` secret.

# node:22-alpine, pinned by manifest-list digest. Bump deliberately.
FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS builder

WORKDIR /app

COPY package*.json ./
# --ignore-scripts: no dependency lifecycle scripts run during install.
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev && npm cache clean --force

FROM node:22-alpine@sha256:0e1754758c2df4cfa3e68d59e2e1b7374bb7fd9ea6328eaaacf15cc934af8202 AS production

RUN apk -U upgrade --no-cache \
  && addgroup -g 1001 -S dubber \
  && adduser -S dubber -u 1001 -G dubber

WORKDIR /app

COPY --from=builder --chown=dubber:dubber /app/package.json ./
COPY --from=builder --chown=dubber:dubber /app/dist ./dist
COPY --from=builder --chown=dubber:dubber /app/node_modules ./node_modules

# npm/npx are not needed at runtime and carry their own CVE surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

USER dubber

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# 0.0.0.0 is safe only because startup refuses to listen without a real
# CONDUIT_S2S_SECRET, supplied at runtime by the platform and never baked into
# the image. AUTH_MODE=gateway never reads DUBBER_* credentials; they arrive
# per request on the X-Dubber-* headers. Every tool is read-only; read is the
# only tier, and any other DUBBER_TOOL_TIERS value refuses to start.
ENV NODE_ENV=production \
    LOG_LEVEL=info \
    MCP_TRANSPORT=http \
    MCP_HTTP_PORT=8080 \
    MCP_HTTP_HOST=0.0.0.0 \
    AUTH_MODE=gateway \
    DUBBER_TOOL_TIERS=read

CMD ["node", "dist/index.js"]

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"

LABEL maintainer="engineering@wyre.ai"
LABEL version="${VERSION}"
LABEL org.opencontainers.image.title="dubber-mcp"
LABEL org.opencontainers.image.description="Model Context Protocol server for Dubber (call recording, compliance, Dub.Point)"
LABEL org.opencontainers.image.version="${VERSION}"
LABEL org.opencontainers.image.created="${BUILD_DATE}"
LABEL org.opencontainers.image.revision="${COMMIT_SHA}"
LABEL org.opencontainers.image.source="https://github.com/WYRE-AI/dubber-mcp"
LABEL org.opencontainers.image.documentation="https://github.com/WYRE-AI/dubber-mcp/blob/main/README.md"
LABEL org.opencontainers.image.url="https://github.com/WYRE-AI/dubber-mcp/pkgs/container/dubber-mcp"
LABEL org.opencontainers.image.vendor="Wyre Technology"
LABEL org.opencontainers.image.licenses="Apache-2.0"

# MCP Registry ownership annotation (must match `name` in server.json)
LABEL io.modelcontextprotocol.server.name="io.github.WYRE-AI/dubber-mcp"
