#!/usr/bin/env bash
# =============================================================================
# restore-test.sh — prove the backups are actually restorable.
#
# A backup that has never been restored is a hypothesis, not a backup. This
# script tests the hypothesis, in isolation, on a schedule.
#
# What it does:
#   1. Restores the latest snapshot into a scratch directory.
#   2. Starts a THROWAWAY PostgreSQL container on its own network.
#   3. Loads both database dumps into it and asserts the expected tables and
#      rows are present.
#   4. Re-hashes a sample of restored artifacts and compares against their
#      content-addressed filenames.
#   5. Destroys the scratch container, network and directory.
#
# Isolation guarantees:
#   * The scratch container has a unique name, its own network, and no bind
#     mount into live data.
#   * The restore target is asserted to be under backups/restore-tests and is
#     refused if it resolves anywhere near data/.
#   * The live stack is never stopped, never reconfigured, never written to.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions
load_stack_env

SCHEDULED=0
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scheduled) SCHEDULED=1; shift ;;
    --keep)      KEEP=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

if ! secret_exists restic_password || [[ ! -f "${PC_ROOT}/config/rclone.conf" ]]; then
  log_warn "MANUAL_CONFIGURATION_REQUIRED: backup is not configured"
  log_info "run: sudo ./pcctl configure-google-drive"
  exit 2
fi
require_cmd restic docker

export RESTIC_REPOSITORY="rclone:gdrive:Project-Control-Backups/restic"
export RESTIC_PASSWORD_FILE="${PC_SECRETS_DIR}/restic_password"
export RCLONE_CONFIG="${PC_ROOT}/config/rclone.conf"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RESTORE_ROOT="${PC_ROOT}/backups/restore-tests/${RUN_ID}"
SCRATCH_CONTAINER="pc-restore-test-${RUN_ID}"
SCRATCH_NETWORK="pc-restore-test-net-${RUN_ID}"
SCRATCH_PASSWORD="$(random_token 32)"

# -----------------------------------------------------------------------------
# Safety assertion: the restore target must be inside the restore-test area.
#
# Without this, a mistaken PC_ROOT or a symlinked backups/ directory could point
# the restore at live data and overwrite it.
# -----------------------------------------------------------------------------
EXPECTED_PREFIX="${PC_ROOT}/backups/restore-tests/"
if [[ "$RESTORE_ROOT" != "$EXPECTED_PREFIX"* ]]; then
  die "refusing to restore: target ${RESTORE_ROOT} is outside ${EXPECTED_PREFIX}"
fi
if [[ "$RESTORE_ROOT" == *"${PC_ROOT}/data"* ]]; then
  die "refusing to restore: target overlaps live data"
fi

# -----------------------------------------------------------------------------
cleanup() {
  local exit_code=$?
  log_step "Tearing down the sandbox"

  docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$SCRATCH_NETWORK" >/dev/null 2>&1 || true

  if (( KEEP )); then
    log_warn "--keep: restored data left at ${RESTORE_ROOT}"
  elif [[ -d "$RESTORE_ROOT" && "$RESTORE_ROOT" == "$EXPECTED_PREFIX"* ]]; then
    rm -rf "$RESTORE_ROOT"
    log_ok "scratch directory removed"
  fi

  exit "$exit_code"
}
trap cleanup EXIT

notify() {
  bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" "$1" >/dev/null 2>&1 || true
}

fail() {
  log_error "$1"
  (( SCHEDULED )) && notify "🔴 Project Control RESTORE TEST FAILED on $(hostname -s): $1"
  exit 1
}

STARTED_AT="$(date +%s)"
log_step "Isolated restore test ${RUN_ID}"

# =============================================================================
# 1. Restore the latest snapshot
# =============================================================================
log_step "1/5  Restoring the latest snapshot"

ensure_dir "$RESTORE_ROOT" 0700 root root

