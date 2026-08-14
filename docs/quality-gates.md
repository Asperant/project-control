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
