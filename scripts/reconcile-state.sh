#!/usr/bin/env bash
# =============================================================================
# reconcile-state.sh — repair deployment metadata to describe an already-
# running, verified-coherent stack.
#
#   sudo ./pcctl reconcile-state          human-readable
#   sudo ./pcctl reconcile-state --json   machine-readable
#
# WHY THIS EXISTS
#
# `update` refuses to publish a rollback point unless the deployed lock,
# stack.env and the five running containers already agree
# (lib/common.sh::deployment_images_match_lock) — deliberately, so a rollback
# point is never built from a state nobody actually verified. `rollback`
# refuses to restore a target whose exact locally built images were pruned —
# deliberately, so it never claims success while leaving the host half
# upgraded. Between those two fail-safes there is a real incident this host
# can land in: the running containers are healthy and mutually coherent, but
# the *files describing* them (versions.lock.env / stack.env /
# checkpoint-reader-max-version) point at a release whose exact application
# images no longer exist locally. Neither `update` nor `rollback` can recover
# that host, and neither should be weakened to try.
#
# WHAT THIS SCRIPT DOES AND DOES NOT DO
#
#   * Read-only until every check below passes. Any failure aborts with no
#     file written and no container touched.
#   * Never recreates, restarts, rebuilds or deploys anything. The only
#     mutations on success are: (a) a `docker image tag` of the exact running
#     image object under a deterministic internal name — never a rebuild,
#     never a different build standing in for the running one — and (b) an
#     atomic replacement of versions.lock.env / stack.env /
#     checkpoint-reader-max-version, with the previous (inconsistent) files
#     preserved under backups/reconcile/<run-id>/.
#   * Derives the declared application capability (pre- vs post-Stage-7) by
#     empirically probing the running Control API, never by trusting the
#     possibly-stale checkpoint-reader-max-version file already on disk.
#   * Accepts no override flag. In particular there is no --force: every
#     check here is a precondition for metadata being truthful, not a policy
#     call an operator can waive.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root

JSON=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON=1; shift ;;
    *) die "unknown argument: $1 (reconcile-state accepts no override flags, including --force — every check here is a precondition, not a policy waiver)" ;;
  esac
done
(( JSON )) && exec 3>&2 2>/dev/null

PORTAL="http://127.0.0.1:8780"
RECONCILE_PROBE_PROJECT="00000000-0000-4000-8000-000000000001"
LOCK_FILE="${PC_CONFIG_DIR}/versions.lock.env"
STACK_FILE="${PC_CONFIG_DIR}/stack.env"
READER_FILE="${PC_CONFIG_DIR}/checkpoint-reader-max-version"
LOCALLY_BUILT_SERVICES=(control-api web caddy)

finish() {
  local rc=0
  (( PC_CHECK_FAIL > 0 )) && rc=1
  if (( JSON )); then exec 2>&3; emit_checks_json; else print_check_summary; fi
  exit "$rc"
}

[[ -d "$PC_ROOT" ]] || die "deployment root is missing: ${PC_ROOT} — nothing to reconcile"
for f in "$LOCK_FILE" "$STACK_FILE"; do
  [[ -r "$f" ]] || die "cannot reconcile: ${f} is not readable"
done

# -----------------------------------------------------------------------------
# REC-001 / REC-002 — every required container exists and is healthy.
# -----------------------------------------------------------------------------
SERVICES=(postgres n8n control-api web caddy)
declare -A RUNNING_ID=()
containers_ok=1

for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  if [[ -z "$cid" ]]; then
    record_check FAIL REC-001 "Container ${service} does not exist" "cannot reconcile a stack that is not running"
    containers_ok=0
    continue
  fi
  record_check PASS REC-001 "Container ${service} exists" ""

  health="$(container_health "$service")"
  case "$health" in
    healthy|running)
      record_check PASS REC-002 "Container ${service} is healthy" "$health" ;;
    *)
      record_check FAIL REC-002 "Container ${service} is not healthy" "state=${health}"
      containers_ok=0 ;;
  esac
done
(( containers_ok )) || { record_check FAIL REC-000 "aborting before any change" "unhealthy or missing container(s)"; finish; }

