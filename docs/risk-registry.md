# Risk registry

## Database-ahead image rollback

- Category: release / database
- Impact: an older API image may reject a newer migration ledger.
- Mitigation: additive migrations, fresh pre-update backup, new-image dry-run,
  restore-test, and the runbook in `docs/update-rollback.md`.
- Status: accepted operational limitation; release gate required.

## Roadmap mutation without audit

- Category: security / data
- Impact: lifecycle overrides could lose accountability.
- Mitigation: roadmap mutations use required audit inserts in the same database
  transaction; audit failure rolls back the mutation.
- Status: mitigated.

## Concurrent dependency cycle or reorder corruption

- Category: database / backend
- Mitigation: project row locks, target/sibling locks, recursive cycle check,
  deferrable unique positions, and database self/duplicate constraints.
- Status: mitigated; concurrency regression tests remain important.

## Binary source file tooling

- Category: maintainability
- Detail: `apps/control-api/src/projects/store.ts` contains a literal NUL
  separator used in hashing, so some text tools classify it as binary.
- Status: watching; unrelated to roadmap behavior.

## Concurrent or rewritten Work Session history

- Category: database / security / user data
- Impact: two open sessions could create competing focus, or a closed outcome
  could be silently rewritten and make the Resume briefing untrustworthy.
- Mitigation: partial unique open-session index, row/project locks, lifecycle
  check, closed-row mutation trigger, no DELETE grant and append-only amendments.
- How to test: Work Session integration tests plus `PG-025`–`PG-028` and
  `PGS-013`–`PGS-016` on a migrated deployment.
- Status: mitigated; concurrency and role-grant tests remain release gates.

## Session/checkpoint ownership or partial close

- Category: database / release
- Impact: a session could link another project's checkpoint, or expose a closed
  session without the requested checkpoint/audit history.
- Mitigation: composite same-project foreign key and one transaction for
  checkpoint creation, linkage, close and audit events. Restore-test checks
  orphan, cross-project and lifecycle invariants.
- Status: mitigated; rollback remains database-transaction based.

## Repository-local Git configuration executes a program

- Category: security.
- Impact: an observational status read could run a repository-controlled
  fsmonitor or hook.
- Mitigation: compiled operation and fixed argv; scratch environment;
  `core.fsmonitor=false`; `core.hooksPath=/dev/null`; pager/prompt disabled;
  AF_UNIX confinement and read-only allowed-root mounts. Tests use a hostile
  fsmonitor marker and assert repository state remains unchanged.
- Status: mitigated.

## Git remote credential or repository-path disclosure

- Category: security/privacy.
- Impact: credential-bearing URLs or path metadata could reach API,
  checkpoints, logs or UI.
- Mitigation: remotes are reconstructed without userinfo/query/fragment;
  malformed/unsupported values expose no raw URL. Checkpoint v3 omits URLs and
  paths. API requires the runner canonical path to equal the registered path.
- Status: mitigated. Validate-to-exec host filesystem races remain watched and
  are constrained by the runner's read-only mount boundary.

## Pruned exact rollback images strand a coherent-but-mislabeled deployment

- Category: release / availability / state consistency.
- Impact: after a failed update whose own automatic rollback also fails
  because the pre-update snapshot's exact `control-api`/`web`/`caddy` images
  were pruned, the host can be left running a healthy, mutually coherent
  stack whose `versions.lock.env`/`stack.env`/`checkpoint-reader-max-version`
  describe a different release. `update`'s coherence gate correctly refuses
  to publish a new rollback point from that state (by design, not a bug), and
  `rollback` correctly refuses to restore a target whose exact images are
  gone — but neither recovers the host.
- Mitigation: `pcctl reconcile-state` derives deployment metadata only from
  the actual running containers: resolved image IDs, an empirical probe of
  the running application's capability (never a trusted-but-possibly-stale
  checkpoint-reader-max-version file), the applied migration ledger, and the
  stored checkpoint maximum. It is fail-closed on any of those, accepts no
  override flag, mutates nothing until every check passes, preserves the
  prior metadata before an atomic replacement, and re-points a mutable local
  tag to the exact running image via a deterministic internal preservation
  tag rather than ever substituting a different build. It never restarts,
  rebuilds, recreates or deploys. Success leaves the host passing `update`'s
  own coherence gate, so a subsequent `update` can build a trustworthy
  rollback point from the now-truthfully-described state.
- How to test: `tests/reconcile-state-regression.sh`, followed by the
  existing deployment/readiness regressions and the normal release gates.
- Status: mitigated; the fail-closed and no-mutation-on-failure paths are
  release gates.

## Repository Actions: network-mutating Git operations are out of scope by design

