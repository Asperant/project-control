# Test scenarios

Critical roadmap scenarios:

- anonymous read/write is rejected; viewer write is rejected;
- milestone/task CRUD, dense move up/down, boundary moves, and lifecycle dates;
- blocked status requires a reason;
- unfinished acceptance and dependency confirmations are server-counted and audited;
- self, duplicate, cross-project, and A→B→C→A dependencies are rejected;
- cancelled tasks do not affect progress; zero tasks reports `0 / 0`, `0%`;
- notes/description/next action/block reason content is absent from audit metadata;
- archived project and archived/cancelled milestone mutations are rejected;
- audit failure rolls the corresponding mutation back;
- backup/restore preserves all roadmap tables and relationships;
- project registration/rescan/archive, runner security, role isolation, and
  existing web/API flows remain green.

Critical Resume / Work Session scenarios:

- the first session starts; a concurrent second open session is rejected by the
  API and partial unique index; an open goal can be edited;
- close requires a non-empty outcome, records `ended_at`, and makes every
  historical session field immutable; corrections append and cannot be changed
  or deleted;
- an archived project permits reads only and rejects start/edit/close/amend;
  session history remains visible after reactivation;
- checkpoint-on-close is all-or-nothing, writes v3, and cannot link a
  checkpoint owned by another project;
- current focus is open-session goal, otherwise ordered in-progress work,
  otherwise eligible planned work, otherwise an explicit no-focus state;
- recommendation excludes done/cancelled/blocked/dependency-waiting work, then
  orders by in-progress/planned, priority, milestone order, task order and ID;
- displayed action uses `next_action`, first incomplete acceptance criterion,
  then task title; blocker-only and no-pending states are explicit;
- attention counts blocked work, unresolved dependencies, incomplete criteria,
  Agent Runs awaiting validation/failed and stored open-session blockers only;
- Recent Agent Work preserves its accepted compact loader; important memory is
  current/non-archived/non-superseded and ordered pinned, critical, important;
- session history contains closed sessions only, is newest-first, and older
  rows remain reachable through the stable history cursor;
  repeated Resume reads produce stable ordering;
- restore contains both Work Session tables and has no orphan session,
  invalid amendment parent, cross-project checkpoint, invalid lifecycle or
  duplicate-open data; checkpoint v1, v2 and v3 rows remain parseable.

## Development State

- Runner detects clean, staged, unstaged, untracked, renamed, deleted,
  conflicted, detached, unborn and non-repository states without changing HEAD,
  index, refs, config or working-tree bytes.
- `command`, `args`, `cwd`, `env` and mutation-shaped operation names are
  rejected; repository-local fsmonitor is never executed.
- Credential-bearing/malformed remotes fail closed; GitHub detection requires
  exact `github.com`; ahead/behind is labelled local-ref-only.
- Development and Resume survive unavailable Git. Checkpoint v3 capture failure
  does not block normal checkpoint or atomic Work Session close.

## Deployment and rollback readiness

- Runner readiness passes immediately when active/socket/typed health are
  ready; retries `activating`, delayed socket publication, and temporary
  connect/EOF/timeout failures within a bounded 30-second deadline.
- Inactive/failed service states, a non-socket path, and an invalid or
  unsuccessful protocol response fail immediately.
- Update waits for delayed runner readiness without triggering rollback, but a
  genuine readiness failure uses the existing migration-safe rollback path.
- Update refuses to publish a rollback point when deployed lock, stack.env, or
  any of the five running image IDs disagree; `--force` cannot bypass it.
- Rollback waits for the restored runner, continues to container
  reconciliation, and succeeds only when all five running image IDs equal the
  captured target and both API readiness and strict verification pass.
- Missing locally built target images fail before mutation. Runner, Compose,
  image, API, or verify failures produce `ROLLBACK INCOMPLETE`, exit non-zero,
  and never emit a success audit/notification.
- API-013 is enforced for reader capability v3+, skipped for an older valid
  rollback target, and failed for missing/invalid capability metadata;
  IMG-001 remains exact and unchanged.
