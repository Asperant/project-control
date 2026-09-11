# Contributing

This started as a personal self-hosted platform, not a library or a
framework — so before writing code, it's worth opening an issue to discuss
anything beyond a small, clearly-scoped fix. That saves you time on a change
that might not fit the project's direction.

## Ground rules

- **Read [docs/project-map.md](docs/project-map.md) first.** It says where
  each concern lives and which areas are high-risk to change (auth, the
  runner's confinement, migrations, Repository Actions).
- **Security-relevant changes** (auth, the runner, secrets, Repository
  Actions, automation) should also read
  [docs/security-model.md](docs/security-model.md) — a change that weakens a
  documented guarantee needs that document updated in the same PR, not left
  to drift out of sync.
- **No new functionality without discussion first.** This repository is
  currently in a stated feature-freeze/hardening posture — see the commit
  history — so a bug fix, security fix, performance fix, or documentation
  fix is always welcome; a new feature needs an issue first.

## Before opening a pull request

Run [docs/quality-gates.md](docs/quality-gates.md)'s baseline gate list for
whatever you touched, at minimum:

```bash
pnpm typecheck
pnpm test
pnpm build
go build ./... && go vet ./... && go test ./...   # if you touched apps/runner
```

If your change touches migrations, Work Sessions/Resume, automation/service
identity, or deployment/readiness scripts, `docs/quality-gates.md` lists
additional required checks for each — read the relevant section before you
open the PR, not after review comes back asking for it.

A change to a shell script under `scripts/` or `tests/` should also pass:

```bash
bash -n scripts/*.sh scripts/lib/*.sh tests/*.sh
```

## Commit and PR style

- Keep commits scoped to one logical change; explain *why*, not just *what*
  — the diff already shows what changed.
- Reference the file(s) and behavior a reviewer needs to check, not just a
  summary of the change.
- Never commit a real secret, credential, or personally identifying
  infrastructure detail (hostname, IP, internal path) — `./pcctl
  verify-security`'s `GIT-001`/`APP-*` checks and `scripts/lib/secret-scan.py`
  exist to catch this, but they are a safety net, not a substitute for
  reviewing your own diff first.

## Questions

Open an issue. There's no separate chat/forum for this project.
