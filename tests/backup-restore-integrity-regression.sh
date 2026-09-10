#!/usr/bin/env bash
# =============================================================================
# backup-restore-integrity-regression.sh
#
# restore-test.sh proves that a *real* backup, taken from a *real* deployment,
# loads cleanly and that the tables/constraints/triggers/indexes it expects
# are present. What it structurally cannot prove, because it restores with
# --no-owner --no-privileges into a single-superuser sandbox (see the comment
# above `restore_and_check` in restore-test.sh for why that is deliberate),
# is that the *role grants* — control_app denied DELETE, backup_reader
# confined to SELECT, a service token's scope-ceiling trigger, a settled
# row's immutability trigger — actually reject a hostile attempt, as opposed
# to merely existing in the catalog.
#
# This test closes that gap from the other direction: it builds a disposable
# cluster the same way a real one is built (reconcile-roles-and-databases.sh,
# the exact script Compose runs — not a reimplementation of it), applies
# every real migration in order, inserts deterministic fixtures for the
# tables introduced by Repository Actions (0013/0014), Service Identity
# (0015/0016) and Automation (0017/0018), and then actively attempts every
# mutation those features' triggers and grants are supposed to refuse —
# asserting each one is REJECTED, not merely that a trigger with the right
# name exists.
#
# Nothing here touches /srv/project-control, the live postgres container, or
# any real secret. Every credential is generated fresh for this run and
# exists only inside a throwaway, internal-network container destroyed on
# exit.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not available/usable — cannot run this test"
  exit 0
fi

