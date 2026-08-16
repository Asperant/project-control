#!/usr/bin/env bash
# =============================================================================
# update-readiness-gate-regression.sh
#
# Regression coverage for the pcctl update/rollback startup-race fix:
# containers reporting Healthy does not mean Caddy's upstream connection to
# control-api is ready yet, so a single immediate curl right after
# `compose up --wait` can observe a transient HTTP 503 and wrongly trigger an
# automatic rollback of an otherwise-healthy deployment.
#
# Part 1 exercises scripts/lib/common.sh::wait_for_api_route() in isolation,
# against a fake `curl` on PATH driven by a scripted response queue — fully
# deterministic, no Docker/network involved.
#
# Part 2 exercises the real scripts/rollback.sh end to end (fake `docker`,
# `id`, `chown`, `curl`, and stand-in `verify.sh`/`telegram-notify.sh`) to
# prove the rollback path now waits for route readiness before invoking
# verify.sh, instead of a fixed `sleep 5` immediately followed by verify.
#
# Part 3 exercises the real update.sh::rollback_or_require_restore() (pulled
# verbatim out of the live script, not retyped) to prove the migration-safety
# gating around automatic rollback is unchanged by this fix.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-readiness-gate-test.XXXXXXXX")"

cleanup() {
  case "$SCRATCH" in
    "${TMPDIR:-/tmp}"/project-control-readiness-gate-test.*) rm -rf -- "$SCRATCH" ;;
  esac
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# =============================================================================
# Part 1 — wait_for_api_route() in isolation
# =============================================================================
# shellcheck source=/dev/null
source "${REPO_ROOT}/scripts/lib/common.sh"

FAKE_BIN="${SCRATCH}/bin"
mkdir -p "$FAKE_BIN"

# Fake curl: each call pops the next code off a scripted queue file (one code
# per line); once the queue is exhausted, it keeps repeating the last line —
# this is what lets a single queue express "persistent 503" without having to
# know in advance how many attempts a bounded loop will make. A queue line of
# "FAIL" simulates a hard connection failure: exits non-zero with no stdout,
# which is exactly what makes the real `|| echo 000` fallback in
# wait_for_api_route produce the "000" code.
cat >"${FAKE_BIN}/curl" <<'EOF'
#!/usr/bin/env bash
COUNTER="${FAKE_CURL_COUNTER_FILE:?}"
QUEUE="${FAKE_CURL_QUEUE_FILE:?}"
n=0
[[ -f "$COUNTER" ]] && n="$(cat "$COUNTER")"
n=$((n+1))
printf '%s' "$n" >"$COUNTER"
total="$(wc -l <"$QUEUE")"
if (( n <= total )); then
  code="$(sed -n "${n}p" "$QUEUE")"
else
  code="$(tail -n1 "$QUEUE")"
fi
if [[ "$code" == "FAIL" ]]; then
  exit 7
fi
printf '%s' "$code"
exit 0
EOF
chmod +x "${FAKE_BIN}/curl"

# run_gate <name> <timeout> <interval> <queue codes...>
# Populates GATE_EXIT (wait_for_api_route's return code) and GATE_CALLS (how
# many curl invocations actually happened).
run_gate() {
  local name="$1" timeout="$2" interval="$3"; shift 3
  local dir="${SCRATCH}/${name}"
  mkdir -p "$dir"
  printf '%s\n' "$@" >"${dir}/queue"
  # `if ( ... )` — not `set +e; ( ... ); set -e` — because wait_for_api_route
  # runs in-process (sourced, not `bash otherscript.sh`), so the ERR trap
  # from common.sh's `set -Eeuo pipefail` is inherited into the subshell too;
  # only a genuine tested context (the condition of `if`) suppresses it for
  # everything evaluated underneath, including the function call inside.
  if (
    export PATH="${FAKE_BIN}:${PATH}"
    export FAKE_CURL_QUEUE_FILE="${dir}/queue"
    export FAKE_CURL_COUNTER_FILE="${dir}/counter"
    wait_for_api_route "http://fake.invalid/api/auth/me" 401 "$timeout" "$interval" \
      >"${dir}/stdout" 2>"${dir}/stderr"
  ); then
    GATE_EXIT=0
  else
    GATE_EXIT=1
  fi
  GATE_CALLS=0
  [[ -f "${dir}/counter" ]] && GATE_CALLS="$(cat "${dir}/counter")"
}

