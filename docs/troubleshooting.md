# Troubleshooting

Start with:

```bash
./pcctl status
./pcctl health
./pcctl verify
```

---

## The portal is unreachable

### From a tailnet device

```bash
tailscale status                 # BackendState must be "Running"
tailscale serve status           # must list 8780 and 5678
curl -I http://127.0.0.1:8780/   # on the host itself
```

| Symptom | Cause | Fix |
| --- | --- | --- |
| `tailscale status` shows `NeedsLogin` | not connected | `sudo tailscale up` |
| `serve status` is empty | Serve not configured | `sudo ./pcctl configure-tailscale` |
| Loopback curl fails | Caddy is down | `./pcctl logs caddy` |
| Certificate error | HTTPS not enabled for the tailnet | enable HTTPS Certificates in the admin console |

### From a non-tailnet device

This is **correct behaviour**. There is no public access path by design.

---

## "Backend unreachable" in the panel

The browser reached Caddy (so static assets are being served) but the Control API
did not answer.

```bash
./pcctl logs control-api --tail 100
docker inspect project-control-api --format '{{.State.Health.Status}}'
```

Common causes:

| Cause | Diagnosis | Fix |
| --- | --- | --- |
| PostgreSQL not ready | `./pcctl health` shows postgres unhealthy | wait, or check its logs |
| Migration failed | API logs show a migration error | see below |
| Secret unreadable | logs mention a secret file | `sudo ./scripts/generate-secrets.sh` |
| Runner socket missing | logs mention `runner.sock` | `sudo systemctl start project-control-runner` |

---

## Cannot sign in

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Invalid email or password" | wrong credentials, **or** the account is locked | see below |
| HTTP 429 | rate limited (5 attempts / 5 min) | wait five minutes |
| Sign-in succeeds then immediately drops | cookie rejected | check `Secure` vs plain HTTP — see below |

Check for an account lock:

```bash
sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_control_app_password)" \
  psql -U control_app -d project_control -c \
  "SELECT email, failed_login_count, locked_until, is_active FROM users"
```

Reset the password (also revokes every session for that account):

```bash
sudo ./pcctl create-admin        # enter the same email, answer "yes"
```

**Cookie rejected over plain HTTP.** The session cookie is `Secure`, so a browser
will not store it over `http://`. Always use the Tailscale HTTPS URL;
`http://127.0.0.1:8780` is for diagnostics only.

---

## Migration errors

### "was modified after it was applied"

An already-applied migration file was edited. The runner refuses to continue
because the recorded history no longer describes the live schema.

**Fix:** restore the original file content and add a *new* migration instead.

### "Database has migration X applied but no such file exists"

The deployed code is older than the database. Deploy the newer code, or restore
the database from a matching backup.

### Migration hangs

Another process holds the advisory lock:

```bash
sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_superuser_password)" \
  psql -U postgres -d project_control -c \
  "SELECT pid, state, query FROM pg_stat_activity WHERE datname='project_control'"
```

---

## The runner is down

```bash
systemctl status project-control-runner
journalctl -u project-control-runner -n 50
```

| Message | Cause | Fix |
| --- | --- | --- |
| `refusing to run as root` | unit `User=` was changed | restore `User=project-runner` |
| `socket group id is required` | `PC_CONTROL_GID` unset | check `/srv/project-control/config/runner.env` |
| `working directory ... is a symlink` | tampering or a bad install | recreate `/srv/project-control/runner` as a real directory |
| `is not writable by uid` | ownership drift | `chown -R project-runner:project-control /srv/project-control/runner` |

Socket permissions:

```bash
ls -l /run/project-control/runner.sock     # srw-rw---- project-runner project-control
getent group project-control
```

If the API cannot reach it, confirm the container joined the group:

```bash
docker inspect project-control-api --format '{{.HostConfig.GroupAdd}}'
```

---

## Project registration issues

