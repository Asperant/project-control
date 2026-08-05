# =============================================================================
# Web panel image — built assets served by a minimal Caddy instance.
# =============================================================================
ARG NODE_BUILD_IMAGE
ARG CADDY_IMAGE

# -----------------------------------------------------------------------------
# Stage 1 — build the React bundle
# -----------------------------------------------------------------------------
FROM ${NODE_BUILD_IMAGE} AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true

ARG PNPM_VERSION
RUN corepack enable && corepack prepare "pnpm@${PNPM_VERSION}" --activate

WORKDIR /build

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml* tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json           apps/web/

RUN pnpm install --frozen-lockfile --filter @project-control/web... \
 || pnpm install --filter @project-control/web...

COPY packages/contracts ./packages/contracts
COPY apps/web           ./apps/web

RUN pnpm --filter @project-control/contracts run build \
 && pnpm --filter @project-control/web run build

# -----------------------------------------------------------------------------
# Stage 2 — static server
# -----------------------------------------------------------------------------
FROM ${CADDY_IMAGE} AS runtime

ARG WEB_UID=10003

# Caddy's image runs as root by default. It does not need to here: the listener
# is on 8081, above the privileged port range.
RUN addgroup -g "${WEB_UID}" web \
 && adduser -D -H -u "${WEB_UID}" -G web -s /sbin/nologin web

# /usr/bin/caddy ships with the file capability `cap_net_bind_service=ep`.
# Under `cap_drop: ALL` the capability bounding set is empty, and execve() of a
# binary carrying permitted file capabilities that are not in the bounding set
# fails with EPERM ("operation not permitted") — the container never starts.
# This server binds 8081, so the capability is pure liability. `cp` does not
# preserve extended attributes, so copying strips it; the original is then
# removed so no capability-carrying binary remains in the image.
RUN cp /usr/bin/caddy /usr/local/bin/caddy \
 && chmod 0755 /usr/local/bin/caddy \
 && rm -f /usr/bin/caddy

# Point Caddy's autosave/state directories at the only writable location under
# `read_only: true`, so it does not fail trying to write root-owned tmpfs.
ENV XDG_CONFIG_HOME=/tmp \
    XDG_DATA_HOME=/tmp

COPY --from=builder --chown=root:root /build/apps/web/dist /srv/www
COPY --chown=root:root apps/web/Caddyfile /etc/caddy/Caddyfile

# Served content is read-only to the serving user.
RUN chmod -R a-w /srv/www /etc/caddy/Caddyfile

USER web:web

EXPOSE 8081

HEALTHCHECK --interval=20s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8081/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
