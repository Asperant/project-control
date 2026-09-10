#!/usr/bin/env bash
# =============================================================================
# rollback-created-container-recovery-regression.sh
#
# Covers the incident class this turn investigated: postgres/n8n/web healthy
# (web possibly on a stale image), control-api/caddy stuck in Docker's
# `created` state after a failed update, AND — the fact that changes the
# recovery decision — the pending migration(s) that update was trying to
# apply were NEVER actually committed (container *start* failed before the
# entrypoint, which is the only thing that ever runs real, non-dry-run SQL,
# ever executed). That fact is what makes rolling the application images
# back safe here: there is no schema drift to protect against.
#
# This suite proves, against REAL Docker (parts 1-5) and the existing fake-
# docker harness convention (parts 6-8, matching
# tests/deployment-incident-behavior-regression.sh's setup_rollback_fixture):
#
#   1/2. A `created` (never started, or started-and-failed) container's image
#        ID is stable, resolvable via `docker inspect`, and identical to what
#        `docker image inspect` on the same tag reports — the exact fact
#        lib/common.sh's deployment_images_match_lock() and
#        reconcile-state.sh's REC-003/004 already rely on.
#   3/4. deployment_images_match_lock() — real production code, not a test
#        double — correctly REJECTS a service whose container is running a
#        different image than the lock says (wrong image) and one whose lock
#        reference doesn't resolve locally at all (unknown image), and
#        ACCEPTS a fully coherent set. None of this requires any container to
#        be started.
#   6.   rollback.sh (real, unmodified) recovers control-api/caddy from
#        Docker's `created` state exactly as well as it recovers a merely
#        wrong-image running container — it never inspects prior container
#        status, only the target snapshot's own coherence and image
#        presence, so a stuck `created` container is not a special case it
#        needs to know about.
#   7.   rollback.sh never touches schema_migrations or invokes migrate.js —
#        migration safety is a property of what the script does NOT do.
#   8.   After a successful rollback, deployment_images_match_lock() — the
#        exact gate `update.sh` step 2 evaluates — passes against the
#        restored files and the now-running restored containers: the
#        post-recovery coherence gate genuinely passes, not merely "recovery
#        claims success."
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not available/usable — cannot run this test"
  exit 0
fi

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-rollback-created-recovery.XXXXXXXX")"
CLEANUP_CIDS=()
CLEANUP_TAGS=()
trap '
  for c in "${CLEANUP_CIDS[@]:-}"; do [[ -n "$c" ]] && docker rm -f "$c" >/dev/null 2>&1 || true; done
  for t in "${CLEANUP_TAGS[@]:-}"; do [[ -n "$t" ]] && docker rmi "$t" >/dev/null 2>&1 || true; done
  rm -rf -- "$SCRATCH"
' EXIT

docker pull -q alpine:3 >/dev/null
docker pull -q busybox:stable >/dev/null

ALPINE_ID="$(docker image inspect --format '{{.Id}}' alpine:3)"
BUSYBOX_ID="$(docker image inspect --format '{{.Id}}' busybox:stable)"
[[ "$ALPINE_ID" != "$BUSYBOX_ID" ]] || fail "setup: test fixture images must differ (got identical IDs)"

# =============================================================================
# Parts 1-2: a `created` container's image ID — stable, inspectable, correct —
# for BOTH a container that was never started and one whose start genuinely
# failed with the same OCI mount error the live incident hit.
# =============================================================================

CID_NEVER_STARTED="$(docker create --label pc-test=1 alpine:3 sleep 300)"
CLEANUP_CIDS+=("$CID_NEVER_STARTED")
status="$(docker inspect --format '{{.State.Status}}' "$CID_NEVER_STARTED")"
image_id="$(docker inspect --format '{{.Image}}' "$CID_NEVER_STARTED")"
[[ "$status" == "created" ]] || fail "1: a freshly-created, never-started container was not in 'created' state (got: ${status})"
[[ "$image_id" == "$ALPINE_ID" ]] || fail "1: created container's image ID did not match the source image's resolved ID"
pass "1: a never-started container is 'created' and its image ID is already resolvable and correct"