- Category: security / scope.
- Detail: Repository Actions (`docs/repository-actions.md`) supports only
  `git.commit`. `push`, `fetch` and `pull` were deliberately not built: the
  runner's systemd unit sets `RestrictAddressFamilies=AF_UNIX` and
  `IPAddressDeny=any`, so a network-mutating Git operation is structurally
  impossible without first removing that confinement — and doing so would
  also require a credential-delivery mechanism the runner has none of today
  (`GIT_ASKPASS=`, `HOME=/nonexistent`, no SSH agent, no stored token) and a
  remote-divergence (ahead/behind/diverged) decision model this version does
  not implement.
- Mitigation: this is a scope boundary, not a partial mitigation — there is
  no code path attempting a network Git operation to fail unsafely. Any
  future work here is a distinct design effort with its own threat model,
  not an incremental extension of `git.commit`.
- Status: accepted; watch for a future proposal to add push/fetch/pull.

## Repository Actions: a write-enabled project's .git directory is host-writable

- Category: security / host filesystem.
- Impact: `sudo ./pcctl enable-repo-writes <path>` grants the runner's OS
  user (`project-runner`) a POSIX ACL write grant on exactly one project's
  `.git` directory, and the systemd unit gains a matching `BindPaths=`
  exception scoped to that same path. This is the first host-filesystem
  write grant this platform's runner has ever held; every prior operation
  (project registration, Git reads, Development State) is read-only.
- Mitigation: opt-in per project, off by default (empty
  `config/write-enabled-projects.conf`); scoped to `.git` only — the working
  tree stays read-only even for a write-enabled project, so `git.commit`
  cannot alter source files directly, only construct a commit via plumbing
  (`apps/runner/internal/gitwrite`); no hook execution
  (`core.hooksPath=/dev/null`); protected-path denylist rejects committing
  `.env`/key/credential-shaped files; every commit is compare-and-swapped
  against an operator-observed HEAD (`ExpectedHead`) so a stale plan cannot
  silently land; `verify-security` RNR-014–RNR-017 prove the ACL/mount/
  runner-refusal properties functionally, not just by config inspection.
- How to test: `apps/runner/internal/gitwrite`'s test suite (temp-index
  isolation, hook non-execution, protected-path rejection, HEAD CAS),
  `apps/control-api/test/integration/repository-actions.test.ts` (plan →
  execute → verify, fingerprint staleness, concurrent-plan rejection,
  archived-project block), and `sudo ./pcctl verify-security` on a host with
  at least one project enabled.
- Status: mitigated; the `.git`-only write scope and the CAS-protected commit
  are release gates for this feature.

## Service identity: a leaked service token authenticates as a machine

- Category: security.
- Impact: `sudo ./pcctl create-service-token` mints a Bearer credential that,
  if leaked (for example, from n8n's credential store, or a copy-pasted
  terminal scrollback), authenticates as that service account until revoked
  or expired.
- Mitigation: closed-by-default routing — only `/api/automation/*` reads the
  `Authorization` header at all, so a leaked token reaches nothing else no
  matter how it is used; a closed scope vocabulary with no execute/apply/
  archive/delete member; a mandatory TTL (no unexpiring token); one-click,
  database-trigger-enforced one-way revocation; only a SHA-256 ever
  persisted, so a `backup_reader` dump contains nothing replayable; every
  resolution failure and scope/kind denial audited with the account key and
  token prefix, never the value.
- How to test: `apps/control-api/test/integration/service-tokens.test.ts`
  (mixed-credential rejection, revoked/expired/disabled-account rejection,
  scope and principal-kind denial, audit coverage) plus `SVC-001`, `SVC-002`,
  `SVC-003`, `SVC-006`, `PGS-020`, `PGS-021` on a migrated deployment.
- Status: mitigated; the closed-by-default routing property and the
  execute/apply-free scope vocabulary are release gates.

## Stale deployment secrets can carry an unintended trailing byte

- Category: operational / security.
- Detail: while building service identity, a live deployment's
  `n8n_encryption_key` and `pg_n8n_app_password` secret files were found to be
  one byte longer than `scripts/generate-secrets.sh` intends (a trailing
  whitespace byte) — n8n's own startup log already warns about this on every
  restart. The generation and distribution code path
  (`scripts/lib/common.sh:write_secret`, `scripts/generate-secrets.sh`) does
  not add one and never has, back to this repository's first commit, so this
  is a pre-existing artifact of how this one deployment's secrets were first
  created, not a defect in the current code.
- Mitigation: `SEC-006` in `verify-security.sh` fails a fresh check against
  any secret file ending in a whitespace byte, so this cannot regress
  silently on a new install or a future secret this platform mints.
