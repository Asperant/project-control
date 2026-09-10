#!/usr/bin/env bash
# =============================================================================
# update.sh — safe stack update with an automatic rollback path.
#
# Sequence:
#   1. Back up (refuse to continue if the backup fails).
#   2. Snapshot the current version lock and the running image ids.
#   3. Verify every new image digest resolves, rebuild local images, THEN
#      stage the new compose file and automation config onto the deployment
#      root and verify the resolved compose model is safe — all before the
#      dry-run below, which reads the deployment root's compose file, not
#      the repository's. Staging late here was a real, live-reproduced bug:
#      see the comment above "Staging updated deployment configuration".
#   4. Migration dry-run — run the SQL for real, then roll it back. Uses
#      `compose run --no-deps`, a disposable one-off container; no running
#      application container is touched by this step.
#   5. Refuse to proceed if any pending migration is irreversible.
#   6. Recreate the stack (compose.yaml/config were already staged in 3).
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
# A rollback point is trustworthy only when the deployment it describes is
# already coherent. Refuse to snapshot the incident state where the restored
# lock/runner and still-running application images belong to different
# releases. This gate is intentionally not bypassed by --force.
log_info "checking pre-update deployment consistency"
load_versions "${PC_ROOT}/config/versions.lock.env"
load_stack_env
[[ -x "${PC_ROOT}/runner/bin/project-control-runner" ]] \
  || die "current runner binary is missing or not executable; refusing to create a misleading rollback point"
wait_for_runner_ready \
  || die "current runner is not ready; recover the deployment before creating a new rollback point"
runner_binary_matches_live_process "${PC_ROOT}/runner/bin/project-control-runner" \
  || die "installed runner bytes do not match systemd's live executable; restart and verify the runner before updating"
deployment_images_match_lock "${PC_ROOT}/config/versions.lock.env" "${PC_ROOT}/config/stack.env" || {
  log_error "the running containers do not match the deployed version lock"
  log_error "supported recovery: sudo ./pcctl rollback --list; sudo ./pcctl rollback --id <failed-stage7-update-id>; sudo ./pcctl verify"
  die "refusing to snapshot an inconsistent deployment; --force cannot bypass this coherence gate"
}
log_ok "pre-update deployment is coherent"

SNAPSHOT_DIR="$(mktemp -d "${PC_ROOT}/backups/.rollback-${RUN_ID}.pending.XXXXXXXX")"
ensure_dir "$SNAPSHOT_DIR" 0700 root root

cp -p "${PC_ROOT}/config/versions.lock.env" "${SNAPSHOT_DIR}/versions.lock.env"
cp -p "${PC_ROOT}/config/stack.env"         "${SNAPSHOT_DIR}/stack.env"
cp -p "${PC_ROOT}/compose/compose.yaml"     "${SNAPSHOT_DIR}/compose.yaml"
if [[ -f "${PC_ROOT}/runner/bin/project-control-runner" ]]; then
  cp -p "${PC_ROOT}/runner/bin/project-control-runner" "${SNAPSHOT_DIR}/project-control-runner"
fi

if [[ -f "${PC_ROOT}/config/checkpoint-reader-max-version" ]]; then
  checkpoint_reader_max="$(cat "${PC_ROOT}/config/checkpoint-reader-max-version")"
  [[ "$checkpoint_reader_max" =~ ^[1-9][0-9]*$ ]] \
    || die "deployed checkpoint reader capability is invalid; refusing to publish a rollback point"
  cp -p "${PC_ROOT}/config/checkpoint-reader-max-version" "${SNAPSHOT_DIR}/checkpoint-reader-max-version"
else
  printf '2\n' >"${SNAPSHOT_DIR}/checkpoint-reader-max-version"
fi

# Record the concrete image IDs currently running. Tags can move; IDs cannot.
running_images_tmp="$(mktemp "${SNAPSHOT_DIR}/.running-images.XXXXXXXX")"
{
  printf '# Image ids in use before update %s\n' "$RUN_ID"
  for service in postgres n8n control-api web caddy; do
    cid="$(container_id "$service")"
    [[ -n "$cid" ]] || die "container ${service} disappeared while recording the rollback point"
    printf '%s=%s\n' "$service" "$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null)"
  done
} >"$running_images_tmp"
validate_snapshot_image_manifest "$running_images_tmp" \
  || die "could not record a complete rollback image manifest"
