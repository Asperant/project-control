#!/usr/bin/env bash
# =============================================================================
# resume-update.sh — completes an update that was interrupted before its
# pending migration(s) were ever applied, when postgres/n8n/(web) are healthy
# but one or more locally-built services (control-api, web, caddy) are stuck
# in Docker's `created` state — container *start* failed (an OCI runtime
# error, not a slow-start race) partway through the SAME `compose up` that
# `update.sh` step 6 already writes the new versions.lock.env/stack.env
# before running.
#
# WHY THIS IS DIFFERENT FROM recover-deployment.sh, AND WHY NEITHER TOOL
# SHOULD BE MADE TO COVER THE OTHER'S CASE
#
# recover-deployment.sh exists for the incident where the database is
# already fully caught up to the current repository (RCV-007: nothing
# pending) — it is deliberately, permanently incapable of ever applying a
# migration, because in that incident recreating containers is the entire
# fix and advancing the schema would be an unrelated, unauthorised action.
#
# This script exists for the DIFFERENT incident where the pending
# migration(s) were interrupted before ever being committed — proven, not
# assumed, by:
#   * the database's applied ledger being a strict subset of the current
#     repository's migrations (no drift — RSU-006, identical to RCV-006), and
#   * at least one migration genuinely pending (RSU-007 — the inverse of
#     recover-deployment's RCV-007: if nothing is pending, THIS is the wrong
#     tool; recover-deployment.sh is).
# Completing this interrupted update necessarily means the pending
# migration(s) get applied for the first time. That is never done by this
# script directly — it happens exactly the way `update.sh` itself would
# always do it: control-api's own entrypoint (apps/control-api/src/db/
# migrate.ts, idempotent, checksum-verified) runs the real migration on a
# successful container start. This script's job is narrowly to make that
# start finally succeed against the CURRENT, corrected compose/config, with
# every safeguard update.sh itself applies before touching the schema:
#   * a migration dry-run against the currently staged compose (transaction
#     rolled back — the same true no-op update.sh's own step 4 performs),
#   * a scan for irreversible migrations (DROP TABLE/COLUMN/DATABASE/SCHEMA,
#     TRUNCATE) — hard refusal, no override, ever. update.sh itself allows
#     `--force` past this gate because an operator running a live update can
#     make that call in the moment; a recovery script run against an already
#     -interrupted deployment does not get that latitude here.
#   * a genuinely FRESH backup taken by this run (not merely "a backup
#     exists somewhere"), because this run is the one that will actually
#     advance the schema — recover-deployment.sh only ever recreates
#     containers, so an existing backup is boundary enough for it; this
#     script is not that case.
#
# WHY NOT JUST WEAKEN update.sh's OWN COHERENCE GATE INSTEAD
#
# `deployment_images_match_lock()` (lib/common.sh) compares a container's own
# stored `.Image` (frozen at `docker create` time, and never updated again
# even if the backing image object is later removed from the image store)
# against what the deployed lock's image reference currently resolves to.
# For a container stuck `created` from an interrupted update, that frozen
# value can never again be reproduced by a fresh build — this project's
# image build (BuildKit, multi-arch manifest + attestation export) produces
# a distinct top-level image ID on every invocation even when every
# filesystem layer is a full cache hit. So update.sh's own gate, exactly as
# designed, is structurally incapable of ever re-passing while these
# containers remain `created` — not because it is broken, but because it
# was built to prove an ALREADY-deployed stack is self-consistent, never to
# repair one still mid-deployment. Weakening it to tolerate this would also
# weaken it for a deployment that is incoherent for a real, unrelated
# reason — exactly what must not happen. This script does not touch that
# gate; it recreates the specific broken containers first, then hands off
# to the real, unmodified reconcile-state.sh, whose own preconditions only
# become true once recovery has actually succeeded — the same handoff
# recover-deployment.sh already uses, for the same reason.
#
# WHAT THIS SCRIPT NEVER DOES
#
#   * Never touches postgres or n8n — not in its recreate scope, ever.
#   * Never applies a migration itself. It never runs raw SQL and never
#     calls migrate.js in anything but --dry-run mode; the only thing that
#     ever commits SQL is control-api's own entrypoint on a real start.
#   * Never accepts --force or any override flag — irreversible migrations,
#     an unreachable backup, or an unhealthy dependency are refused outright,
#     with no policy waiver, the same stance recover-deployment.sh and
#     reconcile-state.sh already take.
#   * Never retags an image by hand and never rebuilds an OLD image to
#     impersonate a rollback target. The only images it ever deploys come
#     from a normal, deterministic build.sh run against the CURRENT
#     repository checkout.
#   * Never publishes a new rollback point itself. On success it hands off
#     to the real, unmodified reconcile-state.sh.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions
load_stack_env

