#!/usr/bin/env bash
# =============================================================================
# recover-deployment.sh — forward repair of a deployment stuck exactly the
# way `update` can leave one: postgres/n8n healthy, and one or more of the
# locally-built application services (control-api, web, caddy) either stuck
# in Docker's `created` state because container *start* itself failed (an
# OCI runtime error, not a slow-start race) partway through `compose up`, OR
# healthy but still running the OLD image because `compose up` recreates
# services one at a time and got interrupted before reaching them — a
# healthy service on the wrong image is just as incomplete a deployment as a
# `created` one, and is detected the same way update.sh's own coherence gate
# (deployment_images_match_lock) and reconcile-state.sh's REC-003 already
# compare running image against deployed lock — not a new mechanism, reused
# here for scope detection instead of for blocking.
#
# WHY THIS IS NOT `update --force` AND NOT `reconcile-state` MADE BROADER
#
# `update` refuses to publish a NEW rollback point (and therefore refuses to
# proceed at all) unless the deployment it is about to snapshot is already
# coherent — deliberately: a rollback point built from a broken deployment
# would be worthless, and `update`'s own migration dry-run must run against
# the currently-deployed compose file, not a hypothetical fixed one.
# `reconcile-state` refuses even harder: by design it never recreates,
# restarts or rebuilds anything — it only repairs *metadata* to describe an
# already-healthy, already-verified stack (see its own header comment).
# Neither tool is wrong to refuse here, and neither should be weakened to
# stop refusing: an "unhealthy/created stack" and a "healthy stack with
# stale bookkeeping" are genuinely different situations needing genuinely
# different tools. This script is the missing piece between them — and
# only that piece: recreate the specific services actually broken, prove
# the result is healthy the same way `update` and `verify` already would,
# then hand off to the unmodified `reconcile-state` for the metadata repair
# it already knows how to do correctly.
#
# WHAT THIS SCRIPT PROVES BEFORE TOUCHING ANYTHING (RCV-001..010)
#
#   * postgres and n8n are healthy and untouched by this script's scope —
#     if either is unhealthy, this is a different, more serious incident
#     this script must not attempt to paper over.
#   * at least one, and only, locally-built service (control-api, web,
#     caddy — see LOCALLY_BUILT_SERVICES) is unhealthy; if all five
#     services are already healthy there is nothing for this script to do
#     (that is reconcile-state's job).
#   * every unhealthy service is specifically in Docker's `created` state —
#     the one failure mode this script is proven safe against. Any other
#     unhealthy state (exited, restarting, dead, ...) is a different
#     incident class this script refuses rather than guesses about.
#   * the database's applied migration ledger is a subset of the CURRENT
#     repository's migrations, AND there is nothing pending — this script
#     recreates containers, it never advances the schema. A pending
#     migration means the real fix is an unblocked `update`, not this.
#   * the runner is ready, a successful backup exists (the database
#     recovery boundary this whole operation is bounded by), and the
#     current repository's compose file resolves to a control-api service
#     with exactly one /config mount and none nested inside another (the
#     exact defect this whole recovery exists because of — verified with a
#     real `docker compose config` render, not a source-file grep).
#
# WHAT THIS SCRIPT NEVER DOES
#
#   * Never touches postgres or n8n — they are not in its recreate scope,
#     ever, regardless of arguments.
#   * Never applies a migration. The dry-run it runs is the same true
#     no-op `update` uses (transaction rolled back).
#   * Never accepts --force or any override flag — every check above is a
#     precondition for this being safe, not a policy an operator can waive
#     (the same stance reconcile-state.sh already takes, for the same
#     reason).
#   * Never retags an image by hand. The images it deploys come from a
#     normal, deterministic `build.sh` run — the same step `update`'s own
#     step 3 always performs — never a specific historical image ID pinned
#     by name.
#   * Never publishes a new rollback point itself. On success it hands off
#     to the real, unmodified reconcile-state.sh, whose own preconditions
#     (REC-001..012) will only be true if recovery actually succeeded.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions
load_stack_env