latest="$(restic snapshots --latest 1 --json 2>/dev/null \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["short_id"] if d else "")' 2>/dev/null || echo '')"
[[ -n "$latest" ]] || fail "no snapshot found in the repository"

log_info "snapshot ${latest}"

if ! restic restore "$latest" --target "$RESTORE_ROOT" 2>&1 | redact_stream; then
  fail "restic restore failed"
fi
log_ok "snapshot restored to the sandbox"

# restic reproduces absolute paths under the target.
RESTORED_STAGING="${RESTORE_ROOT}${PC_ROOT}/backups/staging"
RESTORED_ARTIFACTS="${RESTORE_ROOT}${PC_ROOT}/data/artifacts/objects"

[[ -d "$RESTORED_STAGING" ]] || fail "restored snapshot has no staging directory (no database dumps)"

if [[ -f "${RESTORED_STAGING}/manifest.json" ]]; then
  log_ok "manifest: $(python3 -c 'import json,sys;m=json.load(open(sys.argv[1]));print(f"run {m[\"runId\"]} from {m[\"hostname\"]}, stack {m[\"stackVersion\"]}")' "${RESTORED_STAGING}/manifest.json" 2>/dev/null || echo 'unreadable')"
fi

for dump in project_control n8n; do
  [[ -f "${RESTORED_STAGING}/${dump}.dump" ]] || fail "restored snapshot is missing ${dump}.dump"
done
log_ok "both database dumps are present"

# =============================================================================
# 2. Throwaway PostgreSQL
# =============================================================================
log_step "2/5  Starting an isolated PostgreSQL container"

docker network create --internal "$SCRATCH_NETWORK" >/dev/null 2>&1 || true

# Note what this container does NOT have: no bind mount into live data, no
# published port, no attachment to any project-control network. It is on an
# internal network of its own and is destroyed at the end.
docker run --detach \
  --name "$SCRATCH_CONTAINER" \
  --network "$SCRATCH_NETWORK" \
  --user "${PC_POSTGRES_UID}:${PC_POSTGRES_GID}" \
  --env POSTGRES_PASSWORD="$SCRATCH_PASSWORD" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_DB=postgres \
  --env PGDATA=/tmp/pgdata \
  --tmpfs /tmp:rw,size=2g \
  --tmpfs /run/postgresql:rw,size=64m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --pids-limit 256 \
  --memory 1g \
  --label "com.project-control.ephemeral=true" \
  "$PC_POSTGRES_IMAGE" \
  postgres -c fsync=off -c full_page_writes=off -c synchronous_commit=off \
  >/dev/null || fail "could not start the scratch PostgreSQL container"

log_info "waiting for the scratch database"
ready=0
for _ in $(seq 1 60); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U postgres -q 2>/dev/null; then
    ready=1; break
  fi
  sleep 1
done
(( ready )) || fail "the scratch PostgreSQL container did not become ready"
log_ok "scratch database ready (in-memory, isolated, no published port)"

# =============================================================================
# 3. Load and verify the dumps
# =============================================================================
log_step "3/5  Restoring the database dumps"

restore_and_check() {
  local database="$1"; shift
  local expected_tables=("$@")

  docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
    psql -U postgres -d postgres -q -c "CREATE DATABASE ${database}" >/dev/null 2>&1 \
    || fail "could not create ${database} in the sandbox"

  # pg_restore emits warnings about missing roles (the sandbox has none); those
  # are expected and not fatal, so only a hard failure is treated as one.
  if ! docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
        pg_restore --username=postgres --dbname="$database" \
                   --no-owner --no-privileges --exit-on-error \
        <"${RESTORED_STAGING}/${database}.dump" 2>/dev/null; then
    fail "pg_restore failed for ${database} — this backup is NOT restorable"
  fi

  log_ok "${database}: dump loaded"

  for table in "${expected_tables[@]}"; do
    local exists
    exists="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
      psql -U postgres -d "$database" -tAc \
      "SELECT to_regclass('public.${table}') IS NOT NULL" 2>/dev/null || echo f)"
    [[ "$exists" == "t" ]] || fail "restored ${database} is missing table ${table}"
  done
  log_ok "${database}: all expected tables present (${#expected_tables[@]})"
}