See [`project-registration.md`](project-registration.md) for the full user
flow. Common failures:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no_allowed_roots_configured` on every "Inspect" | `config/allowed-project-roots.conf` is missing or empty | `sudo ./pcctl install` creates it with the default root; add more roots by editing the file, then re-run install |
| `outside_allowed_roots` for a path that looks correct | the path is not actually under a configured root, or a symlink resolves outside it | `cat /srv/project-control/config/allowed-project-roots.conf`; the panel shows the *canonical* (symlink-resolved) path in the error |
| `not_found` for a path you can see in a terminal | the runner cannot read it — check the systemd drop-in applied, and that the path isn't behind a permission the `project-runner` user genuinely lacks | `sudo cat /etc/systemd/system/project-control-runner.service.d/10-allowed-roots.conf`; `sudo -u project-runner test -r <path> && echo readable` |
| Added a new root but inspecting a path under it still fails | the drop-in and runner were not regenerated/restarted after editing the config file by hand | `sudo ./pcctl install` (idempotent — regenerates the drop-in and restarts the runner only if something changed) |
| "The host runner is unavailable" on Inspect/Rescan | `project-control-runner.service` is not running | see [The runner is down](#the-runner-is-down) above |
| A project shows "Unreachable" on its folder | the folder was moved, deleted, or a mount was removed since it was registered | use **Rescan** to confirm; the project's location is marked inaccessible rather than the project being deleted |
| Rescan is blocked with "repository identity has changed" | the folder's git remote changed since the project was registered — this is treated as a high-severity change on purpose | if this is expected (e.g. the remote was renamed), check **I confirm this folder now points at a different repository** and apply again |
| "A project is already registered at this folder" / "against this repository" | the canonical path or the normalised git remote identity already belongs to another active (non-archived) project | archive the other project first, or register the intended one |
| `pcctl verify-security` reports `RNR-010` FAIL/`RNR-011` FAIL even though `PRJ-001`/`PRJ-002`/`PRJ-003` all PASS and the drop-in file exists | the config and drop-in are correct, but the bind mount never actually applied in the runner's live mount namespace — see the kernel-level check below | confirm the base unit uses `ProtectHome=tmpfs`, not `ProtectHome=yes` (`systemctl show project-control-runner -p ProtectHome`); `sudo ./pcctl install` self-heals this by restarting the runner and re-verifying the mount, but a manual `sudo systemctl restart project-control-runner` also applies it |

Kernel-level confirmation that a configured root is genuinely read-only in the
runner's own mount namespace (not just declared so in a unit file):

```bash
sudo -u project-runner true 2>/dev/null; \
runner_pid="$(systemctl show -p MainPID --value project-control-runner.service)"; \
sudo awk -v root="/home/asrin/Desktop" '$5 == root {print $6}' "/proc/${runner_pid}/mountinfo"
# expect a comma-separated options field starting with "ro"
```

---

## n8n problems

### Credentials disappeared after a restart

The encryption key changed. Confirm it is stable:

```bash
sudo ls -l /srv/project-control/secrets/n8n_encryption_key
docker inspect project-control-n8n --format '{{range .Config.Env}}{{println .}}{{end}}' | grep ENCRYPTION
```

Only `N8N_ENCRYPTION_KEY_FILE` should appear — never a literal key.

### n8n created a SQLite database

`data/n8n/database.sqlite` existing means the PostgreSQL configuration did not
take effect. Check `DB_TYPE=postgresdb` and the `DB_POSTGRESDB_*` variables, then
recreate the container. `verify` check `N8N-002` catches this.

### n8n links point at the wrong host

```bash
grep PC_N8N_PUBLIC_URL /srv/project-control/config/stack.env
sudo ./pcctl configure-tailscale     # rewrites it and recreates n8n
```

---

## Backup failures

```bash
journalctl -u project-control-backup -n 100
sudo ./pcctl backup                  # run manually to see the error
```

| Message | Cause | Fix |
| --- | --- | --- |
| `MANUAL_CONFIGURATION_REQUIRED` | not configured | `sudo ./pcctl configure-google-drive` |
| `cannot list Google Drive` | OAuth token expired | re-run `rclone config` for `gdrive` |
| `wrong password` | wrong passphrase | there is no recovery; see disaster-recovery.md |
| `dump ... is only N bytes` | pg_dump produced a truncated dump | check PostgreSQL health first |

---

## Verification failures

### `NET-002` — publishes on a non-loopback address

**Serious.** A service is exposed beyond the host. Check the `ports:` entries in
`compose.yaml`: every one must be `127.0.0.1:<host>:<container>`.

### `DOC-001` — Docker socket mounted

**Critical.** A container with the Docker socket is equivalent to host root.
Remove the mount and recreate the container.

### `PGS-001` — a role can connect to the other database

Cross-database isolation is broken:

```bash
sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_superuser_password)" \
  psql -U postgres -c "REVOKE CONNECT ON DATABASE n8n FROM control_app, control_migrator"
```

### `RNR-007` — the runner accepted a raw command

**Critical.** Stop the runner immediately and investigate the binary's
provenance:

```bash
sudo systemctl stop project-control-runner
sha256sum /srv/project-control/runner/bin/project-control-runner
```

---

## Container will not start

```bash
docker inspect project-control-<service> --format '{{.State.ExitCode}} {{.State.Error}}'
./pcctl logs <service> --tail 100
```

| Exit code | Meaning |
| --- | --- |
| 137 | OOM-killed — raise the memory limit or find the leak |
| 139 | Segfault |
| 1 | Application error — read the logs |

Permission errors on a bind mount usually mean ownership drift:

```bash
sudo chown -R 999:999   /srv/project-control/data/postgres
sudo chown -R 1000:1000 /srv/project-control/data/n8n
sudo chown -R 10001:10001 /srv/project-control/data/artifacts
```

---

## Collecting a support bundle

```bash
./pcctl verify --json          > /tmp/pc-verify.json
./pcctl verify-security --json > /tmp/pc-security.json
./pcctl status                 > /tmp/pc-status.txt 2>&1
./pcctl logs --tail 500        > /tmp/pc-logs.txt 2>&1
journalctl -u project-control-runner -n 500 > /tmp/pc-runner.txt
```

Review each file before sharing it. Logs are redacted by design, but the review
is still yours to do.
