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

## Service identity

- A service token authenticates over Bearer on `/api/automation/whoami`; a
  session cookie authenticates identically through the same preHandler.
- A request carrying both a cookie and a Bearer header is rejected outright
  and audited; a route using only `requireAuth` ignores a Bearer header
  entirely (same 401 as anonymous).
- Unknown, revoked, expired, and disabled-account tokens are all rejected,
  indistinguishably from each other, and each is audited.
- `requirePrincipalKind` denies a service principal and audits it; it is
  transparent to a user principal.
- `requireScope` denies a service principal missing a required scope and
  audits it; it is a no-op for a user principal regardless of the scopes
  listed.
- A token's scopes can never exceed its account's scope ceiling (database
  trigger, not just application code); an unknown scope value is rejected
  outright by a CHECK constraint.
- A token's identity fields are immutable after creation; a revoked token can
  never be un-revoked; revoking an already-revoked token is idempotent and
  audited only once.
- Re-running the compiled-in account registry reconciliation never re-enables
  an operator-disabled account.
- The service-token admin routes (list, revoke) are reachable by an admin
  session only — denied to a viewer session and to a service token entirely
  — and never expose the token value; revoke requires CSRF.

## Automation

- A manual run opens `queued`; a scheduled run opens directly into
  `running`; both are rejected for an unknown workflow key, audited.
- Exactly one `queued`/`running` run exists per workflow at a time,
  regardless of trigger kind; a second manual request and a second
  scheduled open are both rejected while the first is still open.
- A second run inside the same idempotency window is rejected even after
  the first has settled to `completed`/`failed`/`waiting_for_approval`; a
  `cancelled` or `expired` run does **not** consume the window, so a retry
  after either succeeds.
- Two concurrent claims on one queued run never both win; the loser gets
  `204`, never a duplicate `running` row.
- A step can only be recorded against a `running` run; a duplicate step
  position is rejected; steps are visible in run detail in position order.
- An artefact attachment requires `report:write` specifically, not
  `automation:run` alone, and only succeeds against a `running` run.
- Settle computes `notify` from the workflow's manifest severity policy,
  never from the workflow's own request; a second settle on an
  already-settled run is rejected.
- A run whose lease has lapsed becomes `expired` lazily on the next read or
  touch — not before, and with no background sweeper — and a settle
  attempt against an already-expired run is rejected.
- `request-run` and `cancel` are human-only regardless of role; `runs`,
  `queue/claim`, `steps`, `artifact` and `settle` are service-only
  regardless of scope; both directions are denied with the same status a
  wholly wrong credential would get.
- No shipped workflow JSON file contains a webhook/executeCommand/ssh node,
  an HTTP Request node targeting anything but `control-api:8080`, an
  embedded service token, or a `$env` read outside the allowed Telegram
  chat id.
- Restore contains both automation tables with no orphaned step, no
  cross-project run, and every settled row still immutable.

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
