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
