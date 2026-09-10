#!/usr/bin/env bash
# =============================================================================
# control-api-config-mount-regression.sh
#
# Reproduces, then proves fixed, the exact live deployment failure:
# control-api's real container, started with `read_only: true`, used to
# bind-mount TWO directories nested at /config and /config/automation.
# Docker/runc mounts a container's bind mounts in target-path order
# (shortest first), so by the time it processes the /config/automation
# entry, /config is already an active read-only bind mount; creating the
# /config/automation mountpoint inside it requires a `mkdir` that a
# read-only mount refuses. This is an OCI runtime *container-create*
# failure — it happens before the entrypoint ever runs, so no amount of
# readiness-gate retrying could ever have fixed it, and no control-api log
# line can ever explain it (the process never starts).
#
# The fix (infra/compose/compose.yaml, scripts/install.sh, scripts/
# update.sh, scripts/install-workflows.sh, scripts/verify-security.sh):
# the automation manifest/workflow registry now lives ON THE HOST as a real
# subdirectory of config/status (the directory the existing /config mount
# already sources from), not as a sibling directory requiring its own bind
# mount. The container-visible path is unchanged (/config/automation/
# manifest.json); only the host-side layout and the mount count (two -> one)
# changed.
#
# Two tiers:
#   1. Pure Docker/OCI mount semantics (this repo's own control-api image,
#      no database needed) — proves the exact failure reproduces on the old
#      topology and is gone on the new one, and that the new mount is still
#      genuinely read-only (cannot write the manifest, cannot create a new
#      file under /config/automation).
#   2. A full, real boot: disposable PostgreSQL, the real role/database
#      reconciliation script (unmodified, the same file db-bootstrap runs
#      in production), then the real control-api image with the new mount
#      topology, proving it actually reaches a healthy listening state and
#      that its own boot-time manifest validation still runs (an invalid
#      manifest still refuses to start).
#
# Nothing here is production: a throwaway network, throwaway containers,
# throwaway secrets, destroyed on exit.
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
IMAGE_CONTROL_API="$(grep -E '^PC_CONTROL_API_IMAGE=' "${REPO_ROOT}/infra/versions.lock.env" | cut -d= -f2-)"
[[ -n "$IMAGE_PG" && -n "$IMAGE_CONTROL_API" ]] || { echo "FAIL: could not read pinned images from infra/versions.lock.env" >&2; exit 1; }

if ! docker image inspect "$IMAGE_CONTROL_API" >/dev/null 2>&1; then
  echo "SKIP: ${IMAGE_CONTROL_API} is not built locally (run: bash scripts/build.sh) — cannot run this test"
  exit 0
fi

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
ok() { printf '[  OK ] %s\n' "$1" >&2; }

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-config-mount-test.XXXXXXXX")"
PG_CONTAINER="pc-mount-pg-${RUN_ID}"
API_CONTAINER="pc-mount-api-${RUN_ID}"
RECONCILE_CONTAINER="pc-mount-reconcile-${RUN_ID}"
NETWORK="pc-mount-net-${RUN_ID}"

cleanup() {
  local exit_code=$?
  docker rm -f "$API_CONTAINER" "$PG_CONTAINER" "$RECONCILE_CONTAINER" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf -- "$SCRATCH"
  exit "$exit_code"
}
trap cleanup EXIT

# -----------------------------------------------------------------------------
# Fixture layout.
# -----------------------------------------------------------------------------
mkdir -p \
  "${SCRATCH}/old-config-status" \
  "${SCRATCH}/old-config-automation" \
  "${SCRATCH}/config-status/automation/workflows" \
  "${SCRATCH}/artifacts" \
  "${SCRATCH}/secrets/control-api" \
  "${SCRATCH}/secrets/reconcile"

printf '{}' >"${SCRATCH}/old-config-status/tailscale-status.json"
printf '{"version":1,"workflows":[]}' >"${SCRATCH}/old-config-automation/manifest.json"

printf '{}' >"${SCRATCH}/config-status/tailscale-status.json"
printf '{}' >"${SCRATCH}/config-status/backup-status.json"
printf '{}' >"${SCRATCH}/config-status/verification.json"
cp "${REPO_ROOT}/infra/n8n/workflows/manifest.json" "${SCRATCH}/config-status/automation/manifest.json"
cp "${REPO_ROOT}/infra/n8n/workflows/system-health.workflow.json" \
   "${SCRATCH}/config-status/automation/workflows/system-health.workflow.json"

