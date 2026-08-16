#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-runner-ready.XXXXXXXX")"
trap 'rm -rf -- "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

# shellcheck source=/dev/null
source "${REPO_ROOT}/scripts/lib/common.sh"
PC_RUNNER_SOCKET="${SCRATCH}/runner.sock"

make_socket_file() {
  rm -f "$PC_RUNNER_SOCKET"
  /usr/bin/python3 - "$PC_RUNNER_SOCKET" <<'PY'
import socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
s.close()
PY
}

# 1. Already-ready runner succeeds on the first attempt.
make_socket_file
if ( _runner_service_state() { printf 'active\n'; }; _runner_health_probe() { return 0; }; wait_for_runner_ready 1 0.05 ); then
  pass 'scenario 1: active + socket + typed health succeeds immediately'
else
  fail 'scenario 1'
fi

# 2. systemd activating and a socket published afterwards are both transient.
rm -f "$PC_RUNNER_SOCKET"
( sleep 0.15; make_socket_file ) & activating_socket_writer=$!
if (
  state_counter="${SCRATCH}/state-counter"
  _runner_service_state() {
    n=0; [[ -f "$state_counter" ]] && n="$(cat "$state_counter")"; n=$((n+1)); printf '%s' "$n" >"$state_counter"
    (( n < 3 )) && printf 'activating\n' || printf 'active\n'
  }
  _runner_health_probe() { return 0; }
  wait_for_runner_ready 2 0.05
); then
  wait "$activating_socket_writer"
  pass 'scenario 2: socket appearing after activating is retried'
else
  wait "$activating_socket_writer" || true
  fail 'scenario 2'
fi

# 3. An active service may publish its socket shortly after restart.
rm -f "$PC_RUNNER_SOCKET"
( sleep 0.15; make_socket_file ) & socket_writer=$!
if ( _runner_service_state() { printf 'active\n'; }; _runner_health_probe() { return 0; }; wait_for_runner_ready 2 0.05 ); then
  wait "$socket_writer"
  pass 'scenario 3: active with delayed socket is retried'
else
  wait "$socket_writer" || true
  fail 'scenario 3'
fi

# 4. Temporary connect/EOF/timeout class (probe exit 2) is retryable.
make_socket_file
if (
  n=0
  _runner_service_state() { printf 'active\n'; }
  _runner_health_probe() { n=$((n+1)); (( n < 3 )) && return 2 || return 0; }
  wait_for_runner_ready 2 0.05
); then pass 'scenario 4: temporary health connection failures are retried'; else fail 'scenario 4'; fi

# 5-6. Terminal systemd states fail immediately.
make_socket_file
if ( _runner_service_state() { printf 'inactive\n'; }; wait_for_runner_ready 2 0.05 ); then fail 'scenario 5'; else pass 'scenario 5: inactive is terminal'; fi
if ( _runner_service_state() { printf 'failed\n'; }; wait_for_runner_ready 2 0.05 ); then fail 'scenario 6'; else pass 'scenario 6: failed is terminal'; fi

# 7. A path occupying the socket name is a terminal integrity failure.
rm -f "$PC_RUNNER_SOCKET"
printf 'not a socket\n' >"$PC_RUNNER_SOCKET"
if ( _runner_service_state() { printf 'active\n'; }; wait_for_runner_ready 2 0.05 ); then fail 'scenario 7'; else pass 'scenario 7: non-socket path is terminal'; fi

# 8. A real listener returning an invalid typed response is terminal.
rm -f "$PC_RUNNER_SOCKET"
/usr/bin/python3 - "$PC_RUNNER_SOCKET" <<'PY' &
import json, socket, sys
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1]); s.listen(1)
c, _ = s.accept()
req = json.loads(c.makefile("rb").readline())
c.sendall((json.dumps({"requestId": req["requestId"], "operation": "wrong.operation", "ok": True, "result": {"socketOK": True}}) + "\n").encode())
c.close(); s.close()
PY
invalid_server_pid=$!
for _ in $(seq 1 40); do [[ -S "$PC_RUNNER_SOCKET" ]] && break; sleep 0.01; done
if ( _runner_service_state() { printf 'active\n'; }; wait_for_runner_ready 2 0.05 ); then
  wait "$invalid_server_pid" || true
  fail 'scenario 8'
else
  wait "$invalid_server_pid"
  pass 'scenario 8: real invalid typed protocol response is terminal'
fi

# 9. Missing-socket retries are bounded by the configured deadline.
rm -f "$PC_RUNNER_SOCKET"
started="$(date +%s%N)"
if ( _runner_service_state() { printf 'active\n'; }; wait_for_runner_ready 1 0.05 ); then fail 'scenario 9'; fi
elapsed_ms=$(( ( $(date +%s%N) - started ) / 1000000 ))
(( elapsed_ms >= 900 && elapsed_ms < 2500 )) || fail "scenario 9 deadline was ${elapsed_ms}ms"
pass 'scenario 9: readiness timeout is bounded'

