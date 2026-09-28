# Multi-stage build for efficient container size.
# Build with: docker build --platform linux/amd64 --build-arg GITHUB_TOKEN=$(gh auth token) -t dubber-mcp .
FROM node:22-alpine AS builder

ARG VERSION="unknown"
ARG COMMIT_SHA="unknown"
ARG BUILD_DATE="unknown"
ARG GITHUB_TOKEN

WORKDIR /app

COPY package*.json ./

# Install dependencies with GitHub Packages auth for @wyre-ai/* scope.
# --ignore-scripts prevents lifecycle scripts from running before source is copied.
RUN echo "@wyre-ai:registry=https://npm.pkg.github.com" > .npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}" >> .npmrc && \
    npm ci --ignore-scripts && \
    rm -f .npmrc

COPY . .

RUN npm run build

# Prune dev dependencies in the builder so the production stage copies a
# runtime-only node_modules (no re-install, no registry auth needed).
RUN npm prune --omit=dev && npm cache clean --force

FROM node:22-alpine AS production

# Pull latest Alpine package fixes even when the base layer is cached
RUN apk -U upgrade --no-cache

RUN addgroup -g 1001 -S dubber && \
    adduser -S dubber -u 1001 -G dubber

WORKDIR /app

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules

# Remove the npm CLI from the production image — the runtime only needs `node`,
# and npm's bundled dependencies regularly trip vulnerability scanners.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx && \
    chown -R dubber:dubber /app

USER dubber

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

ENV NODE_ENV=production
ENV LOG_LEVEL=info
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=8080
ENV MCP_HTTP_HOST=0.0.0.0
# Default to env mode; set to 'gateway' for hosted deployment behind the WYRE gateway
ENV AUTH_MODE=env

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
