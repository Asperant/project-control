#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/project-control-preflight-test.XXXXXXXX")"

cleanup() {
  case "$TEST_ROOT" in
    "${TMPDIR:-/tmp}"/project-control-preflight-test.*) rm -rf -- "$TEST_ROOT" ;;
  esac
}
trap cleanup EXIT

# Simulate sudo's restricted PATH. The full preflight may report unrelated host
# blockers; this regression only asserts that missing nvm-provided Node/pnpm are
# development warnings, never installation failures.
set +e
env PATH=/usr/sbin:/usr/bin:/sbin:/bin \
  bash "${REPO_ROOT}/scripts/preflight.sh" \
    --report="${TEST_ROOT}/report.md" \
    >"${TEST_ROOT}/stdout" 2>"${TEST_ROOT}/stderr"
set -e

grep -E '\[( WARN|  OK )\] TOOL-002:' "${TEST_ROOT}/stderr" >/dev/null
grep -E '\[( WARN|  OK )\] TOOL-003:' "${TEST_ROOT}/stderr" >/dev/null
if grep -E '\[ FAIL\].*TOOL-(002|003)' "${TEST_ROOT}/stderr" >/dev/null; then
  printf 'FAIL: missing host Node/pnpm blocked install preflight\n' >&2
  exit 1
fi

printf 'PASS: restricted-PATH preflight regression\n'
