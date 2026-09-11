# Security model

Every control below is verified by `./pcctl verify-security`. The check ID in
each row is what that command reports, so a claim here can always be traced to a
command you can run.

---

## Threat model

### In scope

| Threat | Primary control |
| --- | --- |
| Internet-based attacker | No public exposure at all; access requires tailnet membership |
| Compromised container | Non-root, no capabilities, read-only rootfs, no Docker socket, network segmentation |
| Compromised runner | Unprivileged user, no exec path, systemd confinement, no sudo |
| Stolen database dump | Sessions stored as hashes; passwords as Argon2id; backups encrypted before upload |
| Stolen Google Drive backup | restic encryption with an operator-held passphrase |
| Credential stuffing | Argon2id, per-IP rate limit, per-account lockout |
| CSRF | `SameSite=Strict` + double-submit token + Origin check |
| XSS session theft | `HttpOnly` cookie; CSRF token in memory, never in web storage |
| Path traversal in artifacts | Paths derived from validated digests only |
| Log/backup secret leakage | Structured redaction in API, runner and shell layers |
| Audit tampering | No UPDATE/DELETE grant on `audit_events` |
| Stolen or leaked service token | Scoped, TTL-bound, revocable, hashed at rest; cannot execute/apply/archive regardless of what scope it carries |

### Out of scope

- A malicious operator with root on the host.
- Physical access to unencrypted host disks (use full-disk encryption).
- Compromise of the Tailscale coordination server.
- Supply-chain compromise of a pinned upstream image *before* its digest was
  recorded.

---

## 1. Network exposure

**Claim: nothing is reachable from the public internet.**

| Component | Host binding |
| --- | --- |
| caddy | `127.0.0.1:8780` |
| n8n | `127.0.0.1:5678` |
| postgres | none |
| control-api | none |
| web | none |
| runner | none (Unix socket) |

Reachability comes from Tailscale Serve, which terminates TLS on the tailnet
interface. **Funnel is never used** — Funnel publishes to the public internet.
`configure-tailscale` refuses to proceed if Funnel is enabled, and both verify
scripts check for it.

No router configuration, no port forwarding, no dynamic DNS, no Cloudflare, no
domain.

*Verified by:* `NET-001` … `NET-006`, `TS-004`.

---

## 2. Container isolation

| Control | Applied to | Check |
| --- | --- | --- |
| Non-root user | all five | `HRD-004` |
| `cap_drop: ALL`, no `cap_add` | all five | `HRD-003` |
| `no-new-privileges:true` | all five | `HRD-002` |
| Not privileged | all five | `HRD-001` |
| Read-only root filesystem | all except postgres | `HRD-005` |
| PID limit | all five | `HRD-006` |
| Memory + CPU limit | all five | `HRD-007` |
| Bounded logs (10 MiB × 5) | all five | `LOG-001` |
| No host namespace | all five | `HRD-008` |
| Healthcheck | all five | `CNT-002` |

**PostgreSQL is the one documented read-only exception**: it must write its own
data directory. Everything else it writes (`/tmp`, `/run/postgresql`) is
redirected to `tmpfs`.

**The Docker socket is mounted nowhere.** A container with `/var/run/docker.sock`
can start a privileged container and is therefore equivalent to host root. The
runner's user is also not in the `docker` group.

*Verified by:* `DOC-001`, `DOC-002`.

---

## 3. Runner confinement

The runner is the only component outside a container, so it carries the most
layers.

**Application level**

- Refuses to start if uid or euid is 0.
- No `os/exec` import anywhere in the binary.
- The wire protocol has no command/argv/script/cwd/env field, and
  `DisallowUnknownFields` rejects a request that invents one.
- Operation lookup is an exact map hit on a compiled-in table — no case folding,
  no trimming, no prefix matching. `/bin/sh`, `system.health; id` and
  `SYSTEM.HEALTH` are all simply unknown.
- Per-operation timeout, output cap, concurrency limit.
- A panicking handler is recovered inside its own goroutine, so it cannot take
  the service down.
- Working directory must be absolute, must not be a symlink, must be writable.

**systemd level**

```
User=project-runner              NoNewPrivileges=yes
CapabilityBoundingSet=           (empty)
ProtectSystem=strict             ProtectHome=tmpfs
PrivateTmp=yes                   PrivateDevices=yes
RestrictAddressFamilies=AF_UNIX  IPAddressDeny=any
MemoryDenyWriteExecute=yes       RestrictSUIDSGID=yes
SystemCallFilter=@system-service ~@privileged @resources @mount @module …
InaccessiblePaths=/srv/project-control/secrets /srv/project-control/data
MemoryMax=192M  TasksMax=64  CPUQuota=50%
```

`RestrictAddressFamilies=AF_UNIX` is the one that makes "no TCP listener"
structural rather than a promise: the kernel refuses the socket.

**Access control**

The socket is `0660`, owned `project-runner:project-control`. The Control API
container joins that group via `group_add`. Group membership is the entire
credential — there is no token, no password, no allowlist to get wrong.

