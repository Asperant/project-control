#!/usr/bin/env bash
# =============================================================================
# update.sh — safe stack update with an automatic rollback path.
#
# Sequence:
#   1. Back up (refuse to continue if the backup fails).
#   2. Snapshot the current version lock and the running image ids.
#   3. Verify every new image digest resolves.
#   4. Migration dry-run — run the SQL for real, then roll it back.
#   5. Refuse to proceed if any pending migration is irreversible.
#   6. Recreate the stack.
#   7. Health gate.
#   8. On failure, roll back automatically.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions
load_stack_env

SKIP_BACKUP=0
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-backup) SKIP_BACKUP=1; shift ;;
    --force)       FORCE=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
ROLLBACK_DIR="${PC_ROOT}/backups/rollback"
ensure_dir "$ROLLBACK_DIR" 0700 root root

notify() { bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" "$1" >/dev/null 2>&1 || true; }
audit()  {
  # Best effort: an audit write must never abort an update.
  local pg_cid; pg_cid="$(container_id postgres)"
  [[ -n "$pg_cid" ]] || return 0
  docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -q -c \
    "INSERT INTO audit_events (event_type, outcome, subject, detail)
     VALUES ('$1', '$2', 'update:${RUN_ID}', '$3'::jsonb)" >/dev/null 2>&1 || true
}

# =============================================================================
log_step "1/8  Pre-update backup"
# =============================================================================
if (( SKIP_BACKUP )); then
  log_warn "--skip-backup: proceeding without a fresh backup"
  (( FORCE )) || die "--skip-backup requires --force; updating without a backup removes your recovery path"
else
  if bash "${PC_SCRIPTS_DIR}/backup.sh"; then
    log_ok "pre-update backup complete"
  else
    rc=$?
    if (( rc == 2 )); then
      log_warn "backup is not configured (manual checkpoint pending)"
      (( FORCE )) || die "refusing to update without a backup; complete the Google Drive checkpoint or pass --force"
    else
      die "pre-update backup FAILED; not updating"
    fi
  fi
fi

# =============================================================================
log_step "2/8  Recording the current state for rollback"
# =============================================================================
SNAPSHOT_DIR="${ROLLBACK_DIR}/${RUN_ID}"
ensure_dir "$SNAPSHOT_DIR" 0700 root root

cp -p "${PC_ROOT}/config/versions.lock.env" "${SNAPSHOT_DIR}/versions.lock.env"
cp -p "${PC_ROOT}/config/stack.env"         "${SNAPSHOT_DIR}/stack.env"
cp -p "${PC_ROOT}/compose/compose.yaml"     "${SNAPSHOT_DIR}/compose.yaml"

# Record the concrete image IDs currently running. Tags can move; IDs cannot.
{
  printf '# Image ids in use before update %s\n' "$RUN_ID"
  for service in postgres n8n control-api web caddy; do
    cid="$(container_id "$service")"
    [[ -n "$cid" ]] || continue
    printf '%s=%s\n' "$service" "$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null)"
  done
} >"${SNAPSHOT_DIR}/running-images.env"
chmod 0600 "${SNAPSHOT_DIR}"/*

# The rollback script reads this pointer.
printf '%s\n' "$RUN_ID" >"${ROLLBACK_DIR}/latest"
chmod 0600 "${ROLLBACK_DIR}/latest"

log_ok "rollback point saved: ${SNAPSHOT_DIR}"

# =============================================================================
log_step "3/8  Resolving the new image digests"
# =============================================================================
# Reload from the repository, which is where a new lock would have landed.
load_versions "${PC_REPO_ROOT}/infra/versions.lock.env"

for image in "${PC_POSTGRES_IMAGE}" "${PC_N8N_IMAGE}" "${PC_CADDY_IMAGE}"; do
  if [[ "$image" != *"@sha256:"* ]]; then
    die "image ${image} is not digest-pinned; refusing to update to a floating tag"
  fi
  log_info "pulling ${image}"
  if ! docker pull --quiet "$image" >/dev/null 2>&1; then
    die "cannot pull ${image}; aborting before anything is changed"
  fi
done
log_ok "all pinned images resolved and present"

log_step "Rebuilding local images"
bash "${PC_SCRIPTS_DIR}/build.sh" || die "image build failed; nothing was changed"

# =============================================================================
log_step "4/8  Migration dry-run"
# =============================================================================
# The dry-run executes the SQL for real inside a transaction and then rolls it
# back. A syntax error or a constraint violation therefore surfaces now, while
# the old stack is still running and healthy.
api_cid="$(container_id control-api)"
if [[ -n "$api_cid" ]]; then
  if docker exec "$api_cid" node dist/cli/migrate.js --dry-run 2>&1 | redact_stream; then
    log_ok "migration dry-run passed"
  else
    audit system.update failure '{"stage":"migration_dry_run"}'
    die "migration dry-run FAILED; the update was aborted and nothing was changed"
  fi
else
  log_warn "control-api is not running; skipping the migration dry-run"
fi

# =============================================================================
log_step "5/8  Checking for irreversible migrations"
# =============================================================================
# A migration that drops a column or a table cannot be undone by re-running the
# old code, so the automatic rollback path would not actually restore service.
# The operator must decide explicitly.
irreversible=""
for migration in "${PC_REPO_ROOT}"/migrations/*.sql; do
  [[ -f "$migration" ]] || continue
  name="$(basename "$migration")"

  # Only consider migrations that have not been applied yet.
  if [[ -n "$api_cid" ]]; then
    version="${name%%_*}"
    applied="$(docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" \
      "$(container_id postgres)" psql -U control_app -d project_control -tAc \
      "SELECT 1 FROM schema_migrations WHERE version='${version}'" 2>/dev/null || echo '')"
    [[ "$applied" == "1" ]] && continue
  fi

  if grep -qiE '^\s*(DROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)|ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN|TRUNCATE)' "$migration"; then
    irreversible+="  - ${name}"$'\n'
  fi
done

if [[ -n "$irreversible" ]]; then
  log_error "Pending migrations contain irreversible data changes:"
  printf '%s' "$irreversible" >&2
  log_error "A rollback would NOT restore the dropped data."
  if (( ! FORCE )); then
    audit system.update denied '{"stage":"irreversible_migration"}'
    die "aborting before any change. Review the migrations, confirm your backup, then re-run with --force"
  fi
  log_warn "--force: proceeding despite irreversible migrations"
fi
log_ok "no unreviewed irreversible migration"

# =============================================================================
log_step "6/8  Applying the update"
# =============================================================================
install_file "${PC_REPO_ROOT}/infra/versions.lock.env" "${PC_ROOT}/config/versions.lock.env" 0644
install_file "${PC_REPO_ROOT}/infra/compose/compose.yaml" "${PC_ROOT}/compose/compose.yaml" 0644
install_file "${PC_REPO_ROOT}/infra/caddy/Caddyfile" "${PC_ROOT}/config/caddy/Caddyfile" 0644
for migration in "${PC_REPO_ROOT}"/migrations/*.sql; do
  [[ -f "$migration" ]] && install_file "$migration" "${PC_ROOT}/migrations/$(basename "$migration")" 0644
done

# Refresh the image references in stack.env.
tmp="$(mktemp)"
grep -vE '^(PC_POSTGRES_IMAGE|PC_N8N_IMAGE|PC_CADDY_IMAGE|PC_CADDY_PROXY_IMAGE|PC_CONTROL_API_IMAGE|PC_WEB_IMAGE|PC_STACK_VERSION)=' \
  "${PC_ROOT}/config/stack.env" >"$tmp"
{
  printf 'PC_POSTGRES_IMAGE=%s\n'    "$PC_POSTGRES_IMAGE"
  printf 'PC_N8N_IMAGE=%s\n'         "$PC_N8N_IMAGE"
  printf 'PC_CADDY_IMAGE=%s\n'       "$PC_CADDY_IMAGE"
  printf 'PC_CADDY_PROXY_IMAGE=%s\n' "$PC_CADDY_PROXY_IMAGE"
  printf 'PC_CONTROL_API_IMAGE=%s\n' "$PC_CONTROL_API_IMAGE"
  printf 'PC_WEB_IMAGE=%s\n'         "$PC_WEB_IMAGE"
  printf 'PC_STACK_VERSION=%s\n'     "$PC_STACK_VERSION"
} >>"$tmp"
install_file "$tmp" "${PC_ROOT}/config/stack.env" 0640
rm -f "$tmp"
chown root:root "${PC_ROOT}/config/stack.env"

load_stack_env

log_info "recreating containers"
if ! compose up --detach --remove-orphans --wait --wait-timeout 300; then
  log_error "the updated stack did not become healthy"
  audit system.update failure '{"stage":"compose_up"}'
  log_step "Rolling back automatically"
  bash "${PC_SCRIPTS_DIR}/rollback.sh" --auto
  notify "🔴 Project Control update FAILED on $(hostname -s); rolled back automatically"
  exit 1
fi
log_ok "containers recreated"

# =============================================================================
log_step "7/8  Health gate"
# =============================================================================
gate_passed=1

for attempt in $(seq 1 12); do
  gate_passed=1
  for service in postgres n8n control-api web caddy; do
    health="$(container_health "$service")"
    [[ "$health" == "healthy" || "$health" == "running" ]] || gate_passed=0
  done
  (( gate_passed )) && break
  log_info "waiting for health (attempt ${attempt}/12)"
  sleep 10
done

if (( gate_passed )); then
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:8780/api/auth/me" 2>/dev/null || echo 000)"
  [[ "$code" == "401" ]] || { log_error "API gate returned HTTP ${code}, expected 401"; gate_passed=0; }
fi

if (( ! gate_passed )); then
  log_error "health gate FAILED after the update"
  audit system.update failure '{"stage":"health_gate"}'
  log_step "Rolling back automatically"
  bash "${PC_SCRIPTS_DIR}/rollback.sh" --auto
  notify "🔴 Project Control update FAILED the health gate on $(hostname -s); rolled back automatically"
  exit 1
fi
log_ok "health gate passed"

# =============================================================================
log_step "8/8  Post-update verification"
# =============================================================================
if bash "${PC_SCRIPTS_DIR}/verify.sh"; then
  log_ok "verification passed"
else
  log_warn "verification reported issues; the stack is healthy but review the output"
fi

audit system.update success "$(printf '{"version":"%s"}' "$PC_STACK_VERSION")"

# Keep the five most recent rollback points.
find "$ROLLBACK_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +6 | cut -d' ' -f2- | xargs -r rm -rf

log_ok "update complete: version ${PC_STACK_VERSION}"
log_info "rollback point: ${RUN_ID} (sudo ./pcctl rollback)"
notify "✅ Project Control updated to ${PC_STACK_VERSION} on $(hostname -s)"
