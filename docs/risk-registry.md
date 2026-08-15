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
