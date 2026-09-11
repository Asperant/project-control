# Operations

## Daily commands

```bash
./pcctl status         # containers, runner, URLs, pending checkpoints
./pcctl health         # per-component probe; exit code reflects health
./pcctl logs           # all services
./pcctl logs control-api -f
./pcctl logs runner    # journalctl for the host service
```

## Lifecycle

```bash
sudo ./pcctl start     # runner first (the API mounts its socket), then containers
sudo ./pcctl stop      # containers stopped, data untouched
sudo ./pcctl restart
```

`stop` uses `docker compose stop`, never `down`: networks and containers stay in
place and no bind-mounted data is ever at risk.

## Verification

```bash
./pcctl verify                # functional
./pcctl verify-security       # security posture
./pcctl verify --json | jq '.summary'
```

Run `verify-security` after any change to compose, systemd units or PostgreSQL
grants. Suitable for a cron-driven monitor via `--json`.

---

## Repository Actions

Commits from the panel (Development → Actions) are disabled for every project
until explicitly opted in — see [repository-actions.md](repository-actions.md).

```bash
sudo ./pcctl enable-repo-writes /home/<user>/Desktop/my-project
sudo ./pcctl disable-repo-writes /home/<user>/Desktop/my-project
```

Both are idempotent and re-verify their own effect (POSIX ACL grant, systemd
`.git`-scoped bind mount, runner restart) against the runner's live mount
namespace before reporting success. Run `sudo ./pcctl verify-security`
afterwards to confirm the full posture (`RNR-014`–`RNR-017`).

---

## Understanding the status dashboard

| Status | Meaning |
| --- | --- |
| `ok` | Probed successfully |
| `degraded` | Reachable but not fully healthy |
| `down` | Probe failed |
| `manual_configuration_required` | A checkpoint is outstanding — not a fault |

`manual_configuration_required` on Backup or Tailscale before those checkpoints
are done is expected and correct.

---

## Logs

**Containers** — json-file driver, 10 MiB × 5 files per container (50 MiB cap).
Rotation is enforced by Docker; `verify` asserts the limit is present.

```bash
docker compose --project-name project-control logs --tail 200 control-api
```

**Runner** — journald.

```bash
journalctl -u project-control-runner -f
journalctl -u project-control-runner --since "1 hour ago" -p warning
```

**Caddy** — `/srv/project-control/logs/caddy/`, rolled at 10 MiB, 5 kept, 14 days.

**Audit trail** — PostgreSQL, append-only:

```bash
sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_control_app_password)" \
  psql -U control_app -d project_control -c \
  "SELECT occurred_at, event_type, outcome, subject
     FROM audit_events ORDER BY occurred_at DESC LIMIT 30"
```

---

## Secret rotation

```bash
sudo ./scripts/generate-secrets.sh --list                       # names and modes only
sudo ./scripts/generate-secrets.sh --rotate session_secret
```

Nothing is ever rotated without an explicit `--rotate <name>`. The previous value
is kept alongside as `<name>.rotated-<timestamp>` so a failed rollout can be
reversed.

### After rotating a PostgreSQL password

The file and the database must be changed together:

```bash
sudo ./scripts/generate-secrets.sh --rotate pg_control_app_password

sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_superuser_password)" \
  psql -U postgres -c "ALTER ROLE control_app PASSWORD '<new value>'"

sudo ./pcctl restart
```

### Rotating the n8n encryption key

`generate-secrets.sh` **refuses** to rotate `n8n_encryption_key`, because every
stored n8n credential is encrypted with it and would become unreadable. The only
supported procedure:

1. Export every workflow and re-enter every credential in the n8n UI.
2. Take a full backup.
3. Stop n8n, replace the key file, delete the credential rows, restart.
4. Re-enter all credentials.

Treat this as a migration, not a maintenance task.

---

## Sending a notification manually

```bash
sudo ./scripts/telegram-notify.sh "message text"
```

Exit codes: `0` delivered, `2` Telegram not configured (a pending checkpoint, not
an error), `1` delivery failed.

---

## Resource usage

```bash
docker stats --no-stream $(docker ps -q --filter label=com.docker.compose.project=project-control)
systemctl status project-control-runner
```

Configured ceilings:

| Service | CPU | Memory | PIDs |
| --- | --- | --- | --- |
| postgres | 2.0 | 2 GiB | 256 |
| n8n | 2.0 | 1500 MiB | 256 |
| control-api | 1.5 | 512 MiB | 128 |
| caddy | 1.0 | 256 MiB | 64 |
| web | 0.5 | 128 MiB | 64 |
| runner | 50 % | 192 MiB | 64 |

---

## Housekeeping

Automatic:

- expired sessions purged every 30 min (7 days past expiry);
- stale artifact staging files swept every 30 min;
- n8n execution data pruned after 14 days;
- backup run logs kept for the last 30 runs;
- rollback points kept for the last 5 updates.

Manual disk review:

```bash
du -sh /srv/project-control/*
du -sh /srv/project-control/data/artifacts/objects
```

Artifact objects are immutable and are never deleted by the application. Removing
one is a deliberate operator action; check for referencing metadata first.