`verify-security` sends three hostile payloads (`/bin/sh`, a `command` field,
`exec`) over the live socket and requires all three to be refused, and (for
the project-registration operations specifically) four hostile *paths*
(`/etc/passwd`, a `../` traversal, an SSH key path, a relative path) and
requires `project.inspect` to report every one of them `valid: false` rather
than accepting any of them.

*Verified by:* `RNR-001` … `RNR-008`. Allowed-root confinement specifically:
`RNR-009` (drop-in uses `BindReadOnlyPaths=` only, never the whole of `/home`)
and `RNR-010` (a **kernel-level** check — reads the running runner's own
`/proc/<pid>/mountinfo` and confirms the bind mount for the configured root is
actually `ro` in its mount namespace, not just declared so in a unit file).

---

## 4. Database isolation

Six connect/deny combinations are asserted against the live cluster:

| Role | `project_control` | `n8n` |
| --- | --- | --- |
| `control_app` | allowed | **must fail** |
| `control_migrator` | allowed | **must fail** |
| `n8n_app` | **must fail** | allowed |

Plus, as `control_app`:

- `DELETE FROM audit_events` must fail — the trail is append-only.
- `UPDATE audit_events` must fail — history is immutable.
- `CREATE TABLE` must fail — no DDL at runtime.
- `backup_reader` `INSERT` must fail — read-only.

These run as the real roles against the real schema, in both
`verify-security` and the integration suite.

*Verified by:* `PGS-001` … `PGS-006`.

---

## 5. Authentication

| Control | Detail |
| --- | --- |
| Hashing | Argon2id, m=19456 KiB, t=2, p=1 (OWASP) |
| Enumeration | Identical response and identical latency for unknown user vs wrong password |
| Rate limit | 5 login attempts / 5 min per client IP |
| Lockout | 10 consecutive failures locks the account for 15 min |
| Session token | 256-bit random; **only SHA-256 is stored** |
| Cookie | `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain` |
| Expiry | 12 h absolute, 1 h idle (sliding) |
| CSRF | Session-bound token in `x-csrf-token`, constant-time compare, plus Origin check |
| Bootstrap | Interactive CLI only. No default account, no default password, no env var that creates one |
| Audit | Every success, failure, lockout, rate-limit and CSRF rejection recorded |

**Why the token hash matters.** `backup_reader` can dump `sessions`, and that
dump goes to Google Drive. Storing the raw token would make every backup a
bundle of live credentials.

**Why the CSRF token is not in `localStorage`.** Web storage is readable by any
script on the origin, so an XSS payload could read it — defeating the control it
is meant to survive. It lives in a module variable and is re-fetched from
`/api/auth/me` after a reload.

---

## 6. Secret management

| Property | Implementation |
| --- | --- |
| Source of randomness | `/dev/urandom` |
| Directory | `0700`, root-owned |
| Files | `0600`, root-owned |
| Per-service bundles | `0640`, group-readable by exactly that service |
| Delivery | **file paths**, never environment variables |
| Rotation | Never automatic; requires `--rotate <name>` |
| n8n encryption key | Rotation refused outright — it would orphan every stored credential |
| Repository | Only `.example` files; `secrets/` is gitignored and scanned |

**Why files, not environment variables.** A process environment is readable via
`/proc/<pid>/environ`, is included in `docker inspect`, leaks into crash dumps,
and is inherited by children. A `0600` file bind-mounted read-only is none of
those things.

*Verified by:* `SEC-001` … `SEC-005`, `GIT-001` … `GIT-004`.

---

## 7. Secret leakage prevention

Three independent layers, because logging is where secrets escape by accretion:

1. **Control API** — pino `redact` covering cookies, authorization headers,
   password/token/secret/key fields at any depth.
2. **Audit trail** — `sanitiseDetail` strips forbidden keys regardless of case
   or separator, truncates long strings, caps array length and recursion depth.
3. **Runner** — `redact.String` matches `key=value` credential forms, URIs with
   inline credentials, Telegram tokens, PEM blocks, PHC hashes and AWS key IDs;
   `SanitiseLine` strips control characters and terminal escapes so a hostile
   value cannot forge log entries.

Shell scripts pipe third-party output through `redact_stream`. The API's error
handler reports anything that is not a deliberate `AppError` as a bare
`internal_error`, keeping driver messages — which routinely embed connection
strings — out of HTTP responses.

Integration tests assert that no password, hash or connection string appears in
any response body or audit row.

---

## 8. HTTP security headers

Set by Caddy on every response:

```
Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self';
                         img-src 'self' data:; connect-src 'self';
                         frame-ancestors 'none'; base-uri 'none'; object-src 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy / Resource-Policy / Embedder-Policy
Permissions-Policy: camera=(), microphone=(), geolocation=() …
```

No `'unsafe-inline'` anywhere — Vite emits a plain module script and a
stylesheet link, so none is needed.

The API sets an even tighter `default-src 'none'` CSP of its own: nothing may
ever be loaded or executed from a JSON response.

*Verified by:* `HDR-001`, `HDR-002`.

