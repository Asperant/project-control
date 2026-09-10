#!/usr/bin/env bash
# =============================================================================
# resume-update-regression.sh
#
# scripts/resume-update.sh exists for the incident recover-deployment.sh
# deliberately refuses: postgres/n8n healthy, one or more locally-built
# services (control-api, web, caddy) stuck in Docker's `created` state, AND
# the pending migration(s) that triggered the recreation were never actually
# committed (proven live: RCV-006 PASS + RCV-007 FAIL means the applied
# ledger is a clean subset with something still pending). This drives the
# real, unmodified script against a fake Docker (matching the convention in
# tests/recover-deployment-regression.sh) and asserts exactly what it is and
# is not allowed to do — in particular that it takes update.sh's own
# safeguards (fresh backup, irreversible-migration scan) seriously, since —
# unlike recover-deployment.sh — this script's whole point is to let a real
# migration finally commit.
#
# `docker compose ... config` is delegated to REAL docker (never faked),
# exactly as in the recover-deployment suite.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-resume-update-test.XXXXXXXX")"
trap 'rm -rf -- "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not available/usable — cannot run this test"
  exit 0
fi
REAL_DOCKER="$(command -v docker)"

write_stack_env() {
  cat >"$1" <<'EOF'
PC_POSTGRES_IMAGE=postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PC_N8N_IMAGE=n8n@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PC_CADDY_IMAGE=caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
PC_CADDY_PROXY_IMAGE=project-control/caddy:test
PC_CONTROL_API_IMAGE=project-control/control-api:test
PC_WEB_IMAGE=project-control/web:test
PC_STACK_VERSION=test
PC_APP_UID=10001
PC_APP_GID=10001
PC_CONTROL_GID=10002
EOF
}

# Builds a fixture. Args (env-set by caller before calling):
#   FIX_CREATED     space-separated services currently stuck in `created`
#   FIX_HEALTHY     space-separated services already healthy
#   FIX_NO_PENDING  1 = repository has NOTHING pending (wrong tool)
#   FIX_IRREVERSIBLE 1 = the one pending migration contains a DROP TABLE
setup_fixture() {
  local name="$1"
  local F="${SCRATCH}/${name}" SRC DEPLOY BIN
  SRC="${F}/source"; DEPLOY="${F}/deploy"; BIN="${F}/bin"
  mkdir -p \
    "$SRC/scripts/lib" "$SRC/infra/compose" "$SRC/infra/n8n/workflows" "$SRC/migrations" \
    "$DEPLOY/compose" "$DEPLOY/config/status/automation/workflows" "$DEPLOY/secrets" "$BIN"

  cp "${REPO_ROOT}/scripts/resume-update.sh" "$SRC/scripts/resume-update.sh"
  sed -i 's/seq 1 12/seq 1 2/; s/sleep 10/sleep 1/' "$SRC/scripts/resume-update.sh"
  cp "${REPO_ROOT}/scripts/lib/common.sh" "$SRC/scripts/lib/common.sh"
  cp "${REPO_ROOT}/scripts/lib/assert-config-mount.py" "$SRC/scripts/lib/assert-config-mount.py"
  printf '\nrunner_binary_matches_live_process() { return 0; }\n' >>"$SRC/scripts/lib/common.sh"
  printf '\nwait_for_runner_ready() { return 0; }\n' >>"$SRC/scripts/lib/common.sh"

  cat >"$SRC/infra/compose/compose.yaml" <<'EOF'
name: pc-resume-update-test
services:
  control-api:
    image: alpine:3
    volumes:
      - type: bind
        source: ${PC_ROOT}/config/status
        target: /config
        read_only: true
EOF
  write_stack_env "$SRC/infra/versions.lock.env"
  printf '{"version":1,"workflows":[]}' >"$SRC/infra/n8n/workflows/manifest.json"

  # Applied ledger: 0001..0018 always. Pending: 0019 unless FIX_NO_PENDING.
  for v in 0001 0015 0016 0017 0018; do
    printf -- '-- %s\n' "$v" >"$SRC/migrations/${v}_applied.sql"
  done
  if [[ -z "${FIX_NO_PENDING:-}" ]]; then
    if [[ -n "${FIX_IRREVERSIBLE:-}" ]]; then
      printf 'DROP TABLE something;\n' >"$SRC/migrations/0019_pending.sql"
    else
      printf 'CREATE TABLE something (id int);\n' >"$SRC/migrations/0019_pending.sql"
    fi
  fi

  for script in build verify verify-security telegram-notify; do
    var_name="FAKE_$(printf '%s' "$script" | tr '[:lower:]-' '[:upper:]_')_RC"
    cat >"$SRC/scripts/${script}.sh" <<EOF
#!/usr/bin/env bash
printf '${script} %s\n' "\$*" >>"${F}/${script}.calls"
exit \${${var_name}:-0}
EOF
    chmod +x "$SRC/scripts/${script}.sh"
  done
  # backup.sh: distinct from the other fakes above — this run must take a
  # FRESH backup (not merely check a prior one), and rc=2 means "unconfigured".
  cat >"$SRC/scripts/backup.sh" <<EOF
#!/usr/bin/env bash
printf 'backup %s\n' "\$*" >>"${F}/backup.calls"
exit \${FAKE_BACKUP_RC:-0}
EOF
  chmod +x "$SRC/scripts/backup.sh"
  cat >"$SRC/scripts/reconcile-state.sh" <<EOF
#!/usr/bin/env bash
printf 'reconcile-state\n' >>"${F}/reconcile-state.calls"
exit \${FAKE_RECONCILE_RC:-0}
EOF
  chmod +x "$SRC/scripts/reconcile-state.sh"

  write_stack_env "$DEPLOY/config/stack.env"
  write_stack_env "$DEPLOY/config/versions.lock.env"
  cp "$SRC/infra/compose/compose.yaml" "$DEPLOY/compose/compose.yaml"
  printf 'x' >"$DEPLOY/secrets/pg_control_app_password"; chmod 0600 "$DEPLOY/secrets/pg_control_app_password"

  cat >"$BIN/id" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -u ]] && { printf '0\n'; exit 0; }
