# Update and rollback

## Updating

```bash
git pull                      # brings a new infra/versions.lock.env
sudo ./pcctl update
```

### What `update` does, in order

1. **Backup.** Aborts if it fails. `--skip-backup` requires `--force`.
2. **Coherence gate and rollback point.** Before publishing a selectable
   rollback point, proves the deployed lock and `stack.env` agree, all five
   running containers use those exact resolved images, and the runner answers
   a typed `system.health` request. It then atomically publishes the config,
   runner binary and concrete running image IDs (tags move, IDs do not).
3. **Digest check.** Every image must be digest-pinned and must pull. A floating
   tag is refused.
4. **Migration dry-run.** The newly built Control API image (not the still-running old container) executes pending SQL for real inside a transaction
   and then rolled back, so a syntax or constraint error surfaces while the old
   stack is still healthy.
5. **Irreversibility gate.** Pending migrations are scanned for `DROP TABLE`,
   `DROP COLUMN`, `DROP DATABASE`, `DROP SCHEMA` and `TRUNCATE`. Any hit stops
   the update unless `--force` is given, because rollback restores configuration
   and images — never dropped data.
6. **Apply.** Config and the new runner binary are installed, the runner is
   restarted, and readiness is polled for up to 30 seconds before containers
   are recreated. `activating`, delayed socket publication, and temporary
   socket connection failures are retried; a failed service, non-socket path,
   or invalid protocol response fails closed.
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
sudo ./pcctl rollback --id <id> --force  # only after compatibility review
```

### What rollback restores

- `versions.lock.env`, `stack.env`, `compose.yaml`
- exact locally built application image IDs (must still exist) and pinned
  third-party images (re-pulled if pruned)
- the host runner binary (for rollback points created by current releases)

### What it does **not** restore

- **Applied database migrations.** They stay applied.
- **Data.** Use a backup ([disaster-recovery.md](disaster-recovery.md)).

Rollback compares the database's highest checkpoint version with the target's
release-artifact reader capability. It refuses a down-level rollback after a newer
checkpoint version (including v3) has been written unless `--force` is used.
Prefer a v3-capable target; force only after a fresh backup and tested restore
review, because historical checkpoint rows are intentionally immutable.

This is precisely why `update` refuses irreversible migrations without `--force`:
past that point, rollback restores the code but not the dropped data.

The configuration being replaced is itself saved to
`backups/rollback/pre-rollback-<timestamp>/`, so a rollback can be undone.

Rollback uses the same bounded runner readiness check, then reconciles every
running container to the exact immutable image ID stored in the target. The API
route and strict `verify` must pass before a success audit or notification is
written. Any runner, Compose, image, route, or verification failure is reported
as **ROLLBACK INCOMPLETE** and exits non-zero.

The five most recent rollback points are kept.

### Supported recovery for a partial Stage 7 rollback

Do not run another update while the deployed lock/runner and running images are
inconsistent; the coherence gate will refuse to snapshot that state. Recover
using the rollback point created by the failed Stage 7 update:

```bash
sudo ./pcctl rollback --list
sudo ./pcctl rollback --id <FAILED_STAGE7_ROLLBACK_ID>
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl backup
sudo ./pcctl backup --check
sudo ./pcctl update
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl status
```

Do not add `--force` unless the checkpoint compatibility gate specifically
requires it and backup/restore compatibility has been reviewed. The recovery
rollback is successful only when all five exact target image IDs and strict
verification pass.

### Supported recovery when that rollback point is also unrecoverable

`rollback` itself refuses to run if any locally built image it needs
(`control-api`, `web`, `caddy`) was pruned — "rollback target is not locally
recoverable because an exact application image was pruned; nothing was
changed". If this happens on the recovery target above, the running
containers may still be a healthy, mutually coherent stack even though the
files describing them are not — only the metadata is wrong, not the stack.

Do **not** hand-edit `versions.lock.env`/`stack.env`, `docker tag` anything
yourself, retry `rollback --id` against an older point, or add `--force` to
push past the coherence gate. Use the dedicated reconciliation command
instead:

```bash
sudo ./pcctl reconcile-state
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl backup
sudo ./pcctl backup --check
sudo ./pcctl update
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl status
sudo ./pcctl backup
sudo ./pcctl restore-test
```

`reconcile-state` never deploys, builds, restarts or recreates anything — its
only purpose is making the deployment metadata truthfully describe the
already-running, already-verified stack, so `update`'s own coherence gate
(unchanged, unweakened) can then build a trustworthy rollback point from it.
It is fail-closed: containers must exist and be healthy, every running image
ID must still be a real, inspectable Docker object, the Control API and
runner must be verifiably ready, the applied migration ledger must be a
subset of what's deployed, stored checkpoints must not exceed what the
running application proves it can read (via an empirical probe of the
Development State route, never a trusted-but-possibly-stale
`checkpoint-reader-max-version` file), and the deployed Compose file must
still define the running topology. Any failure aborts with nothing written.
On success it preserves the previous metadata under
`backups/reconcile/<run-id>/` before an atomic replacement, and repoints any
mutable local tag that no longer matches its running container to the exact
running image via a deterministic internal preservation tag — never a
rebuild, never a different build standing in for the one actually running.
It accepts no override flag, including `--force`: see
`tests/reconcile-state-regression.sh` and
"Pruned exact rollback images strand a coherent-but-mislabeled deployment" in
`docs/risk-registry.md`.

If `reconcile-state` itself fails closed — most commonly because a container
is unhealthy, the runner is not ready, or the database is genuinely ahead of
what's deployed — it is reporting a real problem with the running stack, not
a metadata problem; fix that condition (see the corresponding `RUN-*`/`CNT-*`
check in `pcctl verify`) before retrying.

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