# --- 1. 503 -> 503 -> 401 => PASS, no rollback (a caller sees exit 0) -------
run_gate "s1-transient-503" 10 0.2 503 503 401
[[ "$GATE_EXIT" == "0" ]] || fail "scenario 1: expected success, got exit ${GATE_EXIT}"
[[ "$GATE_CALLS" == "3" ]] || fail "scenario 1: expected 3 curl attempts, got ${GATE_CALLS}"
grep -q 'API route ready' "${SCRATCH}/s1-transient-503/stderr" \
  || fail "scenario 1: expected a readiness confirmation line"
printf 'PASS: scenario 1 (503, 503, 401 -> success, no rollback)\n'

# --- 2. connection failure -> 503 -> 401 => PASS (retryable) ---------------
run_gate "s2-conn-fail" 10 0.2 FAIL 503 401
[[ "$GATE_EXIT" == "0" ]] || fail "scenario 2: expected success, got exit ${GATE_EXIT}"
[[ "$GATE_CALLS" == "3" ]] || fail "scenario 2: expected 3 curl attempts, got ${GATE_CALLS}"
printf 'PASS: scenario 2 (connection failure classified retryable)\n'

# --- 3 & 6. persistent 503 until timeout => FAIL, and the loop is bounded --
start="$(date +%s)"
run_gate "s3-persistent-503" 2 0.3 503
end="$(date +%s)"
elapsed=$(( end - start ))
[[ "$GATE_EXIT" == "1" ]] || fail "scenario 3: expected failure after the deadline, got exit ${GATE_EXIT}"
(( GATE_CALLS > 1 )) || fail "scenario 3: expected more than one retry before giving up, got ${GATE_CALLS}"
(( elapsed >= 2 )) || fail "scenario 3/6: gate returned before its 2s deadline (elapsed ${elapsed}s) — not honouring the timeout"
(( elapsed <= 6 )) || fail "scenario 3/6: gate ran for ${elapsed}s against a 2s deadline — the retry loop is not bounded"
grep -q 'did not become ready within 2s' "${SCRATCH}/s3-persistent-503/stderr" \
  || fail "scenario 3: expected a deadline-exceeded error message"
printf 'PASS: scenario 3 (persistent 503 -> FAIL after the deadline)\n'
printf 'PASS: scenario 6 (retry loop is bounded: %ss elapsed against a 2s deadline, %s attempts)\n' "$elapsed" "$GATE_CALLS"

# --- 4. unexpected 200 => FAIL immediately, no retry ------------------------
run_gate "s4-unexpected-200" 10 0.2 200
[[ "$GATE_EXIT" == "1" ]] || fail "scenario 4: expected immediate failure, got exit ${GATE_EXIT}"
[[ "$GATE_CALLS" == "1" ]] || fail "scenario 4: expected exactly 1 attempt (no retry on an unexpected 200), got ${GATE_CALLS}"
grep -q 'not a startup-race signature, failing immediately' "${SCRATCH}/s4-unexpected-200/stderr" \
  || fail "scenario 4: expected a terminal-failure message"
printf 'PASS: scenario 4 (unexpected 200 -> FAIL immediately, no retry)\n'

# --- 5. expected 401 on the first attempt => PASS immediately --------------
run_gate "s5-first-try" 10 0.2 401
[[ "$GATE_EXIT" == "0" ]] || fail "scenario 5: expected success, got exit ${GATE_EXIT}"
[[ "$GATE_CALLS" == "1" ]] || fail "scenario 5: expected exactly 1 attempt, got ${GATE_CALLS}"
printf 'PASS: scenario 5 (expected 401 on first attempt -> immediate success)\n'

# --- extra: a persistent non-503 5xx is terminal, not retried away ----------
run_gate "s-persistent-500" 10 0.2 500
[[ "$GATE_EXIT" == "1" ]] || fail "persistent-500: expected failure, got exit ${GATE_EXIT}"
[[ "$GATE_CALLS" == "1" ]] || fail "persistent-500: a non-503 5xx must not be retried, got ${GATE_CALLS} attempts"
printf 'PASS: extra (persistent HTTP 500 -> FAIL immediately, not confused with the 503 startup race)\n'