exec /usr/bin/id "$@"
EOF
  cat >"$BIN/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$BIN/chown"
  cat >"$BIN/telegram-notify.sh" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  chmod +x "$BIN/telegram-notify.sh"

  cat >"$BIN/docker" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${F}/docker.calls"

if [[ "\${1:-}" == compose ]]; then
  for arg in "\$@"; do
    if [[ "\$arg" == config ]]; then
      exec "$REAL_DOCKER" "\$@"
    fi
  done
  if [[ "\${*}" == *"dist/cli/migrate.js --dry-run"* ]]; then
    printf 'migrate %s\n' "\$*" >>"${F}/migrate.calls"
    exit \${FAKE_DRYRUN_RC:-0}
  fi
  if [[ "\${*}" == *" up "* ]]; then
    printf 'compose-up %s\n' "\$*" >>"${F}/compose-up.calls"
    exit \${FAKE_COMPOSEUP_RC:-0}
  fi
  exit 0
fi

health_for() {
  local svc="\$1"
  for h in \$FAKE_HEALTHY; do [[ "\$h" == "\$svc" ]] && { echo healthy; return; }; done
  if [[ -e "${F}/compose-up.calls" ]]; then
    for h in \$FAKE_POST_RECOVERY_HEALTHY; do [[ "\$h" == "\$svc" ]] && { echo healthy; return; }; done
  fi
  for c in \$FAKE_CREATED; do [[ "\$c" == "\$svc" ]] && { echo created; return; }; done
  echo absent
}
image_for() {
  local svc="\$1"
  for s in \$FAKE_STALE_IMAGE; do [[ "\$s" == "\$svc" ]] && { printf 'sha256:%064d\n' 99; return; }; done
  printf 'sha256:%064d\n' 1
}

if [[ "\${1:-}" == ps ]]; then
  for arg in "\$@"; do
    if [[ "\$arg" == label=com.docker.compose.service=* ]]; then
      printf 'cid-%s\n' "\${arg##*=}"; exit 0
    fi
  done
