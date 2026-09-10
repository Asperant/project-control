# Architecture

## Manual roadmap domain

Registered projects own milestones, milestones own tasks, and task detail owns
acceptance criteria, dependency links, and notes. The Control API is the only
write path. Domain transactions lock the project row before mutation, which
makes archived-project enforcement, reorder, and dependency graph changes
atomic. Progress is derived from task status. Activity reuses append-only
`audit_events`; no second history subsystem exists. The runner, project files,
n8n, and Git are outside this data path. See [manual-roadmap.md](manual-roadmap.md).

## Resume and Work Session domain

`GET /api/projects/:projectId/resume` composes a read-only operational view in
the Control API. React renders that response and never reselects the recommended
roadmap action. The composer reuses Current Context (including the accepted
`recentAgentWork` loader), current memory, roadmap state and Work Session reads.
It adds the compact read-only Development service result without changing
roadmap selection. It makes no LLM or n8n call.

Work Session mutations use the existing project guard and append-only audit
transaction pattern. Closing with a checkpoint first captures best-effort Git
metadata, then builds the deterministic v3 snapshot, inserts it, links it to the session and writes required
audit events within one PostgreSQL transaction. Any failure rolls back all
effects. Closed rows remain immutable; corrections are separate, append-only
`work_session_amendments` rows. See
[work-sessions-resume.md](work-sessions-resume.md).

## Repository Actions domain

The platform's first write path into a project's own repository: plan →
confirm+execute → verify → settle, one `project_actions` row per action,
immutable once settled and never physically deleted. `git.commit` is the
only action kind. The Control API builds and fingerprints a plan from a
fresh runner read, and the runner (`project.git.commit`) performs the one
write — scoped to a project's `.git` directory only, and only when that
project is on a separate, empty-by-default, root-managed write-enabled list.
See [repository-actions.md](repository-actions.md).

## Service identity domain

The platform's first non-human principal. `service_accounts` is a small,
compiled-in registry (`apps/control-api/src/auth/service-accounts.ts`),
reconciled into the database at boot; `service_tokens` are minted only by
`pcctl create-service-token`, never by a route. A service token authenticates
over `Authorization: Bearer`, resolved by `createResolvePrincipal` — a
preHandler distinct from, and additive to, the cookie-only `createRequireAuth`
every pre-existing route still uses unchanged. Only a route that explicitly
wires the new preHandler can ever be reached by one; scope
(`requireScope`) and principal kind (`requirePrincipalKind`) compose on top of
it for routes that must accept both kinds of caller but still restrict a
specific action to a human. See [service-accounts.md](service-accounts.md).

## Automation domain

n8n's first legitimate way to call the Control API, layered on service
identity above it. Workflow *definitions* are a repository-owned,
read-only-mounted manifest (`infra/n8n/workflows/manifest.json`), validated
at boot — never a database table, never editable through a route. Workflow
*run history* is the opposite: `workflow_runs` and append-only
`workflow_run_steps` are the authoritative record, deliberately not trusted
to n8n's own execution log, which this deployment prunes after 14 days. A
manual run opens `queued` and is claimed by n8n polling
`POST /api/automation/queue/claim` (`FOR UPDATE SKIP LOCKED`, so two
concurrent claims can never win the same row) — because Control API cannot
call n8n; n8n publishes no inbound HTTP surface, verified functionally
(`N8N-001`) as well as by static lint of every shipped workflow file
(`N8N-002`, `scripts/lib/workflow-lint.py`). A scheduled run opens directly
into `running`. Severity → notification policy is decided server-side from
the manifest at settle time, never by a workflow's own logic. See
[automation.md](automation.md).

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

### Project registration surface

