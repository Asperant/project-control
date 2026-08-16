#!/usr/bin/env bash
# =============================================================================
# rollback.sh — return to the previous version lock and images.
#
#   sudo ./pcctl rollback            roll back to the most recent point
#   sudo ./pcctl rollback --list     show available rollback points
#   sudo ./pcctl rollback --id <id>  roll back to a specific point
#   sudo ./pcctl rollback --id <id> --force  override checkpoint reader gate
#
# Scope: configuration, container images and the snapshotted runner binary. It
# does NOT restore data — an
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
FORCE=0

rollback_incomplete() {
  local stage="$1" detail="$2"
  log_error "ROLLBACK INCOMPLETE at ${stage}: ${detail}"
  log_error "the rollback target has not been proven coherent; do not treat this as success"
  bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" \
    "🔴 Project Control rollback INCOMPLETE at ${stage} on $(hostname -s); manual recovery required" >/dev/null 2>&1 || true
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) LIST=1; shift ;;
    --id)   TARGET_ID="${2:-}"; [[ -n "$TARGET_ID" ]] || die "--id needs a value"; shift 2 ;;
    --auto) AUTO=1; shift ;;
    --force) FORCE=1; shift ;;
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
for required_artifact in versions.lock.env stack.env compose.yaml; do
  [[ -r "${SNAPSHOT_DIR}/${required_artifact}" ]] \
    || die "rollback point ${TARGET_ID} is incomplete: ${required_artifact} is not readable; nothing was changed"
done
validate_snapshot_image_manifest "${SNAPSHOT_DIR}/running-images.env" \
  || die "rollback point ${TARGET_ID} has an incomplete or invalid image manifest; nothing was changed"

TARGET_VERSION="$(grep -E '^PC_STACK_VERSION=' "${SNAPSHOT_DIR}/versions.lock.env" | cut -d= -f2- || echo unknown)"

target_checkpoint_reader_max="$(cat "${SNAPSHOT_DIR}/checkpoint-reader-max-version" 2>/dev/null || echo 2)"
if [[ ! "$target_checkpoint_reader_max" =~ ^[1-9][0-9]*$ ]]; then
  die "rollback target has invalid checkpoint reader capability metadata; nothing was changed"
fi
if (( target_checkpoint_reader_max >= 3 )); then
  [[ -f "${SNAPSHOT_DIR}/project-control-runner" && ! -L "${SNAPSHOT_DIR}/project-control-runner" \
     && -r "${SNAPSHOT_DIR}/project-control-runner" ]] \
    || die "rollback point ${TARGET_ID} is incomplete: a v3-capable target requires a readable runner snapshot; nothing was changed"
elif [[ -e "${SNAPSHOT_DIR}/project-control-runner" ]]; then
  [[ -f "${SNAPSHOT_DIR}/project-control-runner" && ! -L "${SNAPSHOT_DIR}/project-control-runner" \
     && -r "${SNAPSHOT_DIR}/project-control-runner" ]] \
    || die "rollback point ${TARGET_ID} has an invalid runner snapshot; nothing was changed"
fi

# The target's lock and Compose environment must be internally coherent before
# any live configuration is copied over.
if ! (
  unset PC_POSTGRES_IMAGE PC_N8N_IMAGE PC_CONTROL_API_IMAGE PC_WEB_IMAGE PC_CADDY_PROXY_IMAGE PC_STACK_VERSION
  # shellcheck disable=SC1090
  source "${SNAPSHOT_DIR}/versions.lock.env"
  lock_postgres="$PC_POSTGRES_IMAGE" lock_n8n="$PC_N8N_IMAGE" lock_api="$PC_CONTROL_API_IMAGE"
  lock_web="$PC_WEB_IMAGE" lock_caddy="$PC_CADDY_PROXY_IMAGE" lock_version="$PC_STACK_VERSION"
  unset PC_POSTGRES_IMAGE PC_N8N_IMAGE PC_CONTROL_API_IMAGE PC_WEB_IMAGE PC_CADDY_PROXY_IMAGE PC_STACK_VERSION
  # shellcheck disable=SC1090
  source "${SNAPSHOT_DIR}/stack.env"
  [[ "$PC_POSTGRES_IMAGE" == "$lock_postgres" && "$PC_N8N_IMAGE" == "$lock_n8n" \
     && "$PC_CONTROL_API_IMAGE" == "$lock_api" && "$PC_WEB_IMAGE" == "$lock_web" \
     && "$PC_CADDY_PROXY_IMAGE" == "$lock_caddy" && "$PC_STACK_VERSION" == "$lock_version" ]]
); then
  die "rollback point ${TARGET_ID} has inconsistent versions.lock.env and stack.env; nothing was changed"
fi
current_checkpoint_max=""
pg_cid="$(container_id postgres)"
if [[ -n "$pg_cid" ]] && secret_exists pg_control_app_password; then
  current_checkpoint_max="$(docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -tAc 'SELECT COALESCE(max(snapshot_version),1) FROM project_checkpoints' 2>/dev/null || true)"
fi
if [[ ! "$current_checkpoint_max" =~ ^[0-9]+$ ]] && (( ! FORCE )); then
  die "cannot verify checkpoint reader compatibility; restore database access or re-run with --force after backup/restore review"
fi
if [[ "$current_checkpoint_max" =~ ^[0-9]+$ && "$target_checkpoint_reader_max" =~ ^[0-9]+$ ]] \
   && (( current_checkpoint_max > target_checkpoint_reader_max )) && (( ! FORCE )); then
  die "rollback target is only proven through checkpoint v${target_checkpoint_reader_max}, but the database contains v${current_checkpoint_max}; use a v3-capable target or re-run with --force after backup/restore review"
fi