IMAGE="$(grep -E '^PC_POSTGRES_IMAGE=' "${REPO_ROOT}/infra/versions.lock.env" | cut -d= -f2-)"
[[ -n "$IMAGE" ]] || { echo "FAIL: could not read PC_POSTGRES_IMAGE from infra/versions.lock.env" >&2; exit 1; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
CONTAINER="pc-restore-integrity-${RUN_ID}"
NETWORK="pc-restore-integrity-net-${RUN_ID}"

cleanup() {
  local exit_code=$?
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  exit "$exit_code"
}
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
ok() { printf '[  OK ] %s\n' "$1" >&2; }

random_hex() { od -An -tx1 -N24 /dev/urandom | tr -d ' \n'; }

SUPERUSER_PW="$(random_hex)"
CONTROL_APP_PW="$(random_hex)"
CONTROL_MIGRATOR_PW="$(random_hex)"
N8N_APP_PW="$(random_hex)"
BACKUP_READER_PW="$(random_hex)"

# -----------------------------------------------------------------------------
# 1. Throwaway PostgreSQL, isolated network, no published port.
# -----------------------------------------------------------------------------
docker network create --internal "$NETWORK" >/dev/null

docker run --detach \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  --user 999:999 \
  --env POSTGRES_PASSWORD="$SUPERUSER_PW" \
  --env POSTGRES_USER=postgres \
  --env POSTGRES_DB=postgres \
  --env PGDATA=/tmp/pgdata \
  --tmpfs /tmp:rw,size=1g \
  --tmpfs /run/postgresql:rw,size=64m \
  --tmpfs /run/secrets:rw,size=8m,mode=0755,uid=999,gid=999 \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  --label "com.project-control.ephemeral=true" \
  "$IMAGE" \
  postgres -c fsync=off -c full_page_writes=off -c synchronous_commit=off \
  >/dev/null || fail "could not start the scratch PostgreSQL container"

ready=0
for _ in $(seq 1 60); do
  docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && { ready=1; break; }
  sleep 1
done
(( ready )) || fail "the scratch PostgreSQL container did not become ready"
ok "scratch database ready (isolated, no published port)"

# -----------------------------------------------------------------------------
# 2. Provision roles/databases with the REAL script — not a reimplementation.
# -----------------------------------------------------------------------------
printf '%s' "$SUPERUSER_PW"        | docker exec -i "$CONTAINER" sh -c 'cat >/run/secrets/pg_superuser_password'
printf '%s' "$CONTROL_APP_PW"      | docker exec -i "$CONTAINER" sh -c 'cat >/run/secrets/pg_control_app_password'
printf '%s' "$CONTROL_MIGRATOR_PW" | docker exec -i "$CONTAINER" sh -c 'cat >/run/secrets/pg_control_migrator_password'
printf '%s' "$N8N_APP_PW"          | docker exec -i "$CONTAINER" sh -c 'cat >/run/secrets/pg_n8n_app_password'
printf '%s' "$BACKUP_READER_PW"    | docker exec -i "$CONTAINER" sh -c 'cat >/run/secrets/pg_backup_reader_password'

# `docker cp` does not reliably write into a path covered by a `--tmpfs`
# mount for a running container (verified while building this test: it
# reports success but the file never appears) — piping through a live
# `docker exec` process instead works, because that process runs inside the
# container's actual mount namespace rather than whatever mechanism `docker
# cp` uses to reach the container's filesystem from the host side.
docker exec -i "$CONTAINER" sh -c 'cat > /run/secrets/.reconcile.sh' \
  < "${REPO_ROOT}/infra/postgres/reconcile/reconcile-roles-and-databases.sh"
if ! docker exec "$CONTAINER" bash /run/secrets/.reconcile.sh >/tmp/pc-reconcile-out.$$ 2>&1; then
  cat /tmp/pc-reconcile-out.$$ >&2
  rm -f /tmp/pc-reconcile-out.$$
  fail "reconcile-roles-and-databases.sh failed — see output above"
fi
rm -f /tmp/pc-reconcile-out.$$
ok "roles and databases provisioned by the real reconcile script"

psql_as() {
  local role="$1" pw="$2" db="$3"; shift 3
  # -q matters beyond noise suppression: without it, psql prints a command
  # completion tag ("INSERT 0 1") on its own line after -tAc output, which
  # would otherwise get captured as part of a `RETURNING id` value by every
  # `$(...)` fixture-insert call below.
  docker exec -i -e PGPASSWORD="$pw" "$CONTAINER" psql -v ON_ERROR_STOP=1 -q -U "$role" -d "$db" "$@"
}

# -----------------------------------------------------------------------------
# 3. Apply every real migration, in order, as control_migrator — exactly the
#    role/ownership context production migrations run under, which is what
#    makes 0002's `ALTER DEFAULT PRIVILEGES` actually take effect for every
#    table created by every migration after it.
# -----------------------------------------------------------------------------
migration_count=0
for migration in "${REPO_ROOT}"/migrations/*.sql; do
  [[ -f "$migration" ]] || continue
  if ! psql_as control_migrator "$CONTROL_MIGRATOR_PW" project_control -q <"$migration" >/tmp/pc-migrate-out.$$ 2>&1; then
    cat /tmp/pc-migrate-out.$$ >&2
    rm -f /tmp/pc-migrate-out.$$
    fail "migration $(basename "$migration") failed to apply"
  fi
  rm -f /tmp/pc-migrate-out.$$
  migration_count=$((migration_count+1))
done
ok "${migration_count} migration(s) applied cleanly as control_migrator"

# -----------------------------------------------------------------------------
# 4. Deterministic fixtures — one row per lifecycle-bearing table this test
#    covers, each in a terminal/settled state so the immutability triggers
#    have something real to refuse mutating below.
# -----------------------------------------------------------------------------
USER_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO users (email, display_name, password_hash, role) VALUES ('fixture@example.test','Fixture User','\$argon2id\$v=19\$m=19456,t=2,p=1\$abcdefghijklmnop\$abcdefghijklmnopqrstuvwxyzabcdef','admin') RETURNING id")"
[[ -n "$USER_ID" ]] || fail "fixture user insert returned no id"

PROJECT_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO projects (name, location_input_path, location_canonical_path, location_allowed_root)
   VALUES ('Fixture Project', '/tmp/fixture-project', '/tmp/fixture-project', '/tmp') RETURNING id")"
[[ -n "$PROJECT_ID" ]] || fail "fixture project insert returned no id"

ACTION_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO project_actions (project_id, kind, status, risk, plan_json, fingerprint, expires_at, requested_by, started_at, settled_at, result_json)
   VALUES ('${PROJECT_ID}', 'git.commit', 'succeeded', 'low', '{}'::jsonb, repeat('a',64), now() + interval '5 minutes', '${USER_ID}', now() - interval '1 minute', now(), '{\"succeeded\":true,\"commit\":{\"kind\":\"git.commit\",\"commitSha\":\"$(printf 'a%.0s' $(seq 1 40))\",\"shortSha\":\"aaaaaaa\",\"previousHeadSha\":null,\"branch\":\"main\",\"fileCount\":1,\"indexReconciled\":true,\"verified\":true},\"reason\":null,\"reconciledFromInterruption\":false}'::jsonb)
   RETURNING id")"
[[ -n "$ACTION_ID" ]] || fail "fixture project_action insert returned no id"

ACCOUNT_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO service_accounts (key, display_name, scopes) VALUES ('fixture-account','Fixture Account',ARRAY['automation:run','project:read']) RETURNING id")"
[[ -n "$ACCOUNT_ID" ]] || fail "fixture service_account insert returned no id"

TOKEN_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at)
   VALUES ('${ACCOUNT_ID}', repeat('b',64), 'pcs_fixture01', ARRAY['automation:run'], now() + interval '30 days')
   RETURNING id")"
[[ -n "$TOKEN_ID" ]] || fail "fixture service_token insert returned no id"

RUN_ROW_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO workflow_runs (workflow_key, status, trigger_kind, service_token_id, started_at, settled_at, result_json)
   VALUES ('fixture-workflow', 'completed', 'scheduled', '${TOKEN_ID}', now() - interval '1 minute', now(), '{\"summary\":\"ok\",\"severity\":\"info\",\"linkedActionId\":null,\"artifactId\":null,\"reason\":null}'::jsonb)
   RETURNING id")"
[[ -n "$RUN_ROW_ID" ]] || fail "fixture workflow_run insert returned no id"

STEP_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO workflow_run_steps (run_id, position, name, status, detail_json)
   VALUES ('${RUN_ROW_ID}', 0, 'fixture step', 'passed', '{}'::jsonb) RETURNING id")"
[[ -n "$STEP_ID" ]] || fail "fixture workflow_run_step insert returned no id"

ok "deterministic fixtures inserted: project_action=${ACTION_ID:0:8}… service_token=${TOKEN_ID:0:8}… workflow_run=${RUN_ROW_ID:0:8}…"

# -----------------------------------------------------------------------------
# 5. Grant probes — every one of these MUST be denied. A probe that succeeds
#    is a hard failure, not a warning.
# -----------------------------------------------------------------------------
assert_denied() {
  local label="$1" role="$2" pw="$3" sql="$4"
  local out status
  out="$(psql_as "$role" "$pw" project_control -tAc "$sql" 2>&1)" && status=0 || status=$?
  if (( status == 0 )); then
    fail "${label}: expected denial, but the statement SUCCEEDED"
  fi
  # Two families of denial are both acceptable: a PostgreSQL privilege/
  # constraint error (grant denial, FK, CHECK, unique index), or one of this
  # schema's own RAISE EXCEPTION messages from a guard trigger (immutability,
  # scope-ceiling, invalid transition, un-revoke). Either is a real rejection;
  # what would NOT be acceptable is silence, i.e. a nonzero exit with no
  # recognisable reason, which usually means the test's own SQL was wrong.
  if ! printf '%s' "$out" | grep -qiE \
    'permission denied|must be owner|new row violates|update or delete on table|violates.*constraint|insufficient privilege|duplicate key value violates unique constraint|immutable|subset|invalid.*transition|cannot be un-revoked'; then
    fail "${label}: statement failed, but not with a privilege/constraint denial — got: ${out}"
  fi
  ok "${label}: denied as expected"
}

assert_allowed() {
  local label="$1" role="$2" pw="$3" sql="$4"
  psql_as "$role" "$pw" project_control -tAc "$sql" >/dev/null 2>&1 \
    || fail "${label}: expected to succeed, but was denied"
  ok "${label}: succeeded as expected"
}

# --- Repository Actions (0013/0014) ------------------------------------------
assert_denied "control_app cannot DELETE project_actions" control_app "$CONTROL_APP_PW" \
  "DELETE FROM project_actions WHERE id='${ACTION_ID}'"
assert_denied "control_app cannot UPDATE a settled project_action's status" control_app "$CONTROL_APP_PW" \
  "UPDATE project_actions SET status='failed' WHERE id='${ACTION_ID}'"
assert_denied "backup_reader cannot write project_actions" backup_reader "$BACKUP_READER_PW" \
  "UPDATE project_actions SET risk='critical' WHERE id='${ACTION_ID}'"
# The settled ACTION_ID fixture above is terminal, so it does not occupy the
# one-open-per-project slot; a fresh 'planned' row is needed to prove the
# index actually blocks a second one.
OPEN_ACTION_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO project_actions (project_id, kind, status, risk, plan_json, fingerprint, expires_at)
     VALUES ('${PROJECT_ID}', 'git.commit', 'planned', 'low', '{}'::jsonb, repeat('c',64), now() + interval '5 minutes')
   RETURNING id")"
[[ -n "$OPEN_ACTION_ID" ]] || fail "fixture open project_action insert returned no id"
assert_denied "a second open project_action for the same project is rejected" control_app "$CONTROL_APP_PW" \
  "INSERT INTO project_actions (project_id, kind, status, risk, plan_json, fingerprint, expires_at)
     VALUES ('${PROJECT_ID}', 'git.commit', 'planned', 'low', '{}'::jsonb, repeat('f',64), now() + interval '5 minutes')"
assert_allowed "the open project_action can be cancelled" control_app "$CONTROL_APP_PW" \
  "UPDATE project_actions SET status='cancelled', settled_at=now() WHERE id='${OPEN_ACTION_ID}'"
assert_allowed "backup_reader can SELECT project_actions" backup_reader "$BACKUP_READER_PW" \
  "SELECT 1 FROM project_actions WHERE id='${ACTION_ID}'"

# --- Service identity (0015/0016) --------------------------------------------
assert_denied "control_app cannot DELETE service_tokens" control_app "$CONTROL_APP_PW" \
  "DELETE FROM service_tokens WHERE id='${TOKEN_ID}'"
assert_denied "control_app cannot DELETE service_accounts" control_app "$CONTROL_APP_PW" \
  "DELETE FROM service_accounts WHERE id='${ACCOUNT_ID}'"
assert_denied "backup_reader cannot write service_accounts" backup_reader "$BACKUP_READER_PW" \
  "UPDATE service_accounts SET status='disabled' WHERE id='${ACCOUNT_ID}'"
assert_denied "backup_reader cannot write service_tokens" backup_reader "$BACKUP_READER_PW" \
  "UPDATE service_tokens SET revoked_at=now() WHERE id='${TOKEN_ID}'"
# A second, disposable token — kept separate from TOKEN_ID so revoking it
# here does not change the fixture state later assertions rely on.
REVOKE_PROBE_TOKEN_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at)
     VALUES ('${ACCOUNT_ID}', repeat('e',64), 'pcs_revoke001', ARRAY['automation:run'], now() + interval '30 days')
   RETURNING id")"
assert_allowed "a token can be revoked" control_app "$CONTROL_APP_PW" \
  "UPDATE service_tokens SET revoked_at=now() WHERE id='${REVOKE_PROBE_TOKEN_ID}'"
assert_denied "a token cannot be un-revoked once revoked" control_app "$CONTROL_APP_PW" \
  "UPDATE service_tokens SET revoked_at=NULL WHERE id='${REVOKE_PROBE_TOKEN_ID}'"
assert_denied "a token's scopes cannot exceed its account's scopes" control_app "$CONTROL_APP_PW" \
  "INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at)
     VALUES ('${ACCOUNT_ID}', repeat('d',64), 'pcs_toowide01', ARRAY['action:plan'], now() + interval '30 days')"
assert_denied "an unknown scope value is rejected by the vocabulary CHECK" control_app "$CONTROL_APP_PW" \
  "INSERT INTO service_accounts (key, display_name, scopes) VALUES ('bad-scope-fixture','x',ARRAY['not:a:real:scope'])"
assert_denied "a malformed token_hash is rejected (not 64 hex chars)" control_app "$CONTROL_APP_PW" \
  "INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at)
     VALUES ('${ACCOUNT_ID}', 'not-a-real-hash', 'pcs_bad0000001', ARRAY['automation:run'], now() + interval '30 days')"
assert_allowed "backup_reader can SELECT service_accounts and service_tokens" backup_reader "$BACKUP_READER_PW" \
  "SELECT 1 FROM service_accounts a JOIN service_tokens t ON t.account_id=a.id WHERE t.id='${TOKEN_ID}'"

# --- Automation (0017/0018) ---------------------------------------------------
assert_denied "control_app cannot DELETE workflow_runs" control_app "$CONTROL_APP_PW" \
  "DELETE FROM workflow_runs WHERE id='${RUN_ROW_ID}'"
assert_denied "control_app cannot UPDATE a settled workflow_run's status" control_app "$CONTROL_APP_PW" \
  "UPDATE workflow_runs SET status='running' WHERE id='${RUN_ROW_ID}'"
assert_denied "control_app cannot UPDATE workflow_run_steps at all" control_app "$CONTROL_APP_PW" \
  "UPDATE workflow_run_steps SET status='failed' WHERE id='${STEP_ID}'"
assert_denied "control_app cannot DELETE workflow_run_steps" control_app "$CONTROL_APP_PW" \
  "DELETE FROM workflow_run_steps WHERE id='${STEP_ID}'"
assert_denied "backup_reader cannot write workflow_runs" backup_reader "$BACKUP_READER_PW" \
  "UPDATE workflow_runs SET external_ref='hijacked' WHERE id='${RUN_ROW_ID}'"
assert_denied "backup_reader cannot write workflow_run_steps" backup_reader "$BACKUP_READER_PW" \
  "INSERT INTO workflow_run_steps (run_id, position, name, status) VALUES ('${RUN_ROW_ID}', 99, 'hostile', 'passed')"
assert_denied "an orphaned workflow_run_step is rejected by its FK" control_app "$CONTROL_APP_PW" \
  "INSERT INTO workflow_run_steps (run_id, position, name, status) VALUES (gen_random_uuid(), 0, 'orphan', 'passed')"

# The settled RUN_ROW_ID fixture above is terminal, so it does not occupy the
# one-open-per-workflow slot; a fresh 'running' row is needed to prove the
# index actually blocks a second one for the same key.
OPEN_RUN_ID="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "INSERT INTO workflow_runs (workflow_key, status, trigger_kind, service_token_id, started_at)
     VALUES ('fixture-workflow-open', 'running', 'scheduled', '${TOKEN_ID}', now())
   RETURNING id")"
[[ -n "$OPEN_RUN_ID" ]] || fail "fixture open workflow_run insert returned no id"
assert_denied "a second open run for the same workflow key is rejected" control_app "$CONTROL_APP_PW" \
  "INSERT INTO workflow_runs (workflow_key, status, trigger_kind, service_token_id, started_at)
     VALUES ('fixture-workflow-open', 'running', 'scheduled', '${TOKEN_ID}', now())"
assert_allowed "the open workflow_run can be cancelled" control_app "$CONTROL_APP_PW" \
  "UPDATE workflow_runs SET status='cancelled', settled_at=now() WHERE id='${OPEN_RUN_ID}'"
assert_allowed "backup_reader can SELECT workflow_runs and workflow_run_steps" backup_reader "$BACKUP_READER_PW" \
  "SELECT 1 FROM workflow_runs r JOIN workflow_run_steps s ON s.run_id=r.id WHERE r.id='${RUN_ROW_ID}'"

# -----------------------------------------------------------------------------
# 6. Data-shape assertions plaintext-safety depends on.
# -----------------------------------------------------------------------------
plaintext_columns="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "SELECT string_agg(column_name, ',') FROM information_schema.columns WHERE table_name='service_tokens' AND table_schema='public'")"
if printf '%s' "$plaintext_columns" | grep -qiE '(^|,)(token|value|plaintext|secret)(,|$)'; then
  fail "service_tokens has a plaintext-shaped column: ${plaintext_columns}"
fi
ok "service_tokens schema has no plaintext-shaped column (columns: ${plaintext_columns})"

stored_hash="$(psql_as control_app "$CONTROL_APP_PW" project_control -tAc \
  "SELECT token_hash FROM service_tokens WHERE id='${TOKEN_ID}'")"
[[ "$stored_hash" =~ ^[0-9a-f]{64}$ ]] || fail "stored token_hash is not a well-formed SHA-256 digest: ${stored_hash}"
ok "stored token_hash is a well-formed 64-character hex digest"

# -----------------------------------------------------------------------------
printf 'PASS: backup/restore role-grant and trigger integrity — %d migration(s), all denial/allow probes correct\n' "$migration_count"
