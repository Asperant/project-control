#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-incident-behavior.XXXXXXXX")"
trap 'find "$SCRATCH" -name runner.pid -type f -exec sh -c '\''kill "$(cat "$1")" 2>/dev/null || true'\'' _ {} \;; rm -rf -- "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

write_release_files() {
  local root="$1"
  mkdir -p "$root/infra" "$root/infra/compose" "$root/infra/caddy" "$root/infra/n8n/workflows" "$root/config" "$root/apps/runner/bin" "$root/migrations"
  cat >"$root/infra/versions.lock.env" <<'EOF'
PC_POSTGRES_IMAGE=postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PC_N8N_IMAGE=n8n@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PC_CADDY_IMAGE=caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
PC_CONTROL_API_IMAGE=project-control/control-api:test
PC_WEB_IMAGE=project-control/web:test
PC_CADDY_PROXY_IMAGE=project-control/caddy:test
PC_STACK_VERSION=test
EOF
  : >"$root/infra/compose/compose.yaml"
  : >"$root/infra/caddy/Caddyfile"
  # update.sh provisions the automation manifest unconditionally (see its
  # own comment on why: control-api's boot-time manifest load fails closed
  # on a missing file, same as an invalid one) — a synthetic release tree
  # without one would make install_file's own missing-source check fail,
  # not the thing this test is actually exercising.
  printf '{"version":1,"workflows":[]}' >"$root/infra/n8n/workflows/manifest.json"
  printf '3\n' >"$root/config/checkpoint-reader-max-version"
  printf 'new runner\n' >"$root/apps/runner/bin/project-control-runner"
  chmod +x "$root/apps/runner/bin/project-control-runner"
}

write_stack_env() {
  cat >"$1" <<'EOF'
PC_POSTGRES_IMAGE=postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PC_N8N_IMAGE=n8n@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PC_CADDY_IMAGE=caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
PC_CONTROL_API_IMAGE=project-control/control-api:test
PC_WEB_IMAGE=project-control/web:test
PC_CADDY_PROXY_IMAGE=project-control/caddy:test
PC_STACK_VERSION=test
PC_FIXTURE_KEEP=1
EOF
}

write_runner_server() {
  cat >"$1" <<'PY'
#!/usr/bin/python3
import json, os, socket, sys, time
path, delay, pidfile = sys.argv[1], float(sys.argv[2]), sys.argv[3]
with open(pidfile, "w") as f: f.write(str(os.getpid()))
time.sleep(delay)
try: os.unlink(path)
except FileNotFoundError: pass
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path); s.listen(8)
while True:
    c, _ = s.accept()
    try:
        req = json.loads(c.makefile("rb").readline())
        c.sendall((json.dumps({"requestId": req["requestId"], "operation": "system.health", "ok": True, "result": {"socketOK": True}}) + "\n").encode())
    finally:
        c.close()
PY
  chmod +x "$1"
}

setup_update_fixture() {
  local name="$1"
  UF="${SCRATCH}/${name}"
  USRC="${UF}/source"
  UDEPLOY="${UF}/deploy"
  UBIN="${UF}/bin"
  mkdir -p "$USRC/scripts/lib" "$UDEPLOY/config/caddy" "$UDEPLOY/compose" "$UDEPLOY/runner/bin" "$UDEPLOY/secrets" "$UDEPLOY/backups" "$UBIN" "${UF}/runtime"
  cp "${REPO_ROOT}/scripts/update.sh" "$USRC/scripts/update.sh"
  cp "${REPO_ROOT}/scripts/lib/common.sh" "$USRC/scripts/lib/common.sh"
  cp "${REPO_ROOT}/scripts/lib/assert-config-mount.py" "$USRC/scripts/lib/assert-config-mount.py"
  sed -i "s|^PC_RUNTIME_DIR=.*|PC_RUNTIME_DIR=\"${UF}/runtime\"|" "$USRC/scripts/lib/common.sh"
  sed -i 's/local timeout="${1:-30}"/local timeout="${1:-1}"/' "$USRC/scripts/lib/common.sh"
  printf '\nrunner_binary_matches_live_process() { return 0; }\n' >>"$USRC/scripts/lib/common.sh"
  write_release_files "$USRC"
  cp "$USRC/infra/versions.lock.env" "$UDEPLOY/config/versions.lock.env"
  cp "$USRC/infra/compose/compose.yaml" "$UDEPLOY/compose/compose.yaml"
  write_stack_env "$UDEPLOY/config/stack.env"
  printf 'old runner\n' >"$UDEPLOY/runner/bin/project-control-runner"
  chmod +x "$UDEPLOY/runner/bin/project-control-runner"
  printf '3\n' >"$UDEPLOY/config/checkpoint-reader-max-version"
  printf 'x' >"$UDEPLOY/secrets/pg_control_app_password"; chmod 0600 "$UDEPLOY/secrets/pg_control_app_password"

  for script in backup restore-test verify verify-security telegram-notify; do
    cat >"$USRC/scripts/${script}.sh" <<EOF
#!/usr/bin/env bash
[[ "${script}" == verify ]] && printf 'verify\n' >>"${UF}/verify.calls"
exit 0
EOF
    chmod +x "$USRC/scripts/${script}.sh"
  done
  cat >"$USRC/scripts/build.sh" <<EOF
#!/usr/bin/env bash
printf 'build\n' >>"${UF}/build.calls"
exit 0
EOF
  cat >"$USRC/scripts/rollback.sh" <<EOF
#!/usr/bin/env bash
printf 'rollback %s\n' "\$*" >>"${UF}/rollback.calls"
exit 0
EOF
  chmod +x "$USRC/scripts/build.sh" "$USRC/scripts/rollback.sh"
  write_runner_server "${UF}/runner-server.py"

  cat >"$UBIN/id" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -u ]] && { printf '0\n'; exit 0; }
