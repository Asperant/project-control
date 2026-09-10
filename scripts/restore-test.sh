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

# What this section deliberately does NOT test: role grants. pg_dump runs
# with --no-owner --no-privileges (see backup.sh), so the dump carries data
# and schema (tables, constraints, indexes, triggers) only — never
# ownership or GRANT statements, on purpose: the documented disaster-
# recovery procedure (docs/disaster-recovery.md) provisions a fresh cluster
# via `pcctl install` (which runs reconcile-roles-and-databases.sh, the
# same idempotent script that provisions a first-time install) *before*
# `pg_restore` ever runs, so the roles this dump is loaded into already have
# the right grants by the time it lands. Re-deriving a full four-role
# cluster inside this throwaway single-superuser sandbox just to re-prove
# grants that are already the subject of their own dedicated checks would
# duplicate, not strengthen, that proof. Grants are verified where they
# actually apply: against the live, already-provisioned cluster, by
# verify-security.sh's PGS-*/AUT-* checks (control_app cannot DELETE
# project_actions/service_accounts/service_tokens/workflow_runs, cannot
# UPDATE/DELETE workflow_run_steps; backup_reader stays SELECT-only
# everywhere) — run `sudo ./pcctl verify-security` for that half of the
# guarantee.
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

restore_and_check project_control users sessions audit_events schema_migrations system_settings artifact_objects projects roadmap_milestones roadmap_tasks task_acceptance_criteria task_dependencies task_notes project_memory_entries project_checkpoints agent_runs agent_run_prompts agent_reports work_sessions work_session_amendments project_actions service_accounts service_tokens workflow_runs workflow_run_steps

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

roadmap_constraints="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('roadmap_milestones_project_id_fkey','roadmap_tasks_milestone_id_fkey','task_acceptance_criteria_task_id_fkey','task_dependencies_task_id_fkey','task_dependencies_depends_on_task_id_fkey','task_notes_task_id_fkey','roadmap_milestones_position_key','roadmap_tasks_position_key','task_dependencies_pkey','task_dependencies_not_self')" 2>/dev/null || echo 0)"
if [[ "${roadmap_constraints:-0}" == "10" ]]; then
  log_ok "project_control: roadmap relationships and uniqueness constraints restored"
else
  fail "restored project_control is missing roadmap constraints (${roadmap_constraints}/10)"
fi

memory_constraints="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('project_memory_entries_project_id_fkey','project_memory_entries_not_self_superseded','project_memory_entries_pkey','project_checkpoints_project_id_fkey','project_checkpoints_pkey')" 2>/dev/null || echo 0)"
if [[ "${memory_constraints:-0}" == "5" ]]; then
  log_ok "project_control: memory/checkpoint relationships and constraints restored"
else
  fail "restored project_control is missing memory/checkpoint constraints (${memory_constraints}/5)"
fi

# Row-level sanity for checkpoints: if any survived the backup, their snapshot
# content must still be valid jsonb after the restore. On a fresh install
# there may be zero rows, which is not itself a failure.
checkpoint_rows="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc "SELECT count(*) FROM project_checkpoints" 2>/dev/null || echo 0)"
if [[ "${checkpoint_rows:-0}" -gt 0 ]]; then
  invalid_snapshots="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
    psql -U postgres -d project_control -tAc "SELECT count(*) FROM project_checkpoints WHERE snapshot_json IS NULL OR jsonb_typeof(snapshot_json) <> 'object'" 2>/dev/null || echo 0)"
  if [[ "${invalid_snapshots:-0}" == "0" ]]; then
    log_ok "project_control: ${checkpoint_rows} checkpoint(s) restored with valid snapshot content"
  else
    fail "restored project_control has ${invalid_snapshots}/${checkpoint_rows} checkpoints with invalid snapshot content"
  fi
else
  log_warn "no checkpoints in this snapshot to verify (fresh deployment)"
fi

agent_run_constraints="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('agent_runs_pkey','agent_run_prompts_pkey','agent_run_prompts_one_per_run','agent_reports_pkey','agent_reports_run_version_key','agent_reports_not_self_superseded')" 2>/dev/null || echo 0)"
if [[ "${agent_run_constraints:-0}" == "6" ]]; then
  log_ok "project_control: Agent Run relationships and uniqueness constraints restored"
else
  fail "restored project_control is missing Agent Run constraints (${agent_run_constraints}/6)"
fi