---

## 9. Telegram

Outbound only. There is:

- no webhook registration,
- no `getUpdates` polling,
- no parsing of any inbound message,
- no endpoint for Telegram to call.

The bot is a notification sink. Messages sent *to* it are never read, which
removes the entire "attacker messages the bot to trigger something" class.

The token is validated against `getMe` before being stored, kept in a root-only
`0600` file, and passed to `curl` via `--data-urlencode` rather than argv. API
responses are redacted before printing because Telegram echoes the token back in
some error payloads.

---

## 10. Backups

- Encrypted by restic **before** upload; Google Drive only ever holds ciphertext.
- The passphrase is operator-chosen, never generated, never displayed, never
  transmitted.
- Plaintext database dumps exist only in `backups/staging`, which is wiped on
  every exit path including failure.
- The restore test runs in a throwaway container on its own internal network,
  with the restore target asserted to be inside `backups/restore-tests/`.

---

## 11. Project registration

**Claim: the operator can only register folders under a fixed, root-managed
allowlist, the runner can only ever read them, and nothing about a folder's
content that looks like a secret is ever read, stored, or returned.**

### Allowed roots

`config/allowed-project-roots.conf` is root-owned (`0644`), non-secret, and
written only by `scripts/install.sh` or a root operator editing it directly —
never by the web panel or the Control API, which have no write access to it at
all. The default on a fresh install is `/home/<user>/Desktop`; adding a second
root is a one-line edit followed by `sudo ./pcctl install` (idempotent),
which regenerates the systemd exception below and restarts the runner.

At the OS level, `ProtectHome=tmpfs` on the runner's systemd unit hides all of
`/home` by default; a generated drop-in,
`project-control-runner.service.d/10-allowed-roots.conf`, adds one
`BindReadOnlyPaths=` exception per configured root — never `BindPaths=`
(read-write), and never a bare `/home` entry. This is systemd's own documented
mechanism for adding narrow exceptions to `ProtectHome`/`ProtectSystem=strict`.
The value is deliberately `tmpfs`, not `yes`: per `systemd.exec(5)`, a
`BindReadOnlyPaths=` mount point cannot be created nested under a path
`ProtectHome=yes` has made inaccessible (it is treated the same as
`InaccessiblePaths=` for that purpose), so with `yes` the exception would
never actually apply even though the unit still starts — `tmpfs` hides
`/home` the same way but remains a real, mountable filesystem.
`RNR-010` confirms the mount exists by reading the *kernel's* view of the
running process's mount namespace (`/proc/<pid>/mountinfo`); `RNR-011`,
`RNR-012` and `RNR-013` go further and prove the actual functional claim from
inside that namespace (via `nsenter`) — the runner can read a fixture placed
under the allowed root, cannot write to it, and cannot reach anything else
under `/home`. None of this re-reads the same unit file the drop-in was
generated from; a missing or non-functional mount FAILs these checks and is
never reduced to a warning.

### Path validation (`internal/projectpath`)

Every project-registration operation passes through one function,
`projectpath.Validate`, before touching the filesystem:

1. Reject empty, non-UTF-8, or a path containing a null byte.
2. Reject a non-absolute path.
3. Reject an explicit `..` path segment outright — `filepath.Clean` would
   collapse it silently, but a request that spells one out gets a clear
   rejection instead of a silent renormalisation.
4. Resolve with `filepath.EvalSymlinks`, which walks and resolves *every* path
   component, not just the leaf — this makes the **one-time validation
   itself** correct: whatever `Validate` approves and returns as `Canonical`
   really does resolve inside the allowed root at that instant, whether the
   symlink was the target itself or an intermediate directory anywhere along
   the path. Every downstream operation (the manifest scan, Git inspection,
   Repository Actions) is then called with that already-resolved
   `Canonical` value, never the raw input — see the risk registry entry
   below for the one narrower thing this does *not* guarantee.
5. Reject the allowed root itself as a project.
6. Containment is a **path-component** check: `canonical == root` is already
   rejected by (5), and otherwise `canonical` must start with `root +
   separator`. A bare string prefix (`strings.HasPrefix(canonical, root)`
   with no separator) would let `/home/<user>/Desktop-evil` be mistaken for a
   child of `/home/<user>/Desktop`; the separator makes that impossible.

`WithinRoot` (`internal/projectpath/projectpath.go`) implements that same
path-component containment check as a standalone function, exercised
directly by its own unit tests — but it is not called from the manifest
scanner's directory walk. The scanner's actual defense there is independent
and functionally equivalent: `internal/detect`'s `walk` uses `DirEntry`'s
lstat-derived `IsDir()`/mode bits to skip every symlink entry without
following it (a symlink-to-directory reports `IsDir()==false` and is never
descended into; a symlink leaf is skipped outright), and
`considerManifest` re-`Lstat`s a candidate file immediately before reading
it and rejects anything that is a symlink or non-regular file. So a symlink
planted inside a project cannot be used to read anything outside it — this
guarantee holds, just via the scanner's own lstat checks rather than via
`WithinRoot`. See the risk registry for the one place resolved-then-reused
paths still carry a narrow, documented gap (`docs/risk-registry.md`).