exec /usr/bin/id "$@"
EOF
  cat >"$UBIN/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"$UBIN/systemctl" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  is-active) printf 'active\n'; exit 0 ;;
  restart)
    printf 'restart\n' >>"$FAKE_RESTART_MARKER"
    [[ -f "$FAKE_RUNNER_PIDFILE" ]] && kill "$(cat "$FAKE_RUNNER_PIDFILE")" 2>/dev/null || true
    rm -f "$FAKE_RUNNER_SOCKET"
    if [[ "$FAKE_RUNNER_RESTART_MODE" == delayed ]]; then
      "$FAKE_RUNNER_SERVER" "$FAKE_RUNNER_SOCKET" 0.15 "$FAKE_RUNNER_PIDFILE" >/dev/null 2>&1 &
    fi
    exit 0 ;;
esac
exit 0
EOF
  cat >"$UBIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '401'
EOF
  cat >"$UBIN/docker" <<'EOF'
#!/usr/bin/env bash
image_for_service() {
  case "$1" in
    postgres) printf 'sha256:%064d\n' 1 ;; n8n) printf 'sha256:%064d\n' 2 ;;
    control-api) printf 'sha256:%064d\n' 3 ;; web) [[ "${FAKE_RUNNING_MISMATCH:-0}" == 1 ]] && printf 'sha256:%064d\n' 9 || printf 'sha256:%064d\n' 4 ;;
    caddy) printf 'sha256:%064d\n' 5 ;;
  esac
}
if [[ "${1:-}" == ps ]]; then
  for arg in "$@"; do [[ "$arg" == label=com.docker.compose.service=* ]] && { printf 'cid-%s\n' "${arg##*=}"; exit 0; }; done
fi
if [[ "${1:-}" == inspect && "${2:-}" == --format ]]; then
  [[ "$3" == '{{.Image}}' ]] && { image_for_service "${4#cid-}"; exit 0; }
  printf 'healthy\n'; exit 0
fi
# `compose ... config --format json`: this fixture's own compose.yaml is an
# empty placeholder (see write_release_files), so a real `docker compose
# config` against it would fail regardless of the mount-staging-order fix
# this fake exists alongside — none of this test's scenarios are about that
# bug, so a fixed, safe control-api volume list is exactly the "no opinion,
# stay out of the way" response this fixture needs here.
if [[ "${1:-}" == compose ]]; then
  for arg in "$@"; do [[ "$arg" == config ]] && { printf '{"services":{"control-api":{"volumes":[{"type":"bind","target":"/config","read_only":true}]}}}'; exit 0; }; done
fi
if [[ "${1:-}" == image && "${2:-}" == inspect && "${3:-}" == --format ]]; then
  case "$5" in
    postgres@*) image_for_service postgres ;; n8n@*) image_for_service n8n ;;
    project-control/control-api:*) image_for_service control-api ;; project-control/web:*) printf 'sha256:%064d\n' 4 ;;
    project-control/caddy:*) image_for_service caddy ;; *) exit 1 ;;
  esac
  exit 0