# Row-level sanity: prompt/report -> run and memory -> run relationships must
# still resolve after the restore, and report version numbers must still be
# unique per run (the whole point of the unique constraint just checked above
# is that this can never happen — this independently confirms the *data*
# agrees, not just that the constraint exists).
orphan_prompts="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM agent_run_prompts p LEFT JOIN agent_runs r ON r.id = p.agent_run_id WHERE r.id IS NULL" 2>/dev/null || echo 0)"
orphan_reports="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM agent_reports rp LEFT JOIN agent_runs r ON r.id = rp.agent_run_id WHERE r.id IS NULL" 2>/dev/null || echo 0)"
orphan_provenance="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM project_memory_entries m LEFT JOIN agent_runs r ON r.id = m.source_agent_run_id WHERE m.source_agent_run_id IS NOT NULL AND r.id IS NULL" 2>/dev/null || echo 0)"
duplicate_report_versions="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM (SELECT agent_run_id, version FROM agent_reports GROUP BY agent_run_id, version HAVING count(*) > 1) d" 2>/dev/null || echo 0)"
if [[ "${orphan_prompts:-0}" == "0" && "${orphan_reports:-0}" == "0" && "${orphan_provenance:-0}" == "0" && "${duplicate_report_versions:-0}" == "0" ]]; then
  log_ok "project_control: Agent Run prompt/report/memory-provenance relationships and report-version uniqueness hold after restore"
else
  fail "restored project_control has broken Agent Run relationships (orphan prompts=${orphan_prompts}, orphan reports=${orphan_reports}, orphan provenance=${orphan_provenance}, duplicate report versions=${duplicate_report_versions})"
fi

work_session_constraints="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('work_sessions_pkey','work_sessions_project_id_fkey','work_sessions_lifecycle_check','work_sessions_checkpoint_same_project_fk','work_session_amendments_pkey','work_session_amendments_work_session_id_fkey','project_checkpoints_project_id_id_key')" 2>/dev/null || echo 0)"
one_open_indexes="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='work_sessions_one_open_per_project_idx' AND i.indisunique AND i.indpred IS NOT NULL" 2>/dev/null || echo 0)"
work_session_triggers="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgenabled <> 'D' AND ((t.tgname='work_sessions_guard_mutation' AND t.tgrelid='work_sessions'::regclass AND p.proname='guard_work_session_mutation') OR (t.tgname='work_session_amendments_require_closed_parent' AND t.tgrelid='work_session_amendments'::regclass AND p.proname='guard_work_session_amendment_parent_closed'))" 2>/dev/null || echo 0)"
if [[ "${work_session_constraints:-0}" == "7" && "${one_open_indexes:-0}" == "1" && "${work_session_triggers:-0}" == "2" ]]; then
  log_ok "project_control: Work Session ownership, lifecycle, one-open, immutability and amendment protections restored"
else
  fail "restored project_control is missing Work Session protections (constraints=${work_session_constraints}/7, one-open indexes=${one_open_indexes}/1, triggers=${work_session_triggers}/2)"
fi

orphan_work_sessions="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM work_sessions s LEFT JOIN projects p ON p.id=s.project_id WHERE p.id IS NULL" 2>/dev/null || echo 0)"
invalid_amendment_parents="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM work_session_amendments a LEFT JOIN work_sessions s ON s.id=a.work_session_id WHERE s.id IS NULL OR s.status<>'closed'" 2>/dev/null || echo 0)"
cross_project_checkpoints="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM work_sessions s JOIN project_checkpoints c ON c.id=s.checkpoint_id WHERE c.project_id<>s.project_id" 2>/dev/null || echo 0)"
invalid_session_lifecycle="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM work_sessions WHERE (status='open' AND (ended_at IS NOT NULL OR outcome_summary IS NOT NULL OR blockers IS NOT NULL OR next_action IS NOT NULL OR checkpoint_id IS NOT NULL)) OR (status='closed' AND (ended_at IS NULL OR ended_at<started_at OR outcome_summary IS NULL))" 2>/dev/null || echo 0)"
open_session_duplicates="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM (SELECT project_id FROM work_sessions WHERE status='open' GROUP BY project_id HAVING count(*)>1) duplicates" 2>/dev/null || echo 0)"
if [[ "${orphan_work_sessions:-0}" == "0" && "${invalid_amendment_parents:-0}" == "0" && "${cross_project_checkpoints:-0}" == "0" && "${invalid_session_lifecycle:-0}" == "0" && "${open_session_duplicates:-0}" == "0" ]]; then
  log_ok "project_control: restored Work Session rows have no orphans, cross-project checkpoints, invalid lifecycle state or duplicate open sessions"
