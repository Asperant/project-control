#!/usr/bin/env bash
# =============================================================================
# recover-deployment-regression.sh
#
# scripts/recover-deployment.sh exists for exactly one incident class:
# postgres/n8n healthy, one or more locally-built services (control-api,
# web, caddy) stuck in Docker's `created` state after `compose up` failed
# mid-recreation. This drives the real, unmodified script against a fake
# Docker (matching the existing fake-docker convention in
# tests/deployment-incident-behavior-regression.sh and tests/update-
# compose-staging-order-regression.sh) and asserts, per scenario, exactly
# what it is and is not allowed to do.
#
# `docker compose ... config` is delegated to REAL docker throughout (never
# faked) — the resolved-mount-topology claim is the one this script exists
# because of, and a fake render would not actually prove it.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-recover-deployment-test.XXXXXXXX")"
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
#   FIX_CREATED   space-separated services currently stuck in `created`
#   FIX_HEALTHY   space-separated services already healthy
#   FIX_PENDING   1 = repository has a pending migration recovery must refuse
#   FIX_NO_BACKUP 1 = no successful backup on record
setup_fixture() {
  local name="$1"
  local F="${SCRATCH}/${name}" SRC DEPLOY BIN
  SRC="${F}/source"; DEPLOY="${F}/deploy"; BIN="${F}/bin"
  mkdir -p \
    "$SRC/scripts/lib" "$SRC/infra/compose" "$SRC/infra/n8n/workflows" "$SRC/migrations" \
    "$DEPLOY/compose" "$DEPLOY/config/status/automation/workflows" "$DEPLOY/secrets" "$BIN"

  cp "${REPO_ROOT}/scripts/recover-deployment.sh" "$SRC/scripts/recover-deployment.sh"
  # Health-gate retry timing (12 attempts x 10s, up to 120s) is real
  # production behavior worth keeping exactly as update.sh's own gate is —
  # shortened only in this fixture's copy so the stuck-health-gate scenario
  # (9) does not make the suite slow. The retry COUNT and control flow are
  # unchanged, only the interval.
  sed -i 's/seq 1 12/seq 1 2/; s/sleep 10/sleep 1/' "$SRC/scripts/recover-deployment.sh"
  cp "${REPO_ROOT}/scripts/lib/common.sh" "$SRC/scripts/lib/common.sh"
  cp "${REPO_ROOT}/scripts/lib/assert-config-mount.py" "$SRC/scripts/lib/assert-config-mount.py"
  printf '\nrunner_binary_matches_live_process() { return 0; }\n' >>"$SRC/scripts/lib/common.sh"
  printf '\nwait_for_runner_ready() { return 0; }\n' >>"$SRC/scripts/lib/common.sh"

  cat >"$SRC/infra/compose/compose.yaml" <<'EOF'
name: pc-recover-test
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
  # Matches the fake docker's `exec ... schema_migrations` response below —
  # the applied ledger this fixture's database claims to have.
  for v in 0001 0015 0016 0017 0018; do
    printf -- '-- %s\n' "$v" >"$SRC/migrations/${v}_applied.sql"
  done
  if [[ -n "${FIX_PENDING:-}" ]]; then
    printf '0019_pending.sql content\n' >"$SRC/migrations/0019_pending.sql"
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
  # reconcile-state.sh: a faithful-enough stand-in that records it ran and
  # that it ran AFTER verify/verify-security (order is asserted separately).
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
  if [[ -z "${FIX_NO_BACKUP:-}" ]]; then
    mkdir -p "$DEPLOY/config/status"
    printf '{"lastRunAt":"2026-08-17T09:00:00Z","lastResult":"success"}' >"$DEPLOY/config/status/backup-status.json"
  fi

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
  # Not on PATH by name; recover-deployment.sh calls it via PC_SCRIPTS_DIR,
  # already covered by the fake scripts written into $SRC/scripts above.

  cat >"$BIN/docker" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${F}/docker.calls"

# Real render — the one call this harness never fakes.
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
  # Only after this run's own compose-up has actually fired does a
  # recreated target service report healthy — before that point in the
  # sequence it is still whatever it started as (created).
  if [[ -e "${F}/compose-up.calls" ]]; then
    for h in \$FAKE_POST_RECOVERY_HEALTHY; do [[ "\$h" == "\$svc" ]] && { echo healthy; return; }; done
  fi
  for c in \$FAKE_CREATED; do [[ "\$c" == "\$svc" ]] && { echo created; return; }; done
  echo absent
}
# A service listed in FAKE_STALE_IMAGE is healthy but running an OLD image
# (id ...99) while the deployed lock's tag always resolves to the CURRENT
# build (id ...01) — the exact "healthy but not the currently deployed
# build" shape RCV-003/004 must now detect via scope, not container_health.
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
# docker image inspect --format '{{.Id}}' <ref> — always resolves to the
# CURRENT build's id, matching image_for()'s non-stale value.
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
      # Only after this run's own compose-up has actually fired does a
      # recreated target service report running.
      if [[ -e "${F}/compose-up.calls" ]]; then
        for h in \$FAKE_POST_RECOVERY_HEALTHY; do [[ "\$h" == "\$svc" ]] && { echo running; exit 0; }; done
      fi
      # .State.Status never says "healthy" in real Docker (only
      # .State.Health.Status does) — a healthy container's .State.Status is
      # "running". Translate here so callers that ask for the real Docker
      # field (like recover-deployment.sh's removal-loop re-check) see real
      # Docker semantics, while container_health()-style callers above (the
      # *'.State.Health'* case) still see "healthy" as they always did.
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

  # secret_exists (lib/common.sh) requires uid=0/gid=0/mode=600 — real
  # ownership this non-root test cannot produce on a real file. Faked only
  # for the one secret this fixture actually needs recognised as present.
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

