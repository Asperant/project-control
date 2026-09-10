# Disaster recovery

Rebuilding the deployment on a new machine from nothing but a backup — and
the narrower recoveries short of that.

## Which scenario is this?

| Scenario | What you'll see | Section |
| --- | --- | --- |
| The whole host is gone (hardware, disk, cloud instance) | Nothing answers at all | [Host failure](#host-failure-rebuild-on-a-new-machine) |
| The host is fine, PostgreSQL data is corrupt or lost | `pcctl health` shows postgres unhealthy, or the API logs a database error, while everything else is fine | [Database failure](#database-failure-host-and-containers-otherwise-healthy) |
| `sudo ./pcctl update` left things worse than before | `update` reported failure, or the app is up but visibly broken after an update | [A bad deployment](#a-bad-deployment) |
| `systemctl status project-control-runner` is not `active` | "The host runner is unavailable" in the panel; Repository Actions, project inspection or Development State fail | [A broken runner](#a-broken-runner) |
| `rollback`/`update`/`recover-deployment` refuse because an image is gone | "image was pruned" / "images do not match lock" | [A missing image](#a-missing-image) |
| Last night's backup didn't run, or `pcctl backup --check` fails | `journalctl -u project-control-backup` shows an error | [A failed backup](#a-failed-backup) |

## What you must have off-machine

| Item | Without it |
| --- | --- |
| **restic passphrase** | Every snapshot is permanently undecryptable. No recovery exists. |
| **Google Drive account access** | The repository is unreachable. |
| Tailscale account access | You can restore, but not reach the portal. |

The rclone token and the n8n encryption key are *inside* the backup, so they do
not need separate storage — but the restic passphrase does, because it is what
decrypts everything else.

---

## Recovery time

For a full [host failure](#host-failure-rebuild-on-a-new-machine) rebuild:

| Phase | Typical |
| --- | --- |
| Base OS + packages | 20–30 min |
| Restore from Google Drive | 10–60 min (size dependent) |
| Reconfigure and verify | 15 min |
| **Total** | **1–2 hours** |

---

## Host failure (rebuild on a new machine)

The whole host is gone — hardware died, the disk failed, the cloud instance
was terminated. Nothing survives except what restic uploaded off-machine.

### 1. Prepare the machine

Ubuntu 22.04, then follow [installation.md](installation.md) §1 to install
Docker, Node, Go, Tailscale, restic and rclone. Do **not** run `pcctl install`
yet.

### 2. Reconnect Tailscale

```bash
sudo tailscale up
```

Use the same hostname if you want the same MagicDNS name; otherwise the portal
URL changes.

### 3. Reach the repository

```bash
rclone config          # create a remote named exactly: gdrive
```

Then:

```bash
export RESTIC_REPOSITORY=rclone:gdrive:Project-Control-Backups/restic
export RCLONE_CONFIG=$HOME/.config/rclone/rclone.conf

restic snapshots       # prompts for the passphrase
```

If this lists snapshots, recovery is possible. If it does not, stop — nothing
below will work.

### 4. Restore

```bash
sudo mkdir -p /restore
sudo -E restic restore latest --target /restore
```

Everything lands under `/restore/srv/project-control/`.

### 5. Put the deployment back

```bash
sudo mkdir -p /srv/project-control
sudo rsync -a /restore/srv/project-control/ /srv/project-control/

sudo chmod 700 /srv/project-control/secrets
sudo chmod 600 /srv/project-control/secrets/*
sudo chown -R root:root /srv/project-control/secrets
```

### 6. Install over the restored data

```bash
cd project-memory-control-center
git checkout <the tag or commit recorded in the backup manifest>
pnpm install
sudo ./pcctl install
```

`install` is idempotent: it recreates users, groups, systemd units and images,
and **preserves existing secrets** — the restored n8n encryption key is kept, so
credentials remain decryptable.

### 7. Load the database dumps

The restored `data/postgres` is not used; the logical dumps are authoritative.

```bash
sudo ./pcctl stop
sudo rm -rf /srv/project-control/data/postgres/*
sudo ./pcctl start          # a fresh cluster is initialised with the restored secrets

STAGING=/srv/project-control/backups/staging
SUPER="$(sudo cat /srv/project-control/secrets/pg_superuser_password)"

for db in project_control n8n; do
  sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
    psql -U postgres -c "DROP DATABASE IF EXISTS ${db}"
done

sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
  psql -U postgres -c "CREATE DATABASE project_control OWNER control_migrator"
sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
  psql -U postgres -c "CREATE DATABASE n8n OWNER n8n_app"

sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
  pg_restore -U postgres -d project_control --no-owner --no-privileges < "$STAGING/project_control.dump"
sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
  pg_restore -U postgres -d n8n --no-owner --no-privileges < "$STAGING/n8n.dump"

sudo ./pcctl restart
```

### 8. Re-publish over Tailscale

```bash
sudo ./pcctl configure-tailscale
```

### 9. Verify

```bash
./pcctl verify
./pcctl verify-security
./pcctl health
```

Then confirm by hand:

- sign in to the portal with a pre-existing account;
- sign in to n8n and open a workflow **and one of its credentials** — if the
  credential decrypts, the encryption key was restored correctly;
- run the artifact self-test from the dashboard;
- `sudo ./pcctl restore-test`.

### 10. Clean up

```bash
sudo rm -rf /restore
```

---

## Database failure (host and containers otherwise healthy)

The host, Docker and the runner are fine, but PostgreSQL itself is not —
`./pcctl health` reports postgres unhealthy, the data directory is corrupt,
or a database was dropped/mangled by mistake. There is no need to rebuild
the whole host for this: the logical dumps in the backup are authoritative,
the same way they are in step 7 of a full rebuild.

```bash
sudo ./pcctl stop

# If postgres itself will not even start (corrupt data directory), reinitialise
# the cluster from the existing, undamaged secrets before restoring into it:
sudo rm -rf /srv/project-control/data/postgres/*
sudo ./pcctl start          # postgres only is enough; this is simpler

export RESTIC_REPOSITORY=rclone:gdrive:Project-Control-Backups/restic
export RESTIC_PASSWORD_FILE=/srv/project-control/secrets/restic_password
export RCLONE_CONFIG=/srv/project-control/config/rclone.conf

sudo restic restore latest --target /tmp/pc-restore \
  --include /srv/project-control/backups/staging

SUPER="$(sudo cat /srv/project-control/secrets/pg_superuser_password)"

# List the database(s) that actually failed — usually just one:
for db in project_control; do   # or: for db in project_control n8n; do
  owner=control_migrator; [ "$db" = n8n ] && owner=n8n_app
  sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
    psql -U postgres -c "DROP DATABASE IF EXISTS ${db}"
  sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
    psql -U postgres -c "CREATE DATABASE ${db} OWNER ${owner}"
  sudo docker exec -i project-control-postgres env PGPASSWORD="$SUPER" \
    pg_restore -U postgres -d "${db}" --no-owner --no-privileges \
    < "/tmp/pc-restore/srv/project-control/backups/staging/${db}.dump"
done

sudo ./pcctl restart
sudo rm -rf /tmp/pc-restore
```

Verify the same way as after a full rebuild: `./pcctl verify`,
`./pcctl verify-security`, sign in, and `sudo ./pcctl restore-test` once the
stack is confirmed healthy. This is the same recipe as
[backup-restore.md § A single database](backup-restore.md#a-single-database),
generalised to either database.

---

## A bad deployment

`sudo ./pcctl update` made a release live and it is visibly worse than what
was running before — the tool itself reported failure, or the app is up but
broken. Full detail: [update-rollback.md](update-rollback.md#rolling-back).

```bash
sudo ./pcctl rollback --list                # see what's available
sudo ./pcctl rollback                       # roll back to the most recent point
# or: sudo ./pcctl rollback --id <id>        # a specific earlier point

sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl status
```

`rollback` restores configuration, container images and the runner binary —
it never undoes an applied database migration, and it refuses a down-level
rollback past a newer checkpoint version unless `--force` is given (only
after reviewing compatibility — historical checkpoint rows are immutable).
If the release you are rolling back past added migrations, the database
stays ahead of the older code on purpose: `update.sh` itself refuses to
start an older image against a schema it does not understand. In that case,
restoring code with `rollback` is not enough — restore the data too, using
[Database failure](#database-failure-host-and-containers-otherwise-healthy)
above against the pre-update backup `update` took automatically in step 1.

If `rollback` itself refuses because an image was pruned, this is actually
the [missing image](#a-missing-image) scenario below, not this one.

---

## A broken runner

`project-control-runner.service` is the host-resident Go binary the Control
API talks to over a Unix socket for project inspection, Development State,
and Repository Actions. When it is down, the panel shows "The host runner is
unavailable" on those specific features — everything else (roadmap, memory,
automation) keeps working, since nothing else depends on it.

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

```bash
sudo systemctl restart project-control-runner
ls -l /run/project-control/runner.sock     # expect srw-rw---- project-runner project-control
docker inspect project-control-api --format '{{.HostConfig.GroupAdd}}'   # confirm the API container joined the group
sudo ./pcctl verify-security               # re-check the RNR-* runner posture
```

Full symptom table: [troubleshooting.md § The runner is down](troubleshooting.md#the-runner-is-down).
A runner that will not come healthy also blocks the recovery tooling below —
`recover-deployment` and `resume-update` both refuse (`RCV-008`) until the
runner answers a typed `system.health` request, so fix it here first if
you're chasing a different scenario and land on this one instead.

---

## A missing image

`sudo ./pcctl rollback`, `update` or `recover-deployment` refuse with
something like "image was pruned" or "images do not match lock" — a locally
built image (`control-api`, `web`, `caddy`) that the tooling expects no
longer exists (usually from a manual `docker image prune`). Full decision
tree: [update-rollback.md § Supported recovery when that rollback point is
also unrecoverable](update-rollback.md#supported-recovery-when-that-rollback-point-is-also-unrecoverable).

**First, tell the two cases apart.** If `docker ps` shows all five
containers already healthy and only the *metadata* (`versions.lock.env`,
`stack.env`) is stale, no image actually needs rebuilding:

```bash
sudo ./pcctl reconcile-state          # metadata-only repair; never rebuilds or restarts
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl backup
sudo ./pcctl backup --check
sudo ./pcctl update                   # now able to publish a trustworthy rollback point
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl status
sudo ./pcctl backup
sudo ./pcctl restore-test
```

If instead one or more of `control-api`/`web`/`caddy` is actually unhealthy
(stuck in Docker's `created` state because the image it needs is gone), the
image has to be rebuilt from the repository — check whether a migration is
pending first, since that decides which tool is safe:

```bash
sudo ./pcctl recover-deployment       # nothing pending: rebuilds and recreates
                                       #   only the broken service(s)
# — or, only if a migration was left genuinely pending —
sudo ./pcctl resume-update            # takes a fresh backup, then completes
                                       #   the interrupted migration
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl status
```

Both refuse (rather than guess) if `postgres`/`n8n` are unhealthy, if the
runner is not ready, or if a service is unhealthy in a state other than
`created` — in every refusal case nothing was touched, and the message says
what to fix first. Neither accepts `--force`.

---

## A failed backup

The nightly `project-control-backup.timer` run failed, or
`sudo ./pcctl backup --check` reports a problem.

```bash
journalctl -u project-control-backup -n 100
sudo ./pcctl backup                  # run manually to see the current error
```

| Message | Cause | Fix |
| --- | --- | --- |
| `MANUAL_CONFIGURATION_REQUIRED` | Google Drive was never configured | `sudo ./pcctl configure-google-drive` |
| `cannot list Google Drive` | OAuth token expired | re-run `rclone config` for `gdrive` |
| `wrong password` | wrong restic passphrase | there is no recovery for existing snapshots — see [If the restic password is lost](backup-restore.md#if-the-restic-password-is-lost) |
| `dump ... is only N bytes` | `pg_dump` produced a truncated dump | check PostgreSQL health (`./pcctl health`) before retrying |

A single missed or failed run is not itself an emergency: the timer is
`Persistent=true` (it catches up on next boot rather than skipping), and
every previously successful snapshot in Google Drive remains valid and
restorable — check what you can currently fall back to with:

```bash
sudo RESTIC_REPOSITORY=rclone:gdrive:Project-Control-Backups/restic \
     RESTIC_PASSWORD_FILE=/srv/project-control/secrets/restic_password \
     RCLONE_CONFIG=/srv/project-control/config/rclone.conf \
     restic snapshots
```

Once the underlying cause is fixed, confirm recovery actually works again
rather than just that the command exits `0`:

```bash
sudo ./pcctl backup --check      # verify repository integrity (reads 5 % of pack data)
sudo ./pcctl restore-test        # full isolated restore rehearsal
```

If backups have been failing for a long enough stretch that no snapshot
exists at all yet, that is the [Disk failure with no backup](#disk-failure-with-no-backup)
case below — there is nothing to restore until the first successful run.

---

## Partial failures

### Corrupt artifact objects

Objects are content-addressed, so corruption is detectable:

```bash
cd /srv/project-control/data/artifacts/objects
find . -type f | while read -r f; do
  [ "$(basename "$f")" = "$(sha256sum "$f" | cut -d' ' -f1)" ] || echo "CORRUPT: $f"
done
```

Restore only the affected objects with `restic restore --include`.

### Lost n8n encryption key

Workflows survive; credentials do not. Delete the credential rows and re-enter
every credential in the n8n UI. There is no way to decrypt them without the key.

### Disk failure with no backup

Not recoverable. This is why the monthly restore test exists — it is the only
thing that proves the backup path works *before* you need it.

---

## Recovery drill

Twice a year, on a spare machine or VM, perform the full
[host failure](#host-failure-rebuild-on-a-new-machine) procedure end to end
using only what you keep off-machine. Exercise the narrower scenarios above
more often, and on the real host where it's safe to (rollback, reconcile-state
and the runner checks are all read-heavy and low-risk to rehearse) — a
recovery procedure that has never been executed is a document, not a
capability.