# -----------------------------------------------------------------------------
# REC-003 / REC-004 — resolve the actual running image IDs, and prove each one
# is still a real, inspectable Docker image object. This is the fact this
# whole command rests on: a running container's own image can never have been
# pruned (Docker refuses to remove an image a live container references) even
# when the human-readable tag that used to point at it was overwritten or
# pruned. If that were ever false for a service, reconciliation cannot
# honestly promise a future rollback point could recapture it.
# -----------------------------------------------------------------------------
resolve_ok=1
for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  running_id="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  if [[ ! "$running_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    record_check FAIL REC-003 "Could not resolve a running image ID for ${service}" ""
    resolve_ok=0
    continue
  fi
  record_check PASS REC-003 "Resolved running image ID for ${service}" "${running_id:0:20}…"
  RUNNING_ID[$service]="$running_id"

  if docker image inspect "$running_id" >/dev/null 2>&1; then
    record_check PASS REC-004 "${service}: running image object is inspectable/recoverable" ""
  else
    record_check FAIL REC-004 "${service}: running image object could not be inspected" \
      "the exact running image cannot be preserved as a rollback artifact; refusing to reconcile"
    resolve_ok=0
  fi
done
(( resolve_ok )) || { record_check FAIL REC-000 "aborting before any change" "running image objects are not fully recoverable"; finish; }

# -----------------------------------------------------------------------------
# REC-005 — Control API readiness, probed inside the container network
# (the same in-container /health/ready probe verify.sh's API-004 uses).
# -----------------------------------------------------------------------------
api_cid="$(container_id control-api)"
ready_code="$(docker exec "$api_cid" node -e \
  "fetch('http://127.0.0.1:8080/health/ready').then(async r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('000');process.exit(0)})" \
  2>/dev/null || echo 000)"
if [[ "$ready_code" == "200" ]]; then
  record_check PASS REC-005 "Control API reports ready" "HTTP 200"
else
  record_check FAIL REC-005 "Control API is not ready" "HTTP ${ready_code}"
fi

# -----------------------------------------------------------------------------
# REC-006 — existing authenticated-boundary probe: the real edge route must
# require authentication, proving Caddy and the running Control API still
# agree on the auth boundary before metadata is trusted to describe them.
# -----------------------------------------------------------------------------
if wait_for_api_route "${PORTAL}/api/auth/me" 401 15 2; then
  record_check PASS REC-006 "Authenticated-boundary probe behaves correctly" "/api/auth/me -> HTTP 401"
else
  record_check FAIL REC-006 "Authenticated-boundary probe failed" "/api/auth/me did not return HTTP 401"
fi

# -----------------------------------------------------------------------------
# REC-007 / REC-008 — runner readiness and binary/process coherence, via the
# same bounded typed helpers update.sh and rollback.sh already trust. Neither
# helper restarts anything; both only observe already-live state.
# -----------------------------------------------------------------------------
if wait_for_runner_ready 15 0.5; then
  record_check PASS REC-007 "Runner is ready via the bounded typed health helper" ""
else
  record_check FAIL REC-007 "Runner is not ready" "system.health did not succeed"
fi

if [[ -x "${PC_RUNNER_DIR}/bin/project-control-runner" ]] \
   && runner_binary_matches_live_process "${PC_RUNNER_DIR}/bin/project-control-runner"; then
  record_check PASS REC-008 "Installed runner binary matches the live process" ""
else
  record_check FAIL REC-008 "Installed runner binary does not match the live process" \
    "restart and verify the runner before reconciling"
fi

# -----------------------------------------------------------------------------
# REC-009 — the running application's declared capability, observed
# empirically rather than trusted from the possibly-stale
# checkpoint-reader-max-version file. The Development State route
# (API-013 in verify.sh) is registered only from Stage 7 onward and sits
# behind auth: an unregistered route answers 404 (route not found, before
# auth ever runs); a registered one answers 401 for an anonymous caller.
# Anything else is not a signature this command understands, and per
# "do not generally hard-code '404 means good'", an unrecognised response
# fails closed rather than being guessed at.
# -----------------------------------------------------------------------------
dev_code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
  "${PORTAL}/api/projects/${RECONCILE_PROBE_PROJECT}/development" 2>/dev/null || echo 000)"