while [[ $# -gt 0 ]]; do
  case "$1" in
    *) die "unknown argument: $1 (resume-update accepts no override flags, including --force — every check here is a precondition, not a policy waiver)" ;;
  esac
done

LOCALLY_BUILT_SERVICES=(control-api web caddy)
STATEFUL_SERVICES=(postgres n8n)

notify() { bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" "$1" >/dev/null 2>&1 || true; }
audit()  {
  local pg_cid; pg_cid="$(container_id postgres)"
  [[ -n "$pg_cid" ]] || return 0
  docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -q -c \
    "INSERT INTO audit_events (event_type, outcome, subject, detail)
     VALUES ('$1', '$2', 'resume-update', '$3'::jsonb)" >/dev/null 2>&1 || true
}

# =============================================================================
log_step "Preflight — proving this is the specific, narrow incident this tool repairs"
# =============================================================================

# --- RSU-001 / RSU-002: stateful services this script never touches --------
stateful_ok=1
rsu_id=0
for service in "${STATEFUL_SERVICES[@]}"; do
  rsu_id=$((rsu_id+1))
  health="$(container_health "$service")"
  if [[ "$health" == "healthy" || "$health" == "running" ]]; then
    record_check PASS "RSU-00${rsu_id}" "${service} is healthy" "$health"
  else
    record_check FAIL "RSU-00${rsu_id}" "${service} is not healthy — this is a different, more serious incident" "state=${health}"
    stateful_ok=0
  fi
done
if (( ! stateful_ok )); then
  record_check FAIL RSU-000 "aborting before any change" "postgres and/or n8n are unhealthy; this script only ever recreates locally-built application services and refuses when its stateful dependencies are not already sound"
  print_check_summary
  exit 1
fi

# --- RSU-003 / RSU-004 / RSU-005: exactly which locally-built services need
#     recovery: stuck `created`, OR healthy but running an image other than
#     what the deployed lock currently specifies (compose recreates services
#     one at a time — an interrupted run can leave some already-recreated
#     services healthy while others never got their turn). Same comparison
#     update.sh's own coherence gate and reconcile-state.sh's REC-003 already
#     trust, reused here for scope detection. -------------------------------
expected_ref_for() {
  case "$1" in
    control-api) printf '%s' "${PC_CONTROL_API_IMAGE:-}" ;;
    web)         printf '%s' "${PC_WEB_IMAGE:-}" ;;
    caddy)       printf '%s' "${PC_CADDY_PROXY_IMAGE:-}" ;;
  esac
}
declare -a TARGET_SERVICES=()
scope_ok=1
for service in "${LOCALLY_BUILT_SERVICES[@]}"; do
  health="$(container_health "$service")"
  case "$health" in
    healthy|running)
      cid="$(container_id "$service")"
      expected_ref="$(expected_ref_for "$service")"
      running_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
      expected_id="$(docker image inspect --format '{{.Id}}' "$expected_ref" 2>/dev/null || true)"
      if [[ -n "$running_id" && -n "$expected_id" && "$running_id" == "$expected_id" ]]; then
        record_check PASS RSU-003 "${service} is already healthy and running the current build" "$health — not in this run's recovery scope"
      else
        record_check PASS RSU-004 "${service} is healthy but not running the currently deployed build" \
          "state=${health}; expected=${expected_ref}; will be recreated to match the current repository build"
        TARGET_SERVICES+=("$service")
      fi
      ;;
    created)
      record_check PASS RSU-004 "${service} is unhealthy in the one state this script repairs" "state=created"
      TARGET_SERVICES+=("$service")
      ;;
    *)
      record_check FAIL RSU-004 "${service} is unhealthy in a state this script does not know how to repair" \
        "state=${health} — investigate manually (docker logs, docker inspect); this is not the created-container incident"
      scope_ok=0
      ;;
  esac
done
if (( ! scope_ok )); then
  record_check FAIL RSU-000 "aborting before any change" "an unhealthy service is not in the specific 'created' state this script is proven safe against"
  print_check_summary
  exit 1
