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

This same command sequence is also the correct recovery when a failed update
has left one or more application containers stuck in Docker's `created`
state (container *start* failed — an OCI runtime error, not a slow-start
race) — `rollback` does not inspect current container state before it acts;
it only requires the target snapshot to be internally coherent and its exact
image IDs to still be present locally, then unconditionally recreates all
five containers from that snapshot regardless of whatever state they were
already in. **The one fact that decides whether this is the right tool
instead of `recover-deployment` (below) is whether the pending migration was
ever actually applied**, checkable with:

```bash
sudo ./pcctl recover-deployment
```

— read its `RCV-006`/`RCV-007` output, don't act on it (it will correctly
refuse either way; that refusal is not the answer, its diagnosis is):

- **`RCV-007` fails because migrations are pending, and the database's
  applied ledger has not moved past the previous release (`RCV-006` still
  passes as a subset check, it says nothing about *how much* is pending).**
  The only thing that ever runs real, committing SQL is the Control API's
  own entrypoint on a successful start (see `apps/control-api/src/db/
  migrate.ts` — idempotent, checksum-verified, applied once per version) —
  so a container that never started could not have applied anything.
  Rolling the application images back to the pre-update snapshot is fully
  safe here: the old images expect exactly the schema that's still there.
  Use the sequence above.

  **If `rollback` itself then refuses** — its own "Verifying the target
  images are present" step reports one or more of `control-api`/`web`/
  `caddy` as pruned — rolling back is no longer available at all, and trying
  an older point on the list is not a substitute (there is no guarantee any
  older snapshot's exact images survived either, and probing them one by one
  is not a supported recovery step). This does not make the situation
  unsafe — migrations are still confirmed unapplied — it only means the
  "roll back, then retry `update`" path is closed. Use
  `sudo ./pcctl resume-update` instead (see below): it completes the same
  interrupted update forward, with `update.sh`'s own safeguards (a fresh
  backup, an irreversible-migration scan) applied before anything is
  touched, precisely because a real migration is about to commit for the
  first time.
- **The pending migration(s) were already committed** (the previous release
  got e.g. `control-api` far enough to start at least once before a *later*
  recreation attempt got stuck `created`). Rolling back now would start an
  older Control API image against a schema it does not understand — refused
  automatically by `update.sh` itself for exactly this reason (see
  "Additive migration rollback limitation" above). Use
  `sudo ./pcctl recover-deployment` instead (below) — never `rollback`,
  never `resume-update` — and never hand-apply, retry, or skip a migration
  to route around this.

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

### Supported recovery when a locally-built service is stuck `created`

A different incident from either recovery above: `postgres` and `n8n` are
healthy, but one or more of `control-api`/`web`/`caddy` never made it past
Docker's `created` state, because container *start* itself failed (an OCI
runtime error — e.g. a nested bind mount under an already read-only parent —
not a slow-start readiness race). `docker inspect` still resolves the
`created` container's image: `compose up` pins the image at container-create
time regardless of whether the later `start` succeeds, so the stuck
container is already the new image, it just never ran.

This is **not** what `update --force` or a broader `reconcile-state` are for.
`update` refuses to publish a rollback point from an incoherent deployment
(the same coherence gate as above), and rolling application images back
automatically is unsafe once a migration may have advanced the schema ledger
— an older Control API image can refuse to start against newer schema.
`reconcile-state` never recreates anything; it only repairs metadata for an
already-healthy stack, and a `created` container fails its very first check.

Use the dedicated command instead:

```bash
sudo ./pcctl recover-deployment
```

It proves, before touching anything: `postgres`/`n8n` are healthy and outside
its scope; every unhealthy service is specifically `created` (anything else —
`exited`, `restarting`, `dead` — is refused as a different incident); the
database's applied migration ledger is a subset of the current repository's
migrations with nothing pending (recovery recreates containers, it never
advances the schema); the runner is ready; a successful backup exists (the
database recovery boundary this operation stays behind); and the current
repository's Compose file resolves — via a real `docker compose config`
render, not a source grep — to exactly one `control-api` `/config` mount,
none nested. Only then does it rebuild images with `build.sh` (the same
deterministic step `update` always runs), stage the current Compose/
automation config, re-run the migration dry-run as a final live check,
remove **only** the specific `created` container(s) it already proved are
`created`, recreate them with `--no-deps` (postgres/n8n and any
already-healthy service are never named), health-gate them, run the real,
unmodified `verify.sh` and `verify-security.sh`, and — only after every one
of those passes — hand off to the real, unmodified `reconcile-state.sh` to
publish the new, coherent version lock. It accepts no override flag,
including `--force`. See `tests/recover-deployment-regression.sh`.

Follow up exactly like any other successful `reconcile-state` run:

```bash
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl status
```

`recover-deployment` refuses (rather than guessing) if a targeted service is
unhealthy in a state other than `created`, if `postgres`/`n8n` are unhealthy,
if a migration is pending, or if no successful backup is on record — in each
case, nothing is touched and the failing check tells you what to fix first.

### Supported recovery when a stuck service also has a pending migration and rollback is unavailable

The same `created`-container incident as above, but `RCV-007` reports
migration(s) genuinely pending (not yet committed — see "Interpreting
`recover-deployment`'s diagnosis" above) **and** `rollback` cannot be used
either, because its target snapshot's exact `control-api`/`web`/`caddy`
images have been pruned. `recover-deployment` correctly refuses here (its
whole design is to never be the tool that first advances the schema); do not
weaken that refusal or repurpose the command. Use the dedicated command
instead:

```bash
sudo ./pcctl resume-update
```

It proves everything `recover-deployment` does (`postgres`/`n8n` healthy and
untouched; every unhealthy service specifically `created`; the applied
ledger a clean subset of the repository's migrations with **at least one**
migration genuinely pending — the inverse of `recover-deployment`'s
precondition; the runner ready; the current repository's Compose resolves to
exactly one `control-api` `/config` mount), plus the two additional
safeguards this incident specifically needs because a real migration is
about to commit for the first time:

- **A fresh backup taken by this run** — not merely "a successful backup is
  on record" (`recover-deployment`'s weaker check is enough for a tool that
  never touches the schema; this one is not that tool).
- **A hard, unconditional refusal on any irreversible pending migration**
  (`DROP TABLE`/`COLUMN`/`DATABASE`/`SCHEMA`, `TRUNCATE`) — the same
  detection `update.sh` step 5 uses, but with no `--force` escape at all:
  a recovery run does not get to make that judgement call in the moment the
  way a live `update` operator can.

Only after both pass does it rebuild images, stage the current Compose/
automation config, run the migration dry-run as a final live check, remove
**only** the specific `created` container(s) it already proved are
`created`, and recreate them with `--no-deps`. The pending migration(s) are
never applied by this script directly — recreating `control-api` triggers
its own entrypoint's real, idempotent, checksum-verified migration run
(`apps/control-api/src/db/migrate.ts`), the exact same mechanism `update.sh`
itself would have used. It then health-gates, runs the real, unmodified
`verify.sh`/`verify-security.sh`, and only then hands off to the real,
unmodified `reconcile-state.sh`. It accepts no override flag, including
`--force`. See `tests/resume-update-regression.sh`.

Follow up exactly like a successful `recover-deployment` run:

```bash
sudo ./pcctl verify
sudo ./pcctl verify-security
sudo ./pcctl status
```

If a mid-run failure happens **after** the migration dry-run passed but the
run did not reach "resume-update complete", do not assume the migration did
or did not commit and do not re-run this tool blindly — check
`schema_migrations` directly first, exactly as its own failure messages say.

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
