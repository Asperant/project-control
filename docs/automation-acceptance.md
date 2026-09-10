# Automation feature live acceptance runbook

Everything below is written to be run, in order, against the real
production host, on the **first** live deployment of the automation
(n8n workflow) feature. All automated verification that *can* run without
touching production — the full `tests/*.sh` suite, `pnpm`/`go` gates, and a
complete characterisation of `n8n import:workflow`'s real behavior against
a disposable, throwaway n8n + PostgreSQL pair — is reported separately.
This document exists because five of the eighteen steps below (service
token creation, `update`, `install-workflows`, n8n owner-scoped UI actions,
and `restore-test`) are exactly the class of action that must never be
"tested" by running it for real outside of a live deployment window: doing
so *is* using it.

**Run to completion on 2026-09-02.** All 18 steps passed. Along the way this
run surfaced and fixed several real gaps the pre-deployment test suite had
not caught: `/api/system/status` rejecting the service token it was meant
for, a broken SQL probe in `verify-security.sh`, `n8n audit` flagging this
deployment's own reviewed workflows as unreviewed risk, a missing Telegram
`$env` path, and a host-specific non-reproducible-build issue that kept
orphaning locally-built image tags mid-recovery. Keep this runbook (and one
like it for every future feature that touches the live host) as a required
step before calling a feature done — the existing test suite, however
thorough, did not catch any of the above on its own.

**Hard constraints for anyone running this runbook:**

- Do not execute `update`/`install-workflows` on the host except as this
  runbook's own step 3 / step 7.
- No DB migration on the host outside step 3's own `update` (which runs
  migrations as part of its normal, already-verified flow).
- No service token creation on a production host except as step 6.
- No workflow import on production except as step 7.
- No commit or push as part of running this runbook.

---

## Steps

### 1. Backup

```bash
sudo ./pcctl backup
```

**Expected:** exits 0. A new restic snapshot exists
(`restic snapshots` via the credentials in `PC_SECRETS_DIR`, or
`sudo ./pcctl status` reports the new backup age). This is the safety net
for every step that follows — do not proceed if this fails.

### 2. Backup integrity check

```bash
sudo ./pcctl backup --check
```

**Expected:** exits 0, reports the repository as structurally sound
(`backup.sh`'s `--check` mode runs `restic check`, not a new backup — see
`scripts/backup.sh`). A non-zero exit here means stop: do not run `update`
against a backup whose integrity is unverified.

### 3. Update

```bash
sudo ./pcctl update
```

**Expected:** pulls/rebuilds the pinned images from `infra/versions.lock.env`,
applies any pending SQL migrations (currently `0015`–`0018`, the service
identity and automation schema), recreates containers, and runs the
readiness gate documented in `tests/update-readiness-gate-regression.sh`
(bounded retry against transient `503`s during startup, immediate failure
on anything else, automatic rollback on a persistent failure when no
migration has advanced the schema). Expected terminal output: a success
banner, not a rollback notice. If a rollback banner appears instead, stop
here — everything downstream assumes the update succeeded.

### 4. Verify

```bash
sudo ./pcctl verify
```

**Expected:** all checks `PASS`. This is the general health/consistency
gate (containers up, healthy, migrations at the expected version, secrets
present with correct modes) — see `docs/quality-gates.md`.

### 5. Verify security

```bash
sudo ./pcctl verify-security
```

**Expected:** all checks `PASS`, **except** `SEC-006` which is a
pre-existing, documented, accepted condition (`docs/service-accounts.md`):
`n8n_encryption_key` and `pg_n8n_app_password` carry one trailing
whitespace byte, which n8n itself already tolerates and warns about on
every CLI invocation (`[n8n] Warning: The file specified by
DB_POSTGRESDB_PASSWORD_FILE contains leading or trailing whitespace`).
**Do not rotate `n8n_encryption_key` to silence this** — that orphans
every credential n8n has ever encrypted (same document). Every other
`N8N-*`/`SEC-*`/`SVC-*` row (including the new `N8N-002` id-presence
lint check) must be `PASS`.

### 6. Create the automation service token

```bash
sudo ./pcctl create-service-token n8n-automation --ttl-days 365
```

**Expected:** prints the token exactly once, to the terminal, never to a
log file (`docs/service-accounts.md`). Copy it immediately — it cannot be
retrieved again, only revoked and re-minted. Paste it into an n8n **Header
Auth** credential (`Authorization: Bearer <token>`) named to match what the
shipped workflows' HTTP Request nodes reference. This is the "credential
reference unresolved" state the workflow-lint fixtures and the live import
test both treat as acceptable pre-credential-setup — the workflow JSON
itself never contains the token (`workflow-lint.py`'s embedded-token rule
would reject it if it did).