fi
if (( ${#TARGET_SERVICES[@]} == 0 )); then
  record_check FAIL RSU-000 "aborting before any change" "every service is already healthy — there is nothing for this script to resume; if metadata looks stale, run: sudo ./pcctl reconcile-state"
  print_check_summary
  exit 1
fi
target_services_str="$(IFS=' '; echo "${TARGET_SERVICES[*]}")"
record_check PASS RSU-005 "Recovery scope is exactly the locally-built, currently-created service(s)" "$target_services_str"

# --- RSU-006 / RSU-007: the database's applied ledger against the CURRENT
#     repository's migrations must be a clean subset with NOTHING drifted —
#     but, unlike recover-deployment.sh, this tool exists ONLY when at least
#     one migration is genuinely still pending. -----------------------------
pg_cid="$(container_id postgres)"
migration_state_ok=1
applied_versions=""
if [[ -n "$pg_cid" ]] && secret_exists pg_control_app_password; then
  applied_versions="$(docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -tAc 'SELECT version FROM schema_migrations ORDER BY version' 2>/dev/null || true)"
  if [[ -z "$applied_versions" ]]; then
    record_check FAIL RSU-006 "Could not read the applied migration ledger" ""
    migration_state_ok=0
  else
    missing=""
    while IFS= read -r version; do
      [[ -n "$version" ]] || continue
      if ! compgen -G "${PC_REPO_ROOT}/migrations/${version}_*.sql" >/dev/null; then
        missing+="${version} "
      fi
    done <<<"$applied_versions"
    if [[ -n "$missing" ]]; then
      record_check FAIL RSU-006 "Applied migration(s) have no matching file in the current repository" "${missing}— database is ahead of this repository checkout; this is a different, more serious incident"
      migration_state_ok=0
    else
      record_check PASS RSU-006 "Applied migration ledger is a clean subset of the current repository's migrations — no drift" ""
    fi
  fi
else
  record_check FAIL RSU-006 "Cannot verify migration ledger compatibility" "database is not reachable"
  migration_state_ok=0
fi
if (( ! migration_state_ok )); then
  record_check FAIL RSU-000 "aborting before any change" "migration ledger checks failed"
  print_check_summary
  exit 1
fi

declare -a PENDING_MIGRATIONS=()
for migration in "${PC_REPO_ROOT}"/migrations/*.sql; do
  [[ -f "$migration" ]] || continue
  name="$(basename "$migration")"; version="${name%%_*}"
  grep -qx "$version" <<<"$applied_versions" || PENDING_MIGRATIONS+=("$migration")
done
if (( ${#PENDING_MIGRATIONS[@]} == 0 )); then
  record_check FAIL RSU-007 "No migration is pending — this is not the incident this tool repairs" \
    "the created container(s) are stuck for a reason unrelated to a pending migration; use: sudo ./pcctl recover-deployment"
  record_check FAIL RSU-000 "aborting before any change" "nothing pending"
  print_check_summary
  exit 1
fi
record_check PASS RSU-007 "Migration(s) genuinely pending — this is the incident this tool repairs" "${#PENDING_MIGRATIONS[@]} pending"

# --- RSU-008: irreversible-migration scan — hard refusal, no override, ever.
#     Identical detection to update.sh's own step 5, but with no --force
#     escape: a recovery run does not get to make that judgement call. ------
irreversible=""
for migration in "${PENDING_MIGRATIONS[@]}"; do
  name="$(basename "$migration")"
  if grep -qiE '^\s*(DROP\s+(TABLE|COLUMN|DATABASE|SCHEMA)|ALTER\s+TABLE\s+\S+\s+DROP\s+COLUMN|TRUNCATE)' "$migration"; then
    irreversible+="  - ${name}"$'\n'
  fi
done
if [[ -n "$irreversible" ]]; then
  log_error "Pending migration(s) contain irreversible data changes:"
  printf '%s' "$irreversible" >&2
  record_check FAIL RSU-008 "Pending migration(s) are irreversible" "a recovery run never overrides this — review manually, confirm the backup, then use an unblocked 'sudo ./pcctl update' with its own --force instead"
  record_check FAIL RSU-000 "aborting before any change" "irreversible pending migration"
  print_check_summary
  exit 1
fi
record_check PASS RSU-008 "No pending migration is irreversible" ""

# --- RSU-009: runner readiness. --------------------------------------------
if wait_for_runner_ready 15 0.5; then
  record_check PASS RSU-009 "Runner is ready via the bounded typed health helper" ""
else
  record_check FAIL RSU-009 "Runner is not ready" "system.health did not succeed"
  record_check FAIL RSU-000 "aborting before any change" "runner is not ready"
  print_check_summary
  exit 1
fi

# --- RSU-010: a FRESH backup, taken by this run — not merely "one exists
#     somewhere". This run is about to advance the schema for real; recover-
#     deployment.sh's weaker "a successful backup is on record" check is not
#     enough here, for the same reason update.sh always takes one first. ---
log_step "Pre-recovery backup (this run is about to apply a real migration)"
if bash "${PC_SCRIPTS_DIR}/backup.sh"; then
  record_check PASS RSU-010 "Fresh backup completed — the database recovery boundary for this run" ""
else
  rc=$?
  if (( rc == 2 )); then
    record_check FAIL RSU-010 "Backup is not configured (manual checkpoint pending)" "no override exists for this — complete the Google Drive checkpoint first"
  else
    record_check FAIL RSU-010 "Backup FAILED" ""
  fi
  record_check FAIL RSU-000 "aborting before any change" "no fresh backup boundary to recover behind"
  audit system.resume_update denied '{"stage":"backup"}'
  print_check_summary
  exit 1
fi

# --- RSU-011: the CURRENT repository's compose file, resolved for real. ---
compose_check_scratch="$(mktemp -d)"
cp "${PC_REPO_ROOT}/infra/compose/compose.yaml" "${compose_check_scratch}/compose.yaml"
if PC_ROOT="$PC_ROOT" docker compose --project-name "$PC_COMPOSE_PROJECT" --project-directory "$PC_ROOT" \
     --env-file "${PC_CONFIG_DIR}/stack.env" --file "${compose_check_scratch}/compose.yaml" \
     config --format json 2>/dev/null \
     | python3 "${PC_SCRIPTS_DIR}/lib/assert-config-mount.py" control-api /config; then
  record_check PASS RSU-011 "Current repository compose resolves to exactly one control-api /config mount, none nested" ""
  rm -rf -- "$compose_check_scratch"
else
  record_check FAIL RSU-011 "Current repository compose has an unsafe control-api mount" "the fix this recovery depends on is not actually present in this checkout"
  record_check FAIL RSU-000 "aborting before any change" "repository compose is not safe to deploy"
  rm -rf -- "$compose_check_scratch"
  print_check_summary
  exit 1
fi

print_check_summary
log_ok "preflight passed: resuming ${target_services_str} — postgres, n8n, and every other locally-built service already healthy remain untouched"

# =============================================================================
log_step "Rebuilding images (deterministic; same step 'update' always runs) — only the service(s) actually being recreated"
# =============================================================================
# --only <service> for each TARGET_SERVICES entry — see recover-deployment.sh
# for why: rebuilding a service outside this run's scope would retag it to a
# fresh (but functionally identical) image object without ever recreating
# its still-running container, silently orphaning the tag this deployment's
# lock currently, correctly, references.
build_only_args=()
for service in "${TARGET_SERVICES[@]}"; do
  build_only_args+=(--only "$service")
done
bash "${PC_SCRIPTS_DIR}/build.sh" "${build_only_args[@]}" || die "image build failed; nothing was changed"

# =============================================================================
log_step "Staging the current repository's compose/config"
# =============================================================================
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
for migration in "${PC_REPO_ROOT}"/migrations/*.sql; do
  [[ -f "$migration" ]] && install_file "$migration" "${PC_ROOT}/migrations/$(basename "$migration")" 0644
done
if ! compose config --format json 2>/dev/null \
     | python3 "${PC_SCRIPTS_DIR}/lib/assert-config-mount.py" control-api /config; then
  die "staged compose model has an unsafe control-api mount after staging; refusing to proceed — nothing was recreated"
fi
log_ok "staged compose/config verified: control-api has exactly one /config mount, none nested"

# =============================================================================
log_step "Migration dry-run (real transactional dry-run, rolled back — the final live confirmation before this run finally applies it for real)"
# =============================================================================
if compose run --rm --no-deps --entrypoint node control-api dist/cli/migrate.js --dry-run 2>&1 | redact_stream; then
  log_ok "migration dry-run passed"
else
  audit system.resume_update failure '{"stage":"migration_dry_run"}'
  die "migration dry-run FAILED; the schema and this repository's code do not agree — aborting before recreating anything or touching the database"
fi

# =============================================================================
log_step "Removing the specific 'created' container(s) being resumed"
# =============================================================================
for service in "${TARGET_SERVICES[@]}"; do
  cid="$(container_id "$service")"
  [[ -n "$cid" ]] || die "internal error: ${service} container disappeared between preflight and recovery"
  state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  case "$state" in
    created)
      docker rm "$cid" >/dev/null || die "could not remove the created ${service} container; nothing else was touched"
      log_ok "removed created container: ${service} (${cid:0:12})"
      ;;
    running)
      expected_ref="$(expected_ref_for "$service")"
      running_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
      expected_id="$(docker image inspect --format '{{.Id}}' "$expected_ref" 2>/dev/null || true)"
      if [[ -n "$running_id" && -n "$expected_id" && "$running_id" == "$expected_id" ]]; then
        die "internal error: ${service} now matches the currently deployed build — refusing to remove an up-to-date, healthy container"
      fi
      docker rm -f "$cid" >/dev/null || die "could not remove the stale-image ${service} container; nothing else was touched"
      log_ok "removed healthy-but-stale-image container: ${service} (${cid:0:12})"
      ;;
    *)
      die "internal error: ${service} is in an unexpected state (${state}) — refusing to remove a container this recovery run did not prove safe to remove"
      ;;
  esac
done

# =============================================================================
log_step "Recreating ${target_services_str} from the staged compose/config — this is where control-api's own entrypoint applies the pending migration(s) for real"
# =============================================================================
if ! compose up --detach --no-deps "${TARGET_SERVICES[@]}"; then
  audit system.resume_update failure '{"stage":"compose_up"}'
  die "recreation FAILED — ${target_services_str} did not come up. Do not assume partial success: inspect 'docker ps -a' and 'docker logs' before retrying anything. Do not re-run this tool blindly — check whether the migration actually committed (docker exec into postgres and query schema_migrations) before deciding next steps."
fi
log_ok "containers recreated"

# =============================================================================
log_step "Health gate — recovered service(s) only"
# =============================================================================
gate_passed=1
for attempt in $(seq 1 12); do
  gate_passed=1
  for service in "${TARGET_SERVICES[@]}"; do
    health="$(container_health "$service")"
    [[ "$health" == "healthy" || "$health" == "running" ]] || gate_passed=0
  done
  (( gate_passed )) && break
  log_info "waiting for health (attempt ${attempt}/12)"
  sleep 10
done
if (( gate_passed )) && [[ " ${target_services_str} " == *" control-api "* || " ${target_services_str} " == *" caddy "* ]]; then
  wait_for_api_route "http://127.0.0.1:8780/api/auth/me" 401 || gate_passed=0
fi
if (( ! gate_passed )); then
  audit system.resume_update failure '{"stage":"health_gate"}'
  die "health gate FAILED after recreation. Do not assume partial success: inspect 'docker logs' and confirm whether the migration committed before retrying anything."
fi
log_ok "health gate passed"

# =============================================================================
log_step "Strict verification — verify.sh and verify-security.sh, unmodified"
# =============================================================================
if ! bash "${PC_SCRIPTS_DIR}/verify.sh"; then
  audit system.resume_update failure '{"stage":"verification"}'
  die "verify.sh FAILED after recreation. Containers are up but the deployment is not proven correct — do not assume success."
fi
log_ok "verify.sh passed"
if ! bash "${PC_SCRIPTS_DIR}/verify-security.sh"; then
  audit system.resume_update failure '{"stage":"verification_security"}'
  die "verify-security.sh FAILED after recreation. Containers are up but the security posture is not proven correct — do not assume success."
fi
log_ok "verify-security.sh passed"

# =============================================================================
log_step "Handing off to reconcile-state for metadata/version-lock repair"
# =============================================================================
if bash "${PC_SCRIPTS_DIR}/reconcile-state.sh"; then
  log_ok "deployment metadata reconciled to the now-healthy, recovered stack"
else
  die "recreation and verification succeeded, but reconcile-state.sh could not repair the version lock — recreation succeeded; do not re-run this tool. Investigate reconcile-state's own output, then run it again by hand: sudo ./pcctl reconcile-state"
fi

audit system.resume_update success "$(printf '{"resumed":"%s","migrationsApplied":%d}' "$target_services_str" "${#PENDING_MIGRATIONS[@]}")"
notify "🛠️ Project Control: interrupted update resumed on $(hostname -s) — ${target_services_str} recovered, ${#PENDING_MIGRATIONS[@]} migration(s) applied, metadata reconciled"
log_ok "resume-update complete: ${target_services_str} recreated, migration(s) applied, health-gated, strictly verified, and metadata reconciled"
