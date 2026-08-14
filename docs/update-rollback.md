# Update and rollback

## Updating

```bash
git pull                      # brings a new infra/versions.lock.env
sudo ./pcctl update
```

### What `update` does, in order

1. **Backup.** Aborts if it fails. `--skip-backup` requires `--force`.
2. **Rollback point.** Copies the current `versions.lock.env`, `stack.env` and
   `compose.yaml`, plus the concrete image IDs currently running (tags move,
   IDs do not).
3. **Digest check.** Every image must be digest-pinned and must pull. A floating
   tag is refused.
4. **Migration dry-run.** The newly built Control API image (not the still-running old container) executes pending SQL for real inside a transaction
   and then rolled back, so a syntax or constraint error surfaces while the old
   stack is still healthy.
5. **Irreversibility gate.** Pending migrations are scanned for `DROP TABLE`,
   `DROP COLUMN`, `DROP DATABASE`, `DROP SCHEMA` and `TRUNCATE`. Any hit stops
   the update unless `--force` is given, because rollback restores configuration
   and images — never dropped data.
6. **Apply.** Config installed, containers recreated.
7. **Health gate.** Every container must be healthy and `/api/auth/me` must
   answer `401`, retried for up to two minutes.
8. **Verify** and audit-log the result.

If step 6 or 7 fails without a pending migration, `rollback.sh --auto` runs and
a Telegram notification is sent. If migrations may have advanced the ledger,
the updater fails closed and requires backup/restore review instead of starting
an older image that may reject the newer schema.

### Additive migration rollback limitation

Database migrations are not reversed by an image rollback. A release that adds
new migration ledger entries can therefore leave the database ahead of an older
Control API image, and that older image deliberately refuses to start. Before a
migration-bearing production update, keep the fresh backup from step 1 and test
the database restore procedure. Automatic image rollback is not a substitute
for database restore when the schema ledger moved forward.

### Flags

| Flag | Effect |
| --- | --- |
| `--skip-backup` | Skip the pre-update backup. Requires `--force`. |
| `--force` | Proceed past the irreversible-migration gate. |

---

## Rolling back

```bash
sudo ./pcctl rollback              # most recent point
sudo ./pcctl rollback --list       # show available points
sudo ./pcctl rollback --id <id>    # a specific point
```

### What rollback restores

- `versions.lock.env`, `stack.env`, `compose.yaml`
- container images (re-pulled if pruned)

### What it does **not** restore

- **Applied database migrations.** They stay applied.
- **Data.** Use a backup ([disaster-recovery.md](disaster-recovery.md)).

This is precisely why `update` refuses irreversible migrations without `--force`:
past that point, rollback restores the code but not the dropped data.

The configuration being replaced is itself saved to
`backups/rollback/pre-rollback-<timestamp>/`, so a rollback can be undone.

The five most recent rollback points are kept.

---

## Manual verification after an update

```bash
./pcctl verify
./pcctl verify-security
./pcctl status

# The running images must match the lock:
docker inspect project-control-postgres --format '{{.Image}}'
grep PC_POSTGRES_IMAGE /srv/project-control/config/versions.lock.env
```

`verify` check `IMG-001` performs this comparison for all five services.

---

## Updating a pinned version

Never edit a digest by hand.

```bash
# 1. Resolve the digest from the official registry
docker buildx imagetools inspect postgres:17.11-trixie --format '{{.Manifest.Digest}}'

# 2. Update BOTH the tag and the digest in infra/versions.lock.env
# 3. Commit, then:
sudo ./pcctl update
```

`update` refuses any image reference without `@sha256:`.

---

## Emergency stop

```bash
sudo ./pcctl stop        # data preserved
```

If a container will not stop:

```bash
docker kill project-control-<service>
sudo ./pcctl start
```