OBSERVED_CAPABILITY=""
case "$dev_code" in
  404) OBSERVED_CAPABILITY=2
       record_check PASS REC-009 "Observed application capability: pre-Stage-7 (v2)" "development route absent (HTTP 404)" ;;
  401) OBSERVED_CAPABILITY=3
       record_check PASS REC-009 "Observed application capability: Stage 7 (v3)" "development route present and authenticated (HTTP 401)" ;;
  *)   record_check FAIL REC-009 "Application capability probe is ambiguous" \
         "HTTP ${dev_code} is neither the pre-Stage-7 (404) nor Stage 7 (401) signature; refusing to guess" ;;
esac

# -----------------------------------------------------------------------------
# REC-010 — the database's applied migration ledger must be a subset of the
# migrations actually deployed to this host. A ledger entry with no matching
# file on disk means the database is ahead of the code that is running
# against it — the exact "database-ahead" risk in docs/risk-registry.md.
# -----------------------------------------------------------------------------
pg_cid="$(container_id postgres)"
migration_ok=1
current_checkpoint_max=""
if [[ -n "$pg_cid" ]] && secret_exists pg_control_app_password; then
  applied_versions="$(docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -tAc 'SELECT version FROM schema_migrations ORDER BY version' 2>/dev/null || true)"
  if [[ -z "$applied_versions" ]]; then
    record_check FAIL REC-010 "Could not read the applied migration ledger" ""
    migration_ok=0
  else
    missing=""
    while IFS= read -r version; do
      [[ -n "$version" ]] || continue
      if ! compgen -G "${PC_ROOT}/migrations/${version}_*.sql" >/dev/null; then
        missing+="${version} "
      fi
    done <<<"$applied_versions"
    if [[ -n "$missing" ]]; then
      record_check FAIL REC-010 "Applied migration(s) have no matching deployed file" "${missing}— database is ahead of the deployed code"
      migration_ok=0
    else
      record_check PASS REC-010 "Applied migration ledger matches deployed migrations" ""
    fi
  fi
  current_checkpoint_max="$(docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -tAc 'SELECT COALESCE(max(snapshot_version),1) FROM project_checkpoints' 2>/dev/null || true)"
else
  record_check FAIL REC-010 "Cannot verify migration ledger compatibility" "database is not reachable"
  migration_ok=0
fi

# -----------------------------------------------------------------------------
# REC-011 — the checkpoint reader capability that would be published must be
# able to read every checkpoint already stored. Same comparison rollback.sh
# already makes against a rollback target, made here against the observed
# running capability instead.
# -----------------------------------------------------------------------------
if [[ -n "$OBSERVED_CAPABILITY" && "$current_checkpoint_max" =~ ^[0-9]+$ ]]; then
  if (( current_checkpoint_max > OBSERVED_CAPABILITY )); then
    record_check FAIL REC-011 "Checkpoint reader capability is incompatible with stored checkpoints" \
      "database contains checkpoint v${current_checkpoint_max}, running application only proves v${OBSERVED_CAPABILITY}"
  else
    record_check PASS REC-011 "Checkpoint reader capability is compatible with stored checkpoints" \
      "stored max v${current_checkpoint_max} <= observed v${OBSERVED_CAPABILITY}"
  fi
else
  record_check FAIL REC-011 "Could not evaluate checkpoint reader compatibility" ""
fi

# -----------------------------------------------------------------------------
# REC-012 — the deployed compose file must still define the same five
# services actually running, so reconciled metadata does not describe a
# topology nobody is running.
# -----------------------------------------------------------------------------
COMPOSE_FILE="${PC_COMPOSE_DIR}/compose.yaml"
compose_ok=1
if [[ -r "$COMPOSE_FILE" ]]; then
  for service in "${SERVICES[@]}"; do
    if ! grep -qE "^[[:space:]]{2}${service}:" "$COMPOSE_FILE"; then
      record_check FAIL REC-012 "Deployed compose.yaml does not define service ${service}" ""
      compose_ok=0
    fi
  done
  (( compose_ok )) && record_check PASS REC-012 "Deployed compose.yaml is compatible with the running stack" ""
else
  record_check FAIL REC-012 "Deployed compose.yaml is not readable" "$COMPOSE_FILE"
  compose_ok=0
fi

if (( PC_CHECK_FAIL > 0 )); then
  record_check FAIL REC-000 "aborting before any change" "one or more reconciliation checks failed; nothing was changed"
  finish
fi

# =============================================================================
# All checks passed. Compute the target metadata from the ACTUAL running
# state and, only if it differs from what is on disk, replace it atomically.
# =============================================================================
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"

