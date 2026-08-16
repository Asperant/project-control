#!/usr/bin/env bash
# =============================================================================
# reconcile-state-regression.sh
#
# Regression coverage for `pcctl reconcile-state`: the supported recovery for
# a host whose running containers are healthy and mutually coherent but whose
# versions.lock.env / stack.env / checkpoint-reader-max-version describe a
# release whose exact application images were pruned — the gap left when a
# documented rollback (docs/update-rollback.md "Supported recovery for a
# partial Stage 7 rollback") itself fails because the target's exact local
# images are gone, per the fail-safe already exercised by scenario 19 in
# tests/deployment-incident-behavior-regression.sh.
#
# All Docker, systemd, curl and PostgreSQL interaction is faked on PATH; the
# real scripts/lib/common.sh and scripts/reconcile-state.sh are exercised
# unmodified apart from two speed-only patches (bounded-wait timeouts shrunk,
# PC_RUNTIME_DIR pointed at the fixture) and one seam every other regression
# suite in this repo already uses for the same reason: overriding
# runner_binary_matches_live_process(), which otherwise requires a real
# /proc/<pid>/exe.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-reconcile-state-test.XXXXXXXX")"
trap 'find "$SCRATCH" -name runner.pid -type f -exec sh -c '\''kill "$(cat "$1")" 2>/dev/null || true'\'' _ {} \;; rm -rf -- "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

RID_POSTGRES="$(printf 'sha256:%064d' 1)"
RID_N8N="$(printf 'sha256:%064d' 2)"
RID_CONTROL_API="$(printf 'sha256:%064d' 3)"
RID_WEB="$(printf 'sha256:%064d' 4)"
RID_CADDY="$(printf 'sha256:%064d' 5)"
STALE_ID="sha256:$(printf '9%.0s' $(seq 1 64))"

write_deploy_config() {
  local dir="$1" reader="$2"
  mkdir -p "$dir/config" "$dir/compose" "$dir/runner/bin" "$dir/secrets" "$dir/migrations" "$dir/backups"
  cat >"$dir/config/versions.lock.env" <<'EOF'
PC_POSTGRES_IMAGE=postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PC_N8N_IMAGE=n8n@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PC_CADDY_IMAGE=caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
PC_CONTROL_API_IMAGE=project-control/control-api:test
PC_WEB_IMAGE=project-control/web:test
PC_CADDY_PROXY_IMAGE=project-control/caddy:test
PC_STACK_VERSION=test
EOF
  cp "$dir/config/versions.lock.env" "$dir/config/stack.env"
  printf '%s\n' "$reader" >"$dir/config/checkpoint-reader-max-version"
  printf 'dummy runner\n' >"$dir/runner/bin/project-control-runner"
  chmod +x "$dir/runner/bin/project-control-runner"
  printf 'x' >"$dir/secrets/pg_control_app_password"
  chmod 0600 "$dir/secrets/pg_control_app_password"
  cat >"$dir/compose/compose.yaml" <<'EOF'
services:
  postgres:
    image: x
  n8n:
    image: x
  control-api:
    image: x
  web:
    image: x
  caddy:
    image: x
EOF
  for n in 0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012; do
    : >"$dir/migrations/${n}_stub.sql"
  done
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

write_fake_bin() {
  local bin="$1"
  mkdir -p "$bin"

  cat >"${bin}/id" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -u ]] && { printf '0\n'; exit 0; }
exec /usr/bin/id "$@"
EOF

  cat >"${bin}/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

  cat >"${bin}/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "${@: -1}" == *pg_control_app_password ]]; then
  case "$2" in
    %s) printf '1\n' ;;
    %a) printf '600\n' ;;
    %u|%g) printf '0\n' ;;
  esac
  exit 0
fi
exec /usr/bin/stat "$@"
EOF

  cat >"${bin}/systemctl" <<'EOF'
#!/usr/bin/env bash
case "${1:-}" in
  is-active) printf 'active\n'; exit 0 ;;
esac
exit 0
EOF

  cat >"${bin}/curl" <<'EOF'