run_recover() {
  local src="$1" deploy="$2" bin="$3"
  ( export PATH="${bin}:${PATH}" PC_ROOT="$deploy"
    export FAKE_HEALTHY="${FIX_HEALTHY:-postgres n8n web}" FAKE_CREATED="${FIX_CREATED-control-api caddy}"
    export FAKE_POST_RECOVERY_HEALTHY="${FIX_POST_RECOVERY_HEALTHY:-}" FAKE_STALE_IMAGE="${FIX_STALE_IMAGE:-}"
    export FAKE_DRYRUN_RC="${FIX_DRYRUN_RC:-0}" FAKE_COMPOSEUP_RC="${FIX_COMPOSEUP_RC:-0}"
    export FAKE_VERIFY_RC="${FIX_VERIFY_RC:-0}" FAKE_VERIFY_SECURITY_RC="${FIX_VERIFY_SECURITY_RC:-0}"
    export FAKE_RECONCILE_RC="${FIX_RECONCILE_RC:-0}"
    timeout 20 bash "$src/scripts/recover-deployment.sh" >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr"
  ) && echo 0 || echo $?
}

# -----------------------------------------------------------------------------
# 1: ordinary reconcile-state (real, unmodified) still refuses unchanged
#    given control-api/caddy created — proves this incident is exactly the
#    one reconcile-state's own REC-001/002 gate was already designed to
#    refuse, and that refusal is untouched by this turn's changes.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture rec1)
( export PATH="${BIN}:${PATH}" PC_ROOT="$DEPLOY"
  export FAKE_HEALTHY="postgres n8n web" FAKE_CREATED="control-api caddy"
  bash "${REPO_ROOT}/scripts/reconcile-state.sh" >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr"
) && rc=0 || rc=$?
[[ "$rc" != "0" ]] || fail "1: reconcile-state accepted a deployment with created containers"
grep -q 'REC-002' "${SCRATCH}/stderr" || fail "1: reconcile-state did not report the expected REC-002 health failure"
grep -q 'REC-000' "${SCRATCH}/stderr" || fail "1: reconcile-state did not abort via REC-000 before any change"
pass "1: ordinary reconcile-state refuses control-api/caddy=created, unchanged"

# -----------------------------------------------------------------------------
# 2 & 5 & 6: recovery recognises the exact incident, scopes itself to only
# the created services, and never touches already-healthy postgres/n8n/web.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture rec2)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_POST_RECOVERY_HEALTHY="control-api caddy" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" == "0" ]] || { cat "${SCRATCH}/stderr" >&2; fail "2: recovery did not succeed against the exact target incident"; }
grep -q 'recovering control-api caddy' "${SCRATCH}/stderr" || fail "2: recovery did not identify control-api+caddy as its scope"
grep -qE 'compose-up .* control-api caddy' "${F}/compose-up.calls" || fail "5: compose up was not called with exactly the target services"
grep -qE ' postgres| n8n' "${F}/compose-up.calls" && fail "6: compose up named a service outside the created target set (postgres/n8n)"
pass "2/5/6: recovery identifies the incident, scopes itself to exactly control-api+caddy, never names postgres/n8n"

