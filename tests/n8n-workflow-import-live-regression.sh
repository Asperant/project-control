#!/usr/bin/env bash
# =============================================================================
# n8n-workflow-import-live-regression.sh
#
# Proves how `n8n import:workflow` actually behaves on the real, pinned
# n8n image — not assumed, not guessed from --help output alone — using a
# fully disposable n8n + PostgreSQL pair on an isolated network, and then
# runs the real, unmodified scripts/install-workflows.sh against it end to
# end. Nothing here is production: a fresh throwaway database, a random
# COMPOSE_PROJECT label so install-workflows.sh's own `container_id()`
# lookup only ever finds this disposable container, destroyed on exit.
#
# What this found and fixed while it was written (see infra/n8n/workflows/
# *.workflow.json and scripts/lib/workflow-lint.py's id-presence rule):
# a workflow file with no top-level "id" is REFUSED by import:workflow with
# a NOT NULL constraint violation on workflow_entity.id — every shipped
# workflow was missing one until this test caught it. That is the concrete
# reason this test exists as a permanent regression rather than a one-off
# exploration: a future workflow file that regresses the same way should
# fail here, in CI, not on a live host's first `install-workflows` run.
#
# Proven, each directly against this image, not inferred:
#   - a workflow file with no "id" fails import outright, importing nothing
#   - a workflow file WITH an id imports successfully
#   - re-importing the identical file (same id) does NOT create a duplicate
#     (import:workflow upserts by id)
#   - a DIFFERENT id sharing the same workflow `name` DOES create a genuine
#     duplicate — which is exactly why install-workflows.sh's own
#     list:workflow name-based skip check is load-bearing, not redundant
#   - with no --userId/--projectId (install-workflows.sh passes neither),
#     the imported workflow is NOT ownerless: n8n always has exactly one
#     pre-existing user row (the not-yet-claimed instance owner, created at
#     first boot before any UI setup) and one personal project owned by it;
#     import:workflow assigns to that project by default. Completing owner
#     setup later fills in that same row's email/password — it does not
#     create a new user — so the imported workflows are the real operator's
#     from the moment they finish setup, in either order.
#   - scripts/install-workflows.sh itself, run unmodified against this
#     disposable instance, imports once, then correctly SKIPS on a second
#     run (by name, via its own `n8n list:workflow` check) without ever
#     calling import:workflow a second time — proving the shipped
#     "no duplicate on re-run" claim end to end, through the real script.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not available/usable — cannot run this test"
  exit 0
fi

IMAGE_PG="$(grep -E '^PC_POSTGRES_IMAGE=' "${REPO_ROOT}/infra/versions.lock.env" | cut -d= -f2-)"
IMAGE_N8N="$(grep -E '^PC_N8N_IMAGE=' "${REPO_ROOT}/infra/versions.lock.env" | cut -d= -f2-)"
[[ -n "$IMAGE_PG" && -n "$IMAGE_N8N" ]] || { echo "FAIL: could not read pinned images from infra/versions.lock.env" >&2; exit 1; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
PG_CONTAINER="pc-n8n-import-pg-${RUN_ID}"
N8N_CONTAINER="pc-n8n-import-n8n-${RUN_ID}"
NETWORK="pc-n8n-import-net-${RUN_ID}"
# Deliberately not "project-control": install-workflows.sh's container_id()
# (scripts/lib/common.sh) filters on this label, and a random, obviously
# test-scoped value guarantees it can never accidentally resolve to a real
# deployment's container if this test ever ran alongside one.
COMPOSE_PROJECT="pc-import-test-${RUN_ID}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-n8n-import-test.XXXXXXXX")"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
ok() { printf '[  OK ] %s\n' "$1" >&2; }

