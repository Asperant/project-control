# Project memory and checkpoints

Each registered project has a Memory screen in its detail view, alongside
Overview and Roadmap. It answers, deterministically, the question every
returning operator asks first: *where was I?* Nothing here calls an LLM, runs
a command, mutates Git, or writes into the registered project's folder. Every
byte is stored in — and read straight back out of — the `project_control`
PostgreSQL database.

## Concepts

The Memory screen has four parts:

- **Current context / "Where was I?"** — a deterministic, structured read of
  the roadmap, memory and audit tables. Not a summary and not AI-generated;
  every line is a direct field from a table row.
- **Pinned memory** — the subset of active memory entries an operator has
  pinned, always visible.
- **Memory entries** — the full, searchable, filterable list of manually
  authored memory.
- **Checkpoint history** — the list of immutable snapshots saved over time,
  each openable to see exactly what the project looked like at that moment.

## Memory entries

Six types are supported: `decision`, `constraint`, `context`, `finding`,
`handoff`, `lesson`. Importance is one of `normal`, `important`, `critical` —
deliberately not a numeric score. An entry can optionally reference one task
and one milestone in the *same* project; a cross-project reference is
rejected the same way a cross-project roadmap dependency is.

Entries are never physically deleted. Their lifecycle is:

```text
active → archived → active (reactivate)
active → superseded (permanent)
```

- **Archive/reactivate** hides an entry from the default list without losing
  it; it remains visible with the "Archived" filter.
- **Supersede** replaces an entry's guidance without erasing its history. The
  recommended flow is: open a memory entry → Supersede → fill in the new
  entry's fields → the old entry is automatically marked superseded and
  linked to the new one. An existing entry can also be named directly as the
  successor. Either way, the same checks apply: an entry cannot supersede
  itself, cannot supersede across projects, cannot be superseded twice, and
  cannot complete a cycle (if A is already superseded by B and B by C,
  superseding C with A is rejected). A superseded entry is read-only; its
  card shows "Superseded by …", and the successor shows how many entries it
  replaced.

Pin/unpin, archive/reactivate and supersede are audited (`memory.pinned`,
`memory.archived`, `memory.superseded`, ...). The entry body and any
checkpoint session note are never copied into audit detail, even truncated —
only structured, low-risk metadata (ids, type, importance, a sanitised title)
is recorded.

### Search and filter

The search box matches title and body, case-insensitively. The filter chips
are `All`, each of the six types, `Pinned`, `Archived`, `Superseded` — the
default view is active entries of every type. There is no embedding, vector
search or full-text index; a plain indexed `ILIKE` is enough at this data
volume, and the query is written so Postgres full-text search could be added
later without changing the API shape.

## Checkpoints

A checkpoint is an immutable, server-generated snapshot: "Save checkpoint"
with an optional session note is the only input a client provides. The
snapshot content itself — current focus, in-progress/blocked roadmap items,
next actions, pending acceptance counts, unresolved dependencies, recently
completed tasks, pinned memory, and active important/critical decisions and
constraints — is always computed server-side from the live tables at the
moment of saving. A client cannot inject snapshot content; the request schema
has no field for it.

**Immutability is enforced at the database privilege level**, not just by
application code: `control_app` may `INSERT` a checkpoint and `SELECT`
existing ones, and may `UPDATE` only the `archived_at` column — an attempt to
change the snapshot, the session note, or any other column is a permission
error from PostgreSQL itself, before the query even runs. See
`migrations/0008_memory_role_grants.sql`. Checkpoints are never physically
deleted; a mistaken one is archived instead, and the archive action is
audited (`checkpoint.archived`).

`snapshot_version` is stored on every row so the API can keep reading older
checkpoints if the snapshot's internal shape ever changes. New checkpoints use
format `3`, adding compact metadata-only Git state. Existing formats `1` and
`2` remain readable and unchanged; v3 stores no file list, diff, source body,
raw remote URL or commit history.

Two "Save checkpoint" clicks in quick succession, or two operators saving at
once, cannot corrupt anything: creation locks the project row for the
duration of the snapshot read and insert, so each checkpoint's content is
read from a single consistent moment and checkpoints commit — and therefore
sort — in a well-defined order.

## Current context / "Where was I?"

Server-computed, in this fixed order:

1. **Current focus** — every `in_progress`, non-archived milestone.
2. **In-progress tasks** — every `in_progress` task, across all milestones.
3. **Blocked** — every `blocked` milestone and task, with its `blocked_reason`.
4. **Next actions** — every task with a non-empty, manually written
   `next_action`, excluding `done`/`cancelled`. Ordering:  `in_progress`
   tasks first, then `blocked`, then the rest, each group by roadmap
   position (milestone, then task `sort_order`). This is a fixed policy, not
   a guess at "the one true next step."