fi
if [[ "\${1:-}" == image && "\${2:-}" == inspect && "\${3:-}" == --format && "\${4:-}" == '{{.Id}}' ]]; then
  printf 'sha256:%064d\n' 1
  exit 0
fi
if [[ "\${1:-}" == inspect && "\${2:-}" == --format ]]; then
  svc="\${4#cid-}"
  case "\$3" in
    *'.State.Health'*) health_for "\$svc"; exit 0 ;;
    '{{.Image}}') image_for "\$svc"; exit 0 ;;
    '{{.State.Status}}')
      if [[ -e "${F}/compose-up.calls" ]]; then
        for h in \$FAKE_POST_RECOVERY_HEALTHY; do [[ "\$h" == "\$svc" ]] && { echo running; exit 0; }; done
      fi
      st="\$(health_for "\$svc")"
      [[ "\$st" == "healthy" ]] && st="running"
      echo "\$st"; exit 0 ;;
    *) echo healthy; exit 0 ;;
  esac
fi
if [[ "\${1:-}" == exec ]]; then
  if [[ "\${*}" == *'schema_migrations'* ]]; then
    printf '0001\n0015\n0016\n0017\n0018\n'; exit 0
  fi
  exit 0
fi
exit 0
EOF
  chmod +x "$BIN"/*

  cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '401'
EOF
  chmod +x "$BIN/curl"

  cat >"$BIN/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "${*: -1}" == *pg_control_app_password ]]; then
  case "$2" in %s) printf '1\n' ;; %a) printf '600\n' ;; %u|%g) printf '0\n' ;; esac
  exit 0
fi
exec /usr/bin/stat "$@"
EOF
  chmod +x "$BIN/stat"

  echo "$SRC:$DEPLOY:$BIN:$F"
}

run_resume() {
  local src="$1" deploy="$2" bin="$3"
  ( export PATH="${bin}:${PATH}" PC_ROOT="$deploy"
    export FAKE_HEALTHY="${FIX_HEALTHY:-postgres n8n web}" FAKE_CREATED="${FIX_CREATED-control-api caddy}"
    export FAKE_POST_RECOVERY_HEALTHY="${FIX_POST_RECOVERY_HEALTHY:-}" FAKE_STALE_IMAGE="${FIX_STALE_IMAGE:-}"
    export FAKE_DRYRUN_RC="${FIX_DRYRUN_RC:-0}" FAKE_COMPOSEUP_RC="${FIX_COMPOSEUP_RC:-0}"
    export FAKE_VERIFY_RC="${FIX_VERIFY_RC:-0}" FAKE_VERIFY_SECURITY_RC="${FIX_VERIFY_SECURITY_RC:-0}"
    export FAKE_RECONCILE_RC="${FIX_RECONCILE_RC:-0}" FAKE_BACKUP_RC="${FIX_BACKUP_RC:-0}"
    timeout 20 bash "$src/scripts/resume-update.sh" >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr"
  ) && echo 0 || echo $?
}

# -----------------------------------------------------------------------------
# 1: the clean path — pending migration genuinely present, everything else
#    healthy — resume-update succeeds, takes a fresh backup, dry-runs before
#    recreating, recreates exactly the target services, and hands off to
#    reconcile-state only after verify/verify-security both pass.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture clean)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_POST_RECOVERY_HEALTHY="control-api caddy" run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" == "0" ]] || { cat "${SCRATCH}/stderr" >&2; fail "1: resume-update did not succeed on the clean pending-migration path"; }
grep -q 'RSU-007' "${SCRATCH}/stderr" || fail "1: RSU-007 (pending confirmed) was not reported"
[[ -e "${F}/backup.calls" ]] || fail "1: resume-update did not take a fresh backup"
grep -q -- '--dry-run' "${F}/migrate.calls" || fail "1: migration dry-run was not invoked"
grep -vq -- '--dry-run' "${F}/migrate.calls" 2>/dev/null && fail "1: a non-dry-run migrate invocation was made — this tool must never apply SQL itself"
grep -qE 'compose-up .* control-api caddy' "${F}/compose-up.calls" || fail "1: compose up was not called with exactly the target services"
grep -qE ' postgres| n8n' "${F}/compose-up.calls" && fail "1: compose up named a service outside the created target set"
[[ -e "${F}/reconcile-state.calls" ]] || fail "1: reconcile-state was never invoked on a fully successful run"
verify_line="$(grep -n 'verify.sh passed' "${SCRATCH}/stderr" | head -1 | cut -d: -f1)"
verify_sec_line="$(grep -n 'verify-security.sh passed' "${SCRATCH}/stderr" | head -1 | cut -d: -f1)"
reconcile_line="$(grep -n 'Handing off to reconcile-state' "${SCRATCH}/stderr" | head -1 | cut -d: -f1)"
[[ -n "$verify_line" && -n "$verify_sec_line" && -n "$reconcile_line" ]] || fail "1: expected log lines missing to check ordering"
(( verify_line < reconcile_line && verify_sec_line < reconcile_line )) || fail "1: reconcile-state ran before verify/verify-security both passed"
pass "1: resume-update takes a fresh backup, dry-runs, recreates exactly control-api+caddy, never touches postgres/n8n, and reconciles only after verify+verify-security pass"

# -----------------------------------------------------------------------------
# healthy-but-stale-image: compose recreates services one at a time — an
# interrupted update can leave control-api already recreated and healthy
# while web never got its turn and is still on the OLD image.
# container_health() alone cannot see this.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture stale)
  rc="$(FIX_HEALTHY="postgres n8n web control-api" FIX_CREATED="caddy" FIX_STALE_IMAGE="web" FIX_POST_RECOVERY_HEALTHY="caddy web" run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" == "0" ]] || { cat "${SCRATCH}/stderr" >&2; fail "stale: resume-update did not succeed with a healthy-but-stale-image web alongside created caddy"; }
grep -q 'resuming caddy web\|resuming web caddy' "${SCRATCH}/stderr" || fail "stale: resume-update did not identify both caddy and web as its scope"
grep -q 'control-api is already healthy and running the current build' "${SCRATCH}/stderr" || fail "stale: control-api was not confirmed already-current and left out of scope"
grep -q 'web is healthy but not running the currently deployed build' "${SCRATCH}/stderr" || fail "stale: web's healthy-but-stale reason was not reported"
grep -qE ' control-api| postgres| n8n' "${F}/compose-up.calls" && fail "stale: compose up named a service outside caddy+web"
pass "stale: resume-update detects a healthy web running the OLD image (via image identity, not container_health) and recreates it alongside created caddy, leaving already-current control-api untouched"

# -----------------------------------------------------------------------------
# 2: nothing pending — this is recover-deployment's incident, not this tool's.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(FIX_NO_PENDING=1 setup_fixture nopending)
lock_before="$(sha256sum "$DEPLOY/config/versions.lock.env")"
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "2: resume-update proceeded despite nothing being pending"
grep -q 'RSU-007' "${SCRATCH}/stderr" || fail "2: RSU-007 refusal was not reported"
grep -qi 'recover-deployment' "${SCRATCH}/stderr" || fail "2: resume-update did not point the operator at recover-deployment instead"
[[ ! -e "${F}/backup.calls" ]] || fail "2: resume-update took a backup despite refusing before that point"
[[ ! -e "${F}/compose-up.calls" ]] || fail "2: resume-update attempted to recreate containers despite nothing pending"
[[ "$lock_before" == "$(sha256sum "$DEPLOY/config/versions.lock.env")" ]] || fail "2: versions.lock.env was rewritten despite refusing"
pass "2: nothing pending — resume-update refuses (RSU-007) and points at recover-deployment instead; no lock rewrite, no backup, no recreation"

# -----------------------------------------------------------------------------
# 3: an irreversible pending migration — hard refusal, no override exists.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(FIX_IRREVERSIBLE=1 setup_fixture irreversible)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "3: resume-update proceeded despite an irreversible pending migration"
grep -q 'RSU-008' "${SCRATCH}/stderr" || fail "3: RSU-008 irreversible-migration refusal was not reported"
[[ ! -e "${F}/backup.calls" ]] || fail "3: resume-update took a backup despite refusing before that point"
[[ ! -e "${F}/compose-up.calls" ]] || fail "3: resume-update attempted to recreate containers despite an irreversible pending migration"
pass "3: an irreversible pending migration is refused outright (RSU-008) — no --force escape exists for this tool"

( export PATH="${BIN}:${PATH}" PC_ROOT="$DEPLOY"
  export FAKE_HEALTHY="postgres n8n web" FAKE_CREATED="control-api caddy"
  timeout 20 bash "$SRC/scripts/resume-update.sh" --force >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr"
) && force_rc=0 || force_rc=$?
[[ "$force_rc" != "0" ]] || fail "3b: --force was accepted"
grep -q 'accepts no override flag' "${SCRATCH}/stderr" || fail "3b: resume-update did not report its no-override-flags stance"
pass "3b: --force is rejected outright as an unknown argument, before any precondition check runs"

# -----------------------------------------------------------------------------
# 4: backup fails — refuse, no partial progress.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture backupfail)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_BACKUP_RC=1 run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "4: resume-update succeeded despite the fresh backup failing"
grep -q 'RSU-010' "${SCRATCH}/stderr" || fail "4: RSU-010 backup-failure refusal was not reported"
[[ ! -e "${F}/compose-up.calls" ]] || fail "4: resume-update attempted to recreate containers despite the backup failing"
pass "4: a failed fresh backup refuses (RSU-010) before anything is touched"

# -----------------------------------------------------------------------------
# 5: backup unconfigured (rc=2) — refuse, no override.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture backupunconfigured)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_BACKUP_RC=2 run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "5: resume-update succeeded despite backup being unconfigured"
grep -q 'RSU-010' "${SCRATCH}/stderr" || fail "5: RSU-010 refusal for unconfigured backup was not reported"
pass "5: an unconfigured backup (rc=2) refuses (RSU-010) exactly like a failed one — no --skip-backup escape exists for this tool"

# -----------------------------------------------------------------------------
# 6: unhealthy postgres — refuse outright, different incident.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture statefuldown)
  rc="$(FIX_HEALTHY="n8n web" FIX_CREATED="control-api caddy" run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "6: resume-update proceeded despite postgres being unhealthy"
grep -q 'RSU-001' "${SCRATCH}/stderr" || fail "6: RSU-001 postgres-unhealthy refusal was not reported"
[[ ! -e "${F}/backup.calls" ]] || fail "6: resume-update took a backup despite postgres being unhealthy"
pass "6: unhealthy postgres refuses outright (RSU-001), never touches anything"

# -----------------------------------------------------------------------------
# 7: an unrecognised unhealthy state (not created) — refuse, not this tool's job.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture exited)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="" run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "7: resume-update succeeded with control-api/caddy absent (not created, not healthy)"
grep -q 'RSU-000' "${SCRATCH}/stderr" || fail "7: resume-update did not abort via RSU-000"
pass "7: control-api/caddy absent (an unrecognised failure mode, not 'created'): resume-update refuses rather than guessing"

# -----------------------------------------------------------------------------
# 8: a stuck health gate after recreation must not claim success.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture stuckhealth)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_POST_RECOVERY_HEALTHY="" run_resume "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "8: resume-update reported success despite the recreated containers never becoming healthy"
grep -qi 'health gate FAILED' "${SCRATCH}/stderr" || fail "8: resume-update did not report the health gate failure"
[[ ! -e "${F}/reconcile-state.calls" ]] || fail "8: reconcile-state ran even though the health gate never passed"
pass "8: a stuck health gate after recreation fails the whole run — metadata is never reconciled, migration commit status must be checked manually"

printf 'PASS: resume-update.sh completes an interrupted update exactly for the incident recover-deployment.sh correctly refuses, with update.sh'"'"'s own migration safeguards (fresh backup, irreversible-migration scan) intact and no override flag\n'