### Secret exclusion, structurally

The manifest scanner (`internal/detect`) reads a file only if its name
matches a fixed allowlist of known project-definition filenames (`package.json`,
`go.mod`, `requirements.txt`, `Dockerfile`, …). There is no code path that
opens a file by any other name, which is what makes `.env`, `id_rsa`,
`credentials.json`, `*.pem` and everything else structurally unreachable —
not filtered out, never reached. The scanner also skips `node_modules`,
`.git`, `vendor`, virtual environments and build-output directories entirely,
never follows a symlink (file or directory), never reads a non-regular file
(FIFO, socket, device), and is bounded by depth, directory count, file count,
per-file size and overall context timeout.

### Git — the one execution exception

`project.inspect` and `project.git.summary` shell out to the real `git`
binary — the single exception to "the runner executes nothing" — because a
from-scratch reimplementation of `git status` means parsing the binary index
format and replicating gitignore semantics, and a subtly wrong
reimplementation would silently misreport a project's state. The invocation
is guarded on every axis that matters:

- No shell, ever — `os/exec` with a fixed argv slice, never a string handed
  to `/bin/sh`.
- Every argv is a literal declared in `internal/gitinfo`. The only variable
  component of any invocation is the directory, always the already-validated,
  absolute `Canonical` path from `projectpath.Validate` (absolute, so it can
  never be mistaken for a flag).
- Only read-only, non-hook-invoking subcommands: `rev-parse`, `symbolic-ref`,
  `show-ref`, `config --get-regexp`, `log`, and `status
  --no-optional-locks`. Never fetch, pull, checkout, commit or merge.
- `GIT_OPTIONAL_LOCKS=0` (env and flag) guarantees `git status` never writes
  the refreshed stat cache to `.git/index` — asserted directly by a test that
  stages exactly the condition a normal `git status` would otherwise "fix".
- A from-scratch environment (`PATH` plus a small fixed `GIT_*` set) — no
  inherited credential helper, SSH command, pager or editor.
- The child inherits the runner's own systemd sandbox (seccomp filters and
  namespace restrictions apply across `exec`), including
  `RestrictAddressFamilies=AF_UNIX`, so even a bug here could not open a
  network connection.

Remote URLs are sanitised (`gitinfo.sanitiseRemoteURL`) before they ever leave
the runner — the userinfo component of an `https://user:pass@host/...` remote
is stripped; an SSH form (`git@host:org/repo.git`) carries no such component
and passes through unchanged.

### Inspection lifecycle and duplicate detection

A folder scan never creates a project directly. It produces a `pending`
`project_inspections` row — single-use, owned by the requesting user, expiring
after 15 minutes — that the operator reviews and edits before confirming.
`POST /api/projects` re-validates ownership, pending status and expiry inside
the same transaction that consumes the inspection and inserts the project, so
two concurrent confirmations of the same inspection cannot both succeed and a
different user's inspection cannot be used.

Duplicate registration is enforced by two partial unique indexes on
`projects` — one on the canonical filesystem path, one on a normalised,
credential-free repository identity (`normalizeRepositoryIdentity`) — both
scoped to non-archived projects, at the database level, which is what makes it
race-safe under concurrent creates rather than merely check-then-insert.
`normalizeRepositoryIdentity` is deliberately conservative: an unparseable
remote URL still normalises to *something* deterministic rather than `null`,
so two different unparseable strings can never collide into the same identity.

*Verified by:* `PG-006`, `PG-007`, `PRJ-001` … `PRJ-003`, `RNR-008` …
`RNR-010`, and the project-registration integration suite
(`apps/control-api/test/integration/projects.test.ts`), which runs the real
Go runner binary — not a mock — against real fixture folders including a
planted secret file and a symlink escape attempt.

---

## 12. Repository Actions

**Claim: the runner can write to at most one thing — a single project's
`.git` directory, only after an operator has explicitly opted that exact
project in — and even there, the working tree it lives in stays read-only.**

Full design in [repository-actions.md](repository-actions.md); this section
is the security summary.

This is the first host-filesystem write grant the runner has ever held.
Every prior operation (project registration, Git reads, Development State)
is strictly read-only, and that stays true for every project that has not
been explicitly opted in — `config/write-enabled-projects.conf` ships empty,
and with it empty, `project.git.commit` refuses every project just as if the
operation did not exist.

Opting a project in (`sudo ./pcctl enable-repo-writes <path>`) does three
things, all narrowly scoped to that one project:

1. Adds its canonical path to the write-enabled list.
2. Grants the runner's OS user a POSIX ACL write grant on `<project>/.git`
   only — never the project directory itself.
3. Adds a matching `BindPaths=` systemd exception scoped to `<project>/.git`
   — the working tree keeps the same `BindReadOnlyPaths=` exception project
   registration already gave it.

