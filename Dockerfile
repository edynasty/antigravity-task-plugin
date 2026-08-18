# syntax=docker/dockerfile:1
# Multi-stage build for the agy-gateway (OpenAI-compatible HTTP gateway that
# proxies to the local agy CLI as a subprocess). The gateway NEVER makes
# direct API calls; the runtime only needs plain compiled JS (node:http/fs/
# path/crypto), so the runtime image excludes node_modules, src and devDeps.

# --- Stage 1: build ---------------------------------------------------------
# The repo has no package-lock.json (only bun.lock) — plain `npm install`
# resolves devDeps (typescript etc.) for the `npm run build` step.
FROM node:22-slim AS build
WORKDIR /build
COPY package.json ./
RUN npm install
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: runtime -------------------------------------------------------
FROM node:22-slim AS runtime
# node:22-slim ships without curl or ca-certificates — both are required by
# the agy install script below (curl TLS verification needs the CA bundle).
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Install the official agy CLI (installs to /root/.local/bin/agy).
# In-container account sign-in is impossible (no OS keyring), so auth relies
# on the Gemini API key path: see README "Docker deployment" section.
RUN curl -fsSL --retry 3 --retry-delay 5 --retry-all-errors \
      https://antigravity.google/cli/install.sh | bash \
    && test -x /root/.local/bin/agy
ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /app
# Runtime needs only the compiled output and package.json (for the bin name).
COPY --from=build /build/dist ./dist
COPY --from=build /build/package.json ./package.json
# CRITICAL: default bind host is 127.0.0.1, which is unreachable from the
# host machine. Bind to all interfaces so the published port works.
ENV AGY_GATEWAY_HOST=0.0.0.0
EXPOSE 8787
# node:22-slim has no curl; use Node's built-in fetch for the health probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/v1').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
# agy agent-mode runs (accept-edits) operate relative to this working directory.
WORKDIR /workspace
CMD ["node", "/app/dist/gateway/cli.js"]