5. **Pending acceptance** — tasks with one or more incomplete acceptance
   criteria, with the pending count.
6. **Unresolved dependencies** — dependency edges whose target task is not
   `done` (a cancelled dependency still counts as unresolved, matching the
   existing roadmap semantics).
7. **Pinned context** — active pinned memory entries.
8. **Last checkpoint** — the most recent non-archived checkpoint, or an
   explicit "No checkpoint saved yet."
9. **Changes since last checkpoint** — see below.

Every section renders a clean empty state when there is nothing to show. No
`null`, `undefined`, `NaN` or raw database id is ever shown to the user in
this view; every reference is resolved to a title first.

### Changes since your last checkpoint

Computed from the existing audit trail: every `roadmap.*` and `memory.*`
event (plus `checkpoint.archived`) for the project with `occurred_at` after
the last active checkpoint's `created_at`, grouped by event type into
human-readable lines such as "✓ 2 tasks completed" or "+ 1 memory decision
added". The checkpoint-creation event itself is always excluded — both
structurally (its own `occurred_at` cannot be later than the checkpoint's
`created_at`, since they are written in the same transaction) and explicitly,
as a second guard. Event types outside the curated list are folded into a
single "N other change(s)" line rather than silently dropped. If a project
has no checkpoint yet, the screen shows "Save a checkpoint to start tracking
changes between sessions." instead of an empty changes list.

## Archive behavior

An archived project's memory and checkpoints remain fully readable. Every
mutation — create, edit, pin/unpin, archive/reactivate, supersede a memory
entry; save or archive a checkpoint — is rejected server-side with a
`conflict` error, and the web panel shows "This project is archived. Memory
changes are disabled." Reactivating the project restores mutation without
altering any stored memory or checkpoint data.

## API overview

Authenticated reads and admin/operator writes, project-scoped:

```text
GET/POST/PATCH /api/projects/:projectId/memory/...
GET/POST       /api/projects/:projectId/checkpoints/...
GET            /api/projects/:projectId/context
```

`GET .../context` returns the full current-context bundle described above,
including the "changes since checkpoint" summary, in one deterministic
response — there is deliberately one code path computing this data, shared
with the checkpoint snapshot builder (`src/checkpoints/snapshot.ts`), so the
two views cannot silently drift apart.

## Deployment and backup

Migrations `0007` and `0008` add the schema and explicit role grants. They
are additive and preserve every existing table. `control_app` receives no
`DELETE` on either table; `project_checkpoints` additionally restricts
`control_app`'s `UPDATE` to the single `archived_at` column. `backup_reader`
receives `SELECT` on both.

The existing full `project_control` dump automatically includes the new
tables — no backup configuration change is needed. After an update:

```bash
./pcctl verify
./pcctl verify-security
sudo ./pcctl backup
sudo ./pcctl restore-test
```

`restore-test` confirms both tables exist after restore, checks their
identity/relationship constraints, and — when at least one checkpoint exists
— validates that every restored snapshot is still well-formed JSON.

See [update-rollback.md](update-rollback.md) before a migration-bearing
update.

## Resume and Work Sessions

Resume is a separate operational briefing rather than a renamed Current
Context card. It reuses Current Context/checkpoint facts, then adds an explicit
work focus, deterministic recommended action, attention summary, current/last
session and paginated session history. Work Session close may create and link a
checkpoint atomically. Development State advances new writes to checkpoint v3
without rewriting historical v1/v2 rows. Full behavior and the selection
algorithm are documented in
[work-sessions-resume.md](work-sessions-resume.md).

## Troubleshooting

- **Memory changes are disabled:** reactivate the project first.
- **Supersede rejected:** the target entry is already superseded, belongs to
  another project, is the same entry, or would close a supersede cycle.
- **Related task/milestone rejected:** select a task or milestone in the same
  project; the field is optional and can be left empty.
- **"No checkpoint saved yet." / no changes-since-checkpoint list:** save a
  checkpoint first — this is the expected state for a project that has never
  had one.
- **Checkpoint content looks wrong:** checkpoints are immutable by design;
  save a new one rather than expecting an old one to update. If a checkpoint
  was saved by mistake, archive it — do not attempt to edit it.
- **Memory/checkpoint endpoint returns 401/403:** sign in; viewers can read
  but only admins and operators can mutate.
