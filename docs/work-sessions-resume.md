# Resume Project and Work Sessions

Resume is a deterministic project-continuity briefing. It does not use AI,
semantic search, embeddings or n8n. It includes a best-effort, read-only
Development projection from the typed runner operation; Git state never changes
roadmap selection policy. The server owns all selection policy, and the web
client renders the API response without choosing a different next action.

## Briefing composition

`GET /api/projects/:projectId/resume` returns, in product order: Current Focus,
Recommended Next Action, Attention Required, Active Work Session, Last Session,
Last Checkpoint, Changes Since Last Checkpoint, Active / Blocked Work, Recent
Agent Work, Important Memory and Work Session History.

The composer reuses the existing deterministic Current Context and
`recentAgentWork` loaders. Recent Agent Work remains compact (agent, run title,
lifecycle status, validation status and relevant timestamp); draft-only and
archived runs remain excluded and prompt/report bodies are never copied.
Important Memory contains current, non-archived, non-superseded entries that are
pinned, critical or important. Ordering is pinned first, then critical,
important and normal, with decision/constraint visibility as the next tie-break
and timestamp/ID for stability.

The first Resume history page is bounded to 20 newest-first **closed** sessions;
the open session appears only in Active Work Session. The response carries
`page`, `pageSize`, `total` and a stable `(startedAt,id)` cursor. Older history
is available from the Work Session endpoint without offset drift when a newer
session closes concurrently; it is not silently truncated.

## Exact focus and recommendation algorithm

Current Focus is selected as follows:

1. An open Work Session goal wins.
2. Otherwise choose an in-progress task whose milestone is non-archived and is
   not blocked, done or cancelled.
3. Otherwise choose an eligible planned task with no incomplete dependency.
4. Otherwise return the explicit no-active-focus state.

Within task lifecycle groups, ordering is existing roadmap priority
`critical`, `high`, `medium`, `low`; milestone `sort_order`; task `sort_order`;
then task UUID as the stable tie-breaker.

Recommended Next Action first excludes tasks that are done, cancelled, blocked,
under a blocked/done/cancelled/archived milestone, or have any dependency whose
task status is not done. Eligible tasks are ordered:

1. `in_progress` before `planned`;
2. priority `critical`, `high`, `medium`, `low`;
3. milestone `sort_order`;
4. task `sort_order`;
5. task UUID lexicographically.

For the selected task the displayed action is the first non-empty value of
trimmed `task.next_action`, the first incomplete acceptance criterion ordered by
criterion `sort_order`, creation time and UUID, then the task title. If no task
is eligible but blocked/dependency-waiting work exists, the response reports its
deterministic counts. If no pending work exists, it explicitly says so.

Attention Required reports only stored/derived facts: blocked task count,
unresolved dependency count, incomplete acceptance-criterion count, completed
Agent Runs awaiting validation, failed non-archived Agent Runs, and whether the
open session has stored blockers. It invents no warning text from free-form
content.

## Work Session lifecycle

`work_sessions` is project-scoped and has no physical delete path. A partial
unique index on `project_id WHERE status = 'open'` permits at most one open
session per project, including concurrent starts. Open rows require a goal and
may edit only that goal. Their close-only fields are null.

Close requires an outcome, sets `ended_at`, and may set blockers, next action
and a same-project checkpoint. A database check enforces open/closed field
shape and timestamp order. The mutation trigger freezes identity/start history,
allows only the open-goal edit and the one open-to-closed transition, and rejects
every later update to a closed row.

Corrections are new `work_session_amendments` rows. A trigger accepts them only
for closed parents; grants allow `control_app` SELECT/INSERT but deny
UPDATE/DELETE/TRUNCATE. Sessions also deny DELETE/TRUNCATE. `backup_reader` is
SELECT-only on both tables. The composite foreign key from
`(work_sessions.project_id, checkpoint_id)` to
`project_checkpoints(project_id, id)` prevents cross-project linkage.

All reads remain available for archived projects. The shared server-side
project mutability guard rejects start, goal edit, close and amendment while a
project is archived. Reactivation exposes the same untouched history and
restores mutation permission.

## Atomic checkpoint close and compatibility

When `createCheckpoint` is true, close locks the project and session, builds the
current deterministic checkpoint snapshot, inserts the checkpoint, writes its
audit events, links it to the session, closes the session and writes close audit
events in one PostgreSQL transaction. Any checkpoint, link, lifecycle or audit
failure rolls back the checkpoint and leaves the session open.

New checkpoints use snapshot version 3 and contain compact Git metadata captured
best-effort before the database transaction. Session bodies, file paths, diffs,
source content, raw remote URLs and commit history are not duplicated. Existing
v1/v2 rows remain unchanged and readable. Runner/Git failure records an
unavailable Git state and does not prevent the otherwise atomic close.

## API and audit

Authenticated, project-scoped reads and admin/operator mutations:

```text
GET  /api/projects/:projectId/resume
GET  /api/projects/:projectId/work-sessions
GET  /api/projects/:projectId/work-sessions/:sessionId
POST /api/projects/:projectId/work-sessions
PATCH /api/projects/:projectId/work-sessions/:sessionId
POST /api/projects/:projectId/work-sessions/:sessionId/close
POST /api/projects/:projectId/work-sessions/:sessionId/amendments
```

Meaningful mutations emit `work_session.started`,
`work_session.goal_updated`, `work_session.closed`,
`work_session.amendment_added` and, when selected,
`work_session.checkpoint_created`. Audit details contain identifiers and compact
booleans only, not goal, outcome, blocker, next-action or amendment bodies.

## Release order and rollback boundary

On the live host, run `sudo ./pcctl update` first; it creates the pre-update
backup before applying migrations. After the update, run `sudo ./pcctl verify`
and `sudo ./pcctl verify-security`, then create a fresh post-migration backup
with `sudo ./pcctl backup` and validate that backup with
`sudo ./pcctl restore-test`.

The new restore test expects the Work Session schema. A pre-migration backup
therefore must be tested with the matching pre-migration restore script; the
post-migration backup must be tested with this version. Once migrations 0011
and 0012 are recorded, an image-only rollback is unsafe because the old API
does not contain those migration files. Preserve the pre-update snapshot and,
if rollback is required, restore the database together with the matching old
application and configuration as described in `docs/disaster-recovery.md`.