log_step "Rolling back to ${TARGET_ID} (stack ${TARGET_VERSION})"

if (( ! AUTO )); then
  cat >&2 <<WARNING

  This will:
    * restore the previous version lock, compose file and stack.env
    * recreate every container from the previously running images
    * restore the snapshotted runner binary when present

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
while IFS='=' read -r service image_id; do
  [[ "$service" == \#* || -z "$service" || -z "$image_id" ]] && continue
  if docker image inspect "$image_id" >/dev/null 2>&1; then
    log_ok "${service}: image present"
  elif [[ "$service" == "control-api" || "$service" == "web" || "$service" == "caddy" ]]; then
    log_error "${service}: locally built image ${image_id:0:20}… is unavailable"
    missing=1
  else
    log_warn "${service}: pinned third-party image is not local and will be re-pulled"
  fi
done <"${SNAPSHOT_DIR}/running-images.env"

if (( missing )); then
  die "rollback target is not locally recoverable because an exact application image was pruned; nothing was changed"
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
cp -p "${PC_ROOT}/runner/bin/project-control-runner" "${FAILED_DIR}/" 2>/dev/null || true

install_file "${SNAPSHOT_DIR}/versions.lock.env" "${PC_ROOT}/config/versions.lock.env" 0644
install_file "${SNAPSHOT_DIR}/compose.yaml"      "${PC_ROOT}/compose/compose.yaml" 0644
install_file "${SNAPSHOT_DIR}/stack.env"         "${PC_ROOT}/config/stack.env" 0640
if [[ -f "${SNAPSHOT_DIR}/checkpoint-reader-max-version" ]]; then
  install_file "${SNAPSHOT_DIR}/checkpoint-reader-max-version" \
               "${PC_ROOT}/config/checkpoint-reader-max-version" 0644
else
  reader_tmp="$(mktemp)"
  printf '%s\n' "$target_checkpoint_reader_max" >"$reader_tmp"
  install_file "$reader_tmp" "${PC_ROOT}/config/checkpoint-reader-max-version" 0644
  rm -f "$reader_tmp"
fi
chown root:root "${PC_ROOT}/config/stack.env"

if [[ -f "${SNAPSHOT_DIR}/project-control-runner" ]]; then
  install_file "${SNAPSHOT_DIR}/project-control-runner" "${PC_ROOT}/runner/bin/project-control-runner" 0750
  chown project-runner:project-control "${PC_ROOT}/runner/bin/project-control-runner"
  if ! systemctl restart project-control-runner.service || ! wait_for_runner_ready; then
    rollback_incomplete runner_restart "restored runner did not become ready; inspect project-control-runner.service"
  fi
  log_ok "runner binary restored and service restarted"
else
  log_warn "rollback point predates runner snapshots; current runner binary was retained"
fi

log_ok "configuration restored"

# -----------------------------------------------------------------------------
log_step "Recreating containers"
# -----------------------------------------------------------------------------
load_versions "${PC_ROOT}/config/versions.lock.env"
load_stack_env

# Local application image tags are mutable. Reattach them to the exact image
# IDs captured before update so Compose really starts the prior API/web/proxy.
if [[ -f "${SNAPSHOT_DIR}/running-images.env" ]]; then
  while IFS='=' read -r service image_id; do
    [[ "$service" == \#* || -z "$service" || -z "$image_id" ]] && continue
    target_ref=""
    case "$service" in
      control-api) target_ref="$PC_CONTROL_API_IMAGE" ;;
      web) target_ref="$PC_WEB_IMAGE" ;;
      caddy) target_ref="$PC_CADDY_PROXY_IMAGE" ;;
    esac
    if [[ -n "$target_ref" ]]; then
      if ! docker image inspect "$image_id" >/dev/null 2>&1; then
        rollback_incomplete image_restore "recorded ${service} image became unavailable: ${image_id}"
      fi
      if ! docker image tag "$image_id" "$target_ref"; then
        rollback_incomplete image_restore "could not retag the exact ${service} target image"
      fi
      log_ok "${service}: restored exact image ${image_id:0:20}…"
    fi
  done <"${SNAPSHOT_DIR}/running-images.env"
fi

for image in "${PC_POSTGRES_IMAGE}" "${PC_N8N_IMAGE}" "${PC_CADDY_IMAGE}"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    log_info "re-pulling ${image}"
    docker pull --quiet "$image" >/dev/null \
      || rollback_incomplete image_restore "could not restore required pinned image ${image}"
  }
done

if compose up --detach --remove-orphans --wait --wait-timeout 300; then
  log_ok "containers recreated from the previous version"
else
  compose ps
  rollback_incomplete compose_up "the target stack did not become healthy; see docs/troubleshooting.md"
fi

running_images_match_snapshot "${SNAPSHOT_DIR}/running-images.env" \
  || rollback_incomplete image_reconciliation "one or more running containers do not use the exact captured image ID"
log_ok "all five services match the exact rollback image target"

# -----------------------------------------------------------------------------
log_step "Verifying"
# -----------------------------------------------------------------------------
# Recreating containers races the same way an update does: "Healthy" does not
# mean Caddy's upstream connection to control-api has come up yet. Wait for
# the route to genuinely answer before handing off to verify.sh, instead of
# guessing with a fixed sleep. A missed deadline is an incomplete rollback,
# not a warning that can be followed by a success audit.
if ! wait_for_api_route "http://127.0.0.1:8780/api/auth/me" 401; then
  rollback_incomplete api_readiness "the restored Control API route did not become ready"
fi
if bash "${PC_SCRIPTS_DIR}/verify.sh"; then
  log_ok "verification passed after rollback"
else
  rollback_incomplete strict_verification "pcctl verify reported one or more failures"
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
