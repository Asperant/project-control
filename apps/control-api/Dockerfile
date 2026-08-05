# =============================================================================
# Control API image
#
# Base images are supplied as build args pinned to digests in
# infra/versions.lock.env; the build fails if they are not provided, so a
# floating tag can never sneak in via a default value.
# =============================================================================
ARG NODE_BUILD_IMAGE
ARG NODE_RUNTIME_IMAGE

# -----------------------------------------------------------------------------
# Stage 1 — dependencies + compile
# -----------------------------------------------------------------------------
FROM ${NODE_BUILD_IMAGE} AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

ARG PNPM_VERSION
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /build

# Manifests first so the dependency layer is cached independently of source.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/contracts/package.json  packages/contracts/
COPY apps/control-api/package.json    apps/control-api/

RUN pnpm install --frozen-lockfile --filter @project-control/control-api... \
 || pnpm install --filter @project-control/control-api...

COPY packages/contracts ./packages/contracts
COPY apps/control-api   ./apps/control-api

RUN pnpm --filter @project-control/contracts run build \
 && pnpm --filter @project-control/control-api run build

# Re-resolve with production dependencies only, so devDependencies (typescript,
# vitest, tsx) never reach the runtime image.
#
# `--legacy` is required from pnpm 10 onwards: the default deploy mode expects
# `inject-workspace-packages=true`, which this workspace deliberately does not
# set — @project-control/contracts is consumed as a normal workspace dependency
# and is bundled into the deploy output by the legacy resolver.
RUN pnpm --filter @project-control/control-api --prod deploy --legacy /deploy

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM ${NODE_RUNTIME_IMAGE} AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

# Dedicated unprivileged account. The default `node` user (uid 1000) is avoided
# so this container's uid does not collide with n8n's on shared bind mounts.
RUN groupadd --gid "${APP_GID}" control \
 && useradd --uid "${APP_UID}" --gid "${APP_GID}" --home-dir /app --no-create-home --shell /usr/sbin/nologin control

WORKDIR /app

COPY --from=builder --chown=root:root /deploy/node_modules ./node_modules
COPY --from=builder --chown=root:root /deploy/dist         ./dist
COPY --from=builder --chown=root:root /deploy/package.json ./package.json
COPY --chown=root:root migrations ./migrations

# Application files are owned by root and readable-but-not-writable by the
# runtime user, so a compromised process cannot rewrite its own code. This is
# what makes `read_only: true` in compose meaningful rather than cosmetic.
RUN chmod -R a-w /app

ENV NODE_ENV=production \
    NODE_OPTIONS="--max-old-space-size=384 --disable-proto=throw" \
    PC_MIGRATIONS_DIR=/app/migrations

USER control:control

EXPOSE 8080

# Healthcheck uses the liveness endpoint, which never touches PostgreSQL —
# a database outage must not cause Docker to restart-loop this container.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "dist/index.js"]
