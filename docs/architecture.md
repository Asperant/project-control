# Architecture

## Overview

```
                    ┌─────────────────────────────────────┐
                    │  Tailnet device (browser)           │
                    └──────────────┬──────────────────────┘
                                   │ HTTPS (Tailscale, WireGuard)
                    ┌──────────────▼──────────────────────┐
                    │  tailscaled  (host)                 │
                    │    :443  → 127.0.0.1:8780           │
                    │    :8443 → 127.0.0.1:5678           │
                    └──────┬───────────────────┬──────────┘
                           │                   │
     ══════════════════════│═══════════════════│════════════ host loopback
                           │                   │
                    ┌──────▼──────┐     ┌──────▼──────┐
        edge ───────┤    caddy    │     │     n8n     │
                    └──────┬──────┘     └──┬───────┬──┘
                           │               │       │
     application ──────────┼───────────────┘       │
                     ┌─────┴─────┐                 │
              ┌──────▼───┐  ┌────▼────────┐        │
              │   web    │  │ control-api │        │
              └──────────┘  └──────┬──────┘        │
                                   │               │
     data ─────────────────────────┼───────────────┘   (internal: no gateway)
                            ┌──────▼──────┐
                            │  postgres   │
                            └─────────────┘

                    ┌─────────────────────────────────────┐
                    │  project-control-runner.service     │
                    │  (host, unprivileged, Go binary)    │
                    │  /run/project-control/runner.sock   │◄── bind-mounted
                    └─────────────────────────────────────┘     into control-api
```

## Components

### Control API (`apps/control-api`)

TypeScript on Fastify 5. Owns authentication, sessions, the audit trail, the
artifact store and the runner client. Talks to PostgreSQL as `control_app` — a
role with no DDL rights and no ability to modify audit history.