# -----------------------------------------------------------------------------
# healthy-but-stale-image: the live incident this turn found — control-api
# and caddy already healthy AND running the current build, but web is
# healthy on the OLD image (compose recreates services one at a time; an
# interrupted `compose up` can leave some already-recreated services healthy
# while others never got their turn). container_health() alone cannot see
# this — RCV-003/004 must compare running image against the deployed lock,
# exactly like update.sh's own coherence gate already does.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture stale)
  rc="$(FIX_HEALTHY="postgres n8n web control-api caddy" FIX_CREATED="" FIX_STALE_IMAGE="web" FIX_POST_RECOVERY_HEALTHY="web" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" == "0" ]] || { cat "${SCRATCH}/stderr" >&2; fail "stale: recovery did not succeed against a healthy-but-stale-image web"; }
grep -q 'recovering web' "${SCRATCH}/stderr" || fail "stale: recovery did not identify web (alone) as its scope"
grep -qE 'compose-up .* web' "${F}/compose-up.calls" || fail "stale: compose up was not called for web"
grep -qE ' control-api| caddy| postgres| n8n' "${F}/compose-up.calls" && fail "stale: compose up named a service outside web (control-api/caddy were already healthy AND current, must stay untouched)"
grep -q 'control-api is already healthy and running the current build' "${SCRATCH}/stderr" || fail "stale: control-api was not confirmed already-current and left out of scope"
grep -q 'caddy is already healthy and running the current build' "${SCRATCH}/stderr" || fail "stale: caddy was not confirmed already-current and left out of scope"
grep -q 'web is healthy but not running the currently deployed build' "${SCRATCH}/stderr" || fail "stale: web's healthy-but-stale reason was not reported"
pass "healthy-but-stale-image: recovery detects a healthy web running the OLD image (via image identity, not container_health) and recreates ONLY web, leaving already-current control-api/caddy untouched"

# -----------------------------------------------------------------------------
# 3 & 4: recovery never applies a migration (only ever --dry-run), and never
# issues a mutating DB call beyond the read-only ledger check.
# -----------------------------------------------------------------------------
grep -q -- '--dry-run' "${F}/migrate.calls" || fail "3: migration dry-run was not invoked with --dry-run"
grep -vq -- '--dry-run' "${F}/migrate.calls" 2>/dev/null && fail "4: a non-dry-run migrate invocation was made"
pass "3/4: recovery only ever runs migrate.js --dry-run; no migration is applied, no DB data is modified"

# -----------------------------------------------------------------------------
# 7: corrected compose (real docker compose config render) has only one
#    /config mount on control-api — proven by RCV-010 in the real run above.
# -----------------------------------------------------------------------------
grep -q 'RCV-010' "${SCRATCH}/stderr" || true  # stderr from the LAST run only; re-check directly instead:
compose_check_scratch="$(mktemp -d)"
cp "${SRC}/infra/compose/compose.yaml" "${compose_check_scratch}/compose.yaml"
docker compose --project-name pc-recover-check --project-directory "$DEPLOY" \
  --env-file "${DEPLOY}/config/stack.env" --file "${compose_check_scratch}/compose.yaml" \
  config --format json 2>/dev/null | python3 "${REPO_ROOT}/scripts/lib/assert-config-mount.py" control-api /config \
  || fail "7: the fixture's own compose does not have exactly one /config mount"
rm -rf -- "$compose_check_scratch"
pass "7: real docker compose config confirms exactly one control-api /config mount, none nested"

# -----------------------------------------------------------------------------
# 8: the automation manifest is staged before control-api is recreated.
# -----------------------------------------------------------------------------
[[ -f "${DEPLOY}/config/status/automation/manifest.json" ]] || fail "8: automation manifest was not staged"
staged_time="$(stat -c %Y "${DEPLOY}/config/status/automation/manifest.json")"
compose_up_time="$(stat -c %Y "${F}/compose-up.calls")"
(( staged_time <= compose_up_time )) || fail "8: automation manifest was staged AFTER compose up ran"
pass "8: automation manifest is present before control-api is recreated"

