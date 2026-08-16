# Read-only Development State

Development State connects a registered project's live local Git metadata to
project continuity. It is observational only: there is no repository mutation
endpoint, generic Git operation, shell input, caller-supplied argv, fetch or
network dependency.

## Runner boundary

`project.git.development` accepts exactly the registered project path. The
runner revalidates it against root-owned allowed roots and executes fixed Git
invocations for repository/status, a bounded recent log, origin and existing
local tracking refs. Every invocation uses `--no-pager`,
`--no-optional-locks`, `core.fsmonitor=false`, `core.hooksPath=/dev/null`, a
scratch environment with `GIT_NO_LAZY_FETCH=1`, and the canonical directory.
Porcelain v2 metadata is
NUL-delimited and bounded to 200 returned files; recent history is bounded to
20 commits. No diff or file content is collected.

Remote URLs are parsed and reconstructed. Userinfo, query and fragment are
discarded; malformed, local and unsupported remotes expose no raw URL. GitHub
is detected only when the normalized host is exactly `github.com`. Live GitHub
API reads are intentionally not configured; no token is stored or exposed.
Ahead/behind uses only already-present local tracking refs and may be stale
because no fetch occurs.

## API and UI

`GET /api/projects/:projectId/development` is authenticated, read-only and
available for archived projects. It returns repository/head facts,
working-tree counts, bounded changed-file metadata, recent commits, safe
origin/tracking metadata, GitHub detection, deterministic attention and the
latest Git-aware checkpoint comparison. Runner, malformed-response, Git and
path-drift failures become a safe `unavailable` model. Reads are not audited.

The Development tab renders Repository Status, Working Tree, Changed Files,
Recent Commits, Remote / Tracking, GitHub and Checkpoint Comparison. Resume
uses a compact projection from the same backend service; Git does not alter the
roadmap Recommended Next Action.

## Checkpoint v3

New checkpoints use v3: v2 project/roadmap/memory/Agent Run facts plus compact
`gitState`. It carries capture time, availability, branch/detached, HEAD,
dirty/count facts, normalized remote identity and local tracking ref. It never
contains paths, diff/source bodies, raw remote URLs or commit history. Capture
occurs before the DB transaction and degrades to `unavailable`; checkpoint
insert/audit and Work Session close/link/audit remain atomic in PostgreSQL.
Historical v1/v2 rows are never rewritten.

Comparison scans compact Git-state projections in bounded keyset pages and
deterministic creation/ID order, then uses the latest non-archived,
schema-valid v3 state that is
`available` or `not_repository`. It reports only known repository, HEAD,
branch and working-tree changes. SHA inequality is not converted into an
invented ancestry or commit-count claim.