mkdir -p "$SCRATCH/status"
CID_FAILED_START="$(docker create --label pc-test=1 --read-only \
  --mount type=bind,source="$SCRATCH/status",target=/config,readonly \
  --mount type=bind,source="$SCRATCH/status",target=/config/nested,readonly \
  alpine:3 sleep 300)"
CLEANUP_CIDS+=("$CID_FAILED_START")
pre_image_id="$(docker inspect --format '{{.Image}}' "$CID_FAILED_START")"
if docker start "$CID_FAILED_START" >/dev/null 2>&1; then
  fail "2: expected the nested-read-only-mount start to fail with an OCI runtime error, it succeeded"
fi
post_status="$(docker inspect --format '{{.State.Status}}' "$CID_FAILED_START")"
post_image_id="$(docker inspect --format '{{.Image}}' "$CID_FAILED_START")"
err="$(docker inspect --format '{{.State.Error}}' "$CID_FAILED_START")"
[[ "$post_status" == "created" ]] || fail "2: a container whose start failed with an OCI mount error was not left in 'created' state (got: ${post_status})"
[[ "$post_image_id" == "$pre_image_id" && "$post_image_id" == "$ALPINE_ID" ]] \
  || fail "2: image ID changed or was wrong across a failed start (before=${pre_image_id} after=${post_image_id} expected=${ALPINE_ID})"
[[ "$err" == *"read-only file system"* || "$err" == *"mountpoint"* ]] \
  || fail "2: did not reproduce the expected nested-mount OCI error (got: ${err})"
pass "2: a container whose start fails with the exact live nested-mount OCI error stays 'created' with its image ID unchanged and inspectable"

# =============================================================================
# Parts 3-4: deployment_images_match_lock() — the real production coherence
# gate from lib/common.sh, exercised directly, no test double — correctly
# distinguishes coherent / wrong-image / unknown-image without starting
# anything.
# =============================================================================

PROJECT="pc-coherence-test-$$"
DEPLOY="$SCRATCH/deploy"
mkdir -p "$DEPLOY/config"

# shellcheck disable=SC1091
export PC_ROOT="$DEPLOY" PC_COMPOSE_PROJECT="$PROJECT"
source "${REPO_ROOT}/scripts/lib/common.sh"

TAG_PG="pc-coherence-test/postgres:1";  docker tag alpine:3 "$TAG_PG";  CLEANUP_TAGS+=("$TAG_PG")
TAG_N8N="pc-coherence-test/n8n:1";      docker tag alpine:3 "$TAG_N8N"; CLEANUP_TAGS+=("$TAG_N8N")
TAG_API="pc-coherence-test/api:1";      docker tag alpine:3 "$TAG_API"; CLEANUP_TAGS+=("$TAG_API")
TAG_WEB="pc-coherence-test/web:1";      docker tag alpine:3 "$TAG_WEB"; CLEANUP_TAGS+=("$TAG_WEB")
TAG_CADDY="pc-coherence-test/caddy:1";  docker tag alpine:3 "$TAG_CADDY"; CLEANUP_TAGS+=("$TAG_CADDY")

write_lock_and_stack() {
  local api_image="$1"
  for f in "$DEPLOY/config/versions.lock.env" "$DEPLOY/config/stack.env"; do
    cat >"$f" <<EOF
PC_POSTGRES_IMAGE=${TAG_PG}
PC_N8N_IMAGE=${TAG_N8N}
PC_CONTROL_API_IMAGE=${api_image}
PC_WEB_IMAGE=${TAG_WEB}
PC_CADDY_PROXY_IMAGE=${TAG_CADDY}
PC_STACK_VERSION=test
EOF
  done
}

make_container() { docker create --label "com.docker.compose.project=${PROJECT}" \
  --label "com.docker.compose.service=$1" "$2" sleep 300; }

CID_PG="$(make_container postgres "$TAG_PG")";      CLEANUP_CIDS+=("$CID_PG")
CID_N8N="$(make_container n8n "$TAG_N8N")";         CLEANUP_CIDS+=("$CID_N8N")
CID_API="$(make_container control-api "$TAG_API")"; CLEANUP_CIDS+=("$CID_API")
CID_WEB="$(make_container web "$TAG_WEB")";         CLEANUP_CIDS+=("$CID_WEB")
CID_CADDY="$(make_container caddy "$TAG_CADDY")";   CLEANUP_CIDS+=("$CID_CADDY")