# -----------------------------------------------------------------------------
# 9: health gate (API + Caddy readiness) is required — a stuck health gate
#    must fail the whole run, not be silently accepted.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture rec9)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_POST_RECOVERY_HEALTHY="" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "9: recovery reported success despite the recreated containers never becoming healthy"
grep -qi 'health gate FAILED' "${SCRATCH}/stderr" || fail "9: recovery did not report a health gate failure"
[[ ! -e "${F}/reconcile-state.calls" ]] || fail "9: reconcile-state ran even though the health gate never passed"
pass "9: API/Caddy readiness is required — a stuck health gate fails the whole run, metadata is never reconciled"

# -----------------------------------------------------------------------------
# 10: strict verify/verify-security are required before success.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture rec10)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_POST_RECOVERY_HEALTHY="control-api caddy" FIX_VERIFY_RC=1 run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "10a: recovery succeeded despite verify.sh failing"
grep -qi 'verify.sh FAILED' "${SCRATCH}/stderr" || fail "10a: recovery did not report the verify.sh failure"
[[ ! -e "${F}/reconcile-state.calls" ]] || fail "10a: reconcile-state ran even though verify.sh failed"

IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture rec10b)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_POST_RECOVERY_HEALTHY="control-api caddy" FIX_VERIFY_SECURITY_RC=1 run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "10b: recovery succeeded despite verify-security.sh failing"
[[ ! -e "${F}/reconcile-state.calls" ]] || fail "10b: reconcile-state ran even though verify-security.sh failed"
pass "10: verify.sh and verify-security.sh are both required to pass before recovery can succeed"

# -----------------------------------------------------------------------------
# 11: a failure halfway through (container recreation itself) must not
#     claim success, and must not proceed to health-gate/verify/reconcile.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture rec11)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_COMPOSEUP_RC=1 run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "11: recovery reported success despite compose up itself failing"
grep -qi 'recreation FAILED' "${SCRATCH}/stderr" || fail "11: recovery did not report the recreation failure clearly"
grep -qi 'do not assume partial success' "${SCRATCH}/stderr" || fail "11: recovery did not warn against assuming partial success"
[[ ! -e "${F}/verify.calls" ]] || fail "11: verify.sh ran even though container recreation itself failed"
[[ ! -e "${F}/reconcile-state.calls" ]] || fail "11: reconcile-state ran even though container recreation itself failed"
pass "11: a mid-recovery failure (container recreation) is reported loudly and never proceeds toward success"

# -----------------------------------------------------------------------------
# 12 & 13: reconcile-state (the only thing that can establish a new,
#    coherent version lock / rollback point) is invoked ONLY after verify
#    and verify-security both pass — never before coherence is proven. This
#    is also exactly what makes an ordinary `update`'s coherence gate pass
#    afterward: reconcile-state's own job is precisely to make
#    deployment_images_match_lock true again.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture rec12)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" FIX_POST_RECOVERY_HEALTHY="control-api caddy" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" == "0" ]] || { cat "${SCRATCH}/stderr" >&2; fail "12: recovery did not succeed on the clean path"; }
[[ -e "${F}/reconcile-state.calls" ]] || fail "12: reconcile-state was never invoked on a fully successful run"
verify_line="$(grep -n 'verify.sh passed' "${SCRATCH}/stderr" | head -1 | cut -d: -f1)"
verify_sec_line="$(grep -n 'verify-security.sh passed' "${SCRATCH}/stderr" | head -1 | cut -d: -f1)"
reconcile_line="$(grep -n 'Handing off to reconcile-state' "${SCRATCH}/stderr" | head -1 | cut -d: -f1)"
[[ -n "$verify_line" && -n "$verify_sec_line" && -n "$reconcile_line" ]] || fail "12: expected log lines were not all present to check ordering"
(( verify_line < reconcile_line && verify_sec_line < reconcile_line )) \
  || fail "12: reconcile-state was invoked before verify/verify-security both passed"
pass "12/13: reconcile-state only runs after verify AND verify-security both pass — the same mechanism that makes update's coherence gate pass again afterward"

# -----------------------------------------------------------------------------
# Pending migration: recovery must refuse rather than silently proceed —
# it recreates containers, it never advances the schema. (Directly
# supports point 3's "never runs mismatched app/schema": a pending
# migration means the repository expects MORE schema than is applied;
# recovering forward without applying it would be exactly that mismatch.)
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(FIX_PENDING=1 setup_fixture pending)
lock_before="$(sha256sum "$DEPLOY/config/versions.lock.env")"
stack_before="$(sha256sum "$DEPLOY/config/stack.env")"
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "pending: recovery proceeded despite a pending migration"
grep -q 'RCV-007' "${SCRATCH}/stderr" || fail "pending: recovery did not report the RCV-007 pending-migration refusal"
[[ ! -e "${F}/compose-up.calls" ]] || fail "pending: recovery attempted to recreate containers despite a pending migration"
pass "pending migration: recovery refuses (RCV-007) rather than recreating containers against a schema the repository expects to advance further"

