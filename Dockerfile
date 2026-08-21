# syntax=docker/dockerfile:1
#
# NVC360 web application — production container image.
#
# Why this file exists: until now the only definition of "how NVC360 runs" lived
# inside the Runable build pipeline. That made the app un-deployable anywhere
# else and un-testable in staging. This image is the portable artifact that
# CI/CD, staging, and Terraform all target.
#
# Design notes:
#   * ONE process serves both the Hono API (/api/*) and the built SPA (/*), the
#     same as production today (packages/web/src/server.ts).
#   * Bun executes the TypeScript entrypoint directly, so the runtime layer
#     needs src/ as well as the Vite build output in dist/.
#   * `tsc --noEmit` is deliberately NOT run here. Typechecking belongs in CI
#     (.github/workflows/ci.yml already gates it). Running it in the image build
#     would double the build time and couple deploys to a known set of
#     pre-existing Hono method-chain type false-positives.
#   * The AWS SDK must never be reintroduced server-side — it pulled ~570
#     modules / 1.4 MB and OOM'd the bundler. Storage goes through Bun.S3Client,
#     which speaks the plain S3 wire protocol (Tigris today, S3 or any
#     compatible endpoint tomorrow, by env var alone).
#
# Build:  docker build -t nvc360-web:local .
# Run:    docker run --rm -p 4200:4200 --env-file .env nvc360-web:local

# Pinned to the same Bun version as package.json "packageManager".
ARG BUN_VERSION=1.3.5

# ---------------------------------------------------------------------------
# Stage 1 — dependencies. Cached on the lockfile alone, so source edits do not
# re-resolve the dependency graph.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app

# Workspace manifests only. bun install --frozen-lockfile requires every
# workspace member's package.json to be present to validate bun.lock.
COPY package.json bun.lock ./
COPY packages/web/package.json      packages/web/package.json
COPY packages/mobile/package.json   packages/mobile/package.json
COPY packages/desktop/package.json  packages/desktop/package.json

RUN bun install --frozen-lockfile


# ---------------------------------------------------------------------------
# Stage 2 — build the SPA. Vite inlines VITE_* values at build time, so they are
# build args, not runtime env. Everything else (DATABASE_URL, S3_*, Stripe,
# Twilio) is read at runtime by the server and must NOT be baked in.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS build
WORKDIR /app

ARG VITE_SENTRY_DSN=""
ARG VITE_SENTRY_ENV="production"
ARG VITE_APPLICATION_ID=""
ARG VITE_RUNABLE_AUTH_ISSUER=""
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN} \
    VITE_SENTRY_ENV=${VITE_SENTRY_ENV} \
    VITE_APPLICATION_ID=${VITE_APPLICATION_ID} \
    VITE_RUNABLE_AUTH_ISSUER=${VITE_RUNABLE_AUTH_ISSUER} \
    NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY . .

# vite build only — see header note on tsc.
RUN cd packages/web && bunx vite build \
    && test -f dist/index.html \
    || (echo "BUILD FAILED: packages/web/dist/index.html was not produced" && exit 1)


# ---------------------------------------------------------------------------
# Stage 3 — runtime. Carries node_modules, the built SPA, the server source,
# and the committed Drizzle migrations. Mobile and desktop workspace modules
# (Expo, Electron) are dropped — the server never imports them.
# ---------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4200

COPY --from=deps  /app/node_modules              ./node_modules
COPY --from=deps  /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=build /app/packages/web/dist         ./packages/web/dist

COPY package.json bun.lock ./
COPY packages/web/package.json        ./packages/web/package.json
COPY packages/web/tsconfig.json       ./packages/web/tsconfig.json
COPY packages/web/tsconfig.app.json   ./packages/web/tsconfig.app.json
COPY packages/web/tsconfig.node.json  ./packages/web/tsconfig.node.json
COPY packages/web/drizzle.config.ts   ./packages/web/drizzle.config.ts
COPY packages/web/src                 ./packages/web/src
COPY packages/web/drizzle             ./packages/web/drizzle

# Local-disk upload fallback path (server.ts serves /uploads/* from cwd).
# Real uploads go to object storage; this only exists so the path is writable.
RUN mkdir -p /app/packages/web/uploads && chown -R bun:bun /app/packages/web

# Drop the non-server workspaces if the build context carried them in.
RUN rm -rf packages/mobile packages/desktop

USER bun
WORKDIR /app/packages/web
EXPOSE 4200

# /api/ready is the app's own readiness probe (DB round-trip included).
# Cloud load balancers should point their health check at the same path.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD bun -e 'const r = await fetch(`http://127.0.0.1:${process.env.PORT ?? 4200}/api/ready`); process.exit(r.ok ? 0 : 1)'

CMD ["bun", "src/server.ts"]