### 7. Install workflows

```bash
sudo ./pcctl install-workflows
```

**Expected:** `workflows: 3 imported, 0 already present` on a first run
(`system-health`, `deployment-readiness`, `backup-health`;
`checkpoint-reminder` and `weekly-project-report` are in the manifest but
not yet shipped as `*.workflow.json` files — do not expect 5). Every
import lands **inactive**. Re-running this same command immediately after
must report `workflows: 0 imported, 3 already present` — this is the exact
claim proven against the disposable instance in
`tests/n8n-workflow-import-live-regression.sh`; this step is where it is
confirmed true against the real host, once, deliberately.

### 8. List and inspect installed workflows

```bash
docker exec project-control-n8n n8n list:workflow
```

**Expected:** three rows, each `<uuid>|<name>`, matching the committed
`id` fields in `infra/n8n/workflows/*.workflow.json` (`system-health.workflow.json`
→ `9817bb4c-bbb8-44e8-9b60-9e84f80f7181`, etc.) — this is the
manifest-key-to-installed-workflow determinism check, done once against
the real instance rather than only the disposable one.

### 9. Activate workflows in the n8n UI

Browser action, not a command: open each of the three workflows in the n8n
UI, attach the Header Auth credential from step 6 to every HTTP Request
node that needs it (n8n does not carry credential bindings through
`import:workflow` — this is the one piece of state that step 7 cannot
create), review the node graph once by eye, then toggle **Active**.

**Expected:** all three show `Active` in the n8n workflow list. This is
also the point that resolves the one thing the disposable-instance test
could not exercise on its own (no browser): whether an imported,
deactivated workflow is fully visible and editable from a real logged-in
UI session. See `docs/automation.md`'s "still not exercised" note.

### 10. Manually run System Health

In the n8n UI, open **System Health** and click **Execute workflow** (a
one-off manual run of a schedule-triggered workflow — this does not
require the Control API's separate "queued/manual-trigger" panel path,
which is reserved for workflows whose manifest `trigger` is `"manual"`;
none are shipped yet).

**Expected:** the execution succeeds end to end: `Open Run` →
`Read System Status` → `Evaluate` → `Record Step` → `Settle` →
`Should Notify`. No node reports an error. If `/api/system/status` is
healthy, `Should Notify` should not fire the Telegram branch (`notify:
false` for an `info`-severity settle, per `docs/automation.md`'s
"Severity and notification" section).

### 11. Inspect `workflow_runs` and `workflow_run_steps`

Exact table/column names, confirmed against `migrations/0017_automation_schema.sql`:
`workflow_runs` (`id`, `workflow_key`, `status`, `trigger_kind`, `started_at`,
`settled_at`, `result_json` — `result_json` carries `severity` as a JSON
field, not a column) and `workflow_run_steps` (`run_id`, `position`, `name`,
`status`, `recorded_at`).

```bash
docker exec project-control-postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/pg_superuser_password | tr -d "[:space:]")" \
   psql -U postgres -d project_control -c \
   "SELECT id, workflow_key, status, trigger_kind, result_json->>'"'"'severity'"'"' AS severity, started_at, settled_at FROM workflow_runs ORDER BY started_at DESC LIMIT 5;"'

docker exec project-control-postgres sh -c \
  'PGPASSWORD="$(cat /run/secrets/pg_superuser_password | tr -d "[:space:]")" \
   psql -U postgres -d project_control -c \
   "SELECT run_id, position, name, status, recorded_at FROM workflow_run_steps ORDER BY recorded_at DESC LIMIT 10;"'
```

**Expected:** one `workflow_runs` row for the step-10 execution,
`status = 'completed'` (or `'failed'`/`'waiting_for_approval'` only if
step 10 actually reported that), `trigger_kind = 'scheduled'` (n8n's own
schedule trigger opens the run directly into `running`, even for a manual
"Execute workflow" click — see `docs/automation.md`'s "Two triggers, two
flows"), `result_json->>'severity'` reflecting what `/api/system/status`
actually reported (`'info'` only if every component was fully healthy —
a `manual_configuration_required`/`down` component elsewhere, e.g. an
empty artifact store, legitimately yields `'warning'` instead, which is
what a first real run against a not-yet-fully-populated deployment should
show); **exactly one** child row in `workflow_run_steps`,
`position = 0`, `name = 'System status'` — System Health's own "Record
Step" node (`infra/n8n/workflows/system-health.workflow.json`) hard-codes
this single summary step by design, it does not record one row per n8n
node in the canvas. `status IN ('passed','failed','skipped','warning')`.
Confirms the run lifecycle (`queued`/`running` → terminal, lease/
idempotency machinery) is exercised by a real n8n execution, not just by
the Vitest integration suite against a mocked caller.

### 12. Verify no token leakage in audit or logs

```bash
docker logs project-control-api 2>&1 | grep -i "bearer\|n8n-automation.*token" | head -20
docker logs project-control-n8n 2>&1 | grep -iE "pcs_[A-Za-z0-9_-]{6,}" | head -20
sudo ./pcctl verify-security 2>&1 | grep -i token
```

**Expected:** no match in any of the three. The audit log
(`workflow.run_requested`, `.run_opened`, `.run_settled`, etc.) records run
id, workflow key, project id, status, severity, notify — never a bearer
token or a step's payload (`docs/automation.md`'s "Audit" section). This
step exists because a token that *is* leaked into a log is not fixed by
deleting the log line — it means immediate revoke-and-reissue
(`sudo ./pcctl revoke-service-token <id>`) is the correct next action, not
a documentation update.

