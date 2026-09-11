# Project Memory & Development Control Center

A self-hosted control plane for project memory and development operations,
reachable **only** over a Tailscale tailnet. Nothing in this deployment is
published to the public internet.

The platform delivers the foundation — authentication, an immutable artifact
store, a confined host runner, automation (n8n), encrypted off-site backups —
plus the project-management features built on top of it: manual roadmap,
project memory and checkpoints, an agent-run archive, a deterministic Resume
briefing, read-only development (Git) state, controlled repository actions,
and global search with an activity timeline. `./pcctl verify` and
`./pcctl verify-security` prove all of it is actually configured the way this
document claims.

---

## What it consists of

| Component | Technology | Where it runs | Exposure |
| --- | --- | --- | --- |
| Control API | TypeScript, Fastify, PostgreSQL | container | `application` + `data` networks |
| Web panel | React, TypeScript, Vite | container | `application` network |
| Reverse proxy | Caddy | container | `127.0.0.1:8780` |
| Automation | n8n | container | `127.0.0.1:5678` |
| Database | PostgreSQL 17.10 | container | `data` network only |
| Runner | Go static binary | **host**, systemd | Unix socket only |
| Backup | restic + rclone → Google Drive | host, systemd timers | outbound only |

Access is via Tailscale Serve:

```
https://<host>.<tailnet>.ts.net/       → portal   (Caddy → web / control-api)
https://<host>.<tailnet>.ts.net:8443/  → n8n admin
```

---

## Quick start

```bash
# 1. Inspect the host. Read-only; changes nothing.
./pcctl preflight

# 2. Install (creates /srv/project-control, builds images, starts the stack)
sudo ./pcctl install

# 3. Manual checkpoints — each needs a human, once
sudo ./pcctl configure-tailscale      # tailnet login + HTTPS
sudo ./pcctl create-admin             # first administrator account
sudo ./pcctl configure-google-drive   # OAuth + restic password
sudo ./pcctl configure-telegram       # bot token + chat id
#    …then open the n8n URL and create its owner account

# 4. Verify
./pcctl verify
./pcctl verify-security
```

Full walkthrough: [docs/installation.md](docs/installation.md).
Every interactive step: [docs/manual-checkpoints.md](docs/manual-checkpoints.md).

---

## `pcctl`

```
SETUP        preflight  install  create-admin
LIFECYCLE    start  stop  restart  status  health  logs
CHECKPOINTS  configure-tailscale  configure-google-drive  configure-telegram
BACKUP       backup  restore-test
VERIFY       verify [--json]  verify-security [--json]
MAINTENANCE  update  rollback  uninstall
```

`install`, `verify` and every configure step are idempotent: running them twice
is safe and is the intended way to reconcile drift.

---

## Security posture

The properties below are **asserted by `./pcctl verify-security`**, not merely
intended. If a check fails, this section is wrong about your host.

- No port is published on a public interface. Caddy and n8n bind `127.0.0.1`
  only; PostgreSQL, the Control API, the web container and the runner publish
  nothing at all.
- The Docker socket is not mounted into any container, and the runner's user is
  not in the `docker` group.
- Every container: non-root, `cap_drop: ALL`, `no-new-privileges`, PID and memory
  limits, bounded logs, healthcheck. All but PostgreSQL also run with a
  read-only root filesystem.
- Four PostgreSQL roles with no overlapping reach. `control_app` cannot connect
  to the `n8n` database; `n8n_app` cannot connect to `project_control`; neither
  can run DDL; the audit trail is append-only at the grant level.
- The runner executes nothing. It has no `exec` path, no shell, and a
  compiled-in operation registry — a request naming `/bin/sh` is simply an
  unknown operation.
- No default account, no default password. The first administrator is created
  interactively; passwords are hashed with Argon2id (OWASP parameters).
- Secrets live in `0700` root-owned files, are distributed per-service at
  `0640`, and are read from files rather than environment variables.
- Telegram is outbound-only: no webhook, no polling, no inbound endpoint.

Detail and threat model: [docs/security-model.md](docs/security-model.md).

---

## Repository layout

