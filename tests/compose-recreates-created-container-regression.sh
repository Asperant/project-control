#!/usr/bin/env bash
# =============================================================================
# compose-recreates-created-container-regression.sh
#
# Proves, against REAL `docker compose` (never faked — this is exactly the
# mechanism the recommended live recovery route in this turn's investigation
# depends on): a container stuck in Docker's `created` state because its
# ORIGINAL compose file had the nested-mount defect is automatically replaced
# — no manual `docker rm`, no bespoke recovery script — the next time
# `compose up` runs against a compose file whose mount config has changed.
# Compose detects the config-hash divergence and issues a full
# Recreate/Start, not a plain `start` retry against the broken container.
#
# This is why `update.sh`'s own unmodified step "6/8 Applying the update"
# (`compose up --detach --remove-orphans --wait --wait-timeout 300`) needs no
# separate "narrow recovery" step to clear a `created` control-api/caddy
# container once the repository's compose file has already been fixed and
# staged (which it already is, before the dry-run, per
# tests/update-compose-staging-order-regression.sh) — compose's own ordinary
# up semantics already do this.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not available/usable — cannot run this test"
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/pc-compose-recreate-created.XXXXXXXX")"
PROJECT="pc-compose-recreate-created-test-$$"
trap 'docker compose -f "$WORK/fixed-compose.yaml" -p "$PROJECT" down >/dev/null 2>&1 || true; rm -rf -- "$WORK"' EXIT

mkdir -p "$WORK/status"
printf 'hi\n' >"$WORK/status/x"
docker pull -q alpine:3 >/dev/null
EXPECTED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' alpine:3)"

# The exact defect class from infra/compose/compose.yaml's own history: a
# second bind mount nested under an already read-only parent mount target.
cat >"$WORK/broken-compose.yaml" <<EOF
name: ${PROJECT}
services:
  svc:
    image: alpine:3
    command: ["sleep", "300"]
    read_only: true
    volumes:
      - type: bind
        source: ${WORK}/status
        target: /config
        read_only: true
      - type: bind
        source: ${WORK}/status
        target: /config/nested
        read_only: true
EOF

# The fix: fold the nested path into the one parent mount, exactly as
# infra/compose/compose.yaml's own fix does for control-api's /config mount.
cat >"$WORK/fixed-compose.yaml" <<EOF
name: ${PROJECT}
services:
  svc:
    image: alpine:3
    command: ["sleep", "300"]
    read_only: true
    volumes:
      - type: bind
        source: ${WORK}/status
        target: /config
        read_only: true
EOF

docker compose -f "$WORK/broken-compose.yaml" -p "$PROJECT" up -d >/dev/null 2>&1 || true
CID1="$(docker compose -f "$WORK/broken-compose.yaml" -p "$PROJECT" ps -a -q svc)"
[[ -n "$CID1" ]] || fail "setup: broken compose did not even create a container"
status1="$(docker inspect --format '{{.State.Status}}' "$CID1")"
image1="$(docker inspect --format '{{.Image}}' "$CID1")"
[[ "$status1" == "created" ]] || fail "setup: expected the broken-mount container to be stuck 'created' (got: ${status1})"
[[ "$image1" == "$EXPECTED_IMAGE_ID" ]] || fail "setup: created container's image ID was unexpected"
pass "setup: reproduced a container stuck 'created' by the exact nested-mount defect class"

# The live recovery route this proves: apply the FIXED compose (already
# staged by update.sh/recover-deployment.sh before any dry-run) and run an
# ordinary `compose up` — no `docker rm`, no special-cased recovery logic.
docker compose -f "$WORK/fixed-compose.yaml" -p "$PROJECT" up -d >"${WORK}/up.log" 2>&1 \
  || { cat "${WORK}/up.log" >&2; fail "compose up against the fixed compose file did not succeed"; }
grep -qi 'Recreate' "${WORK}/up.log" || fail "compose did not report recreating the stuck container (expected a config-hash-driven Recreate)"

CID2="$(docker compose -f "$WORK/fixed-compose.yaml" -p "$PROJECT" ps -a -q svc)"
status2="$(docker inspect --format '{{.State.Status}}' "$CID2")"
image2="$(docker inspect --format '{{.Image}}' "$CID2")"
[[ "$status2" == "running" ]] || fail "the recreated container did not reach 'running' (got: ${status2})"
[[ "$image2" == "$EXPECTED_IMAGE_ID" ]] || fail "the recreated container's image ID differs from the original (unexpected image substitution)"

printf 'PASS: an ordinary "compose up" against a corrected compose file automatically Recreate+Starts a container stuck in Docker'"'"'s created state — no separate narrow-recovery step or bespoke tooling is required for this part of the incident\n'
