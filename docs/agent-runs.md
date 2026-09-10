# Agent Runs

Each registered project has an Agent Runs screen in its detail view, alongside
Overview, Roadmap and Memory. It is a manual provenance archive for
agent-assisted work sessions: what was actually sent to an agent (Claude,
Codex, or anything else), what the agent reported back, and — kept
deliberately separate — whether the operator actually verified that report.
Months later, this is what answers "did I really check this, or am I just
trusting what the agent said?"

**This is an archive, not an integration.** Nothing here calls Claude, Codex,
or any other API; no prompt is sent automatically and no report is fetched
automatically. A user pastes a prompt in, sends it to an agent by hand, and
pastes the agent's report back in by hand. See [Out of scope](#out-of-scope-by-design)
below.

## Concepts

```text
Project
└── Agent Run
    ├── Prompt (draft, then sent — immutable once sent)
    ├── Agent Report (draft → final, revisable, old versions kept)
    ├── User Validation (independent of the run's own status)
    ├── Related roadmap task/milestone
    ├── Related Project Memory
    └── Timeline
```

An **Agent Run** is the aggregate root: a title, an agent name, a lifecycle
status, an optional link to one roadmap task and/or milestone in the same
project, and its own validation status/note. It is never physically deleted —
only archived and reactivated, exactly like a memory entry or a roadmap item.

## Agent name

Free text (1–80 characters), not a fixed enum — the database only checks a
length bound. The web panel offers `Claude`, `Codex`, `Other` as quick picks;
choosing `Other` opens a text field for anything else. This keeps the schema
open to whatever agent shows up next without a migration.

## Run lifecycle

```text
draft   → sent (only via "Mark as Sent" on the prompt) | cancelled
sent    → in_progress | completed | failed | cancelled
in_progress → completed | failed | cancelled
failed  → in_progress (retry) | cancelled
completed, cancelled — terminal
```

Every other transition is rejected server-side with a `conflict` error. A run
never reaches `sent` through the status endpoint directly — only by sending
its prompt — because the prompt and run status must move together atomically.
Need a different prompt after sending? Use **Duplicate as new run** rather
than editing history.

## Prompt