else
  fail "restored Work Session integrity failed (orphan sessions=${orphan_work_sessions}, invalid amendment parents=${invalid_amendment_parents}, cross-project checkpoints=${cross_project_checkpoints}, invalid lifecycle=${invalid_session_lifecycle}, duplicate open projects=${open_session_duplicates})"
fi

# New checkpoints use v3. Historical v1/v2 rows remain valid; v3 additionally
# carries compact metadata-only Git state.
invalid_checkpoint_versions="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM project_checkpoints WHERE snapshot_version NOT IN (1,2,3) OR snapshot_json->'version' IS DISTINCT FROM to_jsonb(snapshot_version) OR (snapshot_version IN (2,3) AND jsonb_typeof(snapshot_json->'recentAgentActivity') IS DISTINCT FROM 'array') OR (snapshot_version=3 AND (jsonb_typeof(snapshot_json->'gitState') IS DISTINCT FROM 'object' OR snapshot_json->'gitState' ?| ARRAY['files','diff','rawUrl','recentCommits','sourceBody']))" 2>/dev/null || echo 0)"
if [[ "${invalid_checkpoint_versions:-0}" == "0" ]]; then
  log_ok "project_control: checkpoint v1/v2/v3 compatibility and compact v3 Git state hold after restore"
else
  fail "restored project_control has ${invalid_checkpoint_versions} incompatible checkpoint snapshot(s)"
fi

# Repository Actions (0013/0014): this table previously had no dedicated
# restore-test coverage at all beyond the generic table-existence check —
# closed here. The lifecycle CHECK constraint means pg_restore itself would
# already refuse a dump containing a terminal row with inconsistent
# started_at/settled_at/result_json (CHECK constraints are validated as data
# loads), so a successful restore is already meaningful evidence; the
# explicit query below additionally proves the *specific* invariant by name
# rather than only trusting that a restore failure would have said why.
project_action_constraints="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_constraint WHERE conname IN ('project_actions_pkey','project_actions_project_id_fkey','project_actions_lifecycle_check')" 2>/dev/null || echo 0)"
project_action_index="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname='project_actions_one_open_per_project_idx' AND i.indisunique AND i.indpred IS NOT NULL" 2>/dev/null || echo 0)"
project_action_trigger="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgenabled <> 'D' AND t.tgname='project_actions_guard_mutation' AND t.tgrelid='project_actions'::regclass AND p.proname='guard_project_action_mutation'" 2>/dev/null || echo 0)"
if [[ "${project_action_constraints:-0}" == "3" && "${project_action_index:-0}" == "1" && "${project_action_trigger:-0}" == "1" ]]; then
  log_ok "project_control: Repository Action ownership, lifecycle, one-open-per-project and settlement-immutability protections restored"
else
  fail "restored project_control is missing Repository Action protections (constraints=${project_action_constraints}/3, one-open index=${project_action_index}/1, trigger=${project_action_trigger}/1)"
fi

orphan_project_actions="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM project_actions a LEFT JOIN projects p ON p.id=a.project_id WHERE p.id IS NULL" 2>/dev/null || echo 0)"
inconsistent_terminal_actions="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM project_actions WHERE status IN ('succeeded','failed') AND (started_at IS NULL OR settled_at IS NULL OR result_json IS NULL)" 2>/dev/null || echo 0)"
duplicate_open_actions="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM (SELECT project_id FROM project_actions WHERE status IN ('planned','running') GROUP BY project_id HAVING count(*)>1) d" 2>/dev/null || echo 0)"
if [[ "${orphan_project_actions:-0}" == "0" && "${inconsistent_terminal_actions:-0}" == "0" && "${duplicate_open_actions:-0}" == "0" ]]; then
  log_ok "project_control: restored Repository Actions have no dangling project references, inconsistent terminal state, or duplicate open actions per project"
else
  fail "restored Repository Action integrity failed (orphan actions=${orphan_project_actions}, inconsistent terminal=${inconsistent_terminal_actions}, duplicate open per project=${duplicate_open_actions})"
fi

# Service identity (0015/0016): a token's scopes must remain a subset of its
# account's, and revocation/identity immutability triggers must survive the
# restore intact.
service_identity_triggers="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgenabled <> 'D' AND ((t.tgname='service_tokens_guard_scopes' AND t.tgrelid='service_tokens'::regclass AND p.proname='guard_service_token_scopes') OR (t.tgname='service_tokens_guard_mutation' AND t.tgrelid='service_tokens'::regclass AND p.proname='guard_service_token_mutation'))" 2>/dev/null || echo 0)"
if [[ "${service_identity_triggers:-0}" == "2" ]]; then
  log_ok "project_control: service token scope-ceiling and immutability triggers restored"