#!/usr/bin/env bash
url="${@: -1}"
case "$url" in
  */api/auth/me) printf '%s' "${FAKE_AUTH_CODE:-401}" ;;
  */development) printf '%s' "${FAKE_DEV_CODE:-404}" ;;
  *) printf '%s' "${FAKE_AUTH_CODE:-401}" ;;
esac
exit 0
EOF

  cat >"${bin}/docker" <<'EOF'
#!/usr/bin/env bash
running_id() {
  case "$1" in
    postgres)    printf 'sha256:%064d' 1 ;;
    n8n)         printf 'sha256:%064d' 2 ;;
    control-api) printf 'sha256:%064d' 3 ;;
    web)         printf 'sha256:%064d' 4 ;;
    caddy)       printf 'sha256:%064d' 5 ;;
  esac
}
STALE_ID="sha256:$(printf '9%.0s' $(seq 1 64))"
in_list() { local needle="$1" hay=" ${2:-} "; [[ "$hay" == *" ${needle} "* ]]; }

if [[ "${1:-}" == ps ]]; then
  for arg in "$@"; do
    case "$arg" in
      label=com.docker.compose.service=*)
        svc="${arg##*=}"
        in_list "$svc" "${FAKE_MISSING_SERVICE:-}" && exit 0
        printf 'cid-%s\n' "$svc"
        exit 0 ;;
    esac
  done
  exit 0
fi

if [[ "${1:-}" == inspect && "${2:-}" == --format ]]; then
  fmt="$3"; target="${4#cid-}"
  case "$fmt" in
    '{{.Image}}') running_id "$target"; printf '\n'; exit 0 ;;
    '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
      if in_list "$target" "${FAKE_UNHEALTHY_SERVICE:-}"; then printf 'unhealthy\n'; else printf 'healthy\n'; fi
      exit 0 ;;
    *) printf 'running\n'; exit 0 ;;
  esac
fi

if [[ "${1:-}" == image && "${2:-}" == inspect && "${3:-}" != --format ]]; then
  id="$3"
  [[ "$id" == "${FAKE_UNRECOVERABLE_ID:-__none__}" ]] && exit 1
  exit 0
fi

if [[ "${1:-}" == image && "${2:-}" == inspect && "${3:-}" == --format ]]; then
  ref="$5"
  if [[ -s "${FAKE_TAG_STORE:?}" ]] && grep -qF "${ref}=" "$FAKE_TAG_STORE"; then
    grep -F "${ref}=" "$FAKE_TAG_STORE" | tail -1 | cut -d= -f2-
    exit 0
  fi
  case "$ref" in
    postgres@*)
      if in_list postgres "${FAKE_PINNED_MISMATCH:-}"; then printf 'sha256:%064d\n' 8; else running_id postgres; printf '\n'; fi
      exit 0 ;;
    n8n@*)
      if in_list n8n "${FAKE_PINNED_MISMATCH:-}"; then printf 'sha256:%064d\n' 8; else running_id n8n; printf '\n'; fi
      exit 0 ;;
    project-control/control-api:*)
      if in_list control-api "${FAKE_MUTABLE_COHERENT:-}"; then running_id control-api; printf '\n'; else printf '%s\n' "$STALE_ID"; fi
      exit 0 ;;
    project-control/web:*)
      if in_list web "${FAKE_MUTABLE_COHERENT:-}"; then running_id web; printf '\n'; else printf '%s\n' "$STALE_ID"; fi
      exit 0 ;;
    project-control/caddy:*)
      if in_list caddy "${FAKE_MUTABLE_COHERENT:-}"; then running_id caddy; printf '\n'; else printf '%s\n' "$STALE_ID"; fi
      exit 0 ;;
    *) exit 1 ;;
  esac
fi

if [[ "${1:-}" == image && "${2:-}" == tag ]]; then
  printf '%s=%s\n' "$4" "$3" >>"${FAKE_TAG_STORE:?}"
  exit 0
fi

if [[ "${1:-}" == exec ]]; then
  joined=" $* "
  [[ "$joined" == *' node '* ]] && { printf '%s' "${FAKE_READY_CODE:-200}"; exit 0; }
  [[ "$joined" == *'schema_migrations'* ]] && { for v in ${FAKE_MIGRATIONS:-}; do printf '%s\n' "$v"; done; exit 0; }
  [[ "$joined" == *'snapshot_version'* ]] && { printf '%s\n' "${FAKE_CHECKPOINT_MAX:-1}"; exit 0; }
  exit 0