fi
if [[ "${1:-}" == exec ]]; then exit 0; fi
exit 0
EOF
  chmod +x "$UBIN"/*
}

start_initial_runner() {
  rm -f "${UF}/runtime/runner.sock"
  "${UF}/runner-server.py" "${UF}/runtime/runner.sock" 0 "${UF}/runner.pid" >/dev/null 2>&1 &
  for _ in $(seq 1 100); do [[ -S "${UF}/runtime/runner.sock" ]] && return; sleep 0.01; done
  fail 'initial runner fixture did not start'
}

run_update() {
  local mode="$1" mismatch="${2:-0}"
  if (
    export PATH="$UBIN:$PATH" PC_ROOT="$UDEPLOY" PC_ASSUME_YES=1
    export FAKE_RUNNER_SOCKET="${UF}/runtime/runner.sock" FAKE_RUNNER_PIDFILE="${UF}/runner.pid"
    export FAKE_RUNNER_SERVER="${UF}/runner-server.py" FAKE_RUNNER_RESTART_MODE="$mode"
    export FAKE_RESTART_MARKER="${UF}/restart.calls" FAKE_RUNNING_MISMATCH="$mismatch"
    bash "$USRC/scripts/update.sh" --skip-backup --force >"${UF}/stdout" 2>"${UF}/stderr"
  ); then UPDATE_RC=0; else UPDATE_RC=$?; fi
}

# 11, 13 and 21: the real updater waits for the delayed replacement runner,
# avoids rollback, and snapshots the exact prior runner/image IDs.
setup_update_fixture update-delayed
start_initial_runner
run_update delayed 0
[[ "$UPDATE_RC" == 0 ]] || { cat "${UF}/stderr" >&2; fail '#11 delayed update failed'; }
[[ ! -e "${UF}/rollback.calls" ]] || fail '#11 delayed readiness triggered rollback'
grep -q 'runner ready: system.health succeeded' "${UF}/stderr" || fail '#11 typed runner readiness did not pass'
pass '#11 real update delayed socket succeeds without rollback'
snapshot="$(find "$UDEPLOY/backups/rollback" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -n "$snapshot" ]] || fail '#13 update did not publish a rollback point'
cmp -s "$snapshot/project-control-runner" <(printf 'old runner\n') || fail '#13 rollback point did not capture the previous runner'
pass '#13 exact previous runner is captured before replacement'
grep -q '^postgres=sha256:0\{63\}1$' "$snapshot/running-images.env" || fail '#21 postgres actual ID not captured'
grep -q '^web=sha256:0\{63\}4$' "$snapshot/running-images.env" || fail '#21 web actual ID not captured'
pass '#21 rollback manifest records concrete running image IDs'

# 12: a persistent post-restart failure invokes the updater's automatic
# rollback path and cannot report update success.
setup_update_fixture update-timeout
start_initial_runner
run_update fail 0
[[ "$UPDATE_RC" != 0 ]] || fail '#12 persistent runner failure returned success'
grep -q 'rollback --auto' "${UF}/rollback.calls" || fail '#12 automatic rollback was not called'
! grep -q 'update complete' "${UF}/stderr" || fail '#12 failed update reported completion'
pass '#12 persistent update runner failure calls automatic rollback'

# 22: an incoherent running image blocks before build/restart/snapshot/latest.
setup_update_fixture update-incoherent
start_initial_runner
before_runner="$(sha256sum "$UDEPLOY/runner/bin/project-control-runner")"
run_update delayed 1
[[ "$UPDATE_RC" != 0 ]] || fail '#22 incoherent deployment was accepted'
[[ ! -e "${UDEPLOY}/backups/rollback/latest" ]] || fail '#22 latest pointer was published'
[[ -z "$(find "$UDEPLOY/backups/rollback" -mindepth 1 -maxdepth 1 -type d -print -quit)" ]] || fail '#22 selectable snapshot was published'
[[ ! -e "${UF}/restart.calls" && ! -e "${UF}/build.calls" ]] || fail '#22 mutation began before coherence failure'
[[ "$before_runner" == "$(sha256sum "$UDEPLOY/runner/bin/project-control-runner")" ]] || fail '#22 runner changed'
pass '#22 incoherent running IDs publish no snapshot/latest and perform no mutation'

setup_rollback_fixture() {
  local name="$1" with_runner="$2" image_mismatch="$3"
  RF="${SCRATCH}/${name}"; RSRC="${RF}/source"; RDEPLOY="${RF}/deploy"; RBIN="${RF}/bin"; SNAP_ID=20260101T000000Z
  mkdir -p "$RSRC/scripts/lib" "$RSRC/infra" "$RDEPLOY/config" "$RDEPLOY/compose" "$RDEPLOY/runner/bin" "$RDEPLOY/secrets" "$RDEPLOY/backups/rollback/$SNAP_ID" "$RBIN" "${RF}/runtime"
  cp "${REPO_ROOT}/scripts/rollback.sh" "$RSRC/scripts/rollback.sh"; cp "${REPO_ROOT}/scripts/lib/common.sh" "$RSRC/scripts/lib/common.sh"
  sed -i "s|^PC_RUNTIME_DIR=.*|PC_RUNTIME_DIR=\"${RF}/runtime\"|" "$RSRC/scripts/lib/common.sh"
  sed -i 's/local timeout="${1:-30}"/local timeout="${1:-1}"/' "$RSRC/scripts/lib/common.sh"
  write_release_files "$RSRC"
  cp "$RSRC/infra/versions.lock.env" "$RDEPLOY/config/versions.lock.env"; cp "$RSRC/infra/compose/compose.yaml" "$RDEPLOY/compose/compose.yaml"; write_stack_env "$RDEPLOY/config/stack.env"
  printf 'current runner\n' >"$RDEPLOY/runner/bin/project-control-runner"; chmod +x "$RDEPLOY/runner/bin/project-control-runner"
  printf 'x' >"$RDEPLOY/secrets/pg_control_app_password"; chmod 0600 "$RDEPLOY/secrets/pg_control_app_password"
  snap="$RDEPLOY/backups/rollback/$SNAP_ID"
  cp "$RSRC/infra/versions.lock.env" "$snap/versions.lock.env"; cp "$RSRC/infra/compose/compose.yaml" "$snap/compose.yaml"; write_stack_env "$snap/stack.env"; printf '2\n' >"$snap/checkpoint-reader-max-version"
  # update.sh publishes every snapshot artifact as 0600. rollback.sh must
  # accept those exact bytes and restore them with its own 0750 install mode.
  (( with_runner )) && { printf 'target runner\n' >"$snap/project-control-runner"; chmod 0600 "$snap/project-control-runner"; }
  cat >"$snap/running-images.env" <<'EOF'
postgres=sha256:0000000000000000000000000000000000000000000000000000000000000001
n8n=sha256:0000000000000000000000000000000000000000000000000000000000000002
control-api=sha256:0000000000000000000000000000000000000000000000000000000000000003
web=sha256:0000000000000000000000000000000000000000000000000000000000000004
caddy=sha256:0000000000000000000000000000000000000000000000000000000000000005
EOF
  printf '%s\n' "$SNAP_ID" >"$RDEPLOY/backups/rollback/latest"
  cat >"$RSRC/scripts/verify.sh" <<EOF
#!/usr/bin/env bash
printf 'verify\n' >>"${RF}/verify.calls"; exit 0
EOF
  cat >"$RSRC/scripts/telegram-notify.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${RF}/notify.calls"; exit 0
EOF
  chmod +x "$RSRC/scripts/verify.sh" "$RSRC/scripts/telegram-notify.sh"
  cat >"$RBIN/id" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -u ]] && { printf '0\n'; exit 0; }; exec /usr/bin/id "$@"
EOF
  cat >"$RBIN/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"$RBIN/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == is-active ]] && { printf 'active\n'; exit 0; }; exit 0
EOF
  cat >"$RBIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '401'
EOF
  cat >"$RBIN/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "${@: -1}" == *pg_control_app_password ]]; then
  case "$2" in %s) printf '1\n' ;; %a) printf '600\n' ;; %u|%g) printf '0\n' ;; esac; exit 0
fi
exec /usr/bin/stat "$@"
EOF
  cat >"$RBIN/docker" <<'EOF'
#!/usr/bin/env bash
img() { case "$1" in postgres) printf 'sha256:%064d\n' 1;; n8n) printf 'sha256:%064d\n' 2;; control-api) printf 'sha256:%064d\n' 3;; web) [[ "$FAKE_RB_MISMATCH" == 1 ]] && printf 'sha256:%064d\n' 9 || printf 'sha256:%064d\n' 4;; caddy) printf 'sha256:%064d\n' 5;; esac; }
printf '%q ' "$@" >>"$FAKE_DOCKER_CALLS"; printf '\n' >>"$FAKE_DOCKER_CALLS"
if [[ "${1:-}" == ps ]]; then for a in "$@"; do [[ "$a" == label=com.docker.compose.service=* ]] && { printf 'cid-%s\n' "${a##*=}"; exit 0; }; done; fi
if [[ "${1:-}" == inspect && "${2:-}" == --format && "$3" == '{{.Image}}' ]]; then img "${4#cid-}"; exit 0; fi
if [[ "${1:-}" == exec && "$*" == *'SELECT COALESCE(max(snapshot_version)'* ]]; then printf '3\n'; exit 0; fi
exit 0
EOF
  chmod +x "$RBIN"/*
  export FAKE_RB_MISMATCH="$image_mismatch" FAKE_DOCKER_CALLS="${RF}/docker.calls"
}

run_rollback() {
  if ( export PATH="$RBIN:$PATH" PC_ROOT="$RDEPLOY" PC_ASSUME_YES=1 FAKE_RB_MISMATCH FAKE_DOCKER_CALLS; bash "$RSRC/scripts/rollback.sh" --auto "$@" >"${RF}/stdout" 2>"${RF}/stderr" ); then RB_RC=0; else RB_RC=$?; fi
}

# 14: checkpoint compatibility still blocks a v2 reader target against v3 data
# before configuration or runner mutation.
setup_rollback_fixture rollback-checkpoint 0 0
before_lock="$(sha256sum "$RDEPLOY/config/versions.lock.env")"
run_rollback
[[ "$RB_RC" != 0 ]] || fail '#14 incompatible checkpoint rollback succeeded'
grep -q 'database contains v3' "$RF/stderr" || fail '#14 checkpoint compatibility reason missing'
[[ "$before_lock" == "$(sha256sum "$RDEPLOY/config/versions.lock.env")" ]] || fail '#14 checkpoint gate mutated config'
pass '#14 checkpoint reader compatibility gate remains fail-closed'

# 19: post-Compose exact image mismatch is incomplete and cannot emit success.
setup_rollback_fixture rollback-mismatch 0 1
run_rollback --force
[[ "$RB_RC" != 0 ]] || fail '#19 image mismatch returned success'
grep -q 'ROLLBACK INCOMPLETE at image_reconciliation' "$RF/stderr" || fail '#19 incomplete stage missing'
! grep -q 'rollback complete' "$RF/stderr" || fail '#19 completion log emitted'
! grep -q 'Project Control rolled back to' "$RF/notify.calls" 2>/dev/null || fail '#19 success notification emitted'
! grep -q "system.rollback.*success" "$RF/docker.calls" || fail '#19 success audit attempted'
pass '#19 rollback image mismatch is nonzero with no success side effects'

# 20: a restored runner that never publishes its socket times out as incomplete.
setup_rollback_fixture rollback-runner-timeout 1 0
run_rollback --force
[[ "$RB_RC" != 0 ]] || fail '#20 runner timeout returned success'
grep -q 'ROLLBACK INCOMPLETE at runner_restart' "$RF/stderr" || fail '#20 runner incomplete stage missing'
! grep -q 'rollback complete' "$RF/stderr" || fail '#20 completion log emitted'
! grep -q 'Project Control rolled back to' "$RF/notify.calls" 2>/dev/null || fail '#20 success notification emitted'
pass '#20 restored-runner timeout is incomplete with no false success'

# 23: execute verify.sh's real IMG-001 function against equal and unequal
# immutable IDs. A tag string alone is never accepted.
IMG_FN="${SCRATCH}/check-digest.fn"
awk '/^check_digest\(\) \{/,/^\}/' "${REPO_ROOT}/scripts/verify.sh" >"$IMG_FN"
[[ -s "$IMG_FN" ]] || fail '#23 could not extract check_digest'
if (
  source "$IMG_FN"
  container_id() { printf 'cid\n'; }
  record_check() { printf '%s|%s\n' "$1" "$2" >>"${SCRATCH}/img-results"; }
  docker() { [[ "$1" == inspect ]] && printf 'sha256:equal\n' || printf 'sha256:equal\n'; }
  check_digest web project-control/web:test
); then :; else fail '#23 matching image function failed'; fi
grep -q '^PASS|IMG-001$' "${SCRATCH}/img-results" || fail '#23 equal IDs did not pass'
: >"${SCRATCH}/img-results"
if (
  source "$IMG_FN"
  container_id() { printf 'cid\n'; }
  record_check() { printf '%s|%s\n' "$1" "$2" >>"${SCRATCH}/img-results"; }
  docker() { [[ "$1" == inspect ]] && printf 'sha256:running\n' || printf 'sha256:locked\n'; }
  check_digest web project-control/web:test
); then :; else fail '#23 mismatching image function errored'; fi
grep -q '^FAIL|IMG-001$' "${SCRATCH}/img-results" || fail '#23 unequal IDs did not fail'
pass '#23 IMG-001 retains exact immutable-ID semantics'

printf 'PASS: deployment incident behavioral regression suite\n'