### 13. Run Deployment Readiness

In the n8n UI, open **Deployment Readiness** and click **Execute
workflow**.

**Expected:** succeeds; reads the daily `verify`/`verify-security` report,
backup age, and pending Repository Actions (per its manifest description),
and settles with a severity reflecting what step 4/5 actually found (should
be `info` unless something regressed since those steps ran).

### 14. Run Backup Health Report

In the n8n UI, open **Backup Health Report** and click **Execute
workflow**.

**Expected:** succeeds; reads `backup-status.json`, reports last
successful backup age and last restore-test age. Should reflect step 1's
fresh backup as recent; will report the restore-test age as stale until
step 15 runs.

### 15. Restore test

```bash
sudo ./pcctl restore-test
```

**Expected:** reports `PASSED` (`docs/manual-checkpoints.md`: "a backup
that has never been restored is a hypothesis, not a backup"). This is the
one step in this runbook that both validates disaster-recovery readiness
*and* would make step 14's next run report a fresh restore-test age.

### 16. Verify (again)

```bash
sudo ./pcctl verify
```

**Expected:** `PASS`, unchanged from step 4 — confirms steps 6–15
(token creation, workflow install/activate/execute, restore-test) left the
deployment in a consistent state.

### 17. Verify security (again)

```bash
sudo ./pcctl verify-security
```

**Expected:** `PASS` on every check except the same pre-existing,
documented `SEC-006` from step 5. In particular, `N8N-001` through
`N8N-006` must all `PASS`: no webhook registered, every shipped workflow
file still lint-clean, n8n unreachable from `project_control`'s network,
community packages disabled, the outdated-instance notice (if any) only
`WARN`s, and no unexpected `n8n audit` finding.

### 18. Status

```bash
sudo ./pcctl status
```

**Expected:** all containers healthy, Tailscale serving both routes,
backup age matching step 1/15, no `MANUAL_CONFIGURATION_REQUIRED` markers
remaining that this runbook was supposed to resolve.

---

## Summary table

| # | Step | Command / action | Stop-the-line condition |
| --- | --- | --- | --- |
| 1 | Backup | `sudo ./pcctl backup` | non-zero exit |
| 2 | Backup check | `sudo ./pcctl backup --check` | non-zero exit |
| 3 | Update | `sudo ./pcctl update` | rollback banner instead of success |
| 4 | Verify | `sudo ./pcctl verify` | any `FAIL` |
| 5 | Verify security | `sudo ./pcctl verify-security` | any `FAIL` other than known `SEC-006` |
| 6 | Create service token | `sudo ./pcctl create-service-token n8n-automation --ttl-days 365` | token printed more than once / to a log |
| 7 | Install workflows | `sudo ./pcctl install-workflows` | not exactly `3 imported, 0 already present` |
| 8 | List workflows | `docker exec project-control-n8n n8n list:workflow` | ids don't match committed manifest ids |
| 9 | Activate (UI) | browser | any workflow fails to activate |
| 10 | Run System Health (UI) | browser | any node errors |
| 11 | Inspect run tables | read-only `psql` | no matching `workflow_run`/`workflow_run_steps` rows |
| 12 | Check for token leakage | `docker logs` / `grep` | any match |
| 13 | Run Deployment Readiness (UI) | browser | any node errors |
| 14 | Run Backup Health (UI) | browser | any node errors |
| 15 | Restore test | `sudo ./pcctl restore-test` | not `PASSED` |
| 16 | Verify | `sudo ./pcctl verify` | any `FAIL` |
| 17 | Verify security | `sudo ./pcctl verify-security` | any `FAIL` other than known `SEC-006` |
| 18 | Status | `sudo ./pcctl status` | any unhealthy container or unresolved manual checkpoint |