# -----------------------------------------------------------------------------
# 1. The OLD, broken topology reproduces the exact live failure — on this
#    repo's own control-api image, not a stand-in.
# -----------------------------------------------------------------------------
old_output="$(docker run --rm --read-only \
  -v "${SCRATCH}/old-config-status:/config:ro" \
  -v "${SCRATCH}/old-config-automation:/config/automation:ro" \
  -v "${SCRATCH}/artifacts:/data/artifacts" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "$IMAGE_CONTROL_API" true 2>&1)" && old_status=0 || old_status=$?

(( old_status != 0 )) || fail "the old two-mount topology was expected to fail to even create the container, but docker run exited 0"
printf '%s' "$old_output" | grep -qi 'mkdirat' || fail "old topology failed, but not with the expected OCI mkdir error; output: ${old_output}"
printf '%s' "$old_output" | grep -qi 'read-only file system' || fail "old topology failed, but not with 'read-only file system'; output: ${old_output}"
ok "old topology (two nested bind mounts under read_only) reproduces the exact live OCI mount failure, on this repo's own control-api image"

# -----------------------------------------------------------------------------
# 2. The NEW topology: a single /config mount, automation nested inside it.
#    Container creation and start must succeed; the manifest must be
#    readable; the mount must still be genuinely read-only.
# -----------------------------------------------------------------------------
new_output="$(docker run --rm --read-only --entrypoint cat \
  -v "${SCRATCH}/config-status:/config:ro" \
  -v "${SCRATCH}/artifacts:/data/artifacts" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "$IMAGE_CONTROL_API" /config/automation/manifest.json 2>&1)" && new_status=0 || new_status=$?

(( new_status == 0 )) || fail "the new single-mount topology failed to create/start; output: ${new_output}"
printf '%s' "$new_output" | grep -q '"workflows"' || fail "manifest.json was not readable at /config/automation/manifest.json inside the container; got: ${new_output}"
ok "new topology (automation nested under the one /config mount) starts cleanly, and /config/automation/manifest.json is readable"

# -----------------------------------------------------------------------------
# 3. Read-only enforcement: control-api cannot write the manifest, and
#    cannot create a new file under /config/automation.
# -----------------------------------------------------------------------------
write_output="$(docker run --rm --read-only --entrypoint sh \
  -v "${SCRATCH}/config-status:/config:ro" \
  -v "${SCRATCH}/artifacts:/data/artifacts" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "$IMAGE_CONTROL_API" -c 'echo overwritten > /config/automation/manifest.json' 2>&1)" && write_status=0 || write_status=$?
(( write_status != 0 )) || fail "control-api was able to write to /config/automation/manifest.json — the manifest is not actually read-only"
printf '%s' "$write_output" | grep -qi 'read-only file system' || fail "the write attempt failed, but not with 'read-only file system'; output: ${write_output}"
ok "control-api cannot write the automation manifest"

create_output="$(docker run --rm --read-only --entrypoint sh \
  -v "${SCRATCH}/config-status:/config:ro" \
  -v "${SCRATCH}/artifacts:/data/artifacts" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "$IMAGE_CONTROL_API" -c 'touch /config/automation/injected.json' 2>&1)" && create_status=0 || create_status=$?
(( create_status != 0 )) || fail "control-api was able to create a new file under /config/automation"
printf '%s' "$create_output" | grep -qi 'read-only file system' || fail "the create attempt failed, but not with 'read-only file system'; output: ${create_output}"
ok "control-api cannot create files under /config/automation"

# -----------------------------------------------------------------------------
# 4. Existing /config/status files are unaffected by the restructuring.
# -----------------------------------------------------------------------------
status_output="$(docker run --rm --read-only --entrypoint sh \
  -v "${SCRATCH}/config-status:/config:ro" \
  -v "${SCRATCH}/artifacts:/data/artifacts" \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "$IMAGE_CONTROL_API" -c 'cat /config/tailscale-status.json && cat /config/backup-status.json && cat /config/verification.json' 2>&1)" \
  && status_status=0 || status_status=$?
(( status_status == 0 )) || fail "existing /config/status files (tailscale/backup/verification) are no longer readable at /config/*.json; output: ${status_output}"
ok "existing /config/status files (tailscale-status.json, backup-status.json, verification.json) still work"

