# Backup and restore

## What is backed up

| Included | Why |
| --- | --- |
| `project_control` dump | users, sessions, audit trail, artifact metadata |
| `n8n` dump | workflows, credentials (encrypted), execution history |
| `data/artifacts/objects` | the artifact bytes themselves |
| `data/n8n` | n8n's persistent user folder |
| `compose/`, `config/`, `migrations/`, `scripts/` | everything needed to rebuild |
| `secrets/` | **required** to decrypt n8n credentials after a restore |
| `docs/`, `runner/` | documentation and the runner binary |

| Excluded | Why |
| --- | --- |
| `data/postgres` | the logical dump is the backup; the raw cluster directory is not portable |
| `data/artifacts/temporary` | staging area |
| `backups/restore-tests` | scratch |
| `backups/logs`, `logs/` | rotatable |
| `node_modules`, `.cache`, `.git` | reconstructible |

> `secrets/` is deliberately in scope. Restoring without the n8n encryption key
> would leave every stored credential unreadable. The restic repository is itself
> encrypted, so this does not weaken anything.

## Repository

```
rclone:gdrive:Project-Control-Backups/restic
```

Encrypted by restic (AES-256) **before** upload — Google Drive only ever holds
ciphertext.

## Schedule

| Job | When | `Persistent` |
| --- | --- | --- |
| Backup | daily 02:30 (+ ≤ 30 min jitter) | yes |
| `restic check` | Sunday 04:00 (+ ≤ 1 h) | yes |
| Restore test | 1st of month 05:00 (+ ≤ 2 h) | yes |

`Persistent=true` means a run missed because the machine was off happens on the
next boot rather than being skipped.

All three are independent of n8n: if the automation engine is broken, backups
still run.

## Retention

14 daily, 8 weekly, 12 monthly, with `--prune` so space is reclaimed.

---

## Manual operations

```bash
sudo ./pcctl backup              # run now
sudo ./pcctl backup --check      # verify integrity (reads 5 % of pack data)
sudo ./pcctl restore-test        # full isolated restore rehearsal
```

Listing snapshots:

```bash
sudo RESTIC_REPOSITORY=rclone:gdrive:Project-Control-Backups/restic \
     RESTIC_PASSWORD_FILE=/srv/project-control/secrets/restic_password \
     RCLONE_CONFIG=/srv/project-control/config/rclone.conf \
     restic snapshots
```

---

## The restore test

`restore-test.sh` is what turns "we have backups" into a verified fact:

1. Restores the latest snapshot into `backups/restore-tests/<timestamp>/`.
2. Starts a throwaway PostgreSQL container — unique name, own **internal**
   network, tmpfs data directory, no published port, no bind mount into live
   data.
3. Loads both dumps and asserts the six Stage 1 tables and a non-empty migration
   ledger are present.
4. Re-hashes up to 50 restored artifacts and compares against their
   content-addressed filenames.
5. Confirms the live containers were not disturbed and the sandbox never joined
   a project-control network.
6. Destroys the container, network and directory.

The restore target is asserted to be inside `backups/restore-tests/` and refused
otherwise, so a mistaken `PC_ROOT` cannot overwrite live data.

---

## Restoring for real

> Full disaster recovery: [disaster-recovery.md](disaster-recovery.md).

### A single database

```bash
export RESTIC_REPOSITORY=rclone:gdrive:Project-Control-Backups/restic
export RESTIC_PASSWORD_FILE=/srv/project-control/secrets/restic_password
export RCLONE_CONFIG=/srv/project-control/config/rclone.conf

sudo restic restore latest --target /tmp/pc-restore \
  --include /srv/project-control/backups/staging

sudo ./pcctl stop
sudo ./pcctl start        # postgres only is enough, but this is simpler

sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_superuser_password)" \
  psql -U postgres -c "DROP DATABASE project_control"
sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_superuser_password)" \
  psql -U postgres -c "CREATE DATABASE project_control OWNER control_migrator"

sudo docker exec -i project-control-postgres \
  env PGPASSWORD="$(sudo cat /srv/project-control/secrets/pg_superuser_password)" \
  pg_restore -U postgres -d project_control --no-owner --no-privileges \
  < /tmp/pc-restore/srv/project-control/backups/staging/project_control.dump

sudo ./pcctl restart
sudo rm -rf /tmp/pc-restore
```

### Artifacts

```bash
sudo restic restore latest --target /tmp/pc-artifacts \
  --include /srv/project-control/data/artifacts/objects

sudo rsync -a --ignore-existing \
  /tmp/pc-artifacts/srv/project-control/data/artifacts/objects/ \
  /srv/project-control/data/artifacts/objects/

sudo chown -R 10001:10001 /srv/project-control/data/artifacts
sudo rm -rf /tmp/pc-artifacts
```

`--ignore-existing` is correct here: objects are immutable and content-addressed,
so an existing file with the same name already has the same content.

---

## If the restic password is lost

There is no recovery. Every existing snapshot becomes permanently undecryptable.
There is no reset, no escrow, and no support path. Keep the passphrase in a
password manager or on paper, off this machine.
