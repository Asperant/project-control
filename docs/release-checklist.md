# Release checklist

The gate list below is the roadmap's own definition of "done" for a release:
git status clean, tests green, build green, security green, backup green,
restore green, manual UI green, docs updated, version metadata consistent,
images pinned, runner binary pinned/known. Nothing is added to that list and
nothing on it is optional — a release that has not cleared all eleven is not
a release, it is a deploy someone got away with.

Several of these gates are directly answered by one command:

```bash
./pcctl release-manifest
```

`scripts/release-manifest.sh` (`docs` intentionally kept short here — see
the script's own header comment for the full field-by-field provenance)
assembles a single read-only JSON document: application version, the exact
git commit, every image's digest/ID and whether it matches what is running,
the applied migration count, the checkpoint-reader capability this build's
code supports, the runner binary's reported version, and the last recorded
backup/security status. It changes nothing on the host. Run it with `sudo`
when checking a live deployment — the migration-level field needs root to
read the `pg_superuser_password` secret, the same requirement
`./pcctl verify`'s `PG-004` check already has. Where a field is genuinely
unavailable (no running container, no status file yet, no root) it is
reported as `null` with an honest `note` explaining why — never guessed.

Run every gate below, in order, before calling a release done. Stop at the
first failure; do not proceed past it "to see if the rest pass too" — a
release built past a failed gate is exactly the failure mode this checklist
exists to prevent.

---

## 1. Git status clean

```bash
git status --porcelain
```

**Expected:** no output. If anything is uncommitted, either commit it or
explicitly decide it must not ship and stash/discard it — never build a
release from a dirty tree. Cross-check: `./pcctl release-manifest`'s
`git.dirty` field must be `false`, and `git.commit` is the commit every
other gate below is being evaluated against.

## 2. Tests green

```bash
pnpm lint
pnpm typecheck
pnpm test
go test ./...
```

**Expected:** every command exits `0`. This is `docs/quality-gates.md`'s own
baseline gate list — run it in full, not a subset. If the release touches
an area `docs/quality-gates.md` calls out as needing more (migrations,
Resume/Work Sessions, automation/service identity, deployment/readiness),
also run that area's additional commands listed there, including the full
regression sweep where it applies:

```bash
bash -n scripts/*.sh scripts/lib/*.sh tests/*.sh
for test_script in tests/*.sh; do bash "$test_script" || exit 1; done
```

**Expected:** every regression script exits `0`. A single `FAIL` anywhere
stops the release.

## 3. Build green

```bash
pnpm build
./pcctl build
```

**Expected:** `pnpm build` succeeds for every workspace package.
`./pcctl build` (`scripts/build.sh`) ends with `build complete`: the runner
binary is built and confirmed statically linked (`build.sh` itself dies if
`file` reports it dynamically linked), and `control-api`/`web`/`caddy` are
built and tagged exactly as `infra/versions.lock.env` names them. A failure
here means nothing downstream — deploy, verify, or manifest — can be
trusted, since none of it has anything correct to point at yet.

## 4. Security green

```bash
sudo ./pcctl verify-security
```

**Expected:** every check `PASS`. The one standing, documented exception is
`SEC-006` (`n8n_encryption_key`/`pg_n8n_app_password` trailing-whitespace,
tolerated by n8n itself — see `docs/service-accounts.md`; **never** rotate
`n8n_encryption_key` to silence it, that orphans every credential n8n has
ever encrypted). Any other `FAIL` blocks the release. `verify-security.sh`
writes no status file of its own — this gate must be run fresh, every time;
`./pcctl release-manifest`'s `securityStatus` field only ever reflects the
*last recorded* run (from `config/status/verification.json`, written by
`record-verification-status.sh` on `project-control-verify.timer`), which
is why the manifest's own `securityStatus.note` says so explicitly and
flags `stale: true` past 36 hours. Use the manifest to see when security was
last checked; use this command to actually check it now.

## 5. Backup green

```bash
sudo ./pcctl backup
sudo ./pcctl backup --check
```

**Expected:** both exit `0`. `backup --check` runs `restic check
--read-data-subset=5%` against the repository, not a new backup — a
non-zero exit here means stop, do not proceed to `update` on the strength of
a backup whose integrity is unverified. Confirm
`config/status/backup-status.json`'s `lastResult` is `"success"` — the same
file `./pcctl release-manifest`'s `backupStatus` field embeds verbatim.

## 6. Restore green

```bash
sudo ./pcctl restore-test
```

**Expected:** ends with `restore test passed in <N>s` and exit `0`
(`scripts/restore-test.sh`). This restores the latest snapshot into an
isolated, throwaway PostgreSQL container on its own network — never the
live stack — reloads both database dumps, and re-hashes a sample of
restored artifacts against their content-addressed filenames. A backup that
has never been restored is a hypothesis, not a backup; this is what turns
gate 5's snapshot into a proven one.

## 7. Manual UI green

Browser action, not a command. Log into the portal
(`https://<tailnet-name>` — see `docs/manual-checkpoints.md`) and walk every
flow this release touches, at minimum:

- desktop and ~390px mobile widths;
- full keyboard navigation (no mouse-only path);
- empty, loading, and error states — not just the happy path;
- archived/read-only views render but reject mutation;
- no duplicate-submit on a slow network, and every destructive action has a
  confirmation step.

This is `docs/quality-gates.md`'s own UI checklist — run it in full for
whatever surface changed. If the release ships a feature large enough to
warrant its own acceptance runbook (numbered steps, an "Expected:" for
each, a summary table), run that runbook's browser-driven steps here too;
do not re-invent a parallel checklist for a feature that already has one.

**Expected:** every flow above behaves correctly, by eye. There is no
automated substitute for this gate — that is the entire reason it exists
separately from gate 2.

## 8. Docs updated

```bash
git status --porcelain -- docs/
git diff --stat HEAD~1 -- docs/   # or the commit range this release covers
```

**Expected:** every doc describing behavior this release changed is updated
in the same release — a route, a schema, a script's flags, a security
guarantee, or a manual checkpoint that moved. There is no automated doc
linter in this repository; this gate is a judgment call the release
reviewer makes by reading the diff, not a command that returns pass/fail.
If the release shipped a feature significant enough to touch the live host,
it should have its own acceptance runbook (gate 7's model) before this gate
is considered clear.

## 9. Version metadata consistent

```bash
./pcctl release-manifest
```

**Expected:** the manifest's top-level `"version"` matches
`infra/versions.lock.env`'s `PC_STACK_VERSION` and `package.json`'s
`"version"` field, and — once deployed — the running stack's
`config/stack.env`'s `PC_STACK_VERSION` too (the manifest reads the
deployed value automatically when one exists, the same way
`./pcctl verify` does). Also confirm in the same output:
`checkpointReader.consistent` is `true` (the contracts package's
highest `checkpointSnapshotV<N>Schema` agrees with the deployed
`config/checkpoint-reader-max-version` file), and `git.commit` is the
commit you expect this release to be. Any mismatch here means some part of
the stack is describing a different release than the rest of it —
`docs/risk-registry.md` has prior incidents from exactly this class of
drift.

## 10. Images pinned

```bash
./pcctl release-manifest
sudo ./pcctl verify
```

**Expected:** in the manifest, `images.allPinned` is `true` — meaning every
one of postgres/n8n/caddy/control-api/web was individually confirmed
(`pinnedMatchesRunning: true`) to be the exact image ID/digest
`infra/versions.lock.env` (or the locally built tag, for the three images
this repository builds itself) names, not merely a same-named image that
happens to be running. `sudo ./pcctl verify`'s `IMG-001` row for every
service must `PASS` too — it is the same check, run independently. A `null`
in the manifest (rather than `true`/`false`) means a container was not
running or docker was unreachable when the manifest ran — re-run it against
the actual deployment target before treating this gate as clear; a `null`
is not a pass.

## 11. Runner binary pinned/known

```bash
./pcctl release-manifest
sudo ./pcctl verify
```

**Expected:** the manifest's `runner.version` is set and matches
`version` (gate 9) — the runner binary has no independent semver of its
own today, it is stamped at build time from `PC_STACK_VERSION`
(`apps/runner/cmd/runner/main.go`'s `-X main.version=...`), which the
manifest's own `runner.note` says explicitly rather than implying a
tracking scheme that does not exist. On a live deployment, run this as
root and confirm `runner.matchesLiveProcess` is `true` — proof (via
`/proc/<pid>/exe`, the same check `update.sh` itself gates on) that the
bytes on disk are the bytes systemd is actually running, not a stale
build left over from an interrupted update. `sudo ./pcctl verify`'s
`RUN-001`/`RUN-002`/`RUN-003` rows must also `PASS` (service active,
socket present, reachable from the Control API container).

---

## Summary table

| # | Gate | Command(s) | Passing looks like |
| --- | --- | --- | --- |
| 1 | Git status clean | `git status --porcelain` | no output |
| 2 | Tests green | `pnpm lint && pnpm typecheck && pnpm test && go test ./...` (+ area-specific `docs/quality-gates.md` commands) | all exit `0` |
| 3 | Build green | `pnpm build && ./pcctl build` | both exit `0`, ends `build complete` |
| 4 | Security green | `sudo ./pcctl verify-security` | all `PASS` except documented `SEC-006` |
| 5 | Backup green | `sudo ./pcctl backup && sudo ./pcctl backup --check` | both exit `0`, `lastResult: "success"` |
| 6 | Restore green | `sudo ./pcctl restore-test` | `restore test passed in <N>s`, exit `0` |
| 7 | Manual UI green | browser walkthrough | every flow correct by eye |
| 8 | Docs updated | `git diff --stat -- docs/` + reviewer judgment | every changed behavior has an updated doc |
| 9 | Version metadata consistent | `./pcctl release-manifest` | `version`/`checkpointReader.consistent` agree everywhere |
| 10 | Images pinned | `./pcctl release-manifest && sudo ./pcctl verify` | `images.allPinned: true`, all `IMG-001` `PASS` |
| 11 | Runner binary pinned/known | `./pcctl release-manifest && sudo ./pcctl verify` | `runner.matchesLiveProcess: true`, all `RUN-00*` `PASS` |

A release that has cleared every row above is the point at which
`./pcctl release-manifest --out <path>` is worth keeping as the dated
record of what actually shipped — the command itself writes nothing unless
`--out` is given, so this is a deliberate, final step, not a side effect of
running the checklist.
