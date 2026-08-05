#!/usr/bin/env bash
# =============================================================================
# rollback.sh — return to the previous version lock and images.
#
#   sudo ./pcctl rollback            roll back to the most recent point
#   sudo ./pcctl rollback --list     show available rollback points
#   sudo ./pcctl rollback --id <id>  roll back to a specific point
#
# Scope: configuration and container images only. It does NOT restore data — an
# applied schema migration stays applied, which is exactly why update.sh refuses
# to apply an irreversible migration without --force. To recover data, restore
# from a backup (docs/disaster-recovery.md).
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions
load_stack_env

ROLLBACK_DIR="${PC_ROOT}/backups/rollback"
TARGET_ID=""
AUTO=0
LIST=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) LIST=1; shift ;;
    --id)   TARGET_ID="${2:-}"; [[ -n "$TARGET_ID" ]] || die "--id needs a value"; shift 2 ;;
    --auto) AUTO=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ -d "$ROLLBACK_DIR" ]] || die "no rollback points exist (none has been created by an update)"

if (( LIST )); then
  printf '\nAvailable rollback points:\n\n'
  found=0
  while IFS= read -r dir; do
    id="$(basename "$dir")"
    version="$(grep -E '^PC_STACK_VERSION=' "${dir}/versions.lock.env" 2>/dev/null | cut -d= -f2- || echo unknown)"
    printf '  %-20s  stack %-10s  %s\n' "$id" "$version" "$(date -d "$(stat -c '%y' "$dir")" '+%Y-%m-%d %H:%M' 2>/dev/null || echo '')"
    found=1
  done < <(find "$ROLLBACK_DIR" -mindepth 1 -maxdepth 1 -type d | sort -r)
  (( found )) || printf '  (none)\n'
  printf '\n'
  exit 0
fi

if [[ -z "$TARGET_ID" ]]; then
  [[ -f "${ROLLBACK_DIR}/latest" ]] || die "no rollback pointer found; use --list then --id"
  TARGET_ID="$(<"${ROLLBACK_DIR}/latest")"
fi

SNAPSHOT_DIR="${ROLLBACK_DIR}/${TARGET_ID}"
[[ -d "$SNAPSHOT_DIR" ]] || die "rollback point not found: ${TARGET_ID}"
[[ -f "${SNAPSHOT_DIR}/versions.lock.env" ]] || die "rollback point ${TARGET_ID} is incomplete"

TARGET_VERSION="$(grep -E '^PC_STACK_VERSION=' "${SNAPSHOT_DIR}/versions.lock.env" | cut -d= -f2- || echo unknown)"

log_step "Rolling back to ${TARGET_ID} (stack ${TARGET_VERSION})"

if (( ! AUTO )); then
  cat >&2 <<WARNING

  This will:
    * restore the previous version lock, compose file and stack.env
    * recreate every container from the previously running images

  This will NOT:
    * undo an applied database migration
    * restore data — use a backup for that (docs/disaster-recovery.md)

  Current : ${PC_STACK_VERSION}
  Target  : ${TARGET_VERSION} (${TARGET_ID})

WARNING
  confirm "Proceed with the rollback?" "rollback" || die "aborted; nothing was changed"
fi

# -----------------------------------------------------------------------------
# Verify the target images still exist locally before touching anything. Rolling
# back to an image that has been pruned would leave the stack down entirely.
# -----------------------------------------------------------------------------
log_step "Verifying the target images are present"
missing=0
if [[ -f "${SNAPSHOT_DIR}/running-images.env" ]]; then
  while IFS='=' read -r service image_id; do
    [[ "$service" == \#* || -z "$service" || -z "$image_id" ]] && continue
    if docker image inspect "$image_id" >/dev/null 2>&1; then
      log_ok "${service}: image present"
    else
      log_error "${service}: image ${image_id:0:20}… is no longer available locally"
      missing=1
    fi
  done <"${SNAPSHOT_DIR}/running-images.env"
fi

if (( missing )); then
  log_warn "some previous images have been pruned; the rollback will re-pull from the restored lock"
fi

# -----------------------------------------------------------------------------
log_step "Restoring configuration"
# -----------------------------------------------------------------------------
# Keep a copy of what we are replacing, so a rollback can itself be undone.
FAILED_DIR="${ROLLBACK_DIR}/pre-rollback-$(date -u +%Y%m%dT%H%M%SZ)"
ensure_dir "$FAILED_DIR" 0700 root root
cp -p "${PC_ROOT}/config/versions.lock.env" "${FAILED_DIR}/" 2>/dev/null || true
cp -p "${PC_ROOT}/config/stack.env"         "${FAILED_DIR}/" 2>/dev/null || true
cp -p "${PC_ROOT}/compose/compose.yaml"     "${FAILED_DIR}/" 2>/dev/null || true

install_file "${SNAPSHOT_DIR}/versions.lock.env" "${PC_ROOT}/config/versions.lock.env" 0644
install_file "${SNAPSHOT_DIR}/compose.yaml"      "${PC_ROOT}/compose/compose.yaml" 0644
install_file "${SNAPSHOT_DIR}/stack.env"         "${PC_ROOT}/config/stack.env" 0640
chown root:root "${PC_ROOT}/config/stack.env"

log_ok "configuration restored"

# -----------------------------------------------------------------------------
log_step "Recreating containers"
# -----------------------------------------------------------------------------
load_versions "${PC_ROOT}/config/versions.lock.env"
load_stack_env

for image in "${PC_POSTGRES_IMAGE}" "${PC_N8N_IMAGE}" "${PC_CADDY_IMAGE}"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    log_info "re-pulling ${image}"
    docker pull --quiet "$image" >/dev/null || log_warn "could not pull ${image}"
  }
done

if compose up --detach --remove-orphans --wait --wait-timeout 300; then
  log_ok "containers recreated from the previous version"
else
  log_error "the stack did not become healthy after the rollback"
  compose ps
  log_error "manual intervention required — see docs/troubleshooting.md"
  exit 1
fi

# -----------------------------------------------------------------------------
log_step "Verifying"
# -----------------------------------------------------------------------------
sleep 5
if bash "${PC_SCRIPTS_DIR}/verify.sh"; then
  log_ok "verification passed after rollback"
else
  log_warn "verification reported issues after the rollback"
fi

# Audit trail.
pg_cid="$(container_id postgres)"
if [[ -n "$pg_cid" ]]; then
  docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -q -c \
    "INSERT INTO audit_events (event_type, outcome, subject, detail)
     VALUES ('system.rollback', 'success', 'rollback:${TARGET_ID}',
             '{\"targetVersion\":\"${TARGET_VERSION}\"}'::jsonb)" >/dev/null 2>&1 || true
fi

bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" \
  "↩️ Project Control rolled back to ${TARGET_VERSION} on $(hostname -s)" >/dev/null 2>&1 || true

log_ok "rollback complete: stack ${TARGET_VERSION}"
log_info "the replaced configuration was kept at ${FAILED_DIR}"
log_warn "database migrations were NOT reverted; restore from backup if data must be rolled back"