resolve_image_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null || true; }

declare -A CURRENT_REF=() TARGET_REF=()
while IFS='=' read -r k v; do CURRENT_REF[$k]="$v"; done < <(
  set -a; # shellcheck disable=SC1090
  source "$STACK_FILE"; set +a
  for k in PC_POSTGRES_IMAGE PC_N8N_IMAGE PC_CADDY_IMAGE PC_CADDY_PROXY_IMAGE PC_CONTROL_API_IMAGE PC_WEB_IMAGE PC_STACK_VERSION; do
    printf '%s=%s\n' "$k" "${!k:-}"
  done
)

pinned_ok=1
for pair in "postgres:PC_POSTGRES_IMAGE" "n8n:PC_N8N_IMAGE"; do
  service="${pair%%:*}"; key="${pair##*:}"
  ref="${CURRENT_REF[$key]:-}"
  resolved="$(resolve_image_id "$ref")"
  if [[ -z "$ref" || "$resolved" != "${RUNNING_ID[$service]}" ]]; then
    log_error "REC: pinned image ${key} does not resolve to the running ${service} image; this is outside reconcile-state's scope (only mutable local-build tags are repaired)"
    pinned_ok=0
  fi
  TARGET_REF[$key]="$ref"
done
(( pinned_ok )) || die "aborting: pinned third-party image reference(s) do not match the running containers; nothing was changed. Investigate ${PC_CONFIG_DIR}/stack.env manually — reconcile-state only repairs the three locally-built images."
TARGET_REF[PC_CADDY_IMAGE]="${CURRENT_REF[PC_CADDY_IMAGE]:-}"

changed=0
for pair in "control-api:PC_CONTROL_API_IMAGE" "web:PC_WEB_IMAGE" "caddy:PC_CADDY_PROXY_IMAGE"; do
  service="${pair%%:*}"; key="${pair##*:}"
  ref="${CURRENT_REF[$key]:-}"
  running_id="${RUNNING_ID[$service]}"
  resolved="$(resolve_image_id "$ref")"
  if [[ -n "$ref" && "$resolved" == "$running_id" ]]; then
    TARGET_REF[$key]="$ref"
    continue
  fi

  changed=1
  short="${running_id#sha256:}"; short="${short:0:16}"
  repo="${ref%:*}"
  [[ -n "$repo" ]] || repo="project-control/${service}"
  preserved_ref="${repo}:pcctl-reconciled-${short}"

  if ! docker image tag "$running_id" "$preserved_ref"; then
    die "aborting: could not create the internal preservation tag for ${service}; nothing was changed"
  fi
  retag_id="$(resolve_image_id "$preserved_ref")"
  if [[ "$retag_id" != "$running_id" ]]; then
    die "aborting: internal preservation tag for ${service} did not resolve back to the exact running image ID after tagging; nothing was changed"
  fi
  log_ok "${service}: preserved running image ${running_id:0:20}… as ${preserved_ref}"
  TARGET_REF[$key]="$preserved_ref"
done

reader_changed=0
current_reader="$(cat "$READER_FILE" 2>/dev/null || true)"
if [[ "$current_reader" != "$OBSERVED_CAPABILITY" ]]; then
  reader_changed=1
fi

if (( ! changed && ! reader_changed )); then
  log_ok "deployment metadata already describes the exact running images and observed capability; nothing to reconcile"
  record_check PASS REC-013 "Deployment metadata is already coherent" "no-op"
  finish
fi

TARGET_REF[PC_STACK_VERSION]="reconciled-${RUN_ID}"

BACKUP_DIR="${PC_ROOT}/backups/reconcile/${RUN_ID}"
ensure_dir "$(dirname -- "$BACKUP_DIR")" 0700 root root
ensure_dir "$BACKUP_DIR" 0700 root root
cp -p "$LOCK_FILE" "${BACKUP_DIR}/versions.lock.env"
cp -p "$STACK_FILE" "${BACKUP_DIR}/stack.env"
[[ -f "$READER_FILE" ]] && cp -p "$READER_FILE" "${BACKUP_DIR}/checkpoint-reader-max-version"
log_ok "previous (inconsistent) metadata preserved at ${BACKUP_DIR}"