# =============================================================================
# Part 2 — rollback.sh waits for readiness before invoking verify.sh
# =============================================================================
RB="${SCRATCH}/rollback-env"
FAKE_SCRIPTS="${RB}/scripts"
mkdir -p "$FAKE_SCRIPTS"
cp -a "${REPO_ROOT}/scripts/." "$FAKE_SCRIPTS/"
mkdir -p "${RB}/runtime"
# Keep the end-to-end runner probe inside the disposable fixture; production's
# fixed /run path remains non-overridable.
sed -i "s|^PC_RUNTIME_DIR=.*|PC_RUNTIME_DIR=\"${RB}/runtime\"|" "${FAKE_SCRIPTS}/lib/common.sh"

# Stand-in verify.sh: records only that (and when) it was called — the real
# verify.sh is intentionally never exercised here, this test is about
# ordering, not about verify.sh's own checks (which stay untouched, see
# Part 1's sibling migration-safety checks in verify.sh itself, unmodified).
VERIFY_CALLS="${RB}/verify-calls"
cat >"${FAKE_SCRIPTS}/verify.sh" <<EOF
#!/usr/bin/env bash
date +%s%N >>"${VERIFY_CALLS}"
exit 0
EOF
chmod +x "${FAKE_SCRIPTS}/verify.sh"
cat >"${FAKE_SCRIPTS}/telegram-notify.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "${FAKE_SCRIPTS}/telegram-notify.sh"

# Fakes for everything rollback.sh shells out to besides curl/verify: `id -u`
# (so require_root passes without real root), `chown` (ensure_dir/rollback.sh
# both chown paths this test does not own), and `docker` (compose up /
# image inspect / ps, all made instantaneous and empty).
cat >"${FAKE_BIN}/id" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "-u" ]]; then printf '0\n'; exit 0; fi
exec /usr/bin/id "$@"
EOF
cat >"${FAKE_BIN}/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"${RB}/runner-server.py" <<'PY'
#!/usr/bin/python3
import json, os, socket, sys, time
time.sleep(0.15)
path = sys.argv[1]
try:
    os.unlink(path)
except FileNotFoundError:
    pass
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.listen(1)
c, _ = s.accept()
req = json.loads(c.makefile("rb").readline())
c.sendall((json.dumps({"requestId": req["requestId"], "operation": "system.health", "ok": True, "result": {"socketOK": True}}) + "\n").encode())
c.close(); s.close()
PY
chmod +x "${RB}/runner-server.py"
cat >"${FAKE_BIN}/systemctl" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  restart) "$FAKE_RUNNER_SERVER" "$FAKE_RUNNER_SOCKET" & exit 0 ;;
  is-active) printf 'active\n'; exit 0 ;;
esac
exit 0
EOF
cat >"${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "ps" ]]; then
  for arg in "$@"; do
    case "$arg" in
      label=com.docker.compose.service=*) printf 'cid-%s\n' "${arg##*=}"; exit 0 ;;
    esac
  done
fi
if [[ "${1:-}" == "inspect" && "${2:-}" == "--format" && "${3:-}" == "{{.Image}}" ]]; then
  case "${4#cid-}" in
    postgres) printf 'sha256:%064d\n' 1 ;; n8n) printf 'sha256:%064d\n' 2 ;;
    control-api) printf 'sha256:%064d\n' 3 ;; web) printf 'sha256:%064d\n' 4 ;;
    caddy) printf 'sha256:%064d\n' 5 ;;
  esac
  exit 0
fi
exit 0
EOF
chmod +x "${FAKE_BIN}/id" "${FAKE_BIN}/chown" "${FAKE_BIN}/systemctl" "${FAKE_BIN}/docker"

# A scripted queue of 503 then 401: proves the gate actually retries (there is
# a real interval-length delay) before verify.sh is allowed to run, not just
# that the call order happens to be textually correct.
ROLLBACK_QUEUE="${RB}/curl-queue"
printf '503\n401\n' >"$ROLLBACK_QUEUE"
ROLLBACK_COUNTER="${RB}/curl-counter"