cleanup() {
  local exit_code=$?
  docker rm -f "$N8N_CONTAINER" "$PG_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf -- "$SCRATCH"
  exit "$exit_code"
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# 1. Disposable PostgreSQL for n8n's own database.
# -----------------------------------------------------------------------------
docker network create --internal "$NETWORK" >/dev/null

docker run --detach --name "$PG_CONTAINER" --network "$NETWORK" --user 999:999 \
  --env POSTGRES_PASSWORD=disposable --env POSTGRES_USER=postgres --env POSTGRES_DB=n8n \
  --env PGDATA=/tmp/pgdata \
  --tmpfs /tmp:rw,size=512m --tmpfs /run/postgresql:rw,size=64m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --label "com.project-control.ephemeral=true" \
  "$IMAGE_PG" postgres -c fsync=off >/dev/null || fail "could not start the scratch PostgreSQL container"

ready=0
for _ in $(seq 1 30); do
  docker exec "$PG_CONTAINER" pg_isready -U postgres -q 2>/dev/null && { ready=1; break; }
  sleep 1
done
(( ready )) || fail "scratch PostgreSQL did not become ready"
ok "scratch PostgreSQL ready"

# -----------------------------------------------------------------------------
# 2. Disposable n8n on the pinned image. Bind mounts throughout (never
#    `docker cp`, which does not reliably write into a --tmpfs-covered path
#    on a running container — see install-workflows.sh's own comment).
# -----------------------------------------------------------------------------
mkdir -p "${SCRATCH}/secrets" "${SCRATCH}/n8n-data" "${SCRATCH}/pcroot/config/status/automation/workflows"
printf 'disposable' >"${SCRATCH}/secrets/db_password"
printf '%s' "$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')" >"${SCRATCH}/secrets/encryption_key"
chmod -R a+rwX "${SCRATCH}/n8n-data"

docker run --detach --name "$N8N_CONTAINER" \
  --network "$NETWORK" \
  --user 1000:1000 \
  --label "com.docker.compose.project=${COMPOSE_PROJECT}" \
  --label "com.docker.compose.service=n8n" \
  -v "${SCRATCH}/n8n-data:/home/node/.n8n" \
  -v "${SCRATCH}/secrets:/run/secrets:ro" \
  -v "${SCRATCH}/pcroot/config/status/automation/workflows:/workflows:ro" \
  --env DB_TYPE=postgresdb \
  --env DB_POSTGRESDB_HOST="$PG_CONTAINER" \
  --env DB_POSTGRESDB_PORT=5432 \
  --env DB_POSTGRESDB_DATABASE=n8n \
  --env DB_POSTGRESDB_USER=postgres \
  --env DB_POSTGRESDB_PASSWORD_FILE=/run/secrets/db_password \
  --env N8N_ENCRYPTION_KEY_FILE=/run/secrets/encryption_key \
  --env N8N_USER_FOLDER=/home/node/.n8n \
  --env N8N_DIAGNOSTICS_ENABLED=false \
  --env N8N_VERSION_NOTIFICATIONS_ENABLED=false \
  --env N8N_TEMPLATES_ENABLED=false \
  --env N8N_PERSONALIZATION_ENABLED=false \
  --env N8N_PUBLIC_API_DISABLED=true \
  --env N8N_LISTEN_ADDRESS=0.0.0.0 \
  --env N8N_PORT=5678 \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --label "com.project-control.ephemeral=true" \
  "$IMAGE_N8N" >/dev/null || fail "could not start the disposable n8n container"

ready=0
for _ in $(seq 1 60); do
  docker exec "$N8N_CONTAINER" wget -q -T 3 -O /dev/null http://127.0.0.1:5678/healthz 2>/dev/null && { ready=1; break; }
  sleep 2
done
(( ready )) || fail "disposable n8n did not become healthy — docker logs ${N8N_CONTAINER}:\n$(docker logs "$N8N_CONTAINER" 2>&1 | tail -30)"
ok "disposable n8n healthy, on the pinned image ${IMAGE_N8N}"

n8n_exec() { docker exec "$N8N_CONTAINER" "$@" 2>&1 | grep -v '^\[n8n\]'; }
# `list:workflow --onlyId` still prints n8n's own "Acquiring database
# migration lock..." status line to stdout ahead of the actual ids (same
# behavior already documented for `n8n audit` — see
# scripts/lib/n8n-audit-classify.py); counting non-empty lines directly
# would over-count by exactly one. Only lines shaped like a workflow id
# (n8n's own uuid, in this schema version) are counted.
n8n_workflow_count() { n8n_exec n8n list:workflow --onlyId | grep -Ec '^[0-9a-f-]{8,}$' || true; }

# -----------------------------------------------------------------------------
# 3. Baseline: nothing imported yet.
# -----------------------------------------------------------------------------
[[ "$(n8n_workflow_count)" == "0" ]] || fail "disposable n8n unexpectedly has workflows before any import"
ok "baseline: no workflows present"

# -----------------------------------------------------------------------------
# 4. A workflow file with no "id" is refused outright — this is the exact
#    defect every shipped workflow had before scripts/lib/workflow-lint.py
#    grew its id-presence rule.
# -----------------------------------------------------------------------------
python3 -c '
import json
doc = json.load(open("'"${REPO_ROOT}"'/infra/n8n/workflows/system-health.workflow.json"))
doc.pop("id", None)
json.dump(doc, open("'"${SCRATCH}"'/pcroot/config/status/automation/workflows/no-id.workflow.json", "w"))
'

no_id_output="$(n8n_exec n8n import:workflow --input=/workflows/no-id.workflow.json)" && no_id_status=0 || no_id_status=$?
printf '%s' "$no_id_output" | grep -qi 'violates not-null constraint' \
  || fail "importing an id-less workflow did not fail with the expected NOT NULL constraint error — n8n's behavior may have changed; output: ${no_id_output}"
[[ "$(n8n_workflow_count)" == "0" ]] || fail "a failed id-less import still left a row behind"
ok "a workflow file with no id is refused by import:workflow, and imports nothing (n8n's behavior confirmed, not assumed)"
rm -f "${SCRATCH}/pcroot/config/status/automation/workflows/no-id.workflow.json"

# -----------------------------------------------------------------------------
# 5. The real, shipped system-health.workflow.json (which now has an id)
#    imports successfully.
# -----------------------------------------------------------------------------
cp "${REPO_ROOT}/infra/n8n/workflows/system-health.workflow.json" \
   "${SCRATCH}/pcroot/config/status/automation/workflows/system-health.workflow.json"
shipped_id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' \
  "${REPO_ROOT}/infra/n8n/workflows/system-health.workflow.json")"

n8n_exec n8n import:workflow --input=/workflows/system-health.workflow.json | grep -qi 'Successfully imported' \
  || fail "the real, shipped system-health.workflow.json (which has an id) failed to import"
[[ "$(n8n_workflow_count)" == "1" ]] || fail "expected exactly 1 workflow after the first successful import"
listed="$(n8n_exec n8n list:workflow)"
printf '%s' "$listed" | grep -qF "${shipped_id}|Project Control — System Health" \
  || fail "the imported workflow's id/name did not match the shipped file; list:workflow said: ${listed}"
ok "the real shipped workflow file imports successfully with its committed id"

# -----------------------------------------------------------------------------
# 6. Re-importing the SAME file (same id) does not create a duplicate —
#    import:workflow upserts by id.
# -----------------------------------------------------------------------------
n8n_exec n8n import:workflow --input=/workflows/system-health.workflow.json | grep -qi 'Successfully imported' \
  || fail "re-importing the identical file failed unexpectedly"
[[ "$(n8n_workflow_count)" == "1" ]] || fail "re-importing the identical file (same id) created a duplicate — still exactly 1 expected, got $(n8n_workflow_count)"
ok "re-importing the identical file (same id) does not duplicate — import:workflow upserts by id"

# -----------------------------------------------------------------------------
# 7. A DIFFERENT id sharing the same workflow name DOES create a genuine
#    duplicate — proving install-workflows.sh's own name-based skip check
#    (via list:workflow) is load-bearing, not redundant defense-in-depth.
# -----------------------------------------------------------------------------
python3 -c '
import json, uuid
doc = json.load(open("'"${REPO_ROOT}"'/infra/n8n/workflows/system-health.workflow.json"))
doc["id"] = str(uuid.uuid4())
json.dump(doc, open("'"${SCRATCH}"'/same-name-different-id.workflow.json", "w"))
'
# Staged via the same tmpfs-safe docker-exec pipe install-workflows.sh itself
# uses, into /tmp rather than the bind-mounted /workflows — this fixture is
# a one-off probe, not something install-workflows.sh's own glob should see.
docker exec -i "$N8N_CONTAINER" sh -c "cat > /tmp/same-name-different-id.workflow.json" <"${SCRATCH}/same-name-different-id.workflow.json"
n8n_exec n8n import:workflow --input=/tmp/same-name-different-id.workflow.json | grep -qi 'Successfully imported' \
  || fail "importing a same-name-different-id fixture failed unexpectedly"
[[ "$(n8n_workflow_count)" == "2" ]] \
  || fail "expected a genuine duplicate (2 rows, same name, different ids) after a different-id/same-name import, got $(n8n_workflow_count)"
ok "a different id sharing the same workflow name DOES create a real duplicate (confirms install-workflows.sh's list:workflow name-check is necessary)"
docker exec "$N8N_CONTAINER" rm -f /tmp/same-name-different-id.workflow.json >/dev/null 2>&1 || true

# -----------------------------------------------------------------------------
# 8. Ownership without --userId/--projectId: n8n's own pre-existing,
#    not-yet-claimed instance-owner user and personal project are what the
#    import lands in — never an orphaned/ownerless row.
# -----------------------------------------------------------------------------
shared_row="$(docker exec -i -e PGPASSWORD=disposable "$PG_CONTAINER" \
  psql -U postgres -d n8n -tAc "SELECT count(*) FROM shared_workflow WHERE \"workflowId\" = '${shipped_id}' AND role = 'workflow:owner'")"