rewrite_image_keys() {
  local src="$1" dest="$2"
  # grep -v exits 1 (not an error here) when every line of $src matched and was
  # filtered out, e.g. a minimal lock file containing only these seven keys.
  grep -vE '^(PC_POSTGRES_IMAGE|PC_N8N_IMAGE|PC_CADDY_IMAGE|PC_CADDY_PROXY_IMAGE|PC_CONTROL_API_IMAGE|PC_WEB_IMAGE|PC_STACK_VERSION)=' \
    "$src" >"$dest" || true
  {
    printf 'PC_POSTGRES_IMAGE=%s\n'    "${TARGET_REF[PC_POSTGRES_IMAGE]}"
    printf 'PC_N8N_IMAGE=%s\n'         "${TARGET_REF[PC_N8N_IMAGE]}"
    printf 'PC_CADDY_IMAGE=%s\n'       "${TARGET_REF[PC_CADDY_IMAGE]}"
    printf 'PC_CADDY_PROXY_IMAGE=%s\n' "${TARGET_REF[PC_CADDY_PROXY_IMAGE]}"
    printf 'PC_CONTROL_API_IMAGE=%s\n' "${TARGET_REF[PC_CONTROL_API_IMAGE]}"
    printf 'PC_WEB_IMAGE=%s\n'         "${TARGET_REF[PC_WEB_IMAGE]}"
    printf 'PC_STACK_VERSION=%s\n'     "${TARGET_REF[PC_STACK_VERSION]}"
  } >>"$dest"
}

NEW_LOCK="$(mktemp "${PC_CONFIG_DIR}/.versions.lock.env.reconcile.XXXXXXXX")"
NEW_STACK="$(mktemp "${PC_CONFIG_DIR}/.stack.env.reconcile.XXXXXXXX")"
rewrite_image_keys "$LOCK_FILE" "$NEW_LOCK"
rewrite_image_keys "$STACK_FILE" "$NEW_STACK"
chmod 0644 "$NEW_LOCK"; chmod 0640 "$NEW_STACK"

# Self-check the candidate files against the same coherence gate `update`
# uses, before either replaces anything live.
if ! deployment_images_match_lock "$NEW_LOCK" "$NEW_STACK"; then
  rm -f "$NEW_LOCK" "$NEW_STACK"
  die "aborting: reconciled metadata failed its own coherence self-check; nothing was changed"
fi

mv -f "$NEW_LOCK" "$LOCK_FILE"
mv -f "$NEW_STACK" "$STACK_FILE"
chown root:root "$LOCK_FILE" "$STACK_FILE" 2>/dev/null || true

if (( reader_changed )); then
  reader_tmp="$(mktemp "${PC_CONFIG_DIR}/.checkpoint-reader-max-version.reconcile.XXXXXXXX")"
  printf '%s\n' "$OBSERVED_CAPABILITY" >"$reader_tmp"
  chmod 0644 "$reader_tmp"
  mv -f "$reader_tmp" "$READER_FILE"
  chown root:root "$READER_FILE" 2>/dev/null || true
  log_ok "checkpoint reader capability metadata corrected: ${current_reader:-<unset>} -> ${OBSERVED_CAPABILITY}"
fi

record_check PASS REC-013 "Deployment metadata reconciled from verified running state" "backup at ${BACKUP_DIR}"

# Audit trail: best effort, must never fail an already-successful reconciliation.
if [[ -n "$pg_cid" ]] && secret_exists pg_control_app_password; then
  docker exec -i -e PGPASSWORD="$(read_secret pg_control_app_password)" "$pg_cid" \
    psql -U control_app -d project_control -q -c \
    "INSERT INTO audit_events (event_type, outcome, subject, detail)
     VALUES ('system.reconcile-state', 'success', 'reconcile:${RUN_ID}',
             '{\"observedCapability\":${OBSERVED_CAPABILITY},\"stackVersion\":\"${TARGET_REF[PC_STACK_VERSION]}\",\"backupDir\":\"${BACKUP_DIR}\"}'::jsonb)" \
    >/dev/null 2>&1 || true
fi
bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" \
  "🛠️ Project Control deployment metadata reconciled to the verified running state on $(hostname -s)" >/dev/null 2>&1 || true

log_ok "reconciliation complete: metadata now describes the verified running stack (${TARGET_REF[PC_STACK_VERSION]})"
log_info "next: sudo ./pcctl verify && sudo ./pcctl verify-security"
finish