# 10. Exercise the real AF_UNIX JSON probe against a delayed typed responder.
rm -f "$PC_RUNNER_SOCKET"
/usr/bin/python3 - "$PC_RUNNER_SOCKET" <<'PY' &
import json, socket, sys, time
time.sleep(0.15)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(sys.argv[1])
s.listen(1)
c, _ = s.accept()
req = json.loads(c.makefile("rb").readline())
c.sendall((json.dumps({"requestId": req["requestId"], "operation": "system.health", "ok": True, "result": {"socketOK": True}}) + "\n").encode())
c.close(); s.close()
PY
server_pid=$!
if ( _runner_service_state() { printf 'active\n'; }; wait_for_runner_ready 2 0.05 ); then
  wait "$server_pid"
  pass 'scenario 10: real fixed system.health probe accepts a typed success'
else
  wait "$server_pid" || true
  fail 'scenario 10'
fi

# 11. Lock and stack.env are compared independently before running IDs.
LOCK="${SCRATCH}/versions.lock.env"
STACK="${SCRATCH}/stack.env"
for file in "$LOCK" "$STACK"; do
  cat >"$file" <<'EOF'
PC_POSTGRES_IMAGE=postgres:test
PC_N8N_IMAGE=n8n:test
PC_CONTROL_API_IMAGE=control:test
PC_WEB_IMAGE=web:test
PC_CADDY_PROXY_IMAGE=caddy:test
PC_STACK_VERSION=1.0.0
EOF
done
container_id() { printf 'cid-%s\n' "$1"; }
docker() {
  if [[ "$1" == inspect ]]; then printf 'id-%s\n' "${4#cid-}"; return; fi
  case "$5" in
    postgres:test) printf 'id-postgres\n' ;; n8n:test) printf 'id-n8n\n' ;;
    control:test) printf 'id-control-api\n' ;; web:test) printf 'id-web\n' ;; caddy:test) printf 'id-caddy\n' ;;
    *) return 1 ;;
  esac
}
deployment_images_match_lock "$LOCK" "$STACK" || fail 'scenario 11 coherent files rejected'
printf 'PC_STACK_VERSION=other\n' >>"$STACK"
if deployment_images_match_lock "$LOCK" "$STACK"; then fail 'scenario 11 mismatch accepted'; fi
pass 'scenario 11: lock/stack mismatch blocks the coherence gate'

# Extra: the rollback-point gate accepts only the bytes the service is
# actually executing, not a stale executable that merely exists on disk.
sleep 5 & live_binary_pid=$!
if (
  systemctl() { printf '%s\n' "$live_binary_pid"; }
  runner_binary_matches_live_process "$(readlink -f /usr/bin/sleep)"
); then
  printf 'different runner bytes\n' >"${SCRATCH}/stale-runner"
  chmod +x "${SCRATCH}/stale-runner"
  if (
    systemctl() { printf '%s\n' "$live_binary_pid"; }
    runner_binary_matches_live_process "${SCRATCH}/stale-runner"
  ); then
    kill "$live_binary_pid" 2>/dev/null || true
    fail 'live runner binary gate accepted stale on-disk bytes'
  fi
  kill "$live_binary_pid" 2>/dev/null || true
  wait "$live_binary_pid" 2>/dev/null || true
  pass 'extra: live runner executable must match snapshotted disk bytes'
else
  kill "$live_binary_pid" 2>/dev/null || true
  wait "$live_binary_pid" 2>/dev/null || true
  fail 'live runner binary gate rejected matching executable bytes'
fi

# 12-14. Guard the production call sites and strict completion semantics.
grep -q 'systemctl restart project-control-runner.service.*' "${REPO_ROOT}/scripts/update.sh" || fail 'scenario 12 update restart missing'
grep -q 'wait_for_runner_ready' "${REPO_ROOT}/scripts/update.sh" || fail 'scenario 12 update readiness missing'
! grep -q '\[\[ ! -S "$PC_RUNNER_SOCKET" \]\]' "${REPO_ROOT}/scripts/update.sh" || fail 'scenario 12 old update single-shot socket check remains'
pass 'scenario 12: update uses bounded runner readiness'

grep -q 'running_images_match_snapshot' "${REPO_ROOT}/scripts/rollback.sh" || fail 'scenario 13 exact rollback reconciliation missing'
grep -q 'rollback_incomplete strict_verification' "${REPO_ROOT}/scripts/rollback.sh" || fail 'scenario 13 verify can still report success'
grep -q 'rollback_incomplete api_readiness' "${REPO_ROOT}/scripts/rollback.sh" || fail 'scenario 13 API failure can still report success'
pass 'scenario 13: rollback completion is strict and image-exact'

grep -q 'wait_for_runner_ready' "${REPO_ROOT}/scripts/install.sh" || fail 'scenario 14 install readiness missing'
grep -q 'checkpoint_reader_max < 3' "${REPO_ROOT}/scripts/verify.sh" || fail 'scenario 14 API-013 capability skip missing'
grep -q 'record_check SKIP API-013' "${REPO_ROOT}/scripts/verify.sh" || fail 'scenario 14 API-013 old-target skip missing'
pass 'scenario 14: install and target-aware verification use the incident contracts'

printf 'PASS: deployment readiness regression suite (14 scenarios)\n'