The one write operation, `project.git.commit`, never runs `git add` or
`git commit` against the repository's real index. It builds a commit through
plumbing against a throwaway index (`GIT_INDEX_FILE` inside `.git`, removed
when the call returns), so the operator's own in-progress staging is never
disturbed, and the one call that changes anything durable —
`update-ref refs/heads/<branch> <new> <expectedOld>` — is a compare-and-swap
against an operator-observed HEAD, not an unconditional write. Every
invocation disables hook execution (`core.hooksPath=/dev/null`) and commit
signing prompts (`commit.gpgsign=false`), and reads commit identity only from
the repository's own local config, never fabricating one.

*Verified by:* `RNR-014` (write-enabled-projects.conf ownership),
`RNR-015` (the systemd drop-in grants only `.git`-scoped `BindPaths=`, never
`BindReadOnlyPaths=` and never the bare project directory), `RNR-016`
(functional, kernel-level: with the list empty, nothing is writable anywhere
under an allowed root; with one project enabled, only its `.git` is
writable and its working tree still is not), `RNR-017` (the runner refuses
`project.git.commit` for a non-write-enabled project and refuses
command/argv/env-shaped hostile extensions to that operation specifically),
`PGS-017` … `PGS-019` (append-only `project_actions` history at the
PostgreSQL privilege level).

---

## 13. Service identity

**Claim: a machine caller (n8n, in the first consumer) authenticates with a
scoped, revocable, TTL-bound Bearer token that cannot execute, apply, archive
or delete anything — and every route that has not explicitly opted into
accepting one rejects it exactly as if it were absent.**

Full design in [service-accounts.md](service-accounts.md); this section is
the security summary.

This is the platform's first non-human principal. Two properties keep it from
becoming a second, weaker authentication system living alongside sessions:

**Closed by default, per route.** `createRequireAuth` — the preHandler every
route used before this feature, and still the preHandler every route except
`/api/automation/*` uses — never reads the `Authorization` header at all. A
Bearer token presented to any of those routes is not rejected by a check; it
is never looked at, which is a stronger guarantee than a check that could be
forgotten on a new route. Only a route that explicitly wires
`resolvePrincipal` instead can ever be reached by a service token, and
`requirePrincipalKind('user')` is available for the case where that same route
must still refuse a machine caller for a specific action.

**Propose, never confirm.** The scope vocabulary
(`automation:run`, `project:read`, `project:rescan`, `action:plan`,
`system:read`, `report:write`) has no member that mutates a project's
repository, roadmap, or registration state, applies a diff, or archives
anything. `action:plan` reaches only as far as producing a Repository Action
preview (`docs/repository-actions.md`); executing it is
`requirePrincipalKind('user')`-gated regardless of scope. A compromised or
leaked service token can read and suggest; it cannot act.

**Minted like the first administrator, not like a session.** There is no
route that creates a service token — only `sudo ./pcctl create-service-token`,
run at a host terminal, against a compiled-in account registry
(`apps/control-api/src/auth/service-accounts.ts`) that only a code change can
extend. The plaintext is printed once and stored nowhere; only its SHA-256 is
persisted, so a `backup_reader` dump that reaches Google Drive contains
nothing replayable — the same property sessions already have. Every token
carries a mandatory expiry (no unexpiring machine credential) and can be
revoked from the panel or `pcctl` in one step; a settled revocation is
immutable at the database trigger level, the same guard `project_actions` and
`work_sessions` use for their own terminal states.

*Verified by:* `SVC-001` (no plaintext-shaped column exists on
`service_tokens`), `SVC-002` (scope-ceiling and immutability triggers exist,
are enabled and RAISE EXCEPTION-guarded), `SVC-003` (functional: a cookie-only
route returns the identical `401` to a Bearer header as it does to no
credential at all), `SVC-006` (the scope vocabulary is closed by a database
CHECK constraint, not only a TypeScript enum), `PGS-020`/`PGS-021`
(append-only `service_tokens`, read-only `service_accounts` for
`backup_reader`, at the PostgreSQL privilege level). Live behavior — mixed
credential rejection, revoked/expired/disabled-account rejection, scope and
principal-kind denial, audit coverage — is proven by
`apps/control-api/test/integration/service-tokens.test.ts` against a real
database, the same split `PGS-012`/`PGS-016`/`PGS-019` already use for
trigger *existence* here versus trigger *behavior* in the integration suite.

---

## 14. Automation

**Claim: n8n has no inbound HTTP surface, and a workflow run can only ever
read platform state and record its own outcome — never confirm a mutation,
never widen what it can reach beyond the manifest's own fixed scope
requirement.**

Full design in [automation.md](automation.md); this section is the security
summary.

n8n calling the Control API (rather than the reverse) is what keeps this
feature from needing a webhook: a manual run is claimed by n8n *polling*
`POST /api/automation/queue/claim` on its own schedule, never pushed to it.
Building this feature surfaced one real, previously undetected gap in the
existing deployment — `N8N_COMMUNITY_PACKAGES_ENABLED` had no explicit
value and defaulted to enabled, which would let anyone with n8n UI access
(already Tailscale- and owner-account-gated, but this platform's design
otherwise refuses to lean on that boundary alone) install an arbitrary
third-party node this platform's own review never sees. It is now pinned to
`"false"` and asserted live by `N8N-004`.