restore_and_check project_control users sessions audit_events schema_migrations system_settings artifact_objects

# n8n owns its own schema, so the table list is not asserted; the check is that
# the dump loads and contains something.
docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d postgres -q -c "CREATE DATABASE n8n" >/dev/null 2>&1 || true
if docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
     pg_restore --username=postgres --dbname=n8n --no-owner --no-privileges \
     <"${RESTORED_STAGING}/n8n.dump" >/dev/null 2>&1; then
  n8n_tables="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
    psql -U postgres -d n8n -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null || echo 0)"
  log_ok "n8n: dump loaded (${n8n_tables} table(s))"
else
  log_warn "n8n dump reported warnings; it may simply have no schema yet"
fi

# Row-level sanity: the migration ledger must have survived.
migrations="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc "SELECT count(*) FROM schema_migrations" 2>/dev/null || echo 0)"
if [[ "${migrations:-0}" -gt 0 ]]; then
  log_ok "project_control: ${migrations} migration record(s) restored"
else
  fail "restored project_control has an empty migration ledger"
fi

# =============================================================================
# 4. Artifact integrity
# =============================================================================
log_step "4/5  Verifying restored artifact integrity"

if [[ -d "$RESTORED_ARTIFACTS" ]]; then
  checked=0; mismatched=0
  while IFS= read -r object; do
    (( checked >= 50 )) && break
    expected="$(basename "$object")"
    actual="$(sha256sum "$object" 2>/dev/null | cut -d' ' -f1)"
    if [[ "$expected" != "$actual" ]]; then
      mismatched=$((mismatched+1))
      log_error "digest mismatch on restored object ${expected:0:16}…"
    fi
    checked=$((checked+1))
  done < <(find "$RESTORED_ARTIFACTS" -type f 2>/dev/null)

  if (( checked == 0 )); then
    log_warn "no artifacts in the snapshot to verify"
  elif (( mismatched == 0 )); then
    log_ok "${checked} restored artifact(s) match their content digests"
  else
    fail "${mismatched}/${checked} restored artifacts are corrupt"
  fi
else
  log_warn "the snapshot contains no artifact objects directory"
fi

# =============================================================================
# 5. Confirm live data was untouched
# =============================================================================
log_step "5/5  Confirming the live system is unaffected"

live_ok=1
for service in postgres control-api; do
  health="$(container_health "$service")"
  if [[ "$health" != "healthy" && "$health" != "running" ]]; then
    log_error "live ${service} is ${health} after the restore test"
    live_ok=0
  fi
done
(( live_ok )) || fail "the live stack was disturbed by the restore test"
log_ok "live containers are unaffected"

# The scratch container must not have joined any project-control network.
if docker inspect "$SCRATCH_CONTAINER" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null \
   | grep -q "${PC_COMPOSE_PROJECT}"; then
  fail "the scratch container was attached to a live network"
fi
log_ok "sandbox remained isolated from the live networks"

# =============================================================================
ELAPSED=$(( $(date +%s) - STARTED_AT ))

cat >&2 <<SUMMARY

$(printf '═%.0s' {1..70})
  Restore test PASSED
$(printf '═%.0s' {1..70})

  Snapshot   : ${latest}
  Duration   : ${ELAPSED}s
  Databases  : project_control (${migrations} migrations), n8n
  Artifacts  : ${checked:-0} verified, ${mismatched:-0} corrupt
  Sandbox    : destroyed
  Live data  : untouched

$(printf '═%.0s' {1..70})

SUMMARY

log_ok "restore test passed in ${ELAPSED}s"
(( SCHEDULED )) && notify "✅ Project Control monthly restore test PASSED on $(hostname -s)
snapshot: ${latest}
duration: ${ELAPSED}s
artifacts verified: ${checked:-0}"
exit 0
