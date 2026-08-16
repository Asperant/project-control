# Repository Actions

Repository Actions is this platform's first write path into a registered
project's own repository. Everything else in Stage 1 — project registration,
Development State, checkpoints, Work Sessions — reads a project; Repository
Actions is the one place the platform ever changes one, and it does so through
a fixed lifecycle: **plan → confirm+execute → verify → settle**, with every
step recorded in the append-only audit trail.

The only action kind in this version is `git.commit`. There is no push, pull,
fetch, sync, checkout, merge, rebase, reset, or arbitrary command — see
[Scope](#scope) and the risk registry entry
"Repository Actions: network-mutating Git operations are out of scope by
design" for why push specifically is a distinct future effort, not a missing
checkbox.

## Principle

```
Read → Plan → Preview → Confirm → Execute → Verify → Audit
```

No mutation is ever a bare `button → shell command`. A plan is a server-built
preview of exactly what would happen, shown to the operator before anything
is touched. Confirming and executing are the same request — there is no
"confirmed but not yet running" state for a race to land in — but confirming
still requires echoing back a fingerprint the server computed from a fresh
read, so a stale preview cannot be blindly approved.

## Default posture: nothing is writable

A fresh install ships with `config/write-enabled-projects.conf` empty. With
nothing configured, `project.git.commit` refuses every project, and every
guarantee project registration already made — every path under an allowed
root is read-only in the runner's mount namespace — is completely unchanged.
`verify-security`'s `RNR-016` proves this directly against the live kernel
mount table, not just by reading the config file.

An operator opts a specific, already-registered project in with:

```
sudo ./pcctl enable-repo-writes /home/asrin/Desktop/my-project
sudo ./pcctl disable-repo-writes /home/asrin/Desktop/my-project
```

`enable-repo-writes`:

1. Validates the path is a real, existing directory under a configured
   allowed root, with a plain (non-worktree, non-submodule) `.git`.
2. Adds the canonical path to `config/write-enabled-projects.conf`.
3. Grants `project-runner` a POSIX ACL (`rwX`, recursive, with a default ACL
   so new objects git creates later inherit it) on that project's `.git`
   directory only — this is the *only* way the runner ever gains write
   access to anything outside its own working directory.
4. Regenerates `project-control-runner.service.d/20-write-enabled-projects.conf`,
   a `BindPaths=` exception scoped to `<project>/.git` — never the project
   directory itself — and restarts the runner.
5. Verifies, from inside the runner's own live mount namespace (`nsenter`),
   that `.git` is now writable **and** that the project's working tree is
   still not.

The working tree stays read-only even for a write-enabled project. This is
the load-bearing invariant of the whole feature: *the system can write
history, never your source files.* `checkout`, `reset --hard`, `stash`,
`clean` are not merely unimplemented — with the working tree bind-mounted
read-only, they are kernel-refused for any operation that tried.

## Scope

**In this version:**

| Action | What it does |
| --- | --- |
| `git.commit` | Commits a caller-selected set of repository-relative paths, with a message, to the current branch |

**Explicitly out of scope, not partially implemented:**

| Excluded | Why |
| --- | --- |
| `push` / `fetch` / `pull` / `sync` | The runner's systemd unit sets `RestrictAddressFamilies=AF_UNIX` and `IPAddressDeny=any` — a network Git operation is structurally impossible without removing that confinement, plus a credential-delivery story the runner has none of today |
| `checkout` / `branch` / `merge` / `rebase` / `reset` / `stash` / `clean` | Every one of these writes the working tree, which stays read-only by design even on a write-enabled project |
| `commit --amend`, `revert`, `tag`, `cherry-pick` | Rewrite or duplicate published history; a distinct design effort |
| `--force` / `--force-with-lease` | Never, in any version |
| Arbitrary shell, generic command executor, `sudo`, `docker exec` | Never, in any version — see `docs/security-model.md` §3 |

## Runner: the one mutating operation

Everything below lives in `apps/runner/internal/gitwrite` (the mutation) and
`apps/runner/internal/projectpath` (`ValidateWritable`, the gate in front of
it); `apps/runner/internal/gitinfo` remains entirely read-only, deliberately
kept in a separate package so "gitinfo never writes" stays true by
construction rather than a claim to audit call-by-call.

Two new runner operations, both taking a caller-supplied `path`:

- **`project.git.write.status`** (read-only) — reports whether the project is
  on the write-enabled list and, if so, whether every precondition
  `project.git.commit` will enforce currently holds (`readyToCommit: ""`) or,
  if not, which one is unmet (a stable reason code). Takes an optional
  `paths[]`; when given, also returns a bounded content identity for exactly
  those paths (see [Fingerprint](#fingerprint-the-staleness-guard)) — never
  their content, never more paths than requested, never the whole working
  tree.
- **`project.git.commit`** (the one write) — `{ path, branch, expectedHead,
  message, paths[] }`. No `command`, `argv`, `script`, `workingDirectory` or
  `env` field exists in the wire protocol for this or any operation; a
  request that invents one is rejected by `DisallowUnknownFields` before the
  handler ever runs.

### How a commit is actually built

A naïve `git add <paths> && git commit` operates on the repository's real
index — the same index the project owner's own editor or `git status` is
looking at. Anything else already staged there would be swept into the
commit. `gitwrite.Commit` never does this. Instead:

1. `read-tree HEAD` into a throwaway index (`GIT_INDEX_FILE` pointed at a
   temp file inside the repository's own `.git`, removed when the call
   returns) — skipped for a still-unborn branch.
2. `update-index --add --remove` for exactly the caller-selected paths,
   against the throwaway index only.
3. `write-tree` → a tree object nothing yet references.
4. `ls-tree` on that tree confirms none of the selected paths resolved to a
   submodule gitlink (mode `160000`); a commit that would add or change a
   submodule reference is refused.
5. `commit-tree` → a commit object nothing yet references, using identity
   read from the repository's own **local** `git config` only — never a
   global or system config (both are disabled via `GIT_CONFIG_NOSYSTEM=1`
   and `GIT_CONFIG_GLOBAL=/dev/null`, matching `gitinfo`), and never
   fabricated: a repository with no local `user.name`/`user.email` gets
   `commit_identity_missing`, not an invented author.
6. `update-ref refs/heads/<branch> <new> <expectedOld>` — the one call that
   changes what anyone else can observe. The third argument makes this a
   **compare-and-swap** at the layer git itself serialises: if the branch
   moved since the caller last observed it, this fails atomically and
   nothing durable has been touched yet. (Verified directly: see
   `TestCommitRejectsWhenBranchMovedBetweenObservationAndExecution` and
   `TestCommitLeavesRealIndexUnchangedUntilTheFinalStep`.)
7. Only after that succeeds, a best-effort fold of the same paths into the
   repository's *real* index, so the owner's own `git status` reads as
   expected. If this step fails (e.g. the owner's editor holds the index
   lock at that exact moment), the commit is not retried or rolled back —
   `IndexReconciled: false` is reported and nothing else changes.

Every invocation is `-c safe.directory=<dir>` scoped to the exact,
already-validated directory (the runner's uid never matches a project's
filesystem owner by design — see "Why `safe.directory` matters" below),
`-c core.hooksPath=/dev/null` (no hook — pre-commit, commit-msg, or
otherwise — ever runs; a hook is caller-adjacent code execution by another
name), and `-c commit.gpgsign=false` (repository-local signing config cannot
make a commit hang waiting for a passphrase this process has no way to
supply).

### Preconditions `project.git.commit` enforces, in order

| Reason code | Condition |
| --- | --- |
| `unsupported_git_layout` | `.git` is not literally this repository's own git directory (a worktree or submodule checkout) |
| `detached_head` | HEAD is not a named branch |
| `branch_mismatch` | The checked-out branch does not match what the caller expected |
| `head_moved` | HEAD does not match the caller's `expectedHead` (the CAS guard) |
| `merge_in_progress` | `MERGE_HEAD`, `CHERRY_PICK_HEAD`, `rebase-merge` or `rebase-apply` is present |
| `unmerged_paths` | The working tree has a conflicted path |
| `commit_identity_missing` | No local `user.name`/`user.email` configured |
| `protected_path_selected` | A selected path matched the protected-path denylist |
| `submodule_path_selected` | A selected path resolves to a gitlink |
| `empty_selection` | No path selected, or the selection produces a tree identical to HEAD's |
| `invalid_path` | A selected path escapes the repository, contains a NUL byte, or duplicates another selection |
| `empty_message` | The commit message is blank |
| `write_not_enabled` | The project is not on the write-enabled list |

### Protected paths: a denylist, not a secret scanner

Both the runner (`apps/runner/internal/gitwrite`, authoritative) and the
Control API (`apps/control-api/src/repository-actions/plan.ts`, UX-only —
lets the plan preview exclude a file and say so before the operator even
selects it) carry the same compiled-in, name-shape pattern list: `.env` and
`.env.*`, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.keystore`/`*.kdbx`,
`id_rsa*`/`id_ed25519*`/`id_ecdsa*`, `.netrc`, `.npmrc`, `.pgpass`,
`credentials.json`, `service-account*.json`, `secrets/**`, `.aws/**`,
`.ssh/**`. A matching path can never be committed; there is no override.

**Be precise about what this is.** It reduces the "selected a sensitive file
without thinking" case. It is not a secret scanner: it does not inspect file
*contents*, so a credential embedded inside an otherwise-ordinary file (a
committed `config.json` with an inline API key, say) is not caught by this
list. Nothing in Repository Actions inspects diff content at all — see
[Audit](#audit).

### Why `safe.directory` matters

The runner's OS user (`project-runner`) never matches the filesystem owner of
a registered project (every project belongs to the desktop user; the runner
is a dedicated system account) — this is true for read operations too, and
was a latent bug fixed as part of this feature: git ≥ 2.35.2 refuses to
operate on a repository it does not own ("detected dubious ownership")
unless the directory is explicitly marked safe. Every invocation in
`gitinfo` and `gitwrite` now passes `-c safe.directory=<dir>` scoped to the
exact, already-validated canonical path — never a wildcard, never a
persisted global config entry. See
`TestInspectDevelopmentSucceedsUnderDifferentOwnership` in
`apps/runner/internal/gitinfo` for the regression test (it uses git's own
`GIT_TEST_ASSUME_DIFFERENT_OWNER` test hook via a thin wrapper binary, since
`gitCommand`/`run` build the child's environment from a fixed literal list
rather than inheriting the process environment).

## Control API: plan, execute, verify

### Data model

`project_actions` (migration `0013`): one row per proposed-then-settled
action. Terminal statuses (`succeeded`, `failed`, `cancelled`, `expired`) are
immutable — a trigger rejects any further `UPDATE` — and rows are never
physically deleted (`control_app` holds no `DELETE` grant). A partial unique
index (`project_actions_one_open_per_project_idx`) permits at most one
`planned`/`running` row per project, so two concurrent "Commit" clicks
resolve at the database level rather than a check-then-insert race.

```
planned → running → succeeded
                   → failed
planned → cancelled
planned → expired
```

There is no `unknown` status stored in the database. A `running` row
abandoned mid-flight by a Control API crash is resolved by
`POST /api/projects/:id/actions/:actionId/reconcile`, which never retries the
write — it takes a fresh runner read and settles the row from that
observation alone, through the same `running → succeeded|failed` transition
every other execution uses.

### Fingerprint: the staleness guard

`repository-actions/plan.ts`'s `computeCommitFingerprint` hashes a
canonically ordered summary of exactly what a `git.commit` plan depends on:
the canonical path, branch, HEAD SHA, and — per selected path — a **content
identity**: a git-blob-identity content hash (`sha1("blob " + len + "\0" +
bytes)`, exactly git's own `hash-object` algorithm — verified against the
real `git` binary in
`apps/runner/internal/gitinfo/identity_test.go`) plus a git tree-entry mode
string, computed by the runner (`gitinfo.ComputePathIdentities`, exposed
through `project.git.write.status`'s optional `paths` parameter) and never
persisted anywhere beyond the single resulting sha256 digest.

**This replaced an earlier design that hashed each file's working-tree size
and modification time instead of its content**, which is not content-safe: a
file can be edited such that its byte count is unchanged and its mtime is
restored to the original value — `cp -p`, `rsync -a`, or simply an editor
that preserves timestamps all produce exactly this, no adversarial intent
required — and a size+mtime fingerprint cannot distinguish that from
"nothing changed". Content identity closes this: different bytes produce a
different hash regardless of size or timestamp coincidence. Proven at three
layers:

- `apps/runner/internal/gitinfo/identity_test.go`,
  `TestContentHashCatchesTheExactSizeAndMtimePreservingEditScenario`.
- `apps/control-api/src/repository-actions/plan.test.ts`, the
  same-size/same-mtime `computeCommitFingerprint` case.
- `apps/control-api/test/integration/repository-actions.test.ts`, "rejects
  execute when content changes but size and mtime are both restored to their
  original values" — against the real runner binary and a real repository,
  asserting not just the 409 but that HEAD did not move and the edited
  content is still sitting, uncommitted, in the working tree.

A chmod with byte-identical content (e.g. `chmod +x`) is still detected: the
tree-entry mode is part of the identity independently of the content hash. A
symlink's identity is the hash of its *target text*, read via `readlink`,
never bytes read from wherever it points — which is also what makes it safe
to fingerprint a symlink that points outside the repository without ever
opening the file it points at. A deleted path is `kind: "absent"`, stable
and distinct regardless of what it was before. Every path is bounded and
non-recursive: the runner never hashes more than the caller's requested
paths (≤200, the same cap `PlanGitCommitRequest.paths` already enforces),
never reads a single file above `gitinfo.MaxContentHashBytes` (8 MiB — an
oversized file falls back to the old size/mtime signal for that one file
only, explicitly flagged as the weaker guarantee it is, never silently
presented as equivalent to a content hash), and every path is re-validated
and re-contained against the project directory independently of
`projectpath.Validate` before anything is opened, so a caller-supplied `..`
or a symlink cannot escape the repository through this path either.

The fingerprint is recomputed from a **fresh** runner read — a fresh
`project.git.write.status` call scoped to exactly the plan's
`selectedPaths` — immediately before `execute` transitions the row out of
`planned`. A mismatch, including the runner reporting the project as no
longer ready to commit at all, expires the plan (`action.expired`,
`state_changed`) rather than silently re-planning against state nobody
confirmed. The client also echoes back the fingerprint it was shown as a
basic consistency check, but the fresh server-side recomputation is the
actual staleness guard; the client cannot forge a match to state it never
observed.

This fingerprint is deliberately narrower than "reimplement every
precondition gitwrite enforces" — merge-in-progress, unmerged paths and
commit identity are the runner's authority and are re-checked live at
execute time, surfacing as a stable reason code if any of them holds.

### Risk and confirmation

| Condition | Risk | What execute additionally requires |
| --- | --- | --- |
| Any branch, `defaultBranchConfidence` not `known`, or branch ≠ default | `medium` | The plan's fingerprint |
| Branch equals a `known` (an explicit `origin/HEAD` symref — never an inferred `main`/`master` guess) default branch | `high` | The fingerprint, and `confirmBranch` matching the branch name exactly |

Confirming and executing are one request
(`POST /api/projects/:id/actions/:actionId/execute`) — there is no separate
"confirmed" state a race could land between.

### Routes

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /api/projects/:id/actions` | session | Paginated history, newest first |
| `GET /api/projects/:id/actions/:actionId` | session | One action's plan/result |
| `POST /api/projects/:id/actions/git-commit/plan` | session + CSRF, admin/operator | Build and store a preview |
| `POST /api/projects/:id/actions/:actionId/execute` | session + CSRF, admin/operator, rate-limited (10/min) | Confirm and run |
| `POST /api/projects/:id/actions/:actionId/cancel` | session + CSRF, admin/operator | Cancel a still-`planned` action |
| `POST /api/projects/:id/actions/:actionId/reconcile` | session + CSRF, admin/operator | Resolve a `running` row abandoned by a crash |

Every write route requires `admin` or `operator`, reusing the existing
`role`/`requireRole` guard — there is no second authorization system because
this mutation happens to touch a repository instead of PostgreSQL. Archived
projects are read-only here exactly as everywhere else
(`assertProjectMutable`).

## Audit

`action.planned`, `action.plan_rejected`, `action.cancelled`,
`action.expired`, `action.execution_started`, `action.execution_succeeded`,
`action.execution_failed`, `action.reconciled` — appended to the same
`audit_events` trail every other mutation uses (`INSERT`-only for
`control_app`; see `docs/security-model.md` §4).

Detail carries structural facts only: action id, project id, kind, branch,
file count, protected-exclusion count, risk, verified, result reason code,
and (on success) the resulting commit SHA. **Never** a diff, file content, or
the commit message body beyond what the caller already supplied and the
`sanitiseAuditText`/`sanitiseDetail` redaction layers already apply
platform-wide. `apps/control-api/test/integration/repository-actions.test.ts`
asserts this directly against the audit rows a real commit produces.

## Verification

*Verified by:* `RNR-014` … `RNR-017` (write-enabled config/drop-in sanity and
functional `.git`-writable / working-tree-still-read-only proof from inside
the runner's live mount namespace, plus a live socket probe that
`project.git.commit` refuses a non-write-enabled or hostile-shaped request),
`PGS-017` … `PGS-019` (`control_app` cannot `DELETE` from `project_actions`,
`backup_reader` cannot write it, the settlement trigger is enabled and
guarded).

Test coverage:

- **Go** (`apps/runner/internal/gitwrite`, `internal/projectpath`,
  `internal/operations`): the temp-index/CAS mechanism, every precondition
  reason code, hook non-execution, protected-path and submodule rejection,
  the write-enabled-list gate, and the `safe.directory` regression.
- **Control API** (`repository-actions/plan.test.ts`,
  `test/integration/repository-actions.test.ts`): fingerprint determinism
  and staleness sensitivity, risk classification, the full plan → execute →
  verify flow against a real runner and a real fixture repository,
  concurrent-plan rejection, archived-project block, audit content.

## What this feature deliberately does not do

- No push, fetch, pull or sync — see [Scope](#scope) and the risk registry.
- No working-tree mutation of any kind, on any project, in any version.
- No arbitrary shell, generic command executor, `sudo`, or `docker exec` —
  unchanged from `docs/security-model.md` §3.
- No secret scanning of file *contents* — the protected-path list is a
  name-shape denylist, stated as a limitation, not implied as complete.
- No automatic retry of a failed or interrupted commit.
