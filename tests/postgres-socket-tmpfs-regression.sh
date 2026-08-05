#!/usr/bin/env bash
# =============================================================================
# postgres-socket-tmpfs-regression.sh
#
# Regression coverage for the /run/postgresql tmpfs ownership bug: a tmpfs
# mount defaults to root:root regardless of the container's `user:`, because
# the mount is set up before the process is exec'd. Without an explicit
# uid/gid, PostgreSQL (running unprivileged, no capabilities) cannot chmod or
# write its own socket lock file and the container fatally exits.
#
# Part 1 (always runs): statically checks infra/compose/compose.yaml so the
# fix cannot silently regress even where Docker is unavailable (e.g. plain CI).
# Part 2 (skipped without Docker): actually starts the pinned PostgreSQL image
# with the extracted tmpfs settings against a fresh, correctly-owned data
# directory and confirms it reaches "ready to accept connections" — proving
# the fix works, not just that the YAML looks right.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
COMPOSE_FILE="${REPO_ROOT}/infra/compose/compose.yaml"
VERSIONS_FILE="${REPO_ROOT}/infra/versions.lock.env"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$COMPOSE_FILE" ]] || fail "compose file not found: $COMPOSE_FILE"
[[ -f "$VERSIONS_FILE" ]] || fail "versions lock file not found: $VERSIONS_FILE"

# shellcheck source=/dev/null
PC_POSTGRES_UID="$(grep -E '^PC_POSTGRES_UID=' "$VERSIONS_FILE" | cut -d= -f2)"
PC_POSTGRES_GID="$(grep -E '^PC_POSTGRES_GID=' "$VERSIONS_FILE" | cut -d= -f2)"
PC_POSTGRES_IMAGE="$(grep -E '^PC_POSTGRES_IMAGE=' "$VERSIONS_FILE" | cut -d= -f2)"
[[ -n "$PC_POSTGRES_UID" && -n "$PC_POSTGRES_GID" ]] \
  || fail "PC_POSTGRES_UID/PC_POSTGRES_GID not found in $VERSIONS_FILE"

postgres_block="$(awk '/^  postgres:/{f=1;next}/^  [a-zA-Z_-]+:$/{f=0}f' "$COMPOSE_FILE")"
[[ -n "$postgres_block" ]] || fail "could not isolate the postgres service block in compose.yaml"

# -----------------------------------------------------------------------------
# Part 1: static compose review
# -----------------------------------------------------------------------------

socket_line="$(echo "$postgres_block" | grep -E '/run/postgresql:' || true)"
[[ -n "$socket_line" ]] || fail "no /run/postgresql tmpfs mount found on the postgres service"

echo "$socket_line" | grep -qE 'uid=\$\{PC_POSTGRES_UID' \
  || fail "/run/postgresql tmpfs mount has no uid= option tied to PC_POSTGRES_UID: ${socket_line}"
echo "$socket_line" | grep -qE 'gid=\$\{PC_POSTGRES_GID' \
  || fail "/run/postgresql tmpfs mount has no gid= option tied to PC_POSTGRES_GID: ${socket_line}"

mode="$(echo "$socket_line" | grep -oE 'mode=[0-7]{3,4}' | cut -d= -f2)"
[[ -n "$mode" ]] || fail "/run/postgresql tmpfs mount has no explicit mode="
last_digit="${mode: -1}"
(( (last_digit & 2) == 0 )) \
  || fail "/run/postgresql tmpfs mode ${mode} grants other-write; the socket directory must not be world-writable"

echo "$postgres_block" | grep -qE '^\s+ports:' \
  && fail "postgres service publishes a ports: mapping; it must be reachable only on the data network"

echo "$postgres_block" | grep -qE '<<:\s*\[\*hardening' \
  || fail "postgres service does not include the shared hardening anchor (cap_drop: ALL, no-new-privileges)"

echo "$postgres_block" | grep -qE '^\s+user:\s*"\$\{PC_POSTGRES_UID' \
  || fail "postgres service user: is not tied to PC_POSTGRES_UID/PC_POSTGRES_GID"

printf 'PASS: compose.yaml static checks (uid=%s gid=%s mode=%s, no ports, hardened)\n' \
  "$PC_POSTGRES_UID" "$PC_POSTGRES_GID" "$mode"

# -----------------------------------------------------------------------------
# Part 2: functional startup check against the real pinned image
# -----------------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf 'SKIP: Docker is not available; static checks above still ran\n' >&2
  exit 0
fi

RUN_ID="pgtmpfs-$$-${RANDOM}"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/${RUN_ID}.XXXXXX")"
DATA_DIR="${SCRATCH}/data"
mkdir -p "$DATA_DIR"

cleanup() {
  docker rm -f "$RUN_ID" >/dev/null 2>&1 || true
  # DATA_DIR ends up owned by PC_POSTGRES_UID, not this user, so it is removed
  # the same way it was created: via a throwaway container.
  docker run --rm -v "${SCRATCH}:/d" alpine:latest rm -rf /d >/dev/null 2>&1 || true
  rmdir "$SCRATCH" 2>/dev/null || true
}
trap cleanup EXIT

docker run --rm -v "${DATA_DIR}:/d" alpine:latest chown -R "${PC_POSTGRES_UID}:${PC_POSTGRES_GID}" /d >/dev/null

docker run -d --name "$RUN_ID" \
  --user "${PC_POSTGRES_UID}:${PC_POSTGRES_GID}" \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs "/tmp:rw,noexec,nosuid,nodev,size=64m" \
  --tmpfs "/run/postgresql:rw,noexec,nosuid,nodev,size=16m,mode=${mode},uid=${PC_POSTGRES_UID},gid=${PC_POSTGRES_GID}" \
  -v "${DATA_DIR}:/var/lib/postgresql/data" \
  -e POSTGRES_PASSWORD=regression-test-only \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  "$PC_POSTGRES_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 30); do
  if docker logs "$RUN_ID" 2>&1 | grep -q 'database system is ready to accept connections'; then
    ready=1
    break
  fi
  if [[ "$(docker inspect --format '{{.State.Status}}' "$RUN_ID" 2>/dev/null)" == "exited" ]]; then
    break
  fi
  sleep 1
done

if (( ! ready )); then
  printf 'FAIL: postgres did not report ready within 30s; logs:\n' >&2
  docker logs "$RUN_ID" 2>&1 | tail -30 >&2
  exit 1
fi

if docker logs "$RUN_ID" 2>&1 | grep -q 'Permission denied\|Operation not permitted'; then
  fail "socket-directory permission errors reappeared in postgres logs"
fi

printf 'PASS: postgres started successfully with the fixed tmpfs mount (no capabilities, non-root, no chown needed)\n'