Stage 1 surface:

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /health/live` | none | process liveness; never touches PostgreSQL |
| `GET /health/ready` | none | readiness; 503 when a hard dependency is down |
| `POST /api/auth/login` | none | rate-limited login |
| `POST /api/auth/logout` | session + CSRF | revoke the session |
| `GET /api/auth/me` | session | current user; mints a fresh CSRF token |
| `GET /api/system/status` | session | dashboard payload |
| `POST /api/artifacts/self-test` | session + CSRF | storage round-trip diagnostic |

`/health/*` is deliberately **not** routed through Caddy, so it is reachable
only from inside the container network — Docker's healthcheck runs there.

### Web panel (`apps/web`)

React 19 + Vite, served as static files by a minimal Caddy instance. It talks
only to `/api` on its own origin, which is what allows the session cookie to be
`SameSite=Strict`. There is no configurable API base URL and no cross-origin
request anywhere in the bundle.

### Runner (`apps/runner`)

A Go binary on the **host**, run by systemd as `project-runner`. It exists
because some future operations must touch the host, and doing that from inside a
container would require either the Docker socket or elevated capabilities —
both of which are worse than a small, auditable, unprivileged service.

Design constraints, all enforced rather than documented-only:

- **Unix socket only.** `RestrictAddressFamilies=AF_UNIX` in the unit means the
  kernel would refuse a TCP socket even if the code tried to open one.
- **No execution path.** There is no `os/exec` import in the binary. The wire
  protocol has no field for a command, argv, script, cwd or environment, and
  `DisallowUnknownFields` rejects a request that invents one.
- **Compiled-in registry.** Operations are a fixed table; there is no
  registration API and no config file that can add one.
- **Refuses root.** The process exits at start-up if uid or euid is 0.
- **No third-party dependencies.** Standard library only, so the supply chain of
  the one host-resident component is this repository.

Stage 1 operations: `system.health`, `runner.selftest`. Both read-only.

### PostgreSQL

One instance, two databases, four roles.

| Role | `project_control` | `n8n` | Rights |
| --- | --- | --- | --- |
| `control_app` | connect | **denied** | SELECT/INSERT/UPDATE; INSERT-only on `audit_events` |
| `control_migrator` | connect, owner | **denied** | DDL |
| `n8n_app` | **denied** | connect, owner | full, within its own database |
| `backup_reader` | connect | connect | SELECT only |

Isolation is enforced by revoking `CONNECT` from `PUBLIC` on each database and
granting it only where it belongs — so a role cannot open a connection to the
other database at all, let alone read from it. `verify-security` asserts each of
these six connect/deny combinations against the live cluster.

### Caddy

Two containers run Caddy: the edge proxy and the static `web` server. Both use a
**locally built thin layer** over the pinned upstream image
(`infra/caddy/Dockerfile`, `apps/web/Dockerfile`) rather than the stock image.

The reason is concrete: upstream ships `/usr/bin/caddy` with the file capability
`cap_net_bind_service=ep` so it can bind :80/:443 unprivileged. Under
`cap_drop: ALL` the capability *bounding set* is empty, and `execve()` of a
binary carrying permitted file capabilities absent from the bounding set fails
with `EPERM` — the container never starts at all. Neither container binds a
privileged port (8780 and 8081), so the capability is pure liability. The build
copies the binary (which does not preserve extended attributes, stripping the
capability) and removes the original.

`XDG_CONFIG_HOME` and `XDG_DATA_HOME` are set to `/tmp` so Caddy's autosave and
state directories land on the one writable tmpfs under `read_only: true`,
instead of failing against root-owned `/data` and `/config` mounts.

Local reverse proxy on `127.0.0.1:8780`. `auto_https off` and `admin off`: it
never requests a certificate, never makes an outbound call, and exposes no
control plane. n8n is deliberately **not** routed through it, so a
misconfiguration here cannot expose n8n and a compromise here does not reach it.

### n8n

PostgreSQL-backed (`DB_TYPE=postgresdb`), never SQLite. Telemetry, diagnostics,
personalisation, version notifications, templates and the public REST API are
all disabled. Every environment variable used was verified against the
`@n8n/config` package inside the pinned 2.34.0 image rather than taken from
documentation that may describe a different release.

## Networks

| Network | `internal` | Members | Rationale |
| --- | --- | --- | --- |
| `edge` | no | caddy | the only tier with a published port |
| `application` | no | caddy, web, control-api, n8n | request path |
| `data` | **yes** | control-api, n8n, postgres | no gateway, so PostgreSQL has no route off the host |

`web` is on `application` only: it has no route to the database whatsoever,
which is the correct blast radius for a container serving static files.

## Storage

### Artifacts

Content-addressed on the host filesystem:

```
/srv/project-control/data/artifacts/
  objects/<first two hex chars>/<full sha256>
  temporary/<random>.part
```

Write path: stream to `temporary/` while hashing → `fsync` → verify the digest →
`rename(2)` into `objects/`. `rename` within one filesystem is atomic, so a
reader sees either no object or the complete object, never a partial one.

**Why traversal is impossible rather than filtered.** The object path is derived
solely from a digest validated against `^[0-9a-f]{64}$`. A caller-supplied
filename never participates in path construction — it is metadata in PostgreSQL
only. There is no input that can contain `/`, `..` or a NUL byte and still reach
the path builder. `resolveObjectPath` additionally re-checks containment, which
would catch a future refactor that reintroduced caller-controlled segments.

Reads use `lstat` and reject symlinks, so a link planted in the object tree
cannot redirect a read to an arbitrary host file.

Deletion is metadata-only (`archived_at`); bytes are never unlinked by the
application.

The `ArtifactStore` interface is defined in terms an S3 adapter can satisfy —
content-addressed keys, streaming I/O, no filesystem paths in the signatures —
so a later stage can add one without touching callers.

### Database

Stage 1 tables: `users`, `sessions`, `audit_events`, `schema_migrations`,
`system_settings`, `artifact_objects`.

Migrations are checksum-verified: editing an applied migration aborts start-up
rather than letting the recorded history diverge from the live schema. A
session-level advisory lock serialises concurrent runners.

## Authentication

- Argon2id, OWASP parameters (m=19456 KiB, t=2, p=1).
- Unknown accounts still pay the full hashing cost, so response timing does not
  reveal whether an email exists.
- Sessions are opaque 256-bit tokens; **only the SHA-256 is stored**, so a
  database dump — which `backup_reader` produces and which lands in Google
  Drive — contains nothing replayable.
- Cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`.
- CSRF: double-submit token bound to the session, compared in constant time,
  plus an independent `Origin` check.
- Both absolute and idle expiry; idle is a sliding window on `last_seen_at`.

## Version selection rationale

**PostgreSQL 17.10 rather than 18.x.** 18 is generally available, but 17 is the
newest major the pinned n8n release is known to run against in production. The
gain from 18 here is negligible; the cost of an incompatibility in the
automation engine is a broken deployment. Revisit when n8n documents 18.

**n8n pinned to `2.34.0`, not `stable`.** The `stable` tag floats between the
1.x and 2.x lines and resolves to a different digest than `2.34.0`. A floating
tag defeats the purpose of a version lock.

**Caddy for the static file server too.** Using the already-pinned Caddy image
instead of adding nginx keeps the image count — and therefore the patch
surface — smaller.

**No named volumes.** Every piece of state is a bind mount under
`/srv/project-control`, which makes it directly visible to restic without a
helper container and makes ownership auditable with `ls`.