# Deployment-root and repo-root scratch layout that rollback.sh expects.
DEPLOY="${RB}/deploy"
mkdir -p "${DEPLOY}/config" "${DEPLOY}/compose" "${DEPLOY}/backups/rollback" "${DEPLOY}/secrets"
mkdir -p "${RB}/infra"
cat >"${RB}/infra/versions.lock.env" <<'EOF'
PC_POSTGRES_IMAGE=postgres@sha256:0000000000000000000000000000000000000000000000000000000000000000
PC_N8N_IMAGE=n8n@sha256:0000000000000000000000000000000000000000000000000000000000000000
PC_CADDY_IMAGE=caddy@sha256:0000000000000000000000000000000000000000000000000000000000000000
PC_CONTROL_API_IMAGE=project-control/control-api:test
PC_WEB_IMAGE=project-control/web:test
PC_CADDY_PROXY_IMAGE=project-control/caddy:test
PC_STACK_VERSION=test
EOF

SNAP_ID="20260101T000000Z"
SNAP_DIR="${DEPLOY}/backups/rollback/${SNAP_ID}"
mkdir -p "$SNAP_DIR"
cp "${RB}/infra/versions.lock.env" "${SNAP_DIR}/versions.lock.env"
: >"${SNAP_DIR}/compose.yaml"
cp "${RB}/infra/versions.lock.env" "${SNAP_DIR}/stack.env"
printf 'fixture runner\n' >"${SNAP_DIR}/project-control-runner"
chmod +x "${SNAP_DIR}/project-control-runner"
cat >"${SNAP_DIR}/running-images.env" <<'EOF'
postgres=sha256:0000000000000000000000000000000000000000000000000000000000000001
n8n=sha256:0000000000000000000000000000000000000000000000000000000000000002
control-api=sha256:0000000000000000000000000000000000000000000000000000000000000003
web=sha256:0000000000000000000000000000000000000000000000000000000000000004
caddy=sha256:0000000000000000000000000000000000000000000000000000000000000005
EOF
printf '%s\n' "$SNAP_ID" >"${DEPLOY}/backups/rollback/latest"

before="$(date +%s%N)"
set +e
(
  export PATH="${FAKE_BIN}:${PATH}"
  export FAKE_CURL_QUEUE_FILE="$ROLLBACK_QUEUE"
  export FAKE_CURL_COUNTER_FILE="$ROLLBACK_COUNTER"
  export PC_ROOT="$DEPLOY"
  export PC_ASSUME_YES=1
  export FAKE_RUNNER_SOCKET="${RB}/runtime/runner.sock"
  export FAKE_RUNNER_SERVER="${RB}/runner-server.py"
  # This isolated fixture has no queryable PostgreSQL; --force explicitly
  # acknowledges the compatibility gate so this scenario can focus on route readiness.
  bash "${FAKE_SCRIPTS}/rollback.sh" --auto --force >"${RB}/stdout" 2>"${RB}/stderr"
)
ROLLBACK_EXIT=$?
set -e

[[ "$ROLLBACK_EXIT" == "0" ]] || { cat "${RB}/stderr" >&2; fail "rollback.sh --auto exited ${ROLLBACK_EXIT}"; }
[[ -f "$VERIFY_CALLS" ]] || fail "rollback.sh never invoked verify.sh"
verify_calls_count="$(wc -l <"$VERIFY_CALLS")"
[[ "$verify_calls_count" == "1" ]] || fail "verify.sh should be invoked exactly once, was invoked ${verify_calls_count} times"

verify_at="$(head -1 "$VERIFY_CALLS")"
delta_ns=$(( verify_at - before ))
delta_ms=$(( delta_ns / 1000000 ))
# One 503 then a 401 against the default 2s poll interval means at least one
# full interval must elapse before verify.sh runs — a leftover `sleep 5`
# immediately-then-verify (the old bug) would show as either a fixed ~5000ms
# gap regardless of readiness, or (with the sleep removed incorrectly) a near
# -0ms gap; a working bounded gate lands at roughly one interval, ~2000ms.
(( delta_ms >= 1500 )) || fail "verify.sh ran only ${delta_ms}ms after rollback started — it was not gated behind the 503->401 readiness wait"
grep -q 'API route ready' "${RB}/stderr" || fail "rollback.sh did not report the API route becoming ready"
grep -q 'runner ready: system.health succeeded' "${RB}/stderr" \
  || fail "rollback.sh did not wait for the delayed restored runner"
grep -q 'all five services match the exact rollback image target' "${RB}/stderr" \
  || fail "rollback.sh did not continue through exact image reconciliation"
