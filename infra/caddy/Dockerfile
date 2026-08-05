# =============================================================================
# Edge reverse proxy image.
#
# A thin layer over the pinned upstream Caddy image whose only job is to make the
# binary runnable under `cap_drop: ALL`.
#
# WHY THIS IMAGE EXISTS
#
# The official Caddy image ships /usr/bin/caddy with the file capability
# `cap_net_bind_service=ep`, so it can bind :80/:443 as a non-root user. When a
# container drops all capabilities, the process's capability *bounding set* is
# empty — and execve() of a binary carrying permitted file capabilities that are
# not in the bounding set fails with EPERM:
#
#     exec /usr/bin/caddy: operation not permitted
#
# This deployment never binds a privileged port (the proxy listens on 8780, the
# static server on 8081), so the capability is not merely unnecessary — it is the
# only thing preventing the container from starting at all under our security
# posture.
#
# `cp` does not preserve extended attributes, so copying the binary strips the
# capability. That is deliberate here and is cheaper than adding libcap purely to
# run `setcap -r`.
# =============================================================================
ARG CADDY_IMAGE
FROM ${CADDY_IMAGE} AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

RUN addgroup -g "${APP_GID}" proxy \
 && adduser -D -H -u "${APP_UID}" -G proxy -s /sbin/nologin proxy

# Strip the file capability by copying, then remove the original so there is no
# capability-carrying binary left in the image at all.
RUN cp /usr/bin/caddy /usr/local/bin/caddy \
 && chmod 0755 /usr/local/bin/caddy \
 && rm -f /usr/bin/caddy

# Caddy stores autosaved config and TLS state under these paths. With
# `read_only: true` the only writable location is the /tmp tmpfs, and pointing
# Caddy there avoids needing writable /data and /config mounts that a non-root
# user could not write to anyway.
ENV XDG_CONFIG_HOME=/tmp \
    XDG_DATA_HOME=/tmp

USER proxy:proxy

EXPOSE 8780

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8780/healthz || exit 1

ENTRYPOINT ["/usr/local/bin/caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