while [[ $# -gt 0 ]]; do
  case "$1" in
    *) die "unknown argument: $1 (recover-deployment accepts no override flags, including --force — every check here is a precondition, not a policy waiver)" ;;
  esac
done

LOCALLY_BUILT_SERVICES=(control-api web caddy)
STATEFUL_SERVICES=(postgres n8n)

notify() { bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" "$1" >/dev/null 2>&1 || true; }

# =============================================================================
log_step "Preflight — proving this is the specific, narrow incident this tool repairs"
# =============================================================================

# --- RCV-001 / RCV-002: the stateful services this script never touches ----
stateful_ok=1
rcv_id=0
for service in "${STATEFUL_SERVICES[@]}"; do
  rcv_id=$((rcv_id+1))
  health="$(container_health "$service")"
  if [[ "$health" == "healthy" || "$health" == "running" ]]; then
    record_check PASS "RCV-00${rcv_id}" "${service} is healthy" "$health"
  else
    record_check FAIL "RCV-00${rcv_id}" "${service} is not healthy — this is a different, more serious incident" "state=${health}"
    stateful_ok=0
  fi
done
if (( ! stateful_ok )); then
  record_check FAIL RCV-000 "aborting before any change" "postgres and/or n8n are unhealthy; this script only ever recreates locally-built application services and refuses when its stateful dependencies are not already sound"
  print_check_summary
  exit 1
fi

# --- RCV-003 / RCV-004 / RCV-005: exactly which locally-built services need
#     recovery: either stuck `created`, OR healthy but running an image other
#     than what the deployed lock currently specifies. The second case is not
#     hypothetical: an interrupted update can leave some locally-built
#     services successfully recreated to the new build while others got stuck
#     `created` (compose recreates services one at a time) — a healthy
#     service on the OLD image is just as much an incomplete deployment as a
#     `created` one, and `container_health` alone cannot see it. The exact
#     same comparison update.sh's own coherence gate
#     (deployment_images_match_lock, lib/common.sh) and reconcile-state.sh's
#     REC-003 already trust is reused here — not a new mechanism, just
#     applied to scope detection instead of to blocking. -------------------
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
        record_check PASS RCV-003 "${service} is already healthy and running the current build" "$health — not in this run's recovery scope"
      else
        record_check PASS RCV-004 "${service} is healthy but not running the currently deployed build" \
          "state=${health}; expected=${expected_ref}; will be recreated to match the current repository build"
        TARGET_SERVICES+=("$service")
      fi
      ;;
    created)
      record_check PASS RCV-004 "${service} is unhealthy in the one state this script repairs" "state=created"
      TARGET_SERVICES+=("$service")
      ;;
    *)
      record_check FAIL RCV-004 "${service} is unhealthy in a state this script does not know how to repair" \
        "state=${health} — investigate manually (docker logs, docker inspect); this is not the created-container incident"
      scope_ok=0
      ;;
  esac
done
if (( ! scope_ok )); then
  record_check FAIL RCV-000 "aborting before any change" "an unhealthy service is not in the specific 'created' state this script is proven safe against"
  print_check_summary
  exit 1