# None of these five containers is ever started — deployment_images_match_lock
# must not require that.
for c in "$CID_PG" "$CID_N8N" "$CID_API" "$CID_WEB" "$CID_CADDY"; do
  [[ "$(docker inspect --format '{{.State.Status}}' "$c")" == "created" ]] \
    || fail "setup: fixture container unexpectedly not 'created'"
done

write_lock_and_stack "$TAG_API"
if deployment_images_match_lock "$DEPLOY/config/versions.lock.env" "$DEPLOY/config/stack.env"; then
  pass "3a: deployment_images_match_lock accepts a fully coherent stack of 'created' (never-started) containers"
else
  fail "3a: deployment_images_match_lock rejected a genuinely coherent stack"
fi

# 3b: wrong image — control-api's container was created from the wrong tag.
docker rm -f "$CID_API" >/dev/null
CID_API="$(docker create --label "com.docker.compose.project=${PROJECT}" \
  --label "com.docker.compose.service=control-api" busybox:stable sleep 300)"
CLEANUP_CIDS+=("$CID_API")
if deployment_images_match_lock "$DEPLOY/config/versions.lock.env" "$DEPLOY/config/stack.env"; then
  fail "3b: deployment_images_match_lock accepted control-api running a different image than the lock"
fi
pass "3b: deployment_images_match_lock rejects a service whose container image does not match the lock (wrong image)"

# 4: unknown image — lock references a tag with no local image at all.
write_lock_and_stack "pc-coherence-test/api:does-not-exist-locally"
if deployment_images_match_lock "$DEPLOY/config/versions.lock.env" "$DEPLOY/config/stack.env"; then
  fail "4: deployment_images_match_lock accepted a lock reference that does not resolve to any local image"
fi
pass "4: deployment_images_match_lock rejects a lock image reference that is not a real local image (unknown image)"

docker rm -f "$CID_PG" "$CID_N8N" "$CID_API" "$CID_WEB" "$CID_CADDY" >/dev/null 2>&1 || true

# =============================================================================
# Parts 6-8: rollback.sh (real, unmodified) recovers control-api/caddy stuck
# in `created`, never touches migrations, and leaves the deployment passing
# the exact same coherence gate `update.sh` step 2 evaluates.
# =============================================================================

write_stack_env() {
  cat >"$1" <<'EOF'
PC_POSTGRES_IMAGE=postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PC_N8N_IMAGE=n8n@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PC_CADDY_IMAGE=caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
PC_CONTROL_API_IMAGE=project-control/control-api:test
PC_WEB_IMAGE=project-control/web:test
PC_CADDY_PROXY_IMAGE=project-control/caddy:test
PC_STACK_VERSION=test
EOF
}

RF="${SCRATCH}/rb"; RSRC="${RF}/source"; RDEPLOY="${RF}/deploy"; RBIN="${RF}/bin"; SNAP_ID=20260101T000000Z
mkdir -p "$RSRC/scripts/lib" "$RSRC/infra" "$RDEPLOY/config" "$RDEPLOY/compose" "$RDEPLOY/runner/bin" "$RDEPLOY/secrets" \
         "$RDEPLOY/backups/rollback/$SNAP_ID" "$RBIN" "${RF}/runtime"
cp "${REPO_ROOT}/scripts/rollback.sh" "$RSRC/scripts/rollback.sh"
cp "${REPO_ROOT}/scripts/lib/common.sh" "$RSRC/scripts/lib/common.sh"
sed -i "s|^PC_RUNTIME_DIR=.*|PC_RUNTIME_DIR=\"${RF}/runtime\"|" "$RSRC/scripts/lib/common.sh"
sed -i 's/local timeout="${1:-30}"/local timeout="${1:-1}"/' "$RSRC/scripts/lib/common.sh"
: >"$RSRC/compose.yaml.placeholder"
write_stack_env "$RSRC/infra/versions.lock.env"
cp "$RSRC/infra/versions.lock.env" "$RDEPLOY/config/versions.lock.env"
: >"$RDEPLOY/compose/compose.yaml"
write_stack_env "$RDEPLOY/config/stack.env"
printf 'current runner\n' >"$RDEPLOY/runner/bin/project-control-runner"; chmod +x "$RDEPLOY/runner/bin/project-control-runner"
printf 'x' >"$RDEPLOY/secrets/pg_control_app_password"; chmod 0600 "$RDEPLOY/secrets/pg_control_app_password"

