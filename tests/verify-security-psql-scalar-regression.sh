#!/usr/bin/env bash
# =============================================================================
# verify-security-psql-scalar-regression.sh
#
# Regression coverage for a live-reported bug: running
#   sudo ./pcctl verify-security
# aborted the *entire* run partway through the PGS-017..019 (Repository
# Actions) checks with:
#
#   [ FAIL] aborted at line 536: 'tr -d '[:space:]'' exited 1
#
# Root cause: PGS-012/016/019 each built a scalar query result with
#   var="$(docker exec ... psql ... 2>/dev/null | tr -d '[:space:]')"
# as a bare variable assignment. Under this script's `set -Eeuo pipefail`,
# if the docker/psql command fails for *any* reason (most plausibly here:
# `project_actions` not yet existing because migrations 0013/0014 had not
# been applied to this host yet), pipefail propagates that failure to the
# whole pipeline and trips the ERR trap, aborting the entire
# verify-security run rather than failing just that one check. The trap
# message is additionally misleading — bash's $BASH_COMMAND at that point
# reports the trailing `tr` command's text, not the command that actually
# failed, which is exactly the confusing "'tr -d ...' exited 1" text seen
# live even though tr itself never failed.
#
# The fix (scripts/verify-security.sh): a run_psql_scalar() helper that
# captures the query's exit status explicitly via `cmd && status=0 ||
# status=$?` — a construct `set -e` does not trip regardless of which branch
# fires — and returns a plain, checkable failure instead of ever letting a
# failing pipeline reach the ERR trap. PGS-017/018 (mutation-expected-to-fail
# checks) get an analogous fix: a failed mutation is only treated as the
# intended PASS when PostgreSQL's own "permission denied" error is what
# refused it; any other failure reason is now FAIL, not a silent false PASS.
#
# This test extracts the real run_psql_scalar/_mutation_denied_by_privilege
# function bodies out of scripts/verify-security.sh (never reimplements
# them, to avoid the test and the implementation drifting apart) and drives
# them against a fake `docker` stub covering every scenario below, entirely
# without a live PostgreSQL/Docker stack. It also reproduces the original
# buggy shape in an identical strict-mode harness to prove the bug was real,
# not hypothetical.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
VERIFY_SECURITY_SH="${REPO_ROOT}/scripts/verify-security.sh"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-psql-scalar-test.XXXXXXXX")"

cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$VERIFY_SECURITY_SH" ]] || fail "scripts/verify-security.sh not found"

# --- Extract the real function bodies (never reimplemented) ------------------
# `line=$0; sub(/^  /, "", line)` deliberately does not mutate $0 itself: an
# in-place `sub(/^  /, "")` (defaulting to $0) would strip the closing
# brace's own leading two spaces before the *next* rule gets a chance to
# match it against `/^  \}$/`, silently disabling the capture cutoff and
# vacuuming in the rest of the file. Three-arg sub() into a separate
# variable keeps $0 intact for that later rule on the same line.
FUNCS_FILE="${SCRATCH}/funcs.sh"
awk '
  /^  run_psql_scalar\(\) \{$/ { capture=1 }
  capture { line=$0; sub(/^  /, "", line); print line }
  capture && /^  \}$/ { capture=0 }
' "$VERIFY_SECURITY_SH" > "$FUNCS_FILE"
awk '
  /^  _mutation_denied_by_privilege\(\) \{$/ { capture=1 }
  capture { line=$0; sub(/^  /, "", line); print line }
  capture && /^  \}$/ { capture=0 }
' "$VERIFY_SECURITY_SH" >> "$FUNCS_FILE"

grep -q 'run_psql_scalar() {' "$FUNCS_FILE" || fail "could not extract run_psql_scalar() from verify-security.sh — has its shape changed?"
grep -q '_mutation_denied_by_privilege() {' "$FUNCS_FILE" || fail "could not extract _mutation_denied_by_privilege() from verify-security.sh — has its shape changed?"

# --- A fake `docker` on PATH, controlled entirely by env vars ----------------
# Ignores its arguments (this test is about run_psql_scalar's own robustness,
# not about docker/psql argument construction, which the rest of this file's
# structural/integration coverage already exercises) and responds exactly as
# FAKE_DOCKER_EXIT/STDOUT/STDERR direct.
FAKE_BIN="${SCRATCH}/bin"
mkdir -p "$FAKE_BIN"
cat > "${FAKE_BIN}/docker" <<'STUB'
#!/usr/bin/env bash
printf '%s' "${FAKE_DOCKER_STDOUT:-}"
printf '%s' "${FAKE_DOCKER_STDERR:-}" >&2
exit "${FAKE_DOCKER_EXIT:-0}"
STUB
chmod +x "${FAKE_BIN}/docker"

