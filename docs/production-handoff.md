# Production handoff

A task-oriented index for an operator taking over this deployment. For every
action listed below: a one-paragraph "how to do this," and a link to the doc
that has the full depth — the command's every flag, every failure mode, every
precondition. This page does not repeat that depth; if it and the linked doc
ever disagree, the linked doc is correct.

Before anything else, read [README.md](../README.md) for what the platform
is and [manual-checkpoints.md](manual-checkpoints.md) for the five one-time
human steps every fresh install needs. This page assumes those are already
done and you're operating a running deployment.

---

## Install

A clean install starts from a bare Ubuntu 22.04 host: base packages, Docker,
Node/pnpm, Go, Tailscale and the backup tooling, then `./pcctl preflight`
(must report READY), then `sudo ./pcctl install`, then the five manual
checkpoints, then `./pcctl verify` and `./pcctl verify-security`. Full
walkthrough, exact package versions and checksums, and the directory layout
it creates: [installation.md](installation.md).

## Update

`git pull` to bring in a new `infra/versions.lock.env`, then
`sudo ./pcctl update`. It backs up first (aborting on failure), proves the
current deployment is internally coherent before publishing a rollback
point, dry-runs pending migrations inside a rolled-back transaction, refuses
an irreversible migration (`DROP`/`TRUNCATE`) without `--force`, then applies
and health-gates the new stack — rolling back automatically if health checks
fail before any migration has committed. Full step-by-step and every flag:
[update-rollback.md § Updating](update-rollback.md#updating).

## Rollback

`sudo ./pcctl rollback` (most recent point), `--list` to see what's
available, or `--id <id>` for a specific one. It restores configuration, the
exact application image IDs and the runner binary — **never** an applied
database migration and never data; a release that added migrations leaves
the database ahead of an older image on purpose, and that older image
refuses to start against a schema it doesn't recognize. If `rollback` itself
refuses because a needed image was pruned, that's a narrower case with its
own dedicated recovery, not a `rollback` problem — see the next section.
Full detail, including what is and isn't restored:
[update-rollback.md § Rolling back](update-rollback.md#rolling-back).

## Recover

"Recover" here covers everything short of a from-scratch rebuild: a stuck
`created` container, a deployment whose metadata drifted from what's
actually running, a partially-applied update, or a host/database/runner/
image/backup failure. [disaster-recovery.md](disaster-recovery.md) opens
with a **"Which scenario is this?"** table that maps the symptom you're
actually seeing (`pcctl health` output, a specific refusal message, a
`journalctl` line) to the right section — start there rather than guessing
which of `reconcile-state`, `recover-deployment`, `resume-update` or a full
[host-failure rebuild](disaster-recovery.md#host-failure-rebuild-on-a-new-machine)
applies; picking the wrong one on a schema that already advanced is exactly
the mistake that decision table exists to prevent. The narrower
container/image/migration recovery paths (which command is safe once a
migration may or may not have already committed) are spelled out in
[update-rollback.md](update-rollback.md), starting at
["Supported recovery for a partial Stage 7 rollback"](update-rollback.md#supported-recovery-for-a-partial-stage-7-rollback).

## Add or inspect a project

**Projects → New project**, type the full folder path (it must be under a
configured allowed root — `/srv/project-control/config/allowed-project-roots.conf`,
default `/home/<user>/Desktop`), **Inspect** to see a read-only preview of
detected git state, languages, frameworks and commands, edit anything, then
**Save project** — nothing is written until that click. Re-inspect an
existing project any time with its detail page's **Rescan** action, which
diffs against what's stored and requires an explicit extra confirmation only
if the repository's remote identity itself changed. Full flow, the allowed-
roots mechanism, what gets detected, and archiving:
[project-registration.md](project-registration.md).

## Backup

`sudo ./pcctl backup` runs one now (the platform also runs it automatically,
daily at 02:30); `sudo ./pcctl backup --check` verifies repository integrity
against a 5% read of pack data without taking a new snapshot. Everything
needed to rebuild is included — both PostgreSQL logical dumps, artifact
objects, config, secrets (required to decrypt n8n credentials after a
restore) — encrypted with restic before it ever leaves the machine. Full
scope, schedule and retention: [backup-restore.md](backup-restore.md).

## Restore

`sudo ./pcctl restore-test` is the safe way to prove a backup actually works:
it restores the latest snapshot into a throwaway, isolated PostgreSQL
container — never the live stack — reloads both dumps, and re-hashes a
sample of artifacts, then tears itself down. Restoring for real (a single
database, or artifacts) is a manual, deliberate procedure — never done live
against the running stack — documented step-by-step in
[backup-restore.md § Restoring for real](backup-restore.md#restoring-for-real).
For a full host rebuild, use
[disaster-recovery.md](disaster-recovery.md) instead — it's the same
restore mechanics plus everything else a dead machine needs.

## Roadmap

Every registered project has a Roadmap tab: milestones containing tasks,
each with status (`planned`/`in_progress`/`blocked`/`done`/`cancelled`),
priority, an acceptance checklist, dependencies on other tasks in the same
project, and a manually written next action. Progress is always derived from
task completion, never entered by hand. Nothing here calls an LLM, runs a
command, or touches the registered project's own files — it's purely rows in
`project_control`. Full lifecycle, confirmation rules and the archive
behavior: [manual-roadmap.md](manual-roadmap.md).

## Memory

Every registered project has a Memory tab: manually authored entries
(`decision`/`constraint`/`context`/`finding`/`handoff`/`lesson`) with an
archive → reactivate lifecycle and a permanent supersede chain, plus
immutable checkpoints — a server-computed snapshot of the project's current
state that a client cannot alter after the fact, enforced at the PostgreSQL
grant level. The same tab's **"Where was I?"** panel answers, deterministically
and without AI, what's in progress, blocked, next, and what changed since the
last checkpoint. Full concepts, the checkpoint snapshot format, and search:
[project-memory.md](project-memory.md).

## Agent runs

Every registered project has an Agent Runs tab: a manual provenance archive
of what was actually sent to an AI agent (Claude, Codex, or anything else)
and what it reported back, pasted in by hand — this platform never calls an
agent API itself. Deliberately separate from that is your own **User
Validation** status, so "the agent said it worked" and "I actually checked
it" are never conflated. A validated finding can be promoted straight into a
Memory entry with provenance preserved. Full lifecycle (prompt/report
immutability, revisions, validation states):
[agent-runs.md](agent-runs.md).

## Resume

`GET /api/projects/:projectId/resume`, surfaced in the panel as the
project's Resume screen, is the deterministic "where was I?" briefing for
picking a project back up: current focus, a recommended next action, what
needs attention, the active or last Work Session, the last checkpoint and
what's changed since it, blocked/active work, recent agent activity, pinned
memory and session history — every field server-computed from stored facts,
none of it AI-generated. A **Work Session** records a goal, and closing one
can atomically create a linked checkpoint. Full selection algorithm and the
Work Session lifecycle: [work-sessions-resume.md](work-sessions-resume.md).

## Inspect Git (development state)

Every registered project has a Development tab showing live, read-only local
Git metadata — branch, HEAD, working-tree counts, bounded changed-file
list, recent commits, remote/tracking info, GitHub detection — fetched
through the host runner's fixed, no-mutation Git invocations. There is no
network fetch involved, so ahead/behind reflects only refs already present
locally. Full detail, what's collected and what deliberately isn't (no
diffs, no file content): [development-state.md](development-state.md).

## Approve operations (Repository Actions)

The only mutation this platform ever makes to a registered project's own
repository is a `git.commit`, and only for a project explicitly opted in
with `sudo ./pcctl enable-repo-writes /path/to/project` (revert with
`disable-repo-writes`) — a fresh install ships with nothing writable. Once
opted in, every commit still goes through **plan → confirm+execute → verify**
in the panel's Development → Actions screen: the server builds a preview of
exactly what would happen, you approve it, and confirming re-checks a
content fingerprint against a fresh read so a stale preview can never be
blindly approved. The project's working tree itself stays read-only even
when write-enabled — only `.git` ever becomes writable. Full scope
(`git.commit` only — no push/checkout/merge/reset, ever), the fingerprint
mechanism, and risk/confirmation rules:
[repository-actions.md](repository-actions.md); the `enable-repo-writes`/
`disable-repo-writes` commands themselves are also covered in
[operations.md § Repository Actions](operations.md#repository-actions).

## Inspect automation

n8n workflow runs (scheduled or operator-triggered via "Run now" in the
panel) are visible in the Automation screen: manifest, each workflow's last
run, and paginated run history with status, severity and steps. It's a
read-and-record surface only — a workflow run can read `/api/system/status`
and record its own outcome, and nothing else; it can never execute a
Repository Action or touch anything outside `/api/automation/*`. Service
tokens for these runs are listed and revoked from the same area (admin
only). Full manifest format, run lifecycle, idempotency and the closed
inbound surface: [automation.md](automation.md).

---

## Before you call a release done

Two things added during this hardening pass, both aimed at the operator, not
just the release author:

- **[release-checklist.md](release-checklist.md)** is the actual, ordered
  gate list for "is this release done" — git status clean, tests, build,
  security, backup, restore, manual UI, docs, version metadata, images
  pinned, runner binary pinned. Stop at the first failing gate; don't
  proceed past one "to see if the rest pass too."
- **`./pcctl release-manifest`** answers "what exactly is running right
  now": application version, the exact git commit, every image's digest and
  whether it matches what's deployed, the applied migration count, the
  checkpoint-reader capability this build supports, the runner binary's
  reported version, and the last recorded backup/security status — all
  read-only, changing nothing on the host. Several of the release checklist's
  gates are answered directly by this one command; run it with `sudo` against
  a live deployment (the migration-level field needs root). See
  [release-checklist.md](release-checklist.md) for exactly which gates it
  answers and what a passing value looks like for each.

## When something's actually broken

If a symptom doesn't map cleanly onto "update," "rollback" or "recover"
above, [disaster-recovery.md](disaster-recovery.md)'s scenario table is
still the right starting point. For a symptom → diagnosis → fix lookup that
isn't specifically a deployment or data-recovery scenario (a stuck UI state,
a confusing 403, a rejected form), see
[troubleshooting.md](troubleshooting.md).
