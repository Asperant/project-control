#!/usr/bin/env bash
# Source-level regression guard for the deployment checks introduced with
# Work Sessions. Live behavior is covered by Control API/PostgreSQL integration
# tests; this catches accidental removal or ID reuse in operational scripts.
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_once() {
  local pattern="$1" file="$2" label="$3"
  local count
  count="$(grep -Ec "$pattern" "$file" || true)"
  [[ "$count" == "1" ]] || fail "${label}: expected once in ${file}, found ${count}"
}

VERIFY="${REPO_ROOT}/scripts/verify.sh"
SECURITY="${REPO_ROOT}/scripts/verify-security.sh"
RESTORE="${REPO_ROOT}/scripts/restore-test.sh"

for id in PG-023 PG-024 PG-025 PG-026 PG-027 PG-028 API-011 API-012; do
  assert_once "record_check PASS ${id} " "$VERIFY" "$id PASS check"
done
for id in PGS-013 PGS-014 PGS-015 PGS-016; do
  assert_once "record_check PASS ${id} " "$SECURITY" "$id PASS check"
done

grep -q "work_sessions work_session_amendments" "$RESTORE" \
  || fail "restore expected-table list omits Work Session tables"
grep -q "work_sessions_one_open_per_project_idx" "$RESTORE" \
  || fail "restore does not validate the one-open-session index"
grep -q "cross_project_checkpoints" "$RESTORE" \
  || fail "restore does not validate same-project checkpoint linkage"
grep -q "checkpoint v1/v2 compatibility" "$RESTORE" \
  || fail "restore does not report checkpoint v1/v2 compatibility"

printf 'PASS: Work Session verify/security/restore operational coverage is present\n'