- Status: **watching, not yet remediated on the affected live host.**
  `n8n_encryption_key` must never be rotated casually — doing so orphans
  every credential n8n has encrypted — so fixing this specific host is an
  operator decision, not something automated tooling should do unprompted.
  See [security-model.md §6](security-model.md#6-secret-management) and
  [service-accounts.md](service-accounts.md#verification) before acting.

## Repository Actions: project_actions had no restore-test coverage

- Category: disaster recovery / test coverage.
- Detail: discovered while adding restore-test coverage for the new service
  identity and automation tables — `project_actions` (migrations 0013/0014,
  shipped before this work) was never added to `restore-test.sh`'s expected-
  table list or given orphan/constraint checks, unlike every other feature's
  tables (Work Sessions, Agent Runs, roadmap, memory). A restore that lost
  or corrupted Repository Action history would not have been caught.
- Mitigation applied now: `project_actions` was added to the expected-table
  list, so a restore missing the table entirely is caught.
- Status: **partially mitigated.** Table presence is now checked; the
  deeper checks other features have (settled-row immutability trigger
  presence, orphan/cross-project reference checks specific to
  `project_actions`) are not yet added, since Repository Actions' data model
  was outside this session's actual scope of work. This is a discovered,
  pre-existing gap, not one introduced here — recorded so it is not lost.

## Automation: n8n community packages were enabled by default

- Category: security.
- Impact: `N8N_COMMUNITY_PACKAGES_ENABLED` had no explicit value in
  `compose.yaml` before this feature and defaulted to enabled, which would
  let anyone with n8n UI access (Tailscale- and owner-account-gated, but a
  boundary this platform's design otherwise refuses to lean on alone)
  install an arbitrary third-party n8n node outside this platform's own
  review — potentially including node types with capabilities the
  compiled-in `NODES_EXCLUDE` list and `workflow-lint.py` have no visibility
  into.
- Mitigation: `N8N_COMMUNITY_PACKAGES_ENABLED: "false"` is now explicit in
  `compose.yaml`; `N8N-004` asserts it live against a running instance's own
  `n8n audit` output on every `verify-security` run.
- How to test: `sudo ./pcctl verify-security` after a redeploy that picks up
  the compose change; `N8N-004` must report the setting disabled.
- Status: mitigated in code; **the live deployment this repository was
  developed against has not yet been redeployed to pick up the change** —
  `N8N-004` will correctly report `FAIL` on that host until it is.

## Automation: manual-run claim latency

- Category: operational.
- Detail: Control API cannot call n8n (n8n publishes no inbound HTTP
  surface, by design — see automation.md). A manual "Run now" therefore
  opens a `queued` row that waits for n8n's own polling workflow to claim it
  on its next scheduled tick, rather than starting immediately.
- Mitigation: the panel shows `queued` and the queue time explicitly rather
  than implying immediate execution; the poll interval is an operator
  choice in the polling workflow's own schedule trigger, not hardcoded.
- Status: accepted trade-off, not a defect — the alternative (a webhook n8n
  exposes so Control API can push) would give this deployment its first
  inbound HTTP surface, which is the one property this entire feature was
  built to avoid.

## Automation: partial-index idempotency semantics are easy to get backwards

- Category: correctness / design lesson.
- Detail: `workflow_runs_idempotency_idx` is a partial unique index. A first
  version scoped its predicate to the terminal-success statuses it was
  trying to deduplicate (`status IN ('completed','failed',
  'waiting_for_approval')`) — but a partial index only constrains rows that
  themselves satisfy its predicate, and a freshly inserted row is always
  `queued` or `running`, never yet one of those three. That version could
  never actually block a duplicate open at INSERT time; it silently
  protected nothing. The corrected predicate excludes only `cancelled` and
  `expired` (`status NOT IN ('cancelled','expired')`), so a fresh row
  participates in the uniqueness check from the moment it exists.
- Mitigation: caught by `apps/control-api/test/integration/automation.test.ts`
  during development, before this migration was ever deployed anywhere; the
  migration's own comment on the index documents the reasoning so the same
  mistake is not reintroduced by a future "simplification."
- Status: mitigated; the corrected predicate and its test coverage are a
  release gate for this feature.

## Runner startup race creates a partial deployment or rollback

- Category: release / availability / state consistency.
- Impact: an immediate post-restart socket check can reject a healthy runner
  that is still activating. A rollback can then restore config and the runner
  without reconciling the still-running application images, producing a
  misleading mixed-version state.
- Mitigation: one bounded typed runner readiness helper; pre-snapshot
  lock/stack/running-image coherence gate; atomic rollback-point publication;
  exact five-service post-Compose image reconciliation; API and strict verify
  failures mark rollback incomplete and cannot emit success.
- How to test: `tests/deployment-readiness-regression.sh` and
  `tests/update-readiness-gate-regression.sh`, followed by shell syntax and the
  normal release gates.
- Status: mitigated; delayed-start and exact-image regressions are release
  gates.