```
apps/
  control-api/   Fastify API — auth, sessions, artifacts, health, runner client
  web/           React operator panel
  runner/        Go host runner (no third-party dependencies)
packages/
  contracts/     Zod schemas shared by API and web
infra/
  compose/       docker compose stack definition
  caddy/         reverse proxy configuration
  postgres/      cluster initialisation (roles, databases, grants)
  systemd/       runner, stack, backup, check and restore-test units
  n8n/           example workflow (contains no credentials)
  versions.lock.env   every image pinned by digest
migrations/      SQL migrations for project_control
scripts/         implementation behind pcctl
docs/            operator documentation
reports/         preflight and verification output
tests/           cross-cutting test helpers
```

---

## Version pinning

Every container image is pinned to an immutable manifest digest in
[`infra/versions.lock.env`](infra/versions.lock.env), resolved from the official
upstream registry. No `latest`, no floating tag, no `^` or `~` in any manifest.

| Component | Version |
| --- | --- |
| PostgreSQL | 17.10 |
| n8n | 2.34.0 |
| Caddy | 2.11.4 |
| Node.js | 24.19.0 |
| Go | 1.26.5 |

---

## Documentation

| Document | Contents |
| --- | --- |
| [architecture.md](docs/architecture.md) | Components, networks, data flow, design rationale |
| [security-model.md](docs/security-model.md) | Threat model and every control, with its verification |
| [project-registration.md](docs/project-registration.md) | Registering, inspecting, rescanning and archiving projects |
| [manual-roadmap.md](docs/manual-roadmap.md) | Manual milestones, tasks, criteria, dependencies, notes and progress |
| [project-memory.md](docs/project-memory.md) | Manual memory entries, supersede history, immutable checkpoints, "Where was I?" |
| [agent-runs.md](docs/agent-runs.md) | Per-project archive of agent prompts/reports and human verification status |
| [work-sessions-resume.md](docs/work-sessions-resume.md) | Work Session lifecycle and the deterministic Resume ("Where was I?") briefing |
| [development-state.md](docs/development-state.md) | Read-only Git state (status, recent commits, tracking refs) surfaced to project continuity |
| [repository-actions.md](docs/repository-actions.md) | Controlled, previewed repository commits: plan → confirm → execute → verify |
| [service-accounts.md](docs/service-accounts.md) | Machine (Bearer token) identity for automation callers: scope, minting, closed-by-default routing |
| [automation.md](docs/automation.md) | n8n workflow runs: manifest, claim/settle lifecycle, idempotency, notification policy |
| [automation-acceptance.md](docs/automation-acceptance.md) | Live acceptance runbook run against production for the automation feature |
| [production-handoff.md](docs/production-handoff.md) | Task-oriented index for an operator: install, update, rollback, recover, backup, restore and every project screen, one paragraph each with a link to full depth |
| [installation.md](docs/installation.md) | Clean-machine install on Ubuntu 22.04 |
| [manual-checkpoints.md](docs/manual-checkpoints.md) | The five steps that need a human |
| [operations.md](docs/operations.md) | Daily operation, logs, secret rotation |
| [backup-restore.md](docs/backup-restore.md) | Backup scope, schedule, restore procedure |
| [update-rollback.md](docs/update-rollback.md) | Update flow, health gate, rollback |
| [disaster-recovery.md](docs/disaster-recovery.md) | Host failure, database failure, a bad deployment, a broken runner, a missing image, a failed backup |
| [troubleshooting.md](docs/troubleshooting.md) | Symptom → diagnosis → fix |
| [search-timeline-acceptance.md](docs/search-timeline-acceptance.md) | Live acceptance runbook for global search, the activity timeline and client-side routing |
| [stage1-acceptance.md](docs/stage1-acceptance.md) | Foundation acceptance criteria and how each is proven |
| [project-map.md](docs/project-map.md) | Where each concern lives in the repository, and which areas are high-risk to change |
| [quality-gates.md](docs/quality-gates.md) | Commands to run before calling any change complete |
| [release-checklist.md](docs/release-checklist.md) | The eleven gates a release must clear, and what `./pcctl release-manifest` answers for each |
| [risk-registry.md](docs/risk-registry.md) | Known risks, their mitigations, and current status |
| [test-scenarios.md](docs/test-scenarios.md) | Critical scenarios each feature's test suite must cover |

---

## Requirements

- Ubuntu 22.04 LTS, x86_64
- Docker Engine with the Compose v2 plugin
- systemd
- Tailscale (required — it is the only supported access path)
- Go 1.26.5 to build the runner
- Node.js 24 and pnpm for local development/tests only (installation builds them inside Docker)
- ≥ 4 GiB RAM, ≥ 20 GiB free disk

## Licence

Unlicensed / private.