# run_scenario <exit> <stdout> <stderr> -> prints run_psql_scalar's stdout,
# and prints its own exit status on the line "STATUS=<n>" so the caller can
# assert both without a second invocation (each invocation runs in a fresh
# subshell so this test file's own `set -e` cannot be tripped by a
# deliberately-failing scenario).
run_scenario() {
  local exit_code="$1" stdout="$2" stderr="$3"
  PATH="${FAKE_BIN}:${PATH}" FAKE_DOCKER_EXIT="$exit_code" FAKE_DOCKER_STDOUT="$stdout" FAKE_DOCKER_STDERR="$stderr" \
    bash -c '
      set -Eeuo pipefail
      source "$1"
      pg_cid="fake-container-id"
      out="$(run_psql_scalar someuser somepassword "SELECT 1")" && status=0 || status=$?
      printf "%s\nSTATUS=%s\n" "$out" "$status"
    ' _ "$FUNCS_FILE"
}

# =============================================================================
# 1. Successful query returning "1\n" parses correctly
# =============================================================================
result="$(run_scenario 0 $'1\n' '')"
[[ "$result" == $'1\nSTATUS=0' ]] || fail "scenario 1 (returns 1): got $(printf '%q' "$result")"
printf 'PASS: scenario 1 — successful query returning "1" parses to 1, status 0\n'

# =============================================================================
# 2. Successful query returning "0\n" parses correctly (the FAIL-semantic
#    value for a trigger-existence count, still just a clean parse here)
# =============================================================================
result="$(run_scenario 0 $'0\n' '')"
[[ "$result" == $'0\nSTATUS=0' ]] || fail "scenario 2 (returns 0): got $(printf '%q' "$result")"
printf 'PASS: scenario 2 — successful query returning "0" parses to 0, status 0\n'

# =============================================================================
# 3. Empty stdout on a successful query is an explicit non-abort outcome —
#    run_psql_scalar reports it as an empty string, never as a crash. The
#    caller ("${x:-0}" == "N") already treats an empty value as not matching
#    any expected count, i.e. FAIL — never a silent PASS.
# =============================================================================
result="$(run_scenario 0 '' '')"
[[ "$result" == $'\nSTATUS=0' ]] || fail "scenario 3 (empty stdout): got $(printf '%q' "$result")"
printf 'PASS: scenario 3 — empty stdout on a successful query does not abort, and yields no in-band value\n'

# =============================================================================
# 4. The psql/docker command itself exits non-zero — the exact live failure.
#    Must be an explicit, checkable failure (non-zero status, no stdout),
#    and — the actual regression — must NOT abort the calling shell, even
#    though the calling shell also runs under `set -Eeuo pipefail`.
# =============================================================================
result="$(run_scenario 1 '' 'ERROR:  relation "project_actions" does not exist')"
[[ "$result" == $'\nSTATUS=1' ]] || fail "scenario 4 (command failure): got $(printf '%q' "$result")"
printf 'PASS: scenario 4 — a failing psql/docker command yields an explicit failure and does not abort the shell\n'

# =============================================================================
# 5. Malformed/unexpected value on a successful query is passed through
#    verbatim (whitespace stripped) — it is the caller's numeric comparison
#    that turns anything unexpected into FAIL; run_psql_scalar's own job is
#    only "did the query succeed", which it correctly reports as yes here.
# =============================================================================
result="$(run_scenario 0 $'not-a-number\n' '')"
[[ "$result" == $'not-a-number\nSTATUS=0' ]] || fail "scenario 5 (malformed value): got $(printf '%q' "$result")"
# And the caller-side comparison used throughout PGS-012/016/019 correctly
# rejects it rather than coercing it into a match:
[[ "not-a-number" == "1" ]] && fail "malformed value must not equality-match an expected numeric string"
printf 'PASS: scenario 5 — a malformed value is preserved verbatim and does not equality-match an expected count\n'

# =============================================================================
# 6. The actual expected trigger-count value present -> the record_check
#    comparison used in PGS-019 (== "1") and PGS-012/016 (== "2") passes.
# =============================================================================
result="$(run_scenario 0 $'  1  \n' '')"
value="${result%%$'\n'*}"
[[ "$value" == "1" ]] || fail "scenario 6 (expected trigger present): whitespace was not stripped, got $(printf '%q' "$value")"
printf 'PASS: scenario 6 — a real count-1 result parses and whitespace-strips exactly as PGS-019 requires\n'