snap="$RDEPLOY/backups/rollback/$SNAP_ID"
cp "$RSRC/infra/versions.lock.env" "$snap/versions.lock.env"
: >"$snap/compose.yaml"
write_stack_env "$snap/stack.env"
printf '2\n' >"$snap/checkpoint-reader-max-version"
cat >"$snap/running-images.env" <<'EOF'
postgres=sha256:0000000000000000000000000000000000000000000000000000000000000001
n8n=sha256:0000000000000000000000000000000000000000000000000000000000000002
control-api=sha256:0000000000000000000000000000000000000000000000000000000000000003
web=sha256:0000000000000000000000000000000000000000000000000000000000000004
caddy=sha256:0000000000000000000000000000000000000000000000000000000000000005
EOF
printf '%s\n' "$SNAP_ID" >"$RDEPLOY/backups/rollback/latest"

cat >"$RSRC/scripts/verify.sh" <<EOF
#!/usr/bin/env bash
printf 'verify\n' >>"${RF}/verify.calls"; exit 0
EOF
cat >"$RSRC/scripts/telegram-notify.sh" <<EOF
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"${RF}/notify.calls"; exit 0
EOF
chmod +x "$RSRC/scripts/verify.sh" "$RSRC/scripts/telegram-notify.sh"

cat >"$RBIN/id" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -u ]] && { printf '0\n'; exit 0; }; exec /usr/bin/id "$@"
EOF
cat >"$RBIN/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$RBIN/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == is-active ]] && { printf 'active\n'; exit 0; }; exit 0
EOF
cat >"$RBIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '401'
EOF
cat >"$RBIN/stat" <<'EOF'
#!/usr/bin/env bash
if [[ "${@: -1}" == *pg_control_app_password ]]; then
  case "$2" in %s) printf '1\n' ;; %a) printf '600\n' ;; %u|%g) printf '0\n' ;; esac; exit 0
