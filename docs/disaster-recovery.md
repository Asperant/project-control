# Disaster recovery

Rebuilding the deployment on a new machine from nothing but a backup.

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

| Phase | Typical |
| --- | --- |
| Base OS + packages | 20–30 min |
| Restore from Google Drive | 10–60 min (size dependent) |
| Reconfigure and verify | 15 min |
| **Total** | **1–2 hours** |

---

## Procedure

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

Twice a year, on a spare machine or VM, perform this entire procedure end to end
using only what you keep off-machine. A recovery procedure that has never been
executed is a document, not a capability.