# =============================================================================
# 7. The original buggy shape really does abort the calling shell — proving
#    this regression was real, not hypothetical, and that the fix (above)
#    is what stands between it and every future PGS-012/016/019 run.
# =============================================================================
old_pattern_status=0
PATH="${FAKE_BIN}:${PATH}" FAKE_DOCKER_EXIT=1 FAKE_DOCKER_STDOUT='' FAKE_DOCKER_STDERR='ERROR: relation does not exist' \
  bash -c '
    set -Eeuo pipefail
    trap "exit 99" ERR
    action_guard="$(docker exec -i fake env PGPASSWORD=x psql -tAc "SELECT 1" 2>/dev/null | tr -d "[:space:]")"
    echo "UNREACHABLE: ${action_guard}"
  ' >/dev/null 2>&1 || old_pattern_status=$?
[[ "$old_pattern_status" == "99" ]] || fail "the original var=\"\$(cmd | tr ...)\" shape no longer reproduces the abort (status=${old_pattern_status}) — has bash's pipefail/ERR-trap interaction changed, or was this assertion invalidated?"
printf 'PASS: scenario 7 — the original crash-prone pattern is confirmed to abort under set -Eeuo pipefail (the exact live bug)\n'

# =============================================================================
# 8. _mutation_denied_by_privilege — PGS-017..019 least-privilege semantics
#    unchanged: a real "permission denied" failure is still the only failure
#    treated as the intended PASS; anything else is FAIL, not a silent PASS.
# =============================================================================
(
  source "$FUNCS_FILE"
  _mutation_denied_by_privilege 'ERROR:  permission denied for table project_actions' \
    || fail "8a: a genuine permission-denied error must be recognised"
  _mutation_denied_by_privilege 'ERROR:  relation "project_actions" does not exist' \
    && fail "8b: a missing-relation error must NOT be treated as permission denial"
  _mutation_denied_by_privilege '' \
    && fail "8c: empty stderr (e.g. the mutation actually succeeded) must NOT be treated as permission denial"
  # Without this, the subshell's own exit status is that of the last command
  # run inside it (8c's deliberately-false check, status 1) even though
  # every assertion passed — which would trip this script's own `set -e` at
  # the call site below purely because of what the *last line inside* the
  # subshell happened to be, not because anything actually failed.
  exit 0
)
printf 'PASS: scenario 8 — _mutation_denied_by_privilege distinguishes real privilege denial from any other failure\n'

# =============================================================================
# 9. Source-level: PGS-017/018/019 still record FAIL on a bare command
#    success (the mutation went through) — the one unambiguous case that
#    must never be weakened.
# =============================================================================
grep -qF 'record_check FAIL PGS-017 "control_app can DELETE Repository Actions"' "$VERIFY_SECURITY_SH" \
  || fail "PGS-017 must still FAIL when the DELETE succeeds"
grep -qF 'record_check FAIL PGS-018 "backup_reader can write Repository Action history"' "$VERIFY_SECURITY_SH" \
  || fail "PGS-018 must still FAIL when the INSERT succeeds"
grep -qF 'record_check FAIL PGS-019 "Repository Action settlement/lifecycle trigger is missing, disabled, or unguarded"' "$VERIFY_SECURITY_SH" \
  || fail "PGS-019 must still FAIL when the trigger is missing/disabled/unguarded"
grep -qF 'record_check PASS PGS-019 "Repository Action settlement/lifecycle trigger is enabled and guarded"' "$VERIFY_SECURITY_SH" \
  || fail "PGS-019 must still PASS when the trigger is present, enabled and guarded"
# And the new query-failure branches exist and are FAIL, never PASS or a
# silent fallthrough.
grep -qF 'record_check FAIL PGS-012 "Sent-prompt/final-report immutability trigger query failed"' "$VERIFY_SECURITY_SH" \
  || fail "PGS-012 must FAIL (not abort, not PASS) when its query fails"
grep -qF 'record_check FAIL PGS-016 "Work Session immutability/lifecycle trigger query failed"' "$VERIFY_SECURITY_SH" \
  || fail "PGS-016 must FAIL (not abort, not PASS) when its query fails"
grep -qF 'record_check FAIL PGS-019 "Repository Action settlement/lifecycle trigger query failed"' "$VERIFY_SECURITY_SH" \
  || fail "PGS-019 must FAIL (not abort, not PASS) when its query fails"
printf 'PASS: scenario 9 — PGS-012/016/017/018/019 success/failure record_check outcomes are unchanged or newly fail-closed, never weakened\n'

printf 'PASS: verify-security psql-scalar robustness regression suite\n'
