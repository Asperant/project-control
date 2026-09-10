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
  integrity and checkpoint v1/v2/v3 compatibility;
- Development State runner tests prove fixed argv, hostile-param rejection,
  fsmonitor non-execution, credential-safe remotes, bounded output and unchanged
  HEAD/index/refs/worktree;
- approximately 390px mobile rendering, long-text wrapping, paginated history,
  explicit empty/error states and archived read-only behavior.

Automation / service identity changes additionally require:

```bash
bash tests/workflow-lint-regression.sh
bash tests/verification-status-merge-regression.sh
python3 scripts/lib/workflow-lint.py infra/n8n/workflows/manifest.json infra/n8n/workflows/*.workflow.json
```

- mixed cookie+Bearer credentials rejected; a Bearer header is ignored
  (not merely denied) on every route that has not opted into
  `resolvePrincipal`;
- revoked/expired/disabled-account tokens rejected indistinguishably, each
  audited;
- a token's scopes can never exceed its account's ceiling (database
  trigger, not just application code); `requirePrincipalKind`/`requireScope`
  deny a service principal and are a no-op for a user principal;
- idempotency window collision including the cancelled/expired exclusion;
  concurrent-claim exclusivity (`FOR UPDATE SKIP LOCKED`); lazy lease
  expiry; severity → notify computed server-side from the manifest;
- every shipped workflow file passes the static lint; the linter itself
  rejects a webhook, a non-control-api HTTP target, `require(...)`, an
  embedded token and an unlisted `$env` read.

Deployment/readiness changes additionally require:

```bash
bash tests/deployment-readiness-regression.sh
bash tests/deployment-incident-behavior-regression.sh
bash tests/update-readiness-gate-regression.sh
bash tests/reconcile-state-regression.sh
bash -n scripts/*.sh scripts/lib/*.sh tests/*.sh
git diff --check
```

- delayed runner startup and socket-connect races must not trigger a false
  rollback;
- inconsistent lock/stack/running-image state must block rollback-point
  publication even with `--force`;
- rollback must reconcile all five exact captured image IDs and report any
  runner, Compose, image, API, or strict-verify failure as incomplete without a
  success audit;
- `reconcile-state` (the recovery for a healthy stack whose exact rollback
  images were pruned, see `docs/update-rollback.md`) must abort with no
  mutation on any unhealthy/missing container, unrecoverable running image,
  not-ready runner, migration-ledger or checkpoint-reader incompatibility, or
  ambiguous capability probe; must accept no override flag; and must leave an
  already-coherent host unchanged.