Added alongside the Stage 1 routes above; see
[`project-registration.md`](project-registration.md) for the full user-facing
flow and [`security-model.md`](security-model.md#11-project-registration) for
the security design.

| Route | Auth | Purpose |
| --- | --- | --- |
| `POST /api/projects/inspections` | session + CSRF, admin/operator | read-only folder inspection → a single-use, expiring preview |
| `GET /api/projects/inspections/:id` | session | view a previously created inspection preview |
| `POST /api/projects` | session + CSRF, admin/operator | create a project from a confirmed inspection |
| `GET /api/projects` | session | paginated, filtered, sorted list |
| `GET /api/projects/:id` | session | project detail |
| `PATCH /api/projects/:id` | session + CSRF, admin/operator | update general information |
| `POST /api/projects/:id/archive` | session + CSRF, admin/operator | archive (never a physical delete) |
| `POST /api/projects/:id/reactivate` | session + CSRF, admin/operator | reactivate an archived project |
| `GET /api/projects/:id/activity` | session | project-scoped audit history |
| `POST/PATCH/DELETE /api/projects/:id/rules/...` | session + CSRF, admin/operator | project rules |
| `POST/DELETE /api/projects/:id/technologies/...` | session + CSRF, admin/operator | operator-added technologies (detected ones cannot be deleted, only removed by a rescan no longer finding them) |
| `POST/PATCH/DELETE /api/projects/:id/commands/...` | session + CSRF, admin/operator | command **metadata** — never executed by any part of this platform |
| `POST /api/projects/:id/rescan` | session + CSRF, admin/operator | re-inspect and compute a diff against the stored profile |
| `POST /api/projects/:id/rescan/apply` | session + CSRF, admin/operator | apply an operator-confirmed diff |

Every write route requires the `admin` or `operator` role (`viewer` is
read-only); this reuses the existing `role` column and `requireRole` guard
rather than introducing a second authorization system.

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

Project-registration operations: `project.path.validate`, `project.inspect`,
`project.git.summary`, `project.git.development`, `project.git.write.status`.
All read-only, and all gated by the same `internal/projectpath` check — a
caller-supplied path is only ever resolved against a fixed, root-owned list
of allowed roots (see `config/allowed-project-roots.conf` and the systemd
drop-in below), never against caller-supplied roots.

**The one exception to "no execution path" is `git`**, invoked by
`project.inspect`/`project.git.summary`/`project.git.development`/
`project.git.write.status` with a fixed, hardcoded argv per subcommand and
only against a directory `internal/projectpath` has already validated.
`internal/gitinfo`'s package doc explains why this is the safer choice over a
from-scratch reimplementation of `git status` (which would mean parsing the
binary index format and replicating gitignore semantics — real parsing of a
complex on-disk format, with a wrong reimplementation silently misreporting a
project's state). `GIT_OPTIONAL_LOCKS=0` plus `--no-optional-locks` guarantee
the invocation never writes to `.git/index`; only read-only, non-hook-invoking
subcommands are used (`rev-parse`, `symbolic-ref`, `show-ref`,
`config --get-regexp`, `log`, `status`) — never fetch, pull, checkout, commit
or merge.

**`project.git.commit` is the runner's one mutating operation** — see
[repository-actions.md](repository-actions.md) and
`internal/gitwrite`'s package doc, kept in a separate package from the
read-only `internal/gitinfo` so "gitinfo never writes" stays true by
construction. It is reachable only for a project on the separate, empty-by-
default write-enabled list (`internal/projectpath.ValidateWritable`), never
touches the working tree (only `.git`, via plumbing against a throwaway
index), never runs a hook, and CAS-guards the one ref update it performs
against an operator-observed HEAD.

**Allowed roots and the systemd drop-in.** The runner reads
`config/allowed-project-roots.conf` — a root-owned, non-secret, newline-
separated list of directories — at start-up. `scripts/install.sh` generates a
matching systemd drop-in,
`project-control-runner.service.d/10-allowed-roots.conf`, adding one
`BindReadOnlyPaths=` exception per configured root to the base unit's
`ProtectHome=tmpfs`. This is systemd's own documented mechanism for punching a
narrow, read-only hole in `ProtectHome`/`ProtectSystem=strict` — the runner
never gains broader `/home` access, and the exception is always read-only.
(`ProtectHome=tmpfs` rather than `=yes`: systemd cannot create a
`BindReadOnlyPaths=` mount point nested under a path `ProtectHome=yes` has
made inaccessible, so the exception would silently never apply.)
Both the config file and the drop-in are written only by root-run tooling; the
web panel and Control API cannot reach either.

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

Project-registration tables (migrations `0003`/`0004`): `projects` (location
and repository facts live as columns on this table, not a separate 1:1 table —
both are intrinsic, always-one-or-none-per-project attributes, so a join would
buy nothing), `project_technologies`, `project_rules`, `project_commands`, and
`project_inspections` — the short-lived, server-held result of a folder scan,
which also doubles as the rescan-diff staging area via its nullable
`project_id`. A partial unique index enforces one active project per canonical
filesystem path and, separately, per normalised repository identity; both are
scoped to non-archived projects, so an archived project never blocks a fresh
registration of the same folder or repository.

Work Session tables (migrations `0011`/`0012`): `work_sessions` and
`work_session_amendments`. A partial unique index permits at most one open row
per project. A composite foreign key `(project_id, checkpoint_id)` prevents
cross-project checkpoint links. Lifecycle and mutation triggers protect open
field rules, closed history and closed-parent-only amendments; grants deny
physical deletion and make amendments append-only for `control_app` while
`backup_reader` remains SELECT-only.

Repository Actions table (migrations `0013`/`0014`): `project_actions`. A
partial unique index permits at most one `planned`/`running` row per project.
A lifecycle trigger enforces the fixed status transition graph and freezes a
row once it reaches a terminal status (`succeeded`, `failed`, `cancelled`,
`expired`); grants deny physical deletion for `control_app`, and
`backup_reader` remains SELECT-only. See
[repository-actions.md](repository-actions.md).

Service identity tables (migrations `0015`/`0016`): `service_accounts` and
`service_tokens`. A trigger rejects a token whose scopes exceed its account's
scope ceiling; a second trigger makes every identity field immutable once a
token exists and makes revocation one-way. Grants deny physical deletion for
`control_app` on both tables, and `backup_reader` remains SELECT-only. See
[service-accounts.md](service-accounts.md).

Automation tables (migrations `0017`/`0018`): `workflow_runs` and append-only
`workflow_run_steps`. A partial unique index permits at most one
`queued`/`running` row per workflow; a second partial index enforces the
manifest's idempotency window while specifically excluding `cancelled`/
`expired` rows, so an aborted or lapsed attempt never blocks a legitimate
retry. A lifecycle trigger enforces the transition graph only when status
actually changes (a same-status update, e.g. touching only a lease
timestamp, is not a transition) and freezes a row once it reaches a terminal
status. `control_app` cannot `DELETE` from `workflow_runs`; it cannot
`UPDATE` `workflow_run_steps` at all. `backup_reader` remains SELECT-only on
both. See [automation.md](automation.md).

Development State adds no table or migration. Live Git metadata is not cached
in PostgreSQL; only compact Git state is persisted inside new immutable
checkpoint v3 JSON. Historical v1/v2 rows remain untouched.

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
