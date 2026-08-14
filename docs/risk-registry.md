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