Workflow *definitions* follow the runner's own pattern: a compiled,
repository-owned, read-only-mounted manifest, not a database row a route
could create. Workflow *run history* is append-only and immutable once
settled, the same trigger-enforced discipline `project_actions` and
`work_sessions` already established, and is treated as authoritative
precisely because n8n's own execution log is not — this deployment prunes it
after 14 days.

*Verified by:* `N8N-001` (functional: no webhook is registered — a random
path returns 404), `N8N-002` (static: every shipped workflow file passes
`workflow-lint.py`, which rejects a webhook/executeCommand/ssh node, any
HTTP Request node not targeting `control-api:8080`, an embedded service
token, and any `$env` read outside the one allowed Telegram chat id —
`tests/workflow-lint-regression.sh` proves the linter itself catches each of
those shapes), `N8N-003` (functional: n8n can reach the Control API — the
positive complement to `PGS-006`'s existing proof that `n8n_app` cannot
reach `project_control`), `N8N-004` (functional: community packages
disabled), `AUT-001`/`AUT-002` (append-only run history at the PostgreSQL
privilege level). Idempotency-window correctness (including the
cancelled/expired exclusion), concurrent-claim exclusivity, lazy lease
expiry and the severity → notify decision are proven by
`apps/control-api/test/integration/automation.test.ts` against a real
database.

---

## 15. Search and timeline

**Claim: neither `GET /api/search` nor either timeline route can expose
anything a caller could not already see through that entity's own endpoint,
and search result text reaching the browser can never be interpreted as
markup.**