# -----------------------------------------------------------------------------
# 5. Full real boot: disposable PostgreSQL, the real (unmodified) role/db
#    reconciliation script, then the real control-api image with the fixed
#    mount, proving it reaches a healthy listening state end to end.
# -----------------------------------------------------------------------------
docker network create --internal "$NETWORK" >/dev/null

superuser_pw="disposable-$(od -An -tx1 -N12 /dev/urandom | tr -d ' \n')"
control_app_pw="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
control_migrator_pw="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
n8n_app_pw="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
backup_reader_pw="$(od -An -tx1 -N24 /dev/urandom | tr -d ' \n')"
session_secret="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"

printf '%s' "$superuser_pw"        >"${SCRATCH}/secrets/reconcile/pg_superuser_password"
printf '%s' "$control_app_pw"      >"${SCRATCH}/secrets/reconcile/pg_control_app_password"
printf '%s' "$control_migrator_pw" >"${SCRATCH}/secrets/reconcile/pg_control_migrator_password"
printf '%s' "$n8n_app_pw"          >"${SCRATCH}/secrets/reconcile/pg_n8n_app_password"
printf '%s' "$backup_reader_pw"    >"${SCRATCH}/secrets/reconcile/pg_backup_reader_password"

printf '%s' "$control_app_pw"      >"${SCRATCH}/secrets/control-api/pg_control_app_password"
printf '%s' "$control_migrator_pw" >"${SCRATCH}/secrets/control-api/pg_control_migrator_password"
printf '%s' "$session_secret"      >"${SCRATCH}/secrets/control-api/session_secret"
touch "${SCRATCH}/runner.sock"

# control-api runs as uid 10001 inside the container (matching production's
# PC_APP_UID); the host-side artifacts directory must be writable by it, the
# same way install.sh's `ensure_dir ... "${PC_APP_UID}" "${PC_APP_GID}"`
# ensures on a real host. chmod, not chown: this test does not run as root.
chmod -R 0777 "${SCRATCH}/artifacts"

docker run --detach --name "$PG_CONTAINER" --network "$NETWORK" --user 999:999 \
  --env POSTGRES_PASSWORD="$superuser_pw" --env POSTGRES_USER=postgres --env POSTGRES_DB=postgres \
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

# The real reconciliation script, unmodified — the same file db-bootstrap
# runs in production, bind-mounted read-only, never copied or re-implemented.
reconcile_output="$(docker run --name "$RECONCILE_CONTAINER" --network "$NETWORK" --user 999:999 \
  -v "${REPO_ROOT}/infra/postgres/reconcile/reconcile-roles-and-databases.sh:/reconcile.sh:ro" \
  -v "${SCRATCH}/secrets/reconcile:/run/secrets:ro" \
  --env PGHOST="$PG_CONTAINER" --env PGPORT=5432 --env POSTGRES_USER=postgres --env POSTGRES_DB=postgres \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "$IMAGE_PG" bash /reconcile.sh 2>&1)" && reconcile_status=0 || reconcile_status=$?
(( reconcile_status == 0 )) || fail "the real reconcile-roles-and-databases.sh failed against the disposable cluster; output:\n${reconcile_output}"
ok "roles and databases reconciled with the real, unmodified reconcile-roles-and-databases.sh"

docker run --detach --name "$API_CONTAINER" --network "$NETWORK" --user 10001:10001 \
  -v "${SCRATCH}/artifacts:/data/artifacts" \
  -v "${SCRATCH}/secrets/control-api:/run/secrets:ro" \
  -v "${SCRATCH}/config-status:/config:ro" \
  -v "${SCRATCH}/runner.sock:/run/project-control/runner.sock" \
  --env NODE_ENV=production \
  --env PC_API_HOST=0.0.0.0 --env PC_API_PORT=8080 \
  --env PC_PG_HOST="$PG_CONTAINER" --env PC_PG_PORT=5432 --env PC_PG_DATABASE=project_control \
  --env PC_PG_USER=control_app --env PC_PG_PASSWORD_FILE=/run/secrets/pg_control_app_password \
  --env PC_PG_MIGRATOR_USER=control_migrator --env PC_PG_MIGRATOR_PASSWORD_FILE=/run/secrets/pg_control_migrator_password \
  --env PC_SESSION_SECRET_FILE=/run/secrets/session_secret --env PC_SESSION_COOKIE_SECURE=false \
  --env PC_ARTIFACT_ROOT=/data/artifacts \
  --env PC_RUNNER_SOCKET=/run/project-control/runner.sock \
  --env PC_AUTOMATION_MANIFEST_FILE=/config/automation/manifest.json \
  --env PC_LOG_LEVEL=info \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  --label "com.project-control.ephemeral=true" \
  "$IMAGE_CONTROL_API" >/dev/null || fail "could not start the real control-api container with the new mount topology"

