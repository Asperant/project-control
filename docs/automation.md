# Automation

## Principle

n8n has been part of this platform since the foundation build — pinned, hardened, database-backed,
never routed through Caddy — but until this feature it had no legitimate way to
call the Control API at all. It could only ever be an outbound notifier
(`infra/n8n/workflows/telegram-notification.example.json`). This feature gives it
a second, narrow capability: **read platform state and record the outcome of a
scheduled or operator-requested run**, using the service identity described in
[service-accounts.md](service-accounts.md).

The two features are deliberately layered — service identity is the *who*,
automation is the *what it's allowed to do with that identity*. A workflow run
can:

- read `/api/system/status` and the automation surface itself,
- record steps and a final result against a run it opened or claimed,
- attach a small text report artefact.

A workflow run can never execute a Repository Action, apply a rescan diff,
archive anything, or reach any route outside `/api/automation/*` — the same
closed-by-default routing service identity already establishes. See
[service-accounts.md § Closed by default](service-accounts.md#closed-by-default-per-route).

## Default posture: no workflow is installed

A fresh deployment has a validated manifest
(`infra/n8n/workflows/manifest.json`, installed on the host at
`config/status/automation/manifest.json` and mounted read-only into
control-api at `/config/automation/manifest.json`) describing what
workflows *could* run, and
zero of them actually imported into n8n. `sudo ./pcctl install-workflows` is
an explicit, optional step — the platform's [manual checkpoints](manual-checkpoints.md)
remain exactly five; this is not a sixth one, the same way `enable-repo-writes`
never became a checkpoint either. Every imported workflow is inactive until an
operator turns it on in the n8n UI.

### `install-workflows` — what is actually proven, and what is not

`n8n import:workflow` creates a real, permanent row in n8n's own database
(this n8n version has no `delete:workflow` CLI command), so it has never
been run against the live deployment to "test" it — that would be
indistinguishable from actually using it, and would leave clutter nothing
can clean up. Instead, its real behavior — including the exact claim that
matters for production acceptance, "re-importing the same workflow does not
create a duplicate" — is proven against a fully disposable n8n + PostgreSQL
pair on an isolated Docker network (unique container/network names, pinned
images, non-root, `--cap-drop ALL`, torn down on every exit path), which
runs the real, unmodified `install-workflows.sh` end to end. See
`tests/n8n-workflow-import-live-regression.sh`, which is now part of the
permanent regression suite, not a one-off exploration. Proven there, each
directly against the pinned n8n 2.34.0 image:

- A workflow file with **no top-level `id`** is refused by `import:workflow`
  outright — a `NOT NULL constraint` violation on `workflow_entity.id`, and
  nothing is imported. This was a **real, live bug**: every shipped
  workflow file (`system-health`, `deployment-readiness`, `backup-health`)
  was missing this field until this test caught it. Fixed by committing a
  permanent, stable UUID as each file's `id`, and by adding a matching
  static rule to `scripts/lib/workflow-lint.py` (N8N-002) so a future
  workflow file that regresses the same way fails lint before it ever
  reaches a host.
- A workflow file **with** its committed `id` imports successfully, and
  `list:workflow` shows it under the id/name the shipped file declares —
  proving the manifest-key-to-installed-workflow mapping is deterministic.
- **Re-importing the identical file (same id) does not create a
  duplicate** — `import:workflow` upserts by `id`. This is the exact claim
  the feature depends on for safe re-runs, and it is now proven, not
  assumed.
- A **different id sharing the same workflow name** DOES create a genuine
  duplicate row. This is why `install-workflows.sh`'s own pre-import
  `n8n list:workflow` name check is load-bearing, not redundant
  defense-in-depth: `id`-based upsert alone would not protect against a
  workflow file that was copy-pasted and renamed but never re-keyed.
- **`--userId`/`--projectId` are not required.** With neither flag (which is
  what `install-workflows.sh` passes), the import is never ownerless: n8n
  always has exactly one pre-existing user row (the not-yet-claimed
  instance owner, created at first boot before any UI setup) and one
  personal project owned by it, and `import:workflow` assigns to that
  project by default. Completing owner setup later fills in that same row's
  email/password rather than creating a new user, so the imported workflows
  belong to the real operator's account from the moment they finish setup,
  regardless of which happens first.
- **File staging**: the first version of `install-workflows.sh` used
  `docker cp`, which was found — empirically, against this exact image, not
  assumed — to silently fail against a path covered by a `--tmpfs` mount: it
  reports success but the file never appears, and n8n's `/tmp` is exactly
  such a mount (`infra/compose/compose.yaml`). The script now pipes the
  file through a live `docker exec -i ... sh -c 'cat > ...'` process
  instead, which runs inside the container's real mount namespace. See
  `tests/install-workflows-regression.sh`.
- **Idempotency / skip-if-present, and the staging-failure path**
  (deterministic, mocked `docker`): the script skips a workflow whose name
  already appears in `n8n list:workflow`, stages and imports one that does
  not, and reports a staging failure to the operator instead of calling
  `import:workflow` against a file that was never actually staged. Same
  test file as the staging point above.

**A safety-relevant bug this test caught, unrelated to n8n itself:**
`scripts/lib/common.sh` used to set `PC_COMPOSE_PROJECT="project-control"`
as a bare, unconditional assignment — not
`${PC_COMPOSE_PROJECT:-project-control}` — so setting `PC_COMPOSE_PROJECT`
in the environment before invoking any pcctl script had no effect at all,
silently discarded on `source`. The first draft of the disposable-instance
test relied on exactly that override to keep `install-workflows.sh`'s own
`container_id()` lookup pointed at its throwaway container; because of the
bug, the real script resolved to the real, running `project-control-n8n`
container instead and imported a (harmless, inactive) workflow into
production. This was caught, the stray row was removed from production
after read-only confirmation, and `common.sh` now correctly honors a
`PC_COMPOSE_PROJECT` environment override the same way it already did for
`PC_ROOT`.

**Still not exercised by an automated test, and left as an explicit,
accepted limitation:** whether an imported-but-deactivated workflow is
visible and editable from a real logged-in n8n UI session, since that
requires a browser, not just the CLI/API surface this test suite drives.
The live acceptance runbook below (steps 7–9) covers this by hand on the
first real deployment: `sudo ./pcctl install-workflows`, then
`docker exec <n8n-container> n8n list:workflow` to confirm the id/name
pair, then opening each workflow in the n8n UI before activating it.

## Two triggers, two flows

**Scheduled** — n8n's own schedule trigger fires the workflow. It opens a run
directly into `running` (`POST /api/automation/runs`) because there is no
reason to queue something that is already executing.

**Manual** — an operator clicks "Run now" in the panel
(`POST /api/automation/workflows/:key/request-run`), which opens a `queued`
row. n8n never receives a push for this: Control API cannot call n8n (n8n
publishes no inbound HTTP surface — see below), so a small n8n workflow polls
`POST /api/automation/queue/claim` on its own schedule and claims the oldest
queued run across every workflow key, using `FOR UPDATE SKIP LOCKED` so two
concurrent claims can never win the same row. This is a deliberate latency
trade — a manual run may wait up to the poll interval — documented rather
than hidden: the panel shows `queued` and when the run was queued, not a
false "starting now."

## Workflow manifest

`infra/n8n/workflows/manifest.json`, loaded and Zod-validated once at Control
API boot (`automation/manifest.ts`) — an invalid or missing manifest refuses
startup, the same rule `config.ts` already applies to secrets. A workflow
definition:

```jsonc
{
  "key": "system-health",           // ^[a-z0-9-]{3,48}$, matched by the route
  "name": "System Health",
  "description": "…",
  "trigger": "scheduled",           // or "manual"
  "schedule": "*/30 * * * *",       // documentation only — n8n holds the real cron
  "scope": "global",                // or "project" (requires a projectId)
  "timeoutSeconds": 120,            // lease length once a run starts
  "idempotencyWindow": "hour",      // "none" | "hour" | "day"
  "requiredScopes": ["automation:run", "system:read"],
  "notify": { "info": false, "warning": true, "critical": true }
}
```

There is no route that creates, edits or removes a manifest entry. Widening
what exists is a code change and a redeploy — the same discipline the
compiled-in service account registry uses.

### Shipped v1 workflows

| Key | Trigger | Reads | Idempotency |
| --- | --- | --- | --- |
| `system-health` | scheduled, `*/30 * * * *` | `/api/system/status`, every component | hour |
| `deployment-readiness` | scheduled, `0 7 * * *` | `/api/system/status`, `verification` component | day |
| `backup-health` | scheduled, `0 9 * * *` | `/api/system/status`, `backup` component | day |

Two entries the manifest schema and run lifecycle fully support but that ship
with **no n8n workflow JSON yet** — `checkpoint-reminder` and
`weekly-project-report`. Building them honestly needs a real per-project data
source, and today a service token can reach exactly two things:
`/api/system/status` and the automation surface itself — no existing route
(`/api/projects`, Work Sessions, Resume) accepts a Bearer token, because this
feature deliberately did not retrofit `resolvePrincipal` onto any existing
route without a concrete consumer (see
[service-accounts.md § Closed by default, per route](service-accounts.md#closed-by-default-per-route)).
Wiring one of those routes for `project:read`/`report:write` is real,
separate, reviewable work against an already-shipped surface — not something
to rush into this change. `n8n-automation`'s registry entry already carries
`report:write` for when `weekly-project-report` is built.

## Run lifecycle

`migrations/0017`/`0018`: `workflow_runs` + append-only `workflow_run_steps`,
following the same conventions `project_actions` (0013) and `work_sessions`
(0011) established — settled rows immutable, no physical deletion ever,
lifecycle enforced by a database trigger rather than trusted to application
code.

```
queued ──(claim)──▶ running ──(settle)──▶ completed
  │                    │                  failed
  └──(cancel)──▶ cancelled                waiting_for_approval   (all terminal)
                       └──(lease lapses)──▶ expired
```

`waiting_for_approval` is terminal, not paused: the automated part of a run
ends the moment it would need to propose a mutation, and there is no "resume
this run" path — a proposal lives on as its own row elsewhere
(`project_actions`, once a workflow is built that reaches `action:plan`) and
a human confirms it separately, through the panel.

### Idempotency

`idempotency_key` is server-computed from the workflow's `idempotencyWindow`
policy — never supplied by the caller — as
`<key>:<projectId-or-"global">:<hour-or-day bucket>`. A partial unique index
(`workflow_runs_idempotency_idx`) blocks a second row sharing that key
**unless** the first is `cancelled` or `expired`: those represent work that
never actually happened, so they must not consume the window and block a
legitimate retry. Getting this predicate right took a real false start while
building the feature — see the migration's own comment on
`workflow_runs_idempotency_idx` for why a partial index has to include the
row's *own* status in what it protects, not just the terminal-success
statuses it is trying to prevent duplicates of.

A separate, always-active partial unique index
(`workflow_runs_one_open_idx`) additionally guarantees at most one
`queued`/`running` row per workflow at a time, regardless of the idempotency
window — the database-level answer to a double "Run now" click.

### Lease and lazy expiry

`lease_expires_at = started_at + timeoutSeconds`, set the moment a run
becomes `running` (at claim or at scheduled-open). There is no background
sweeper — a lapsed lease is resolved to `expired` lazily, the next time
anything reads or touches the row (`AutomationStore.sweepIfExpired`), the
same TTL philosophy `project_actions` already uses.

### Severity and notification

A run settles with a `severity` (`info` | `warning` | `critical`), and the
Control API — never the workflow's own logic — decides whether that severity
should notify, by looking up the settling workflow's `notify` policy in the
manifest. `POST .../settle` returns `{ run, notify: boolean }`; the n8n
workflow's own `IF` node branches on that field into a Telegram node. This
keeps "should this page someone" a server-owned, testable decision rather
than something copy-pasted into every workflow's own logic.

### Audit

`workflow.run_requested`, `workflow.run_opened`, `workflow.run_claimed`,
`workflow.run_step_recorded`, `workflow.run_artifact_attached`,
`workflow.run_settled`, `workflow.run_cancelled`, `workflow.run_rejected`.
Detail: run id, workflow key, project id, status, severity, notify — never a
step's full detail payload, a report's content, or anything from the caller
beyond what identifies the run.

## Routes

| Route | Principal | Purpose |
| --- | --- | --- |
| `GET /api/automation/whoami` | either | confirm what a credential resolves to |
| `GET /api/automation/workflows` | either (`system:read`) | manifest + each workflow's last run |
| `GET /api/automation/runs` | either (`system:read`) | paginated, filterable history |
| `GET /api/automation/runs/:id` | either (`system:read`) | run detail + steps |
| `POST /api/automation/workflows/:key/request-run` | **user**, admin/operator | open a `queued` run |
| `POST /api/automation/runs/:id/cancel` | **user**, admin/operator | cancel a queued or running run |
| `POST /api/automation/runs` | **service** (`automation:run`) | open a scheduled run directly into `running` |
| `POST /api/automation/queue/claim` | **service** (`automation:run`) | claim the oldest queued run, any key |
| `POST /api/automation/runs/:id/steps` | **service** (`automation:run`) | append a step |
| `POST /api/automation/runs/:id/artifact` | **service** (`report:write`) | attach a small text report |
| `POST /api/automation/runs/:id/settle` | **service** (`automation:run`) | terminal transition; returns `notify` |
| `GET /api/automation/service-tokens` | **user**, admin | token inventory (see service-accounts.md) |
| `POST /api/automation/service-tokens/:id/revoke` | **user**, admin | revoke |

"either" means `resolvePrincipal` accepts both kinds; `requireScope` is a
no-op for a user principal, so a human's access here is governed only by
being authenticated, same as any other read route.

## Closed inbound surface — verified, not assumed

n8n publishes no webhook, no public REST API
(`N8N_PUBLIC_API_DISABLED=true`, verified against the pinned image's own
config schema since the foundation build), and — discovered while building this feature
— community packages were enabled by default
(`N8N_COMMUNITY_PACKAGES_ENABLED` had no explicit value), which would let
anyone with n8n UI access install an arbitrary third-party node outside this
platform's own review. That is now set to `"false"` explicitly.

| ID | Proves |
| --- | --- |
| `N8N-001` | Live: `/webhook/<random>` returns 404 — no workflow has registered one |
| `N8N-002` | Static: every shipped `*.workflow.json` passes `workflow-lint.py` — no webhook/executeCommand/ssh node, every HTTP Request node targets only `control-api:8080`, no embedded token, no unlisted `$env` read |
| `N8N-003` | Live: n8n can reach the Control API over the `application` network (the positive half of PGS-006's existing negative proof that `n8n_app` cannot reach `project_control`) |
| `N8N-004` | Live: `n8n audit` reports community packages disabled |

`workflow-lint.py`'s hostile-fixture coverage is
`tests/workflow-lint-regression.sh`.

## Verification

| ID | Check |
| --- | --- |
| `AUT-001` | `control_app` cannot `DELETE` from `workflow_runs` |
| `AUT-002` | `control_app` cannot `UPDATE` `workflow_run_steps` (no grant at all) |
| `AUT-003` | Manifest is root-owned, `0644` |
| `AUT-004` | Not re-proven live (needs a session/token — see below); proven by the integration suite |
| `N8N-001`–`N8N-004` | See above |

Consistent with `SVC-004`/`SVC-005` in service-accounts.md, the checks that
need a real session or a real committed row are not re-proven by
`verify-security.sh`, which mints no credential and logs in as no one. They
are proven by `apps/control-api/test/integration/automation.test.ts` against
a real, disposable database — mixed-credential and scope denial, idempotency
window collision and correct exclusion of cancelled/expired runs,
concurrent-claim exclusivity, lazy lease expiry, settle-severity → notify
computation, and audit coverage.

## Daily verification status

`project-control-verify.timer` (06:00 daily, independent of n8n and of the
container stack's own health — if the stack is down, that must show up as a
verification failure, not a missing status file) runs
`scripts/record-verification-status.sh`, which runs `verify.sh --json` and
`verify-security.sh --json` and merges their `overall`/`summary` into
`config/status/verification.json`. The Control API reads this the same way
it already reads `backup-status.json` and `tailscale-status.json`
(`probeVerification` in `routes/system.ts`) and reports it as the
`verification` component in `/api/system/status` — which is what would let a
future `deployment-readiness` workflow report something real instead of
guessing. The merge logic itself (not the underlying verify scripts, which
have their own coverage) is regression-tested in
`tests/verification-status-merge-regression.sh`.

## What this feature deliberately does not do

- No route creates, edits or removes a manifest entry — only a code change
  and a redeploy do.
- No event trigger. Every shipped workflow is `manual` or `scheduled`; an
  event trigger (a domain mutation opening a queued run in the same
  transaction) is a natural, cheap extension of this same queue once there
  is a real event to wire — not built here because nothing needs it yet.
- No background sweeper for a lapsed lease or a stuck `queued` row — lazy,
  touch-triggered resolution only, the same choice `project_actions` already
  made.
- No automatic retry of anything, ever.
- No workflow reaches `action:plan` or applies a rescan diff in this version
  — `checkpoint-reminder` and `weekly-project-report` are deferred rather
  than shipped against a data source that does not really exist yet. See
  above.
- No change to how n8n is exposed: still no host port beyond
  `127.0.0.1:5678`, still not routed through Caddy, still no Docker socket,
  still no exec path anywhere in this platform's own components.