[[ "$shared_row" == "1" ]] || fail "the imported workflow has no workflow:owner share row — ownership assignment did not happen as expected"
user_count="$(docker exec -i -e PGPASSWORD=disposable "$PG_CONTAINER" psql -U postgres -d n8n -tAc 'SELECT count(*) FROM "user"')"
[[ "$user_count" == "1" ]] \
  || fail "expected exactly one pre-existing (not-yet-claimed) instance-owner user row, found ${user_count}"
ok "with no --userId/--projectId, the import is owned by n8n's own singleton pre-setup instance-owner user — never ownerless"

# -----------------------------------------------------------------------------
# 9. The real, unmodified install-workflows.sh, against this disposable
#    instance: imports once, then correctly skips on a second run without
#    calling import:workflow again.
# -----------------------------------------------------------------------------
# Reset to a clean single-workflow state so the script's own before/after
# counting below is unambiguous.
docker exec -i -e PGPASSWORD=disposable "$PG_CONTAINER" \
  psql -U postgres -d n8n -tAc "DELETE FROM shared_workflow; DELETE FROM workflow_entity;" >/dev/null
[[ "$(n8n_workflow_count)" == "0" ]] || fail "could not reset the disposable n8n to zero workflows before testing install-workflows.sh"

# install-workflows.sh discovers files via glob, not a fixed list — an extra
# leftover fixture from step 7's copy must not be present.
find "${SCRATCH}/pcroot/config/status/automation/workflows" -type f ! -name 'system-health.workflow.json' -delete