mv -f "$running_images_tmp" "${SNAPSHOT_DIR}/running-images.env"
running_images_match_snapshot "${SNAPSHOT_DIR}/running-images.env" \
  || die "deployment changed while its rollback image manifest was being captured"
deployment_images_match_lock "${PC_ROOT}/config/versions.lock.env" "${PC_ROOT}/config/stack.env" \
  || die "deployment changed before rollback point publication; no rollback point was published"
chmod 0600 "${SNAPSHOT_DIR}"/*

# Publish only a fully validated rollback point. A crash during preparation
# leaves at most a hidden sibling under backups, never a selectable target in
# rollback --list.
published_snapshot="${ROLLBACK_DIR}/${RUN_ID}"
mv "$SNAPSHOT_DIR" "$published_snapshot"
SNAPSHOT_DIR="$published_snapshot"

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

log_step "Staging updated deployment configuration"
# -----------------------------------------------------------------------------
# The migration dry-run immediately below runs `compose run ...`, and
# compose() (lib/common.sh) reads ${PC_ROOT}/compose/compose.yaml — the
# DEPLOYED copy, not the repository's. Staging the new compose file (and the
# automation config it now sources /config from through a single mount —
# see infra/compose/compose.yaml's own comment on why that mount must stay
# singular) here, before the dry-run, is what makes the dry-run exercise the
# SAME compose model the real deployment is about to use.
#
# Running the dry-run against a stale deployed compose file is the exact bug
# that broke this update twice on the live host: fixing the repository's
# compose.yaml alone was not enough while this staging step still happened
# afterward, in "6/8 Applying the update" — so the dry-run kept reading the
# old, nested-mount compose file and failed at container *creation*, before
# `dist/cli/migrate.js` ever ran.
#
# This does not touch any running container. `compose run --no-deps` below
# creates a new, disposable one-off container from this staged file; the
# currently-running application containers are only ever replaced later, by
# `compose up` in "6/8 Applying the update", after both the dry-run and the
# irreversible-migration check have passed.
install_file "${PC_REPO_ROOT}/infra/compose/compose.yaml" "${PC_ROOT}/compose/compose.yaml" 0644
ensure_dir "${PC_ROOT}/config/status/automation" 0755 root root
ensure_dir "${PC_ROOT}/config/status/automation/workflows" 0755 root root
install_file "${PC_REPO_ROOT}/infra/n8n/workflows/manifest.json" \
             "${PC_ROOT}/config/status/automation/manifest.json" 0644
if compgen -G "${PC_REPO_ROOT}/infra/n8n/workflows/*.workflow.json" >/dev/null; then
  for workflow_file in "${PC_REPO_ROOT}"/infra/n8n/workflows/*.workflow.json; do
    install_file "$workflow_file" "${PC_ROOT}/config/status/automation/workflows/$(basename "$workflow_file")" 0644
  done
fi

# Deterministic check against the REAL resolved compose model — `docker
# compose config`, not a grep of the YAML source — so this catches the
# actual shape `compose run`/`compose up` would see, including anything
# --env-file interpolation or compose's own merge rules would change.
# Asserts the general failure class (no mount nested inside another on this
# service), not just this one incident's specific /config/automation path.
if ! compose config --format json 2>/dev/null \
     | python3 "${PC_SCRIPTS_DIR}/lib/assert-config-mount.py" control-api /config; then
  die "staged compose model has an unsafe control-api mount (nested under /config, or not exactly one /config mount); refusing to run the migration dry-run against it"
fi
log_ok "staged compose/config verified: control-api has exactly one /config mount, none nested"

# =============================================================================
log_step "4/8  Migration dry-run"
# =============================================================================
# The dry-run executes the SQL for real inside a transaction and then rolls it
# back. A syntax error or a constraint violation therefore surfaces now, while
# the old stack is still running and healthy.
api_cid="$(container_id control-api)"
if [[ -n "$api_cid" ]]; then
  # Use the image that was just built, not the still-running old container:
  # only the new image contains the pending migration files being validated.
  if compose run --rm --no-deps --entrypoint node control-api dist/cli/migrate.js --dry-run 2>&1 | redact_stream; then
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
PENDING_MIGRATIONS=0
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
  PENDING_MIGRATIONS=$((PENDING_MIGRATIONS+1))

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

rollback_or_require_restore() {
  local stage="$1"
  if (( PENDING_MIGRATIONS > 0 )); then
    log_error "automatic image rollback skipped: ${PENDING_MIGRATIONS} migration(s) may have advanced the database ledger"
    log_error "an older Control API image may refuse this schema; follow docs/disaster-recovery.md using the fresh pre-update backup"
    audit system.update failure "$(printf '{\"stage\":\"%s\",\"restoreRequired\":true}' "$stage")"
    notify "🔴 Project Control update FAILED on $(hostname -s); database restore review required before image rollback"
    return 1
  fi
  log_step "Rolling back automatically"
  bash "${PC_SCRIPTS_DIR}/rollback.sh" --auto
}

# =============================================================================
log_step "6/8  Applying the update"
# =============================================================================
install_file "${PC_REPO_ROOT}/infra/versions.lock.env" "${PC_ROOT}/config/versions.lock.env" 0644
# compose.yaml and the automation manifest/workflow registry were already
# staged above, in "Staging updated deployment configuration" — before the
# migration dry-run, which needs them current. install_file is idempotent
# (copies only when content differs), so nothing here needs to re-stage
# them; re-listing them would just be a confusing, redundant no-op.
install_file "${PC_REPO_ROOT}/infra/caddy/Caddyfile" "${PC_ROOT}/config/caddy/Caddyfile" 0644
install_file "${PC_REPO_ROOT}/config/checkpoint-reader-max-version" "${PC_ROOT}/config/checkpoint-reader-max-version" 0644
for migration in "${PC_REPO_ROOT}"/migrations/*.sql; do
  [[ -f "$migration" ]] && install_file "$migration" "${PC_ROOT}/migrations/$(basename "$migration")" 0644
done
for script in backup.sh restore-test.sh verify.sh verify-security.sh telegram-notify.sh; do
  [[ -f "${PC_SCRIPTS_DIR}/${script}" ]] && install_file "${PC_SCRIPTS_DIR}/${script}" "${PC_ROOT}/scripts/${script}" 0750
done
ensure_dir "${PC_ROOT}/scripts/lib" 0755 root root
install_file "${PC_SCRIPTS_DIR}/lib/common.sh" "${PC_ROOT}/scripts/lib/common.sh" 0644
for doc in "${PC_REPO_ROOT}"/docs/*.md; do
  [[ -f "$doc" ]] && install_file "$doc" "${PC_ROOT}/docs/$(basename "$doc")" 0644
done

new_runner="${PC_REPO_ROOT}/apps/runner/bin/project-control-runner"
[[ -f "$new_runner" ]] || die "new runner binary is missing after build"
install_file "$new_runner" "${PC_ROOT}/runner/bin/project-control-runner" 0750
chown project-runner:project-control "${PC_ROOT}/runner/bin/project-control-runner"
if ! systemctl restart project-control-runner.service \
   || ! wait_for_runner_ready; then
  log_error "updated runner failed to restart"
  audit system.update failure '{"stage":"runner_restart"}'
  rollback_or_require_restore runner_restart || true
  exit 1
fi
log_ok "runner binary installed and service restarted"

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
  rollback_or_require_restore compose_up || true
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
  # Containers reporting Healthy does not yet guarantee Caddy's upstream
  # connection to control-api is ready — a transient 503 here is a startup
  # race, not a failure. wait_for_api_route (lib/common.sh) retries that
  # specific signature within a bounded deadline; anything else (an
  # unexpected 200, a persistent non-503 error) still fails immediately.
  wait_for_api_route "http://127.0.0.1:8780/api/auth/me" 401 || gate_passed=0
fi

if (( ! gate_passed )); then
  log_error "health gate FAILED after the update"
  audit system.update failure '{"stage":"health_gate"}'
  rollback_or_require_restore health_gate || true
  exit 1
fi
log_ok "health gate passed"

# =============================================================================
log_step "8/8  Post-update verification"
# =============================================================================
if bash "${PC_SCRIPTS_DIR}/verify.sh"; then
  log_ok "verification passed"
else
  log_error "verification FAILED after the update"
  audit system.update failure '{"stage":"verification"}'
  notify "🔴 Project Control update verification FAILED on $(hostname -s); manual review required"
  exit 1
fi

audit system.update success "$(printf '{"version":"%s"}' "$PC_STACK_VERSION")"

# Keep the five most recent rollback points.
find "$ROLLBACK_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +6 | cut -d' ' -f2- | xargs -r rm -rf

log_ok "update complete: version ${PC_STACK_VERSION}"
log_info "rollback point: ${RUN_ID} (sudo ./pcctl rollback)"
notify "✅ Project Control updated to ${PC_STACK_VERSION} on $(hostname -s)"