fi

exit 0
EOF
  chmod +x "${bin}"/*
}

# setup_fixture <name> <reader-file-content>
setup_fixture() {
  local name="$1" reader="${2:-3}"
  FIX="${SCRATCH}/${name}"; FSRC="${FIX}/source"; FDEPLOY="${FIX}/deploy"; FBIN="${FIX}/bin"
  mkdir -p "$FSRC/scripts/lib" "${FIX}/runtime"
  cp "${REPO_ROOT}/scripts/reconcile-state.sh" "$FSRC/scripts/reconcile-state.sh"
  cp "${REPO_ROOT}/scripts/lib/common.sh" "$FSRC/scripts/lib/common.sh"
  cp "${REPO_ROOT}/scripts/telegram-notify.sh" "$FSRC/scripts/telegram-notify.sh" 2>/dev/null \
    || printf '#!/usr/bin/env bash\nexit 0\n' >"$FSRC/scripts/telegram-notify.sh"
  chmod +x "$FSRC/scripts/telegram-notify.sh"

  sed -i "s|^PC_RUNTIME_DIR=.*|PC_RUNTIME_DIR=\"${FIX}/runtime\"|" "$FSRC/scripts/lib/common.sh"
  printf '\nrunner_binary_matches_live_process() { [[ "${FAKE_RUNNER_BINARY_MATCH:-1}" == 1 ]]; }\n' \
    >>"$FSRC/scripts/lib/common.sh"
  # Speed-only: shrink the two bounded waits so a "never becomes ready" case
  # fails in ~2s instead of the real 15s production timeout.
  sed -i "s/wait_for_runner_ready 15 0.5/wait_for_runner_ready 2 0.2/" "$FSRC/scripts/reconcile-state.sh"
  sed -i 's|wait_for_api_route "\${PORTAL}/api/auth/me" 401 15 2|wait_for_api_route "${PORTAL}/api/auth/me" 401 3 0.2|' \
    "$FSRC/scripts/reconcile-state.sh"

  write_deploy_config "$FDEPLOY" "$reader"
  write_fake_bin "$FBIN"
  write_runner_server "${FIX}/runner-server.py"
}

start_runner() {
  rm -f "${FIX}/runtime/runner.sock"
  "${FIX}/runner-server.py" "${FIX}/runtime/runner.sock" 0 "${FIX}/runner.pid" >/dev/null 2>&1 &
  for _ in $(seq 1 100); do [[ -S "${FIX}/runtime/runner.sock" ]] && return; sleep 0.01; done
  fail 'fixture runner did not start'
}

run_reconcile() {
  : >"${FIX}/tag-store"
  if (
    export PATH="${FBIN}:${PATH}"
    export PC_ROOT="$FDEPLOY"
    export PC_ASSUME_YES=1
    export FAKE_TAG_STORE="${FIX}/tag-store"
    export FAKE_MISSING_SERVICE FAKE_UNHEALTHY_SERVICE FAKE_UNRECOVERABLE_ID
    export FAKE_READY_CODE FAKE_AUTH_CODE FAKE_DEV_CODE
    export FAKE_MIGRATIONS FAKE_CHECKPOINT_MAX
    export FAKE_PINNED_MISMATCH FAKE_MUTABLE_COHERENT FAKE_RUNNER_BINARY_MATCH
    bash "${FSRC}/scripts/reconcile-state.sh" "$@" >"${FIX}/stdout" 2>"${FIX}/stderr"
  ); then RC_EXIT=0; else RC_EXIT=$?; fi
}

lock_hash() { sha256sum "${FDEPLOY}/config/versions.lock.env" "${FDEPLOY}/config/stack.env" 2>/dev/null; }

reset_scenario_env() {
  unset FAKE_MISSING_SERVICE FAKE_UNHEALTHY_SERVICE FAKE_UNRECOVERABLE_ID \
        FAKE_READY_CODE FAKE_AUTH_CODE FAKE_DEV_CODE FAKE_MIGRATIONS FAKE_CHECKPOINT_MAX \
        FAKE_PINNED_MISMATCH FAKE_MUTABLE_COHERENT FAKE_RUNNER_BINARY_MATCH 2>/dev/null || true
  FAKE_MIGRATIONS="0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012"
  FAKE_CHECKPOINT_MAX=1
}

# =============================================================================
# Scenario 1 / 2 / 3 / 4 / 11 — healthy stack, stale mutable lock, exact
# running image objects available: reconciliation succeeds, uses the actual
# running IDs (not the stale mutable tags), passes the same coherence gate
# `update` uses, and preserves the previous inconsistent metadata first.
# =============================================================================
setup_fixture success 3
start_runner
reset_scenario_env
before_hash="$(lock_hash)"
run_reconcile
[[ "$RC_EXIT" == 0 ]] || { cat "${FIX}/stderr" >&2; fail '#1 reconciliation of a healthy-but-stale stack did not succeed'; }
grep -q 'reconciliation complete' "${FIX}/stderr" || fail '#1 missing completion message'
pass '#1 healthy running stack + stale lock + recoverable images -> reconciliation succeeds'

after_hash="$(lock_hash)"
[[ "$before_hash" != "$after_hash" ]] || fail '#1 metadata was not actually rewritten'

# shellcheck disable=SC1090
( set -a; source "${FDEPLOY}/config/stack.env"; set +a
  [[ "$PC_CONTROL_API_IMAGE" != project-control/control-api:test ]] || fail '#2 control-api still references the stale mutable tag'
  [[ "$PC_CONTROL_API_IMAGE" == *pcctl-reconciled-* ]] || fail '#2 control-api was not repointed at a deterministic preservation tag'
  [[ "$PC_WEB_IMAGE" == *pcctl-reconciled-* ]] || fail '#2 web was not repointed at a preservation tag'
  [[ "$PC_CADDY_PROXY_IMAGE" == *pcctl-reconciled-* ]] || fail '#2 caddy was not repointed at a preservation tag'
  [[ "$PC_POSTGRES_IMAGE" == 'postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ]] \
    || fail '#2 already-coherent pinned postgres reference was needlessly rewritten'
)
pass '#2 resulting lock uses the actual running image IDs via a deterministic preservation tag, not the stale mutable tags'

( set -a; source "${FDEPLOY}/config/stack.env"; set +a
  resolved_capi="$(PATH="${FBIN}:${PATH}" FAKE_TAG_STORE="${FIX}/tag-store" docker image inspect --format '{{.Id}}' "$PC_CONTROL_API_IMAGE")"
  [[ "$resolved_capi" == "$RID_CONTROL_API" ]] || fail '#2 preserved control-api tag does not resolve to the exact running ID'
)
pass '#2b preservation tag resolves back to the exact running image ID'

(
  export PATH="${FBIN}:${PATH}" PC_ROOT="$FDEPLOY" FAKE_TAG_STORE="${FIX}/tag-store"
  # shellcheck disable=SC1090
  source "${FSRC}/scripts/lib/common.sh"
  deployment_images_match_lock "${FDEPLOY}/config/versions.lock.env" "${FDEPLOY}/config/stack.env"
) || fail '#3 repaired metadata does not pass the real deployment_images_match_lock coherence gate used by update.sh'
pass '#3 repaired metadata passes the same coherence gate update.sh uses'

(
  export PATH="${FBIN}:${PATH}" FAKE_TAG_STORE="${FIX}/tag-store"
  captured_capi="$(docker inspect --format '{{.Image}}' cid-control-api)"
  captured_web="$(docker inspect --format '{{.Image}}' cid-web)"
  [[ "$captured_capi" == "$RID_CONTROL_API" ]] || fail '#4 a post-reconciliation running-image capture would not record the exact control-api ID'
  [[ "$captured_web" == "$RID_WEB" ]] || fail '#4 a post-reconciliation running-image capture would not record the exact web ID'
)
pass '#4 a rollback point built right after reconciliation (via the same docker inspect update.sh uses) would capture the exact running IDs'

BACKUP_ROOT="${FDEPLOY}/backups/reconcile"
[[ -d "$BACKUP_ROOT" ]] || fail '#11 no backup directory was created'
backup_dir="$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | head -1)"
[[ -n "$backup_dir" ]] || fail '#11 backup directory is empty'
grep -q 'project-control/control-api:test' "${backup_dir}/versions.lock.env" \
  || fail '#11 previous inconsistent metadata was not preserved verbatim before replacement'
pass '#11 previous inconsistent metadata is preserved under backups/reconcile/ before atomic replacement'

grep -q 'checkpoint reader capability metadata corrected: 3 -> 2' "${FIX}/stderr" \
  || fail '#1b observed pre-Stage-7 capability (404) did not correct the stale v3 reader metadata to v2'
pass '#1b checkpoint-reader-max-version corrected from the stale v3 to the observed v2 (404 == route absent)'

# =============================================================================
# Scenario 5 — stale lock + one running image object unavailable: fails
# without mutation.
# =============================================================================
setup_fixture unrecoverable 3
start_runner
reset_scenario_env
FAKE_UNRECOVERABLE_ID="$RID_WEB"
before_hash="$(lock_hash)"
run_reconcile
[[ "$RC_EXIT" != 0 ]] || fail '#5 reconciliation succeeded despite an unrecoverable running image object'
grep -q 'REC-004' "${FIX}/stderr" || fail '#5 expected a REC-004 failure for the unrecoverable image'
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#5 metadata was mutated despite failure'
[[ ! -d "${FDEPLOY}/backups/reconcile" ]] || fail '#5 a backup directory was created despite failure'
pass '#5 one unrecoverable running image object -> reconciliation fails with no mutation'

# =============================================================================
# Scenario 6 — an unhealthy container fails closed.
# =============================================================================
setup_fixture unhealthy 3
start_runner
reset_scenario_env
FAKE_UNHEALTHY_SERVICE="web"
before_hash="$(lock_hash)"
run_reconcile
[[ "$RC_EXIT" != 0 ]] || fail '#6 reconciliation succeeded despite an unhealthy container'
grep -q 'REC-002' "${FIX}/stderr" || fail '#6 expected a REC-002 health failure'
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#6 metadata was mutated despite an unhealthy container'
pass '#6 unhealthy container -> reconciliation fails closed with no mutation'

# =============================================================================
# Scenario 7 — the runner never becomes ready: fails closed within the
# bounded timeout, not hanging and not silently succeeding.
# =============================================================================
setup_fixture runner-not-ready 3
# Deliberately do not start the runner fixture: the socket never appears.
reset_scenario_env
before_hash="$(lock_hash)"
start="$(date +%s)"
run_reconcile
elapsed=$(( $(date +%s) - start ))
[[ "$RC_EXIT" != 0 ]] || fail '#7 reconciliation succeeded despite the runner never becoming ready'
grep -q 'REC-007' "${FIX}/stderr" || fail '#7 expected a REC-007 runner-readiness failure'
(( elapsed <= 10 )) || fail "#7 reconciliation took ${elapsed}s waiting on the runner — the bounded timeout was not honoured"
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#7 metadata was mutated despite the runner not being ready'
pass "#7 runner not ready -> reconciliation fails closed within its bounded timeout (${elapsed}s), no mutation"

# =============================================================================
# Scenario 8 — the database's applied migration ledger is ahead of what is
# deployed on disk: DB migration/capability incompatibility fails closed.
# =============================================================================
setup_fixture migration-ahead 3
start_runner
reset_scenario_env
FAKE_MIGRATIONS="0001 0002 0003 0004 0005 0006 0007 0008 0009 0010 0011 0012 0099"
before_hash="$(lock_hash)"
run_reconcile
[[ "$RC_EXIT" != 0 ]] || fail '#8 reconciliation succeeded despite an undeployed applied migration'
grep -q 'REC-010' "${FIX}/stderr" || fail '#8 expected a REC-010 migration-ledger failure'
grep -q '0099' "${FIX}/stderr" || fail '#8 the offending migration version was not reported'
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#8 metadata was mutated despite the migration-ledger incompatibility'
pass '#8 database ahead of deployed migrations -> reconciliation fails closed with no mutation'

# =============================================================================
# Scenario 9 — checkpoint reader incompatibility: stored checkpoints exceed
# what the observed running capability can read.
# =============================================================================
setup_fixture checkpoint-incompatible 3
start_runner
reset_scenario_env
FAKE_CHECKPOINT_MAX=3
FAKE_DEV_CODE=404   # observed capability v2 (pre-Stage-7)
before_hash="$(lock_hash)"
run_reconcile
[[ "$RC_EXIT" != 0 ]] || fail '#9 reconciliation succeeded despite a checkpoint reader incompatibility'
grep -q 'REC-011' "${FIX}/stderr" || fail '#9 expected a REC-011 checkpoint-compatibility failure'
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#9 metadata was mutated despite the checkpoint incompatibility'
pass '#9 stored checkpoint v3 vs observed capability v2 -> reconciliation fails closed with no mutation'

# =============================================================================
# Scenario 10 — an ambiguous/partial application capability probe result
# fails closed rather than being guessed at.
# =============================================================================
setup_fixture ambiguous-capability 3
start_runner
reset_scenario_env
FAKE_DEV_CODE=500
before_hash="$(lock_hash)"
run_reconcile
[[ "$RC_EXIT" != 0 ]] || fail '#10 reconciliation succeeded despite an ambiguous capability probe'
grep -q 'REC-009' "${FIX}/stderr" || fail '#10 expected a REC-009 capability-ambiguity failure'
grep -q 'refusing to guess' "${FIX}/stderr" || fail '#10 expected an explicit refusal-to-guess message'
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#10 metadata was mutated despite an ambiguous capability probe'
pass '#10 ambiguous/partial application capability -> reconciliation fails closed, does not guess, no mutation'

# =============================================================================
# Scenario 12 — the command cannot deploy, rebuild or restart anything: a
# static guarantee about the shipped script, not just this test run's mocks.
# =============================================================================
if grep -qE 'compose (up|run)|systemctl restart|docker (image )?build' "${REPO_ROOT}/scripts/reconcile-state.sh"; then
  fail '#12 reconcile-state.sh contains a deploy/build/restart call'
fi
pass '#12 reconcile-state.sh contains no compose up/run, systemctl restart or docker build call'

# =============================================================================
# Scenario 13 — --force is not a recognised flag and cannot bypass anything.
# =============================================================================
setup_fixture force-rejected 3
start_runner
reset_scenario_env
FAKE_UNHEALTHY_SERVICE="web"   # would fail regardless; --force must not even reach the checks
before_hash="$(lock_hash)"
run_reconcile --force
[[ "$RC_EXIT" != 0 ]] || fail '#13 --force was accepted'
grep -q 'unknown argument: --force' "${FIX}/stderr" || fail '#13 --force was not rejected as an unknown argument'
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#13 metadata was mutated despite --force being rejected'
pass '#13 --force is rejected outright and cannot bypass reconciliation safety'

# =============================================================================
# Scenario 14 — an already-coherent host is a no-op, not a re-write.
# =============================================================================
setup_fixture already-coherent 2
start_runner
reset_scenario_env
FAKE_MUTABLE_COHERENT="control-api web caddy"
FAKE_DEV_CODE=404   # observed v2, matches the fixture's checkpoint-reader-max-version=2
before_hash="$(lock_hash)"
run_reconcile
[[ "$RC_EXIT" == 0 ]] || { cat "${FIX}/stderr" >&2; fail '#14 already-coherent host was rejected'; }
grep -q 'already coherent' "${FIX}/stderr" || fail '#14 expected an explicit already-coherent report'
[[ "$before_hash" == "$(lock_hash)" ]] || fail '#14 an already-coherent host had its metadata rewritten'
[[ ! -d "${FDEPLOY}/backups/reconcile" ]] || fail '#14 a backup directory was created for a no-op'
pass '#14 normal coherent host is an explicit no-op: unchanged metadata, no backup directory, exit 0'

printf 'PASS: reconcile-state regression suite (14 scenario groups; #15 covered by running the full tests/ suite separately)\n'