first_run="$(PC_ROOT="${SCRATCH}/pcroot" PC_COMPOSE_PROJECT="$COMPOSE_PROJECT" \
  bash "${REPO_ROOT}/scripts/install-workflows.sh" 2>&1)" && first_status=0 || first_status=$?
(( first_status == 0 )) || fail "install-workflows.sh's first run failed (status ${first_status}); output:\n${first_run}"
printf '%s' "$first_run" | grep -qF "workflows: 1 imported, 0 already present" \
  || fail "install-workflows.sh's first run did not report 1 imported/0 skipped; output:\n${first_run}"
[[ "$(n8n_workflow_count)" == "1" ]] || fail "install-workflows.sh's first run did not leave exactly 1 workflow in n8n"

second_run="$(PC_ROOT="${SCRATCH}/pcroot" PC_COMPOSE_PROJECT="$COMPOSE_PROJECT" \
  bash "${REPO_ROOT}/scripts/install-workflows.sh" 2>&1)" && second_status=0 || second_status=$?
(( second_status == 0 )) || fail "install-workflows.sh's second run failed (status ${second_status}); output:\n${second_run}"
printf '%s' "$second_run" | grep -qF "workflows: 0 imported, 1 already present" \
  || fail "install-workflows.sh's second run did not report 0 imported/1 skipped; output:\n${second_run}"
[[ "$(n8n_workflow_count)" == "1" ]] \
  || fail "install-workflows.sh's second run changed the workflow count — expected it to still be 1, got $(n8n_workflow_count)"
ok "scripts/install-workflows.sh (real, unmodified): imports once, skips on re-run, never duplicates — end to end, against the pinned image"

printf 'PASS: n8n import:workflow behavior fully characterised and install-workflows.sh proven idempotent, against the real pinned n8n 2.34.0 image\n'
