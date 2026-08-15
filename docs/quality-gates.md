# Quality gates

Before completion run:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
go test ./...
./pcctl verify
./pcctl verify-security
```

Migration changes additionally require a real PostgreSQL integration run,
role-grant assertions, update dry-run, backup, and restore-test. UI changes need
desktop/mobile, keyboard, empty/loading/error, archived read-only, duplicate
submit, and confirmation-path checks.

Resume / Work Session changes additionally require:

```bash
bash -n scripts/*.sh
bash -n scripts/lib/*.sh
for test_script in tests/*.sh; do bash "$test_script" || exit 1; done
```

- selector tests proving lifecycle, priority, roadmap order and stable-ID
  ordering plus blocked/dependency exclusion and action fallbacks;
- PostgreSQL integration tests for one-open uniqueness, lifecycle/immutability,
  append-only amendments, same-project checkpoint linkage and atomic rollback;
- `PG-023`–`PG-028`, `API-011`–`API-012`, and `PGS-013`–`PGS-016` on a live,
  migrated stack;
- backup/restore validation of both tables, constraints/indexes/triggers, row
  integrity and checkpoint v1/v2 compatibility;
- approximately 390px mobile rendering, long-text wrapping, paginated history,
  explicit empty/error states and archived read-only behavior.