# The readiness message must appear before verification starts.
gate_line="$(grep -n 'API route ready' "${RB}/stderr" | head -1 | cut -d: -f1)"
verify_line="$(grep -n 'verification passed after rollback' "${RB}/stderr" | head -1 | cut -d: -f1)"
[[ -n "$gate_line" && -n "$verify_line" && "$gate_line" -lt "$verify_line" ]] \
  || fail "readiness confirmation did not precede the verification step in rollback.sh's own log output"
printf 'PASS: scenario 7 (rollback verification waits for route readiness, ~%sms, before invoking verify.sh — not a fixed sleep)\n' "$delta_ms"

# =============================================================================
# Part 3 — update.sh's migration-safety gating around automatic rollback is
#          unchanged by this fix (pulled verbatim from the live script).
# =============================================================================
MIG="${SCRATCH}/migration-safety"
mkdir -p "${MIG}/bin"

awk '/^rollback_or_require_restore\(\) \{/,/^\}/' "${REPO_ROOT}/scripts/update.sh" >"${MIG}/fn.sh"
[[ -s "${MIG}/fn.sh" ]] || fail "could not extract rollback_or_require_restore() from update.sh — has its shape changed?"
grep -q 'PENDING_MIGRATIONS > 0' "${MIG}/fn.sh" \
  || fail "rollback_or_require_restore() no longer gates on PENDING_MIGRATIONS"

cat >"${MIG}/bin/rollback.sh" <<EOF
#!/usr/bin/env bash
echo called >>"${MIG}/marker"
exit 0
EOF
chmod +x "${MIG}/bin/rollback.sh"

audit() { :; }
notify() { :; }
# shellcheck source=/dev/null
source "${MIG}/fn.sh"

# Case A: migrations advanced the ledger -> must NOT roll back images
# automatically (an older image could refuse the newer schema).
rm -f "${MIG}/marker"
PENDING_MIGRATIONS=2
PC_SCRIPTS_DIR="${MIG}/bin"
if ( rollback_or_require_restore health_gate ) >"${MIG}/case-a.out" 2>"${MIG}/case-a.err"; then
  CASE_A_EXIT=0
else
  CASE_A_EXIT=1
fi
[[ ! -f "${MIG}/marker" ]] || fail "migration-safety: rollback.sh was invoked automatically despite 2 pending migration(s)"
[[ "$CASE_A_EXIT" == "1" ]] || fail "migration-safety: expected rollback_or_require_restore to fail closed with pending migrations, got exit ${CASE_A_EXIT}"
grep -q 'automatic image rollback skipped' "${MIG}/case-a.err" || fail "migration-safety: expected the automatic-rollback-skipped warning on stderr"
printf 'PASS: scenario 8a (migration-advanced database is not image-rolled-back automatically)\n'

# Case B: no pending migrations -> a real persistent health failure still
# triggers the automatic rollback exactly as before.
rm -f "${MIG}/marker"
PENDING_MIGRATIONS=0
if ( rollback_or_require_restore health_gate ) >"${MIG}/case-b.out" 2>"${MIG}/case-b.err"; then
  CASE_B_EXIT=0
else
  CASE_B_EXIT=1
fi
[[ -f "${MIG}/marker" ]] || fail "migration-safety: rollback.sh should have been invoked with zero pending migrations"
[[ "$CASE_B_EXIT" == "0" ]] || fail "migration-safety: expected rollback_or_require_restore to succeed with zero pending migrations, got exit ${CASE_B_EXIT}"
printf 'PASS: scenario 8b (no-migration update still rolls back automatically on a real persistent failure)\n'

# -----------------------------------------------------------------------------
# Sanity: the health-gate call site in update.sh still routes through
# rollback_or_require_restore on failure, unchanged.
# -----------------------------------------------------------------------------
grep -q 'rollback_or_require_restore health_gate || true' "${REPO_ROOT}/scripts/update.sh" \
  || fail "update.sh's health-gate failure path no longer calls rollback_or_require_restore as before"
grep -q 'wait_for_api_route "http://127.0.0.1:8780/api/auth/me" 401' "${REPO_ROOT}/scripts/update.sh" \
  || fail "update.sh's health gate no longer calls the bounded readiness helper"

printf 'PASS: update/rollback readiness-gate regression (12 assertions across 3 parts)\n'