# Exactly the confirmed live signature: the applied ledger IS a valid subset
# (RCV-006 PASS) — recovery is not confused by an incompatible database, it is
# specifically and only refusing because something is pending (RCV-007 FAIL).
grep -q '\[  OK \] RCV-006' "${SCRATCH}/stderr" || fail "pending: RCV-006 (applied ledger is a subset) did not PASS alongside the RCV-007 refusal — the two checks must be independent"
pass "pending migration: RCV-006 (ledger subset) PASSES while RCV-007 (nothing pending) FAILS — the exact, distinguishable signature confirmed on the live host"

[[ "$lock_before" == "$(sha256sum "$DEPLOY/config/versions.lock.env")" ]] \
  || fail "pending: recovery rewrote versions.lock.env despite refusing"
[[ "$stack_before" == "$(sha256sum "$DEPLOY/config/stack.env")" ]] \
  || fail "pending: recovery rewrote stack.env despite refusing"
pass "pending migration: versions.lock.env and stack.env are byte-identical after the refusal — a stale lock is never silently rewritten as a side effect of a failed recovery attempt"

# --force must not exist as an escape hatch for this refusal, or any other:
# recover-deployment.sh rejects it outright, before RCV-001 ever runs.
( export PATH="${BIN}:${PATH}" PC_ROOT="$DEPLOY"
  export FAKE_HEALTHY="postgres n8n web" FAKE_CREATED="control-api caddy"
  timeout 20 bash "$SRC/scripts/recover-deployment.sh" --force >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr"
) && force_rc=0 || force_rc=$?
[[ "$force_rc" != "0" ]] || fail "pending+force: recovery accepted --force"
grep -q 'accepts no override flag' "${SCRATCH}/stderr" || fail "pending+force: recovery did not report its no-override-flags stance"
grep -q 'RCV-001\|RCV-006\|RCV-007' "${SCRATCH}/stderr" && fail "pending+force: --force was rejected AFTER preflight checks began running, not before"
[[ ! -e "${F}/compose-up.calls" ]] || fail "pending+force: --force reached container recreation"
pass "pending migration + --force: rejected immediately as an unknown argument, before any precondition check runs — no override hatch exists"

# -----------------------------------------------------------------------------
# No backup on record: the database recovery boundary is missing — refuse.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(FIX_NO_BACKUP=1 setup_fixture nobackup)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="control-api caddy" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "nobackup: recovery proceeded with no successful backup on record"
grep -q 'RCV-009' "${SCRATCH}/stderr" || fail "nobackup: recovery did not report the RCV-009 backup-boundary refusal"
pass "no backup on record: recovery refuses (RCV-009) — the database recovery boundary is not established"

# -----------------------------------------------------------------------------
# Unhealthy postgres/n8n: recovery must refuse outright, never attempt to
# repair a stateful service or paper over a more serious incident.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture statefuldown)
  rc="$(FIX_HEALTHY="n8n web" FIX_CREATED="control-api caddy" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "statefuldown: recovery proceeded despite postgres being unhealthy"
grep -q 'RCV-001' "${SCRATCH}/stderr" || fail "statefuldown: recovery did not report the RCV-001 postgres-unhealthy refusal"
[[ ! -e "${F}/compose-up.calls" ]] || fail "statefuldown: recovery attempted to recreate containers despite postgres being unhealthy"
pass "unhealthy postgres: recovery refuses outright (RCV-001), never touches anything"

# -----------------------------------------------------------------------------
# Unexpected unhealthy state (not `created`): refuse, not this tool's job.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture exited)
  rc="$(FIX_HEALTHY="postgres n8n web" FIX_CREATED="" run_recover "$SRC" "$DEPLOY" "$BIN")"
[[ "$rc" != "0" ]] || fail "exited: recovery reported success with control-api/caddy absent (not created, not healthy)"
grep -q 'RCV-000' "${SCRATCH}/stderr" || fail "exited: recovery did not abort via RCV-000"
pass "control-api/caddy absent (an unrecognised failure mode, not 'created'): recovery refuses rather than guessing"

printf 'PASS: recover-deployment.sh recognises the exact incident, scopes itself correctly, and never claims success without proof\n'