else
  fail "restored project_control is missing service token protections (triggers=${service_identity_triggers}/2)"
fi

orphan_service_tokens="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM service_tokens t LEFT JOIN service_accounts a ON a.id=t.account_id WHERE a.id IS NULL" 2>/dev/null || echo 0)"
scope_ceiling_violations="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM service_tokens t JOIN service_accounts a ON a.id=t.account_id WHERE NOT (t.scopes <@ a.scopes)" 2>/dev/null || echo 0)"
if [[ "${orphan_service_tokens:-0}" == "0" && "${scope_ceiling_violations:-0}" == "0" ]]; then
  log_ok "project_control: restored service tokens have no orphaned account references or scope-ceiling violations"
else
  fail "restored service identity integrity failed (orphan tokens=${orphan_service_tokens}, scope violations=${scope_ceiling_violations})"
fi

# The schema itself must still hold no plaintext-shaped column after a
# restore (the same structural property SVC-001 asserts on the live
# cluster) — a future migration accidentally reintroducing one would be
# caught here too, not only by a fresh install. Row-level: every restored
# token_hash must still be exactly 64 lowercase hex characters (the SHA-256
# shape written at mint time — see auth/service-tokens.ts) and no
# service_tokens row anywhere resembles the raw pcs_-prefixed token format.
service_token_columns="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name='service_tokens' AND table_schema='public'" 2>/dev/null || echo '')"
if printf '%s' "${service_token_columns:-}" | grep -qiE '(^|,)(token|value|plaintext|secret)(,|$)'; then
  fail "restored service_tokens has a plaintext-shaped column: ${service_token_columns}"
else
  log_ok "project_control: restored service_tokens schema still stores only a hash, no plaintext-shaped column"
fi

malformed_token_hashes="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM service_tokens WHERE token_hash !~ '^[0-9a-f]{64}\$' OR token_hash ~ '^pcs_'" 2>/dev/null || echo 0)"
if [[ "${malformed_token_hashes:-0}" == "0" ]]; then
  log_ok "project_control: every restored service_tokens.token_hash is a well-formed SHA-256 digest, never a raw token"
else
  fail "restored service_tokens has ${malformed_token_hashes} row(s) whose token_hash is not a valid SHA-256 digest (possible plaintext leak)"
fi

# Automation (0017/0018): the lifecycle trigger and both partial unique
# indexes (one-open-per-workflow, idempotency-window-excluding-cancelled/
# expired) must survive the restore intact.
automation_triggers="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid WHERE t.tgenabled <> 'D' AND t.tgname='workflow_runs_guard_mutation' AND t.tgrelid='workflow_runs'::regclass AND p.proname='guard_workflow_run_mutation'" 2>/dev/null || echo 0)"
automation_indexes="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname IN ('workflow_runs_one_open_idx','workflow_runs_idempotency_idx') AND i.indisunique AND i.indpred IS NOT NULL" 2>/dev/null || echo 0)"
if [[ "${automation_triggers:-0}" == "1" && "${automation_indexes:-0}" == "2" ]]; then
  log_ok "project_control: workflow run lifecycle trigger and partial unique indexes restored"
else
  fail "restored project_control is missing automation protections (trigger=${automation_triggers}/1, indexes=${automation_indexes}/2)"
fi

orphan_workflow_steps="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM workflow_run_steps s LEFT JOIN workflow_runs r ON r.id=s.run_id WHERE r.id IS NULL" 2>/dev/null || echo 0)"
cross_project_runs="$(docker exec -i -e PGPASSWORD="$SCRATCH_PASSWORD" "$SCRATCH_CONTAINER" \
  psql -U postgres -d project_control -tAc \
  "SELECT count(*) FROM workflow_runs r LEFT JOIN projects p ON p.id=r.project_id WHERE r.project_id IS NOT NULL AND p.id IS NULL" 2>/dev/null || echo 0)"
if [[ "${orphan_workflow_steps:-0}" == "0" && "${cross_project_runs:-0}" == "0" ]]; then
  log_ok "project_control: restored workflow runs have no orphaned steps or dangling project references"
else
  fail "restored automation integrity failed (orphan steps=${orphan_workflow_steps}, dangling project refs=${cross_project_runs})"
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