fi
if (( ${#TARGET_SERVICES[@]} == 0 )); then
  record_check FAIL RCV-000 "aborting before any change" "every service is already healthy and running the currently deployed build — there is nothing for this script to recover; if metadata (versions.lock.env/stack.env) looks stale, run: sudo ./pcctl reconcile-state"
  print_check_summary
  exit 1
fi
# IFS is $'\n\t' for the whole script (see the top-level strict-mode setup
# every pcctl script shares); "${TARGET_SERVICES[*]}" would silently join
# with a newline instead of a space, breaking both the space-bounded
# substring match below (target_services_str) and every log line that
# lists more than one service. Joined explicitly, once, here.
target_services_str="$(IFS=' '; echo "${TARGET_SERVICES[*]}")"
record_check PASS RCV-005 "Recovery scope is exactly the locally-built, currently-created service(s)" "$target_services_str"

# --- RCV-006 / RCV-007: the database's applied ledger against the CURRENT
#     repository's migrations — a subset, and nothing pending. Recovery
#     recreates containers; it must never become a side door for a schema
#     change that belongs to `update` instead. -------------------------------
pg_cid="$(container_id postgres)"
migration_ok=1
if [[ -n "$pg_cid" ]] && secret_exists pg_control_app_password; then
  applied_versions="$(docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -tAc 'SELECT version FROM schema_migrations ORDER BY version' 2>/dev/null || true)"
  if [[ -z "$applied_versions" ]]; then
    record_check FAIL RCV-006 "Could not read the applied migration ledger" ""
    migration_ok=0
  else
    missing=""
    while IFS= read -r version; do
      [[ -n "$version" ]] || continue
      if ! compgen -G "${PC_REPO_ROOT}/migrations/${version}_*.sql" >/dev/null; then
        missing+="${version} "
      fi
    done <<<"$applied_versions"
    if [[ -n "$missing" ]]; then
      record_check FAIL RCV-006 "Applied migration(s) have no matching file in the current repository" "${missing}— database is ahead of this repository checkout"
      migration_ok=0
    else
      record_check PASS RCV-006 "Applied migration ledger is a subset of the current repository's migrations" ""
    fi

    pending=0
    for migration in "${PC_REPO_ROOT}"/migrations/*.sql; do
      [[ -f "$migration" ]] || continue
      name="$(basename "$migration")"; version="${name%%_*}"
      grep -qx "$version" <<<"$applied_versions" || pending=$((pending+1))
    done
    if (( pending > 0 )); then
      record_check FAIL RCV-007 "The current repository has pending migration(s) this script will not apply" "${pending} pending — use an unblocked 'sudo ./pcctl update' instead, not recovery"
      migration_ok=0
    else
      record_check PASS RCV-007 "No pending migrations — recovery only ever recreates containers, never advances the schema" ""
    fi
  fi
else
  record_check FAIL RCV-006 "Cannot verify migration ledger compatibility" "database is not reachable"
  migration_ok=0
fi
if (( ! migration_ok )); then
  record_check FAIL RCV-000 "aborting before any change" "migration ledger checks failed"
  print_check_summary
  exit 1
fi

# --- RCV-008: runner readiness, the same bounded typed helper update.sh and
#     reconcile-state.sh already trust. Read-only; restarts nothing. --------
if wait_for_runner_ready 15 0.5; then
  record_check PASS RCV-008 "Runner is ready via the bounded typed health helper" ""
else
  record_check FAIL RCV-008 "Runner is not ready" "system.health did not succeed"
  record_check FAIL RCV-000 "aborting before any change" "runner is not ready"
  print_check_summary
  exit 1
fi

# --- RCV-009: a successful backup exists — the database recovery boundary
#     this whole operation is bounded by. Existence and last result only;
#     this script does not invent a numeric freshness policy. -------------
BACKUP_STATUS_FILE="${PC_ROOT}/config/status/backup-status.json"
if [[ -f "$BACKUP_STATUS_FILE" ]]; then
  last_result="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("lastResult","unknown"))' "$BACKUP_STATUS_FILE" 2>/dev/null || echo unknown)"
  last_run_at="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("lastRunAt","unknown"))' "$BACKUP_STATUS_FILE" 2>/dev/null || echo unknown)"
  if [[ "$last_result" == "success" ]]; then
    record_check PASS RCV-009 "A successful backup exists — the database recovery boundary" "lastRunAt=${last_run_at}"
  else
    record_check FAIL RCV-009 "No successful backup on record" "lastResult=${last_result}; run: sudo ./pcctl backup"
  fi
else
  record_check FAIL RCV-009 "No backup has ever run" "run: sudo ./pcctl backup"
fi
if (( PC_CHECK_FAIL > 0 )); then
  record_check FAIL RCV-000 "aborting before any change" "no proven backup boundary to recover behind"
  print_check_summary
  exit 1
fi

# --- RCV-010: the CURRENT repository's compose file, resolved for real —
#     the exact defect this whole recovery exists because of. Staged into a
#     scratch copy first so this check never depends on what happens to be
#     deployed yet; the real staging (which this check is then repeated
#     against) happens in the action phase below. --------------------------
compose_check_scratch="$(mktemp -d)"
cp "${PC_REPO_ROOT}/infra/compose/compose.yaml" "${compose_check_scratch}/compose.yaml"
if PC_ROOT="$PC_ROOT" docker compose --project-name "$PC_COMPOSE_PROJECT" --project-directory "$PC_ROOT" \
     --env-file "${PC_CONFIG_DIR}/stack.env" --file "${compose_check_scratch}/compose.yaml" \
     config --format json 2>/dev/null \
     | python3 "${PC_SCRIPTS_DIR}/lib/assert-config-mount.py" control-api /config; then
  record_check PASS RCV-010 "Current repository compose resolves to exactly one control-api /config mount, none nested" ""
  rm -rf -- "$compose_check_scratch"
else
  record_check FAIL RCV-010 "Current repository compose has an unsafe control-api mount" "the fix this recovery depends on is not actually present in this checkout"
  record_check FAIL RCV-000 "aborting before any change" "repository compose is not safe to deploy"
  rm -rf -- "$compose_check_scratch"
  print_check_summary
  exit 1
fi

print_check_summary
log_ok "preflight passed: recovering ${target_services_str} — postgres, n8n, and every other locally-built service already healthy remain untouched"

# =============================================================================
log_step "Rebuilding images (deterministic; same step 'update' always runs) — only the service(s) actually being recreated"
# =============================================================================
# --only <service> for each TARGET_SERVICES entry: rebuilding (and therefore
# retagging) a service NOT in this run's scope would move its mutable local
# tag to a fresh image object without ever recreating the container that
# uses it — this build's exporter embeds a new attestation/provenance
# manifest on every invocation, so even an untouched, 100%-cache-hit rebuild
# produces a different top-level image ID, silently orphaning that tag from
# the still-running, still-correct container (a real regression this
# reproduced live: recovering a healthy-but-stale `web` alone still rebuilt
# control-api and caddy too, which were already correct, and that alone made
# their tags stop matching what was actually running).
build_only_args=()
for service in "${TARGET_SERVICES[@]}"; do
  build_only_args+=(--only "$service")
done
bash "${PC_SCRIPTS_DIR}/build.sh" "${build_only_args[@]}" || die "image build failed; nothing was changed"

# =============================================================================
log_step "Staging the current repository's compose/config"
# =============================================================================
# Identical in effect to update.sh's own "Staging updated deployment
# configuration" step, and for the identical reason: whatever compose()
# reads at ${PC_ROOT}/compose/compose.yaml is what `compose up` below will
# actually use. Re-running the resolved-model check immediately after
# staging, against what is now actually on disk, is not redundant with
# RCV-010 above — RCV-010 proved the repository's own file is safe; this
# proves staging it did not somehow get it wrong.
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
if ! compose config --format json 2>/dev/null \
     | python3 "${PC_SCRIPTS_DIR}/lib/assert-config-mount.py" control-api /config; then
  die "staged compose model has an unsafe control-api mount after staging; refusing to proceed — nothing was recreated"
fi
log_ok "staged compose/config verified: control-api has exactly one /config mount, none nested"

# =============================================================================
log_step "Migration dry-run (true no-op — nothing is pending, this is a final live confirmation)"
# =============================================================================
api_cid_before="$(container_id control-api)"
if [[ -n "$api_cid_before" ]]; then
  if compose run --rm --no-deps --entrypoint node control-api dist/cli/migrate.js --dry-run 2>&1 | redact_stream; then
    log_ok "migration dry-run passed"
  else
    die "migration dry-run FAILED; the current schema and the current repository's code do not agree — aborting before recreating anything"
  fi
else
  log_warn "control-api container does not exist yet to run the dry-run against; proceeding — the health gate below is the real proof"
fi

# =============================================================================
log_step "Removing the specific 'created' container(s) being recovered"
# =============================================================================
# Only ever the exact container IDs already proven (RCV-004) to be either
# `created` or healthy-but-running-a-stale-image, and in TARGET_SERVICES —
# never a broader `compose down`, never a service outside this list, and
# postgres/n8n are never even considered. Re-verified right before removal,
# not just trusted from preflight.
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
log_step "Recreating ${target_services_str} from the staged compose/config"
# =============================================================================
# --no-deps: never (re)creates a service outside TARGET_SERVICES. Compose
# still respects depends_on ordering AMONG the named services themselves
# (verified: caddy depends_on control-api: condition: service_started, and
# still starts after it even under --no-deps) — postgres and n8n, already
# healthy, are never touched by this command regardless.
if ! compose up --detach --no-deps "${TARGET_SERVICES[@]}"; then
  die "recreation FAILED — ${target_services_str} did not come up. Do not assume partial success: inspect 'docker ps -a' and 'docker logs' before retrying anything. Do not re-run recovery blindly."
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
  die "health gate FAILED after recreation. Do not assume partial success: the container(s) exist but did not prove healthy. Inspect 'docker logs' before retrying anything."
fi
log_ok "health gate passed"

# =============================================================================
log_step "Strict verification — verify.sh and verify-security.sh, unmodified"
# =============================================================================
if ! bash "${PC_SCRIPTS_DIR}/verify.sh"; then
  die "verify.sh FAILED after recreation. Containers are up but the deployment is not proven correct — do not assume success. Investigate before retrying anything."
fi
log_ok "verify.sh passed"
if ! bash "${PC_SCRIPTS_DIR}/verify-security.sh"; then
  die "verify-security.sh FAILED after recreation. Containers are up but the security posture is not proven correct — do not assume success. Investigate before retrying anything."
fi
log_ok "verify-security.sh passed"

# =============================================================================
log_step "Handing off to reconcile-state for metadata/version-lock repair"
# =============================================================================
# Deliberately the real, unmodified script — not reimplemented here. Its
# own preconditions (REC-001..012) are, at this exact point, genuinely true
# for the first time: every container is healthy, migrations agree, the
# compose file is the one just staged. It alone decides whether a new,
# coherent version lock can be published; recovery never publishes one
# itself.
if bash "${PC_SCRIPTS_DIR}/reconcile-state.sh"; then
  log_ok "deployment metadata reconciled to the now-healthy, recovered stack"
else
  die "recreation and verification succeeded, but reconcile-state.sh could not repair the version lock — recreation succeeded; do not re-run recovery. Investigate reconcile-state's own output, then run it again by hand: sudo ./pcctl reconcile-state"
fi

notify "🛠️ Project Control: ${target_services_str} recovered from a stuck 'created' state on $(hostname -s), verified healthy, metadata reconciled"
log_ok "recovery complete: ${target_services_str} recreated, health-gated, strictly verified, and metadata reconciled"