healthy=0
for _ in $(seq 1 60); do
  status="$(docker inspect --format '{{.State.Status}}' "$API_CONTAINER" 2>/dev/null || echo unknown)"
  [[ "$status" == "exited" || "$status" == "dead" ]] && break
  if docker exec "$API_CONTAINER" node -e \
       "fetch('http://127.0.0.1:8080/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
    healthy=1
    break
  fi
  sleep 2
done

if (( ! healthy )); then
  fail "control-api did not become healthy — this is the exact requirement the live incident failed on. docker logs:\n$(docker logs "$API_CONTAINER" 2>&1 | tail -60)"
fi
ok "control-api starts successfully and reaches a healthy listening state, with the new mount topology (real disposable PostgreSQL, real reconcile script, real migrations)"

log_snapshot="$(docker logs "$API_CONTAINER" 2>&1)"
printf '%s' "$log_snapshot" | grep -qi 'read-only file system' && fail "control-api's logs mention 'read-only file system' even though it started — investigate"
printf '%s' "$log_snapshot" | grep -qi 'automation manifest loaded' \
  || fail "control-api's logs do not show the boot-time manifest-loaded line — automation manifest.ts may not have run; logs:\n${log_snapshot}"
ok "boot-time manifest validation ran (the manifest-loaded log line is present) and no mount-related error appears anywhere in the logs"

docker rm -f "$API_CONTAINER" >/dev/null 2>&1 || true

# -----------------------------------------------------------------------------
# 6. An invalid manifest still prevents startup — fail-closed behavior is
#    unaffected by the mount restructuring.
# -----------------------------------------------------------------------------
BAD_MANIFEST_DIR="${SCRATCH}/config-status-bad-manifest"
mkdir -p "${BAD_MANIFEST_DIR}/automation/workflows"
cp "${SCRATCH}/config-status/tailscale-status.json" "${BAD_MANIFEST_DIR}/"
cp "${SCRATCH}/config-status/backup-status.json" "${BAD_MANIFEST_DIR}/"
cp "${SCRATCH}/config-status/verification.json" "${BAD_MANIFEST_DIR}/"
printf '{ this is not valid json' >"${BAD_MANIFEST_DIR}/automation/manifest.json"

bad_output="$(docker run --rm --user 10001:10001 \
  -v "${SCRATCH}/artifacts:/data/artifacts" \
  -v "${SCRATCH}/secrets/control-api:/run/secrets:ro" \
  -v "${BAD_MANIFEST_DIR}:/config:ro" \
  -v "${SCRATCH}/runner.sock:/run/project-control/runner.sock" \
  --env NODE_ENV=production --env PC_API_HOST=0.0.0.0 --env PC_API_PORT=8080 \
  --env PC_PG_HOST="$PG_CONTAINER" --env PC_PG_PORT=5432 --env PC_PG_DATABASE=project_control \
  --env PC_PG_USER=control_app --env PC_PG_PASSWORD_FILE=/run/secrets/pg_control_app_password \
  --env PC_SESSION_SECRET_FILE=/run/secrets/session_secret --env PC_SESSION_COOKIE_SECURE=false \
  --env PC_ARTIFACT_ROOT=/data/artifacts --env PC_RUNNER_SOCKET=/run/project-control/runner.sock \
  --env PC_AUTOMATION_MANIFEST_FILE=/config/automation/manifest.json \
  --network "$NETWORK" \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,nodev,size=32m \
  --security-opt no-new-privileges:true --cap-drop ALL \
  "$IMAGE_CONTROL_API" 2>&1)" && bad_status=0 || bad_status=$?

(( bad_status != 0 )) || fail "control-api started successfully against an invalid (malformed JSON) manifest — boot-time validation regressed"
printf '%s' "$bad_output" | grep -qi 'not valid JSON\|automation manifest' \
  || fail "control-api refused to start, but not with the expected manifest-validation error; output: ${bad_output}"
ok "an invalid manifest still prevents control-api from starting (fail-closed boot-time validation unaffected by the mount fix)"

printf 'PASS: control-api /config mount fix reproduces and resolves the exact live OCI mount failure, preserves read-only enforcement, and boots for real against a disposable PostgreSQL\n'
