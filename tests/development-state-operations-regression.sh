#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
assert_once() {
  local pattern="$1" file="$2" label="$3" count
  count="$(grep -Ec "$pattern" "$file" || true)"
  [[ "$count" == "1" ]] || fail "${label}: expected once in ${file}, found ${count}"
}

VERIFY="${REPO_ROOT}/scripts/verify.sh"
SECURITY="${REPO_ROOT}/scripts/verify-security.sh"
RESTORE="${REPO_ROOT}/scripts/restore-test.sh"
RUNNER="${REPO_ROOT}/apps/runner/internal/gitinfo/gitinfo.go"
OPERATIONS="${REPO_ROOT}/apps/runner/internal/operations/operations.go"
UPDATE="${REPO_ROOT}/scripts/update.sh"
ROLLBACK="${REPO_ROOT}/scripts/rollback.sh"
INSTALL="${REPO_ROOT}/scripts/install.sh"

assert_once 'record_check PASS API-013 ' "$VERIFY" 'Development auth probe'
assert_once 'record_check PASS RNR-007 ' "$SECURITY" 'runner command rejection probe'
grep -q 'project.git.development' "$OPERATIONS" || fail 'typed Development operation is missing'
grep -q 'core.fsmonitor=false' "$RUNNER" || fail 'fsmonitor execution guard is missing'
grep -q 'core.hooksPath=/dev/null' "$RUNNER" || fail 'hooks path guard is missing'
grep -q 'snapshot_version NOT IN (1,2,3)' "$RESTORE" || fail 'restore does not accept checkpoint v3'
grep -q "'gitState'" "$RESTORE" || fail 'restore does not validate v3 Git state'
grep -q 'runner binary installed and service restarted' "$UPDATE" || fail 'update does not deploy and restart the runner'
grep -q 'checkpoint-reader-max-version' "$UPDATE" || fail 'update does not record checkpoint reader compatibility'
grep -q 'runner binary restored and service restarted' "$ROLLBACK" || fail 'rollback does not restore the runner'
grep -q 'runner_binary_changed' "$INSTALL" || fail 'install does not restart for a changed runner binary'
grep -q 'project-runner:project-control' "$UPDATE" || fail 'update uses the wrong runner ownership'
grep -q 'docker image tag' "$ROLLBACK" || fail 'rollback does not restore exact recorded application images'
grep -q 'cannot verify checkpoint reader compatibility' "$ROLLBACK" || fail 'rollback compatibility gate fails open'
grep -q 'invalid checkpoint reader capability metadata' "$ROLLBACK" || fail 'rollback accepts corrupt reader capability metadata'

! grep -Eq '(run|runRaw|gitCommand)\([^)]*"(add|commit|push|pull|fetch|checkout|switch|reset|clean|stash|merge|rebase|cherry-pick|restore|apply|am|gc|maintenance)"' "$RUNNER" \
  || fail 'mutating Git argv appears in a runner execution call'

printf 'PASS: Development State verify/security/restore and read-only runner guards are present\n'