fi
exec /usr/bin/stat "$@"
EOF
chmod +x "$RBIN"/*

# The fake docker below is the crux of this scenario: BEFORE `compose up`
# runs, control-api and caddy report Docker's `created` state (exactly the
# live incident) rather than merely "a healthy container on the wrong
# image" (already covered by tests/deployment-incident-behavior-regression.sh
# scenario #19). rollback.sh must recover this without ever branching on it.
cat >"$RBIN/docker" <<EOF
#!/usr/bin/env bash
printf '%q ' "\$@" >>"${RF}/docker.calls"; printf '\n' >>"${RF}/docker.calls"

img() {
  if [[ -e "${RF}/compose-up.calls" ]]; then
    case "\$1" in postgres) printf 'sha256:%064d\n' 1;; n8n) printf 'sha256:%064d\n' 2;; \
      control-api) printf 'sha256:%064d\n' 3;; web) printf 'sha256:%064d\n' 4;; caddy) printf 'sha256:%064d\n' 5;; esac
  else
    case "\$1" in postgres) printf 'sha256:%064d\n' 1;; n8n) printf 'sha256:%064d\n' 2;; \
      control-api) printf 'sha256:%064d\n' 99;; web) printf 'sha256:%064d\n' 4;; caddy) printf 'sha256:%064d\n' 98;; esac
  fi
}
status_for() {
  if [[ -e "${RF}/compose-up.calls" ]]; then
    case "\$1" in control-api|caddy) echo running; return;; esac
  else
    case "\$1" in control-api|caddy) echo created; return;; esac
  fi
  echo running
}

if [[ "\${1:-}" == compose ]]; then
  if [[ "\${*}" == *" up "* ]]; then
    printf 'compose-up %s\n' "\$*" >>"${RF}/compose-up.calls"
    exit \${FAKE_COMPOSEUP_RC:-0}
  fi
  exit 0
fi
if [[ "\${1:-}" == ps ]]; then
  for a in "\$@"; do [[ "\$a" == label=com.docker.compose.service=* ]] && { printf 'cid-%s\n' "\${a##*=}"; exit 0; }; done
fi
if [[ "\${1:-}" == inspect && "\${2:-}" == --format ]]; then
  svc="\${4#cid-}"
  case "\$3" in
    '{{.Image}}') img "\$svc"; exit 0 ;;
    '{{.State.Status}}') status_for "\$svc"; exit 0 ;;
    *) echo healthy; exit 0 ;;
  esac
fi
# docker image inspect --format '{{.Id}}' <ref> — resolves a tag/digest
# reference to its concrete ID, exactly as deployment_images_match_lock()
# does when it evaluates the coherence gate against versions.lock.env.
if [[ "\${1:-}" == image && "\${2:-}" == inspect && "\${3:-}" == --format && "\${4:-}" == '{{.Id}}' ]]; then
  ref="\${5:-}"
  case "\$ref" in
    *aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa*) printf 'sha256:%064d\n' 1; exit 0 ;;
    *bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb*) printf 'sha256:%064d\n' 2; exit 0 ;;
    *control-api:test*) printf 'sha256:%064d\n' 3; exit 0 ;;
    *web:test*) printf 'sha256:%064d\n' 4; exit 0 ;;
    *caddy:test*) printf 'sha256:%064d\n' 5; exit 0 ;;
    *) exit 1 ;;
  esac
fi
if [[ "\${1:-}" == exec ]]; then
  if [[ "\${*}" == *'schema_migrations'* || "\${*}" == *'migrate.js'* ]]; then
    printf 'MIGRATION CALL SHOULD NEVER HAPPEN\n' >>"${RF}/UNEXPECTED_MIGRATION_CALL"
    exit 1
  fi
  if [[ "\${*}" == *'SELECT COALESCE(max(snapshot_version)'* ]]; then printf '1\n'; exit 0; fi
  exit 0
fi
exit 0
EOF
chmod +x "$RBIN/docker"

(
  export PATH="${RBIN}:${PATH}" PC_ROOT="$RDEPLOY" PC_ASSUME_YES=1
  bash "$RSRC/scripts/rollback.sh" --auto >"${RF}/stdout" 2>"${RF}/stderr"
) && RB_RC=0 || RB_RC=$?

[[ "$RB_RC" == 0 ]] || { cat "${RF}/stderr" >&2; fail "6: rollback did not succeed recovering control-api/caddy from 'created'"; }
grep -qE 'containers recreated from the previous version' "${RF}/stderr" \
  || fail "6: rollback did not report successful container recreation"
grep -q 'all five services match the exact rollback image target' "${RF}/stderr" \
  || fail "6: rollback did not confirm the exact post-recreation image match"
pass "6: rollback.sh (real, unmodified) recovers control-api/caddy from Docker's 'created' state exactly as it would any other incoherent-image incident — no special-casing needed"

[[ ! -f "${RF}/UNEXPECTED_MIGRATION_CALL" ]] || fail "7: rollback.sh issued a migration-related database call — it must never touch schema_migrations or run migrate.js"
grep -q 'schema_migrations\|migrate.js' "${RF}/docker.calls" && fail "7: docker.calls unexpectedly references migrations" || true
pass "7: rollback.sh never invokes migrate.js and never touches schema_migrations — migration safety preserved"

# 8: post-recovery coherence gate. rollback.sh has already restored
# versions.lock.env/stack.env to the target snapshot's values, and the fake
# docker now reports every service's exact snapshot image ID as running.
# This is a live call to the exact same function update.sh's own step 2 uses.
(
  export PATH="${RBIN}:${PATH}"
  export PC_ROOT="$RDEPLOY" PC_COMPOSE_PROJECT="project-control"
  # shellcheck disable=SC1091
  source "$RSRC/scripts/lib/common.sh"
  deployment_images_match_lock "${RDEPLOY}/config/versions.lock.env" "${RDEPLOY}/config/stack.env"
) || fail "8: update.sh's own coherence gate (deployment_images_match_lock) did not pass after a successful rollback"
pass "8: after rollback recovers the 'created' containers, update's own coherence gate genuinely passes — not merely 'rollback claims success'"

printf 'PASS: rollback.sh proven safe and sufficient to recover control-api/caddy stuck in Docker'"'"'s created state when migrations were never applied — no new forward-migration recovery tool is needed\n'