Both are authenticated-only reads (`createRequireAuth`), the same access
level as every other read in this API — there is no per-project ACL
anywhere yet, so this is not a narrowing of what an authenticated user can
already reach, only a new way to reach it. `timeline_events` is a curated,
write-time, already-redacted summary feed (never an entity's own
body/prompt/report/snapshot content — see [architecture.md](architecture.md#search-and-timeline-domain));
full-text search reads each source table's own content directly, so the
question reduces to whether that table's existing read access already
covers the caller, which it does by construction.

A real stored-XSS path was found and fixed while building this feature:
`ts_headline` (used to build search snippets) does not HTML-escape the
surrounding text, so a raw string from it rendered via
`dangerouslySetInnerHTML` would let arbitrary user-authored content (a
memory body, a task description) reach the browser's HTML parser. Fixed
before any frontend code rendered a snippet: `search/store.ts` uses
control-character match markers instead of `<b>`/`</b>`, parses the result
into `{ text, matched }` segments server-side, and the contract
(`SearchSnippetSegment`) only ever carries those segments — never an HTML
string. The frontend renders them as plain React text nodes.

---

## 16. Application-layer security checklist

The roadmap names 14 threat classes as a closed checklist. §§1–14 above
cover network exposure, container/runner isolation, database isolation,
auth, secrets, headers, and automation in depth already; this section closes
the remaining items — SQL injection, IDOR, CSRF, XSS, audit leakage,
privilege escalation, unsafe file writes, and runner escape — each with its
own conclusion and evidence, rather than leaving them as an implicit
consequence of the sections above.

**SQL injection — clean, by direct read of every query-building site.**
Every `store.ts` under `apps/control-api/src/**/store.ts` (11 files) plus
`auth/session-store.ts`, `auth/service-token-store.ts` and `audit.ts` were
read in full. Every dynamic `WHERE`-fragment (`conditions.push(...)` sites in
`agent-runs/store.ts`, `automation/store.ts`, `memory/store.ts`,
`projects/store.ts`) pushes SQL text containing only hardcoded column names,
with `$N` placeholders for every value. The two places a *request field*
selects SQL text rather than a value — `listProjects`'s sort column
(`projects/store.ts:378`, `SORT_COLUMNS`, an explicit closed
`Record<...>` allowlist with the comment *"never interpolate the
client-supplied sort field directly"*) and `updateProjectCore`/
`updateRule`/`updateCommand`'s `SET` clauses (`PATCH_COLUMN`/`columnMap`,
fixed object literals) — resolve through a hardcoded allowlist, never a
spliced string. The one place a table/column *identifier* is interpolated
into SQL text (`roadmap/store.ts:161-170`, `reorderRows`) is called at all 3
call sites with hardcoded literal arguments only, never the request-supplied
`direction` value. No `pg-format`, no string-concatenated query text built
from request input, anywhere in the tree.
*Verified by:* code review (this section); no dedicated `verify-security.sh`
check — there is no live surface to probe once parameterization is confirmed
structurally, the same reasoning `verify-security.sh`'s own design already
applies to config-level guarantees.

**CSRF — clean, and already has live-HTTP integration test coverage.**
Double-submit token (`csrf_token_hash` on the session row, plaintext
`csrfToken` returned once at login, echoed back via the `x-csrf-token`
header, compared with a constant-time `safeEqual` — `auth/csrf.ts:28-44`)
plus an `Origin`-vs-`Host` check (`auth/csrf.ts:54-72`) plus
`SameSite=Strict`. Both checks run inside `authenticateSessionCookie`
(`auth/middleware.ts:15-61`), the same `preHandler` every cookie-authenticated
route already uses — a route cannot "forget" CSRF without also forgetting
authentication entirely, which would fail closed (401), not silently permit
a forged request. Failure is `403 csrf_failed`, distinct from a bad-cookie
`401 unauthorized`.
*Verified by:* `apps/control-api/test/integration/auth.test.ts`, `describe('CSRF
protection', ...)` (missing header → 403; another session's token → 403;
foreign `Origin` → 403; safe GET with no token → 200; a rejected attempt is
audited as `auth.csrf.rejected`) plus unit coverage in
`apps/control-api/src/auth/auth.test.ts`. This is exercised by `pnpm test`,
not `verify-security.sh` — proving it live would require the script to hold
an authenticated session, which the script deliberately never does (it is
strictly read-only host/config inspection, not an application test client).

**XSS — clean.** Confirmed no raw-HTML injection sink exists anywhere in the
web frontend (`APP-001`, below). The one markdown-rendering surface
(`react-markdown` in `AgentRunDetail.tsx`, rendering an agent report body)
uses no `rehype-raw`/`rehype-sanitize` plugin — react-markdown v10 does not
render embedded raw HTML by default, so this is safe as configured
(`APP-002`, below), and its custom `a` renderer additionally allowlists only
`http(s)`/`mailto`/relative hrefs (`AgentRunDetail.tsx:18-20`). Search
snippets never reach the browser as an HTML string either: `ts_headline`'s
non-printable match markers are parsed server-side into a
`SearchSnippetSegment[] = {text, matched}[]` (`search/store.ts:15-41`,
documented at `packages/contracts/src/search.ts:36-45`) and rendered as
plain text/structured segments, never reassembled markup. CSP
(`script-src 'self'`, no `'unsafe-inline'`) is verified live by `HDR-001`.
*Verified by:* `APP-001`, `APP-002`, `HDR-001`.

**Audit leakage — clean.** Every audit row is redacted at write time, not
trusted from the caller: `sanitiseDetail` (`audit.ts:120-150`) strips a
closed set of forbidden keys (`password`, `token`, `secret`, `apikey`,
`cookie`, …) recursively and truncates long strings, and `sanitiseAuditText`
(`audit.ts:111-117`) additionally redacts PEM blocks, `key=value`-shaped
credential text and userinfo-bearing URLs in free-text fields. On the read
side, no route anywhere returns an unscoped `audit_events` dump — every read
path is a bounded, filtered activity feed (`detail->>'projectId'=$1` /
`detail->>'taskId'=$1`, `LIMIT 100`) behind the same `requireAuth` every
other read uses (`agent-runs/store.ts:568`, `roadmap/store.ts:226,244`,
`context/store.ts:70`); there is no admin "raw audit log" viewer in the API
or the web app. `control_app` holds SELECT/INSERT only, never UPDATE/DELETE,
on `audit_events` — so even a compromised application process cannot alter
history to hide an action, and `backup_reader` is SELECT-only.
*Verified by:* `APP-003`; `PGS`-series role-grant checks cover the
INSERT/SELECT-only grant.

**IDOR and privilege escalation — clean, given this system's actual access
model.** This is a **single-tenant, flat-access-control system**, not a
multi-tenant one: `AuthenticatedUser.role` carries no project-membership or
ACL field (`auth/session-store.ts:15-22`), and `GET /api/projects` returns
every project to any authenticated user regardless of role
(`routes/projects.ts:265-276`). This is a deliberate, documented design
choice — see `routes/timeline.ts:24-29` and `routes/search.ts:19-23` — not
an oversight, so "project A's user can read project B's data" is not a
boundary this platform claims to enforce anywhere, and should not be
mischaracterized as an IDOR bug in a future review. The IDOR question that
*does* apply — whether a request naming both a `projectId` and a nested
entity id can be tricked into touching a same-named entity that actually
belongs to a different project — was checked against every entity type
(projects, roadmap, memory, checkpoints, agent runs, work sessions,
repository actions) and holds uniformly: every nested loader scopes its
query by `project_id` directly (`memory/store.ts`'s `loadEntry`,
`agent-runs/store.ts`'s `loadRun`, `work-sessions/store.ts`'s
`loadSessionRow`, `repository-actions/store.ts`'s `loadActionRow`, all
`WHERE id=$1 AND project_id=$2`) or transitively verifies the parent chain
in the same transaction before touching a third-level child by its own id
(roadmap criteria/dependencies/notes via `getTask`, `roadmap/store.ts:80-87`;
agent reports via `loadRun`, `agent-runs/store.ts:450-487`). No route fetches
an entity by id alone with zero ownership check, with one documented
exception consistent with the flat model: `GET /api/automation/runs/:id`
looks up a workflow run by id with no project filter, because a run may be
intentionally global-scoped and the platform draws no project read boundary
regardless.
For privilege escalation: every mutating route is gated server-side by
`requireRole('admin','operator')` (or the stricter `requireRole('admin')` for
service-token administration) via the shared `auth/middleware.ts:80-87`
`requireRole` guard, reading `request.auth.user.role` from the
database-resolved session — never a client-supplied value — so a
viewer-role session cookie cannot elevate itself by calling a mutating route
directly. The one nuance worth stating precisely: `requireScope`
(`auth/middleware.ts:184-201`) is a deliberate no-op for human principals, so
a viewer can read (never mutate) `/api/automation/workflows` and
`/api/automation/runs*` at the same level as admin/operator — a read-only
consequence of the same flat model, not a mutation-path gap.
*Verified by:* code review (this section); not a `verify-security.sh` check
— proving this live would require standing up multiple authenticated
sessions of different roles, which the script's read-only, no-session design
deliberately does not do. `apps/control-api/test/integration/*.test.ts`
exercises `requireWriter`/`requireRole` rejection paths per feature.

**Unsafe file writes — clean.** The only place `apps/control-api/src`
writes a file to a user-influenced path is
`storage/filesystem-store.ts:74-90` (`resolveObjectPath`), and it is safe by
construction: a `SHA256_PATTERN = /^[0-9a-f]{64}$/` regex rejects anything
that is not a canonical lowercase 64-character hex digest — no `/`, `..`, or
NUL byte can reach `path.join` — plus a redundant prefix re-check after
resolution. The digest itself is always computed server-side
(`createHash('sha256')`), never taken from a request field; no caller-supplied
filename ever participates in path construction. A full-tree search for
`fs.writeFile`/`writeFileSync`/`createWriteStream`/`fs.mkdir` found writes in
exactly two places: this function, and test fixtures using `mkdtempSync`.
*Verified by:* `APP-004`.

**Runner escape — 3 of 4 vectors closed with direct evidence; 1 narrow,
real gap, now corrected in §11 and the risk registry rather than left as an
overclaim.** Sibling-root bypass (`/home/<user>/Desktop-evil` vs.
`/home/<user>/Desktop`) is closed by the separator-suffix containment check
(`projectpath.go:194`) and explicit `..`-segment rejection
(`projectpath.go:169-173`). Symlinked directory entries during a manifest
scan are closed by `internal/detect`'s lstat-derived `IsDir()`/mode-bit
skip and a pre-read `Lstat` re-check (`detect.go:163-180,225-242`) — see the
§11 correction above; this does **not** run through `WithinRoot`, contrary
to what this document previously claimed, though the guarantee itself holds
via the lstat checks. Absolute-path bypass via `filepath.Join` is closed in
`gitinfo.identityFor` by a pre-check (`safeRepositoryRelativePath`) plus a
post-`Join` containment re-check (`identity.go:90-98`), and Git's own path
arguments never go through `filepath.Join` at all. The fourth vector —
whether `projectpath.Validate`'s one-time `EvalSymlinks` resolution remains
valid for every operation that runs later against the same resolved path —
is **not** structurally closed: nothing pins that resolution via a file
descriptor (no `openat`/`O_NOFOLLOW`/`openat2(RESOLVE_NO_SYMLINKS)`), so an
attacker who already holds local filesystem write access to a path
component could swap in a symlink between validation and a later operation
reading that same path string. See
[risk-registry.md](risk-registry.md#runner-symlink-resolution-is-not-pinned-across-the-request-lifecycle)
for the full statement of what this does and does not require to exploit.
*Verified by:* code review of `apps/runner/internal/{projectpath,detect,gitinfo,gitwrite}`
(this section and §11); no `verify-security.sh` check — this is a
source-level guarantee about the Go binary's control flow, not a
live-probable host property.

---

## What this design deliberately does not do

- No public webhook or management port.
- No Tailscale Funnel, Cloudflare tunnel, or domain.
- No rootless-Docker conversion of the host daemon (breaking change to existing
  projects).
- No `sudoers` entry for any service account.
- No raw shell endpoint, in any component, at any privilege level.
- No push, fetch, pull, sync, or any working-tree mutation (checkout, reset,
  merge, rebase, stash) — Repository Actions supports a confirmed `git.commit`
  only. See [repository-actions.md](repository-actions.md#scope) and the risk
  registry for why push specifically is a distinct future effort.
- No panel route that mints a service token — only `pcctl`, at a host
  terminal. No unexpiring service token. No scope that can execute, apply,
  archive or delete. No route that creates a `service_accounts` row outside
  the compiled-in registry. See [service-accounts.md](service-accounts.md).
- No webhook, anywhere, in any workflow — enforced statically as well as
  documented. No route that creates or edits a workflow manifest entry. No
  workflow that reaches `action:plan` or applies a rescan diff in this
  version. See [automation.md](automation.md).
- No automatic deploy, and no automatic commit either — every Repository
  Action requires an explicit, previewed confirmation.