One prompt per run — there is no prompt-revision system. While `draft`, the
body is freely editable. **Mark as Sent** freezes it: `status` becomes
`sent`, `sent_at` is set, and from that moment the row is immutable —
enforced at the database level by a trigger, not just by the API (see
[Immutability](#immutability-how) below). A duplicate "Mark as Sent" click is
a harmless no-op, not an error. **Copy Prompt** copies the exact sent text to
the clipboard; it never touches the server.

## Agent Report

Markdown or plain text, versioned. **Add report** creates a draft; a draft is
freely editable. **Finalize** freezes it — `status` becomes `final`,
`finalized_at` is set, and (like the prompt) the row becomes immutable at the
database level from that point on.

To fix or extend a final report, **Start revision** creates a new draft
version N+1. The previous final report stays the *current* final — still
shown, still the one referenced elsewhere — until the new revision is itself
finalized. Finalizing a revision is one atomic transaction: the old final
flips to `superseded` (recording which report superseded it) and the new
draft flips to `final`, together or not at all. A superseded report is frozen
forever; only that one legal `final → superseded` transition is ever
permitted on an already-final row.

The detail view offers **Rendered** / **Raw** and **Copy raw report** for
every version, including superseded ones. Rendering uses `react-markdown`
with no raw-HTML plugin — Markdown syntax renders, but literal HTML (including
a pasted `<script>` tag) renders as inert text, never as markup. Links open in
a new tab with `rel="noopener noreferrer"`; only `http(s)`/`mailto`/relative
links are honored, anything else renders as plain text.

## Immutability, how

Existing immutability in this codebase (e.g. checkpoints) is *unconditional*
— "this column never changes" — and is enforced with a column-scoped
`REVOKE`/`GRANT`. Prompt and report immutability is *conditional* — "editable
while draft, frozen once sent/final" — which a `GRANT` cannot express, since
whether an `UPDATE` is legal depends on the row's own current value. Instead,
`migrations/0009_agent_runs_schema.sql` adds two `BEFORE UPDATE` triggers:

- `agent_run_prompts_guard_immutable` — rejects any update once
  `status = 'sent'`.
- `agent_reports_guard_immutable` — rejects any update once
  `status = 'superseded'`, and rejects any update to a `final` row except the
  one specific `final → superseded` transition the revision-finalize
  transaction performs (and only when every other column stays unchanged).

Both apply to every role, including the migrator's own runtime connection —
not just `control_app`. `control_app` additionally holds no `DELETE`
privilege on any of the three Agent Run tables, matching every other archive
table in this schema.

## User Validation

**Deliberately separate from the run's own status.** A run can be `completed`
with its agent claiming success while the human's validation is `rejected` —
that disagreement is the entire point of keeping an archive instead of
trusting the agent's own report.

Five statuses: `not_reviewed` (default), `under_review`, `accepted`,
`accepted_with_changes`, `rejected`. The validation note is a manual text
field — never derived from the agent's report, never AI-summarized. It is
never copied into audit detail, even truncated, so a secret accidentally
pasted into a note never leaks into the audit trail. Validation can change
after being set to `accepted` — a later regression or a missed edge case is
allowed to flip it to `rejected`; every change is audited
(`agentvalidation.updated`) and the old value is preserved in that history,
not overwritten.

## Related roadmap context

A run may optionally reference one milestone and/or one task, always
same-project — a cross-project reference is rejected exactly like a
cross-project memory reference. If both are given together, the task's own
milestone must agree with the given milestone, or the request is rejected. A
task or milestone that is later archived or cancelled does not break the
link; the run keeps referencing it. A single task can have any number of
Agent Runs against it (e.g. "Initial implementation", "Security fix",
"Checkpoint ACL correction").

## Related Project Memory / promote-to-memory

**Add to Memory** on a run creates a normal Project Memory entry — the user
writes the title/body themselves; this is not AI extraction. The only special
behavior is provenance: the new entry's `source_agent_run_id` is set
server-side to the run it was created from. The general Memory-tab create
form has no such field in its request schema, so a client cannot spoof this
value through the ordinary memory endpoint no matter what JSON it sends — only
the dedicated promote endpoint, which has already verified the run belongs to
the current project, can set it. The memory entry survives archiving (or even
duplicating) the source run, since runs are never physically deleted. The
Memory tab shows "Source: Agent Run — *title*" on a promoted entry; the
Agent Run detail shows a **Related Memory** list of everything promoted from
it.

## Timeline

Built from the same `audit_events` table every other per-entity activity
history in this system uses (roadmap activity, project activity), filtered
to this run's id and this feature's event types (`agentrun.*`,
`agentprompt.*`, `agentreport.*`, `agentvalidation.*`). Raw audit rows are
never sent to the browser — each is mapped to a short human label ("Prompt
marked as sent", "Report finalized", "Validation set to accepted with
changes", ...). This is a different, older feature from the project-wide
**Timeline** tab and the `/timeline` global activity feed
(`timeline_events`, not `audit_events` — see
[architecture.md](architecture.md#search-and-timeline-domain)); a
completed/failed Agent Run does also appear there, as its own curated,
project-scoped entry.

**Audit redaction:** no event ever carries a prompt body, report body, or
validation note in its detail — only structured metadata (`agentRunId`,
`agentName`, `status`, `validationStatus`, `reportVersion`,
`relatedTaskId`/`relatedMilestoneId`, and boolean "did this field change"
flags). This is a hard rule enforced at every call site, not merely a
truncation.

## Duplicate as new run

Available on any run, in any status. Creates a brand-new draft run in the
same project: title, agent name, related task/milestone and the prompt body
(as a new *draft* prompt) are copied; the report, validation, and every
timestamp are not. The original run is never modified. This is the intended
way to re-run a prompt or start a related session without losing the
original's history — there is no in-place prompt-revision system to do it
any other way.

## Search and filter

The search box matches title, prompt body, report body (including superseded
revisions — an old report's wording can still lead you back to the run it
belongs to), and validation note, case-insensitively. Filters: run status,
agent name, validation status, and an archived toggle (archived runs are
hidden by default). As with Memory, this is a plain indexed `ILIKE` — no
embeddings, no vector search — appropriate at this data volume, and
deliberately separate from the header's global search (`GET /api/search`,
migration `0021`), which full-text-indexes run titles and prompt/report
bodies across every project at once — see
[architecture.md](architecture.md#search-and-timeline-domain).

## Checkpoint v2 and "Where was I?"

Checkpoint snapshots gained a `recentAgentActivity` field: up to 5 recent,
non-draft, non-archived Agent Runs (id, title, agent name, status, validation
status, related task id, and a deterministic "most recent lifecycle event"
timestamp) — no prompt or report content. `snapshot_version` moved from `1`
to `2` to carry it; **existing `version: 1` checkpoint rows are never
rewritten** and still read back correctly — the API validates the snapshot
against a discriminated union of both shapes. New checkpoints are always
written as `version: 2`.

The same query backs the live "Where was I?" context under **Recent Agent
Work**, so the two views cannot silently drift apart from each other —
exactly the same principle that already keeps the roadmap portion of a
checkpoint snapshot and the live context in sync.

**Changes since your last checkpoint** gained new categories: agent runs
sent/completed/failed/cancelled, reports finalized, findings promoted to
memory, and validation set to accepted/accepted-with-changes/rejected (the
last three counted separately, since they carry materially different
meaning). Low-level noise — a draft prompt or report being edited, a run
simply being renamed — is not counted, matching the existing policy of only
surfacing meaningful state changes.

## Archive behavior

**Archived Agent Run:** read-only. Prompt, report, and validation mutation are
all rejected with `conflict`, independent of the project's own archived
state. Reactivating restores mutation without altering any stored data.

**Archived project:** every Agent Run mutation is rejected the same way
existing roadmap/memory mutations are on an archived project — create, edit,
status change, archive/reactivate, prompt/report mutation, validation change,
duplicate, promote-to-memory. Reads remain available. The web panel shows
"This project is archived. Agent Run changes are disabled."

## API overview

Authenticated reads and admin/operator writes, project-scoped:

```text
GET/POST/PATCH  /api/projects/:projectId/agent-runs/...
GET/PATCH/POST  /api/projects/:projectId/agent-runs/:runId/prompt[...]
GET/POST/PATCH  /api/projects/:projectId/agent-runs/:runId/reports[...]
PATCH           /api/projects/:projectId/agent-runs/:runId/validation
GET             /api/projects/:projectId/agent-runs/:runId/timeline
GET             /api/projects/:projectId/agent-runs/:runId/related-memory
POST            /api/projects/:projectId/agent-runs/:runId/promote-memory
```

## Deployment and backup

Migrations `0009` and `0010` add the schema (including the two immutability
triggers) and explicit role grants; `0009` also adds
`project_memory_entries.source_agent_run_id`. Both are additive and preserve
every existing table and row.

The existing full `project_control` dump automatically includes the three new
tables — no backup configuration change is needed. After an update:

```bash
./pcctl verify
./pcctl verify-security
sudo ./pcctl backup
sudo ./pcctl restore-test
```

`restore-test` confirms all three tables exist after restore, checks their
identity/relationship/uniqueness constraints, and independently verifies (not
just via the constraint's presence, but by querying the actual restored data)
that no prompt or report references a missing run, no promoted memory entry
references a missing run, and no run has two reports sharing a version
number.

See [update-rollback.md](update-rollback.md) before a migration-bearing
update.

## Troubleshooting

- **Agent Run changes are disabled:** either the run itself or its project is
  archived — reactivate the relevant one.
- **"Mark as Sent" rejected:** the prompt is empty, or the run has already
  left `draft` (e.g. it was cancelled in another tab). Reload and check the
  run's current status.
- **Prompt/report edit rejected after the fact:** sent prompts and
  final/superseded reports are immutable by design, at the database level —
  not just in the UI. Start a revision (reports) or duplicate the run
  (prompts) instead of expecting an old one to update.
- **"Start revision" rejected with a conflict:** a draft report already
  exists for this run — finalize or continue editing it first; only one
  draft is allowed at a time.
- **Related task/milestone rejected:** either it belongs to another project,
  or a milestone was given that does not match the given task's own
  milestone.
- **Promote to Memory rejected:** the project is archived, or the run does
  not belong to this project.
- **Validation looks "wrong" compared to what the agent reported:** that is
  the intended behavior — the agent's report and the human's validation are
  independent, on purpose. Update the validation, not the report.
- **Agent Run endpoint returns 401/403:** sign in; viewers can read but only
  admins and operators can mutate.

## Out of scope (by design)

No Claude/Codex/OpenAI API integration, no agent execution, no automatic
prompt sending or report retrieval, no automatic acceptance or memory
extraction, no AI prompt generation or scoring, no embeddings/vector
search/RAG, no token counting, no automatic Git/commit/task-completion
association, no file attachments. This platform archives and lets a human
validate agent-assisted work; it does not run agents.
