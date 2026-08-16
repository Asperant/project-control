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

### Out of scope for Stage 1

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
all. The default on a fresh install is `/home/asrin/Desktop`; adding a second
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
   component, not just the leaf — this is what makes a symlink escape
   structurally impossible, whether the symlink is the target itself or an
   intermediate directory anywhere along the path.
5. Reject the allowed root itself as a project.
6. Containment is a **path-component** check: `canonical == root` is already
   rejected by (5), and otherwise `canonical` must start with `root +
   separator`. A bare string prefix (`strings.HasPrefix(canonical, root)`
   with no separator) would let `/home/asrin/Desktop-evil` be mistaken for a
   child of `/home/asrin/Desktop`; the separator makes that impossible.

The same rule (`WithinRoot`) governs the manifest scanner's own directory
walk, and a directory entry that is a symlink is never followed at all — not
resolved-and-checked, simply skipped — so a symlink planted inside a project
cannot be used to read anything outside it.

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
- No automatic deploy, and no automatic commit either — every Repository
  Action requires an explicit, previewed confirmation.
