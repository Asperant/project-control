#!/usr/bin/env bash
# =============================================================================
# release-manifest.sh — assembles one JSON document describing exactly what a
# stack IS, so a release checklist has a single artifact to check instead of
# re-deriving the answer eight different ways:
#
#   * version              the application's own stack version
#   * git commit            the exact commit this build's images trace to
#   * image digests          postgres / n8n / caddy / control-api / web
#   * migration level        applied schema_migrations count
#   * checkpoint reader      highest checkpointSnapshot version this code reads
#   * runner version         the Go runner binary's self-reported version
#   * backup status           last recorded backup-status.json
#   * security status         last recorded verify-security summary
#
#   ./pcctl release-manifest             JSON on stdout
#   ./pcctl release-manifest --out FILE  also write a copy to FILE
#
# Strictly read-only: every field is read from git, the version lock, running
# containers, PostgreSQL, and status files other scripts already wrote. This
# script never starts, stops, builds, or reconfigures anything. Docker access
# and root are each used opportunistically — a field that needs either and
# doesn't have it degrades to null with an honest "note" explaining why,
# rather than failing the whole document (the same philosophy
# apps/control-api/src/routes/system.ts's probes use: a down dependency
# becomes a reported state, not a crash).
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_cmd git python3

OUT_FILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out)
      [[ -n "${2:-}" ]] || die "--out needs a file path"
      OUT_FILE="$2"; shift 2 ;;
    -h|--help)
      cat <<'USAGE'
Usage: release-manifest.sh [--out FILE]

Assembles a single JSON release manifest — version, git commit, image
digests, migration level, checkpoint-reader capability, runner version,
backup status, and security status — and prints it to stdout.

Read-only: reports state, changes nothing.

  --out FILE   also write the JSON document to FILE
USAGE
      exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# Same two calls, same order, as verify.sh: repo lock first, then the
# deployed stack.env layered on top so every field below reflects what is
# actually deployed when this runs on a live host, and falls back to the
# repository's own lock when there is no deployment yet (disposable testing).
load_versions
load_stack_env

GENERATED_AT="$(_pc_ts)"

# -----------------------------------------------------------------------------
# git commit
#
# Images embed no revision of their own (build.sh's IMAGE_CREATED_LABEL is a
# commit *timestamp*, not the hash) — this reads the exact same source
# (`git -C "$PC_REPO_ROOT" log -1`) so the commit reported here always
# matches what IMAGE_CREATED_LABEL was computed from at build time. This is
# only trustworthy if nothing was built from a HEAD other than the checkout's
# current one, which release-checklist.md's "git status clean" gate exists to
# protect.
# -----------------------------------------------------------------------------
log_step "Reading git provenance"
GIT_COMMIT=""; GIT_COMMIT_SHORT=""; GIT_COMMIT_DATE=""; GIT_DIRTY="null"
if git -C "$PC_REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  GIT_COMMIT="$(git -C "$PC_REPO_ROOT" log -1 --format=%H 2>/dev/null || true)"
  GIT_COMMIT_SHORT="$(git -C "$PC_REPO_ROOT" log -1 --format=%h 2>/dev/null || true)"
  GIT_COMMIT_DATE="$(git -C "$PC_REPO_ROOT" log -1 --format=%cI 2>/dev/null || true)"
  if git -C "$PC_REPO_ROOT" diff --quiet HEAD -- >/dev/null 2>&1 \
     && [[ -z "$(git -C "$PC_REPO_ROOT" status --porcelain 2>/dev/null || true)" ]]; then
    GIT_DIRTY="false"
  else
    GIT_DIRTY="true"
  fi
  log_ok "commit ${GIT_COMMIT_SHORT:-unknown} (dirty=${GIT_DIRTY})"
else
  log_warn "not a git checkout at ${PC_REPO_ROOT}; commit fields will be null"
fi

# -----------------------------------------------------------------------------
# Image digests
#
# postgres/n8n/caddy's base image are pulled and pinned by digest in
# infra/versions.lock.env; control-api/web/the caddy proxy layer are built
# locally and never pushed, so their only meaningful "digest" is the local
# image ID docker assigned the build. Verified the same way verify.sh's
# IMG-001 check already does: docker inspect --format '{{.Image}}' on the
# running container against docker image inspect --format '{{.Id}}' on the
# expected reference.
# -----------------------------------------------------------------------------
log_step "Reading image digests"

extract_digest() {  # <image-ref> -> the @sha256:... suffix, or empty
  local ref="$1"
  [[ "$ref" == *"@sha256:"* ]] && printf '%s' "${ref#*@}" || printf ''
}

running_image_id() {  # <service> -> the running container's .Image field, or empty
  local svc="$1" cid
  have docker || { printf ''; return 0; }
  cid="$(container_id "$svc" 2>/dev/null || true)"
  [[ -n "$cid" ]] || { printf ''; return 0; }
  docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || printf ''
}

pinned_status() {  # <expected-ref> <running-id> -> true|false|"" (unknown)
  local expected_ref="$1" running_id="$2" expected_id
  have docker || { printf ''; return 0; }
  [[ -n "$expected_ref" && -n "$running_id" ]] || { printf ''; return 0; }
  expected_id="$(docker image inspect --format '{{.Id}}' "$expected_ref" 2>/dev/null || true)"
  [[ -n "$expected_id" ]] || { printf ''; return 0; }
  [[ "$expected_id" == "$running_id" ]] && printf 'true' || printf 'false'
}

image_note() {  # <running-id> <pinned> -> human note
  local running="$1" pinned="$2"
  if ! have docker; then printf 'docker is not available in this environment'; return 0; fi
  if [[ -z "$running" ]]; then printf 'container is not running'; return 0; fi
  case "$pinned" in
    true)  printf 'running image ID matches the expected reference (docker inspect .Image vs docker image inspect .Id — same method as verify.sh IMG-001)' ;;
    false) printf 'running image ID does NOT match the expected reference — the container predates the current build/lock' ;;
    *)     printf 'expected image reference is not present locally; cannot verify' ;;
  esac
}

image_json() {  # <ref> <pinned_digest> <running_id> <pinned> <note>
  local ref="$1" pinned_digest="$2" running_id="$3" pinned="$4" note="$5"
  local ref_j pinned_digest_j running_id_j pinned_j note_j
  ref_j="$(json_string "$ref")"
  [[ -n "$pinned_digest" ]] && pinned_digest_j="$(json_string "$pinned_digest")" || pinned_digest_j="null"
  [[ -n "$running_id" ]] && running_id_j="$(json_string "$running_id")" || running_id_j="null"
  case "$pinned" in true|false) pinned_j="$pinned" ;; *) pinned_j="null" ;; esac
  note_j="$(json_string "$note")"
  printf '{ "image": %s, "pinnedDigest": %s, "runningImageId": %s, "pinnedMatchesRunning": %s, "note": %s }' \
    "$ref_j" "$pinned_digest_j" "$running_id_j" "$pinned_j" "$note_j"
}

# postgres
PG_REF="${PC_POSTGRES_IMAGE:-}"
PG_DIGEST="$(extract_digest "$PG_REF")"
PG_RUNNING="$(running_image_id postgres)"
PG_PINNED="$(pinned_status "$PG_REF" "$PG_RUNNING")"
PG_JSON="$(image_json "$PG_REF" "$PG_DIGEST" "$PG_RUNNING" "$PG_PINNED" "$(image_note "$PG_RUNNING" "$PG_PINNED")")"

# n8n
N8N_REF="${PC_N8N_IMAGE:-}"
N8N_DIGEST="$(extract_digest "$N8N_REF")"
N8N_RUNNING="$(running_image_id n8n)"
N8N_PINNED="$(pinned_status "$N8N_REF" "$N8N_RUNNING")"
N8N_JSON="$(image_json "$N8N_REF" "$N8N_DIGEST" "$N8N_RUNNING" "$N8N_PINNED" "$(image_note "$N8N_RUNNING" "$N8N_PINNED")")"

# caddy — two images: the pinned upstream base, and the locally built proxy
# layer that is what actually runs as the "caddy" service (see
# infra/caddy/Dockerfile and verify.sh's own check_digest call).
CADDY_BASE_REF="${PC_CADDY_IMAGE:-}"
CADDY_BASE_DIGEST="$(extract_digest "$CADDY_BASE_REF")"
CADDY_BASE_JSON="$(image_json "$CADDY_BASE_REF" "$CADDY_BASE_DIGEST" "" "" "upstream pin from infra/versions.lock.env; not what runs as the 'caddy' service — see runtimeImage")"

CADDY_RUNTIME_REF="${PC_CADDY_PROXY_IMAGE:-}"
CADDY_RUNTIME_RUNNING="$(running_image_id caddy)"
CADDY_RUNTIME_PINNED="$(pinned_status "$CADDY_RUNTIME_REF" "$CADDY_RUNTIME_RUNNING")"
CADDY_RUNTIME_JSON="$(image_json "$CADDY_RUNTIME_REF" "" "$CADDY_RUNTIME_RUNNING" "$CADDY_RUNTIME_PINNED" "$(image_note "$CADDY_RUNTIME_RUNNING" "$CADDY_RUNTIME_PINNED")")"

# control-api
API_REF="${PC_CONTROL_API_IMAGE:-}"
API_RUNNING="$(running_image_id control-api)"
API_PINNED="$(pinned_status "$API_REF" "$API_RUNNING")"
API_JSON="$(image_json "$API_REF" "" "$API_RUNNING" "$API_PINNED" "$(image_note "$API_RUNNING" "$API_PINNED")")"

# web
WEB_REF="${PC_WEB_IMAGE:-}"
WEB_RUNNING="$(running_image_id web)"
WEB_PINNED="$(pinned_status "$WEB_REF" "$WEB_RUNNING")"
WEB_JSON="$(image_json "$WEB_REF" "" "$WEB_RUNNING" "$WEB_PINNED" "$(image_note "$WEB_RUNNING" "$WEB_PINNED")")"

# Aggregate: true only if every one of the five is verified true; false if
# any is verified false; null if any is unverifiable (no container/no
# docker) — never guess.
ALL_PINNED="true"
for p in "$PG_PINNED" "$N8N_PINNED" "$CADDY_RUNTIME_PINNED" "$API_PINNED" "$WEB_PINNED"; do
  case "$p" in
    true) ;;
    false) ALL_PINNED="false" ;;
    *) [[ "$ALL_PINNED" == "true" ]] && ALL_PINNED="null" ;;
  esac
done
log_ok "image digests read (allPinned=${ALL_PINNED})"

# -----------------------------------------------------------------------------
# Migration level — the exact same query as verify.sh's PG-004 and
# apps/control-api/src/routes/health.ts's /health/ready "schema" check:
# SELECT count(*) FROM schema_migrations. Requires root, to read the
# pg_superuser secret the same way verify.sh does.
# -----------------------------------------------------------------------------
log_step "Reading migration level"
MIGRATIONS_APPLIED=""
MIGRATIONS_NOTE=""
PG_CID="$(container_id postgres 2>/dev/null || true)"
if [[ -z "$PG_CID" ]]; then
  MIGRATIONS_NOTE="postgres container is not running"
elif ! is_root; then
  MIGRATIONS_NOTE="requires root (to read the pg_superuser secret) — same requirement as verify.sh's PG-004"
elif ! secret_exists pg_superuser_password; then
  MIGRATIONS_NOTE="pg_superuser_password secret is not readable"
else
  PG_PW="$(read_secret pg_superuser_password)"
  RAW=""
  if RAW="$(docker exec -i "$PG_CID" env PGPASSWORD="$PG_PW" \
      psql -U postgres -d project_control -tAq -c 'SELECT count(*) FROM schema_migrations' 2>/dev/null)"; then
    RAW="$(printf '%s' "$RAW" | tr -d '[:space:]')"
    if [[ "$RAW" =~ ^[0-9]+$ ]]; then
      MIGRATIONS_APPLIED="$RAW"
    else
      MIGRATIONS_NOTE="query returned a non-numeric result"
    fi
  else
    MIGRATIONS_NOTE="psql query failed against the postgres container"
  fi
  PG_PW=""; unset PG_PW
fi
if [[ -n "$MIGRATIONS_APPLIED" ]]; then
  log_ok "migrations applied: ${MIGRATIONS_APPLIED}"
else
  log_warn "migration level unavailable: ${MIGRATIONS_NOTE}"
fi

# -----------------------------------------------------------------------------
# Checkpoint reader capability — the highest version
# checkpointSnapshotSchema's discriminated union accepts, read directly from
# packages/contracts/src/memory.ts (the source of truth this build's code was
# compiled from), cross-checked against the deployed
# config/checkpoint-reader-max-version file that update.sh/verify.sh's
# API-013 already treat as authoritative for a running deployment.
# -----------------------------------------------------------------------------
log_step "Reading checkpoint reader capability"
MEMORY_TS="${PC_REPO_ROOT}/packages/contracts/src/memory.ts"
CONTRACTS_MAX=""
if [[ -r "$MEMORY_TS" ]]; then
  CONTRACTS_MAX="$(grep -oE 'checkpointSnapshotV[0-9]+Schema[[:space:]]*=' "$MEMORY_TS" 2>/dev/null \
    | grep -oE '[0-9]+' | sort -n | tail -1 || true)"
fi

DEPLOYED_CONFIG_FILE="${PC_CONFIG_DIR}/checkpoint-reader-max-version"
REPO_CONFIG_FILE="${PC_REPO_ROOT}/config/checkpoint-reader-max-version"
CHECKPOINT_CONFIG_VALUE=""
CHECKPOINT_CONFIG_SOURCE=""
if [[ -r "$DEPLOYED_CONFIG_FILE" ]]; then
  CHECKPOINT_CONFIG_VALUE="$(tr -d '[:space:]' <"$DEPLOYED_CONFIG_FILE" 2>/dev/null || true)"
  CHECKPOINT_CONFIG_SOURCE="$DEPLOYED_CONFIG_FILE"
elif [[ -r "$REPO_CONFIG_FILE" ]]; then
  CHECKPOINT_CONFIG_VALUE="$(tr -d '[:space:]' <"$REPO_CONFIG_FILE" 2>/dev/null || true)"
  CHECKPOINT_CONFIG_SOURCE="${REPO_CONFIG_FILE} (repo copy — no deployed copy found at ${DEPLOYED_CONFIG_FILE})"
fi

CHECKPOINT_CONSISTENT="null"
if [[ -n "$CONTRACTS_MAX" && -n "$CHECKPOINT_CONFIG_VALUE" ]]; then
  [[ "$CONTRACTS_MAX" == "$CHECKPOINT_CONFIG_VALUE" ]] && CHECKPOINT_CONSISTENT="true" || CHECKPOINT_CONSISTENT="false"
fi
log_ok "checkpoint reader max version: ${CONTRACTS_MAX:-unknown} (config file: ${CHECKPOINT_CONFIG_VALUE:-unknown})"

# -----------------------------------------------------------------------------
# Runner version — apps/runner/cmd/runner/main.go stamps `main.version` at
# build time from PC_STACK_VERSION (build.sh's -ldflags -X) and exposes it
# via `--version`, which prints and exits with no side effect (no socket
# listen, no privilege check). Prefers the deployed binary; falls back to a
# freshly built repo binary for disposable/pre-deploy testing.
# -----------------------------------------------------------------------------
log_step "Reading runner version"
RUNNER_VERSION=""
RUNNER_BIN=""
RUNNER_NOTE=""
DEPLOYED_RUNNER="${PC_RUNNER_DIR}/bin/project-control-runner"
REPO_RUNNER="${PC_REPO_ROOT}/apps/runner/bin/project-control-runner"
if [[ -x "$DEPLOYED_RUNNER" ]]; then
  RUNNER_BIN="$DEPLOYED_RUNNER"
  RUNNER_NOTE="deployed binary"
elif [[ -x "$REPO_RUNNER" ]]; then
  RUNNER_BIN="$REPO_RUNNER"
  RUNNER_NOTE="freshly built repo binary (not yet deployed)"
else
  RUNNER_NOTE="no runner binary found at ${DEPLOYED_RUNNER} or ${REPO_RUNNER} — build.sh has not been run"
fi
RUNNER_SOURCE_TEXT="$RUNNER_NOTE"
if [[ -n "$RUNNER_BIN" ]]; then
  RUNNER_RAW="$("$RUNNER_BIN" --version 2>/dev/null || true)"
  RUNNER_VERSION="${RUNNER_RAW#project-control-runner }"
  [[ "$RUNNER_VERSION" == "$RUNNER_RAW" ]] && RUNNER_VERSION=""  # prefix did not match; treat as unknown
  RUNNER_SOURCE_TEXT="${RUNNER_BIN} --version (${RUNNER_NOTE})"
fi

RUNNER_MATCHES_LIVE="null"
if [[ "$RUNNER_BIN" == "$DEPLOYED_RUNNER" ]] && is_root; then
  if runner_binary_matches_live_process "$DEPLOYED_RUNNER" 2>/dev/null; then
    RUNNER_MATCHES_LIVE="true"
  else
    RUNNER_MATCHES_LIVE="false"
  fi
fi
if [[ -n "$RUNNER_VERSION" ]]; then
  log_ok "runner version: ${RUNNER_VERSION} (${RUNNER_NOTE})"
else
  log_warn "runner version unavailable: ${RUNNER_NOTE}"
fi

# -----------------------------------------------------------------------------
# Assemble the "facts" JSON that does not depend on the two status files
# (backup, security) below. Those two are merged in by the python3 step,
# which also does the final pretty-print — the same division of labour
# record-verification-status.sh already uses for the same reason: constructing
# nested, escaped JSON by hand in bash beyond this point stops being worth it.
# -----------------------------------------------------------------------------
opt_num() { [[ -n "$1" ]] && printf '%s' "$1" || printf 'null'; }
opt_str() { [[ -n "$1" ]] && json_string "$1" || printf 'null'; }
opt_bool() { case "$1" in true|false) printf '%s' "$1" ;; *) printf 'null' ;; esac; }

FACTS_TMP="$(mktemp)"
cat >"$FACTS_TMP" <<EOF
{
  "schema": 1,
  "version": $(opt_str "${PC_STACK_VERSION:-}"),
  "git": {
    "commit": $(opt_str "$GIT_COMMIT"),
    "commitShort": $(opt_str "$GIT_COMMIT_SHORT"),
    "commitDate": $(opt_str "$GIT_COMMIT_DATE"),
    "dirty": $(opt_bool "$GIT_DIRTY"),
    "repoRoot": $(opt_str "$PC_REPO_ROOT"),
    "source": "git -C <repoRoot> log -1 — the same source build.sh's IMAGE_CREATED_LABEL is derived from"
  },
  "images": {
    "postgres": $PG_JSON,
    "n8n": $N8N_JSON,
    "caddy": { "baseImage": $CADDY_BASE_JSON, "runtimeImage": $CADDY_RUNTIME_JSON },
    "controlApi": $API_JSON,
    "web": $WEB_JSON,
    "allPinned": $(opt_bool "$ALL_PINNED")
  },
  "migrations": {
    "applied": $(opt_num "$MIGRATIONS_APPLIED"),
    "source": "psql: SELECT count(*) FROM schema_migrations (project_control) — same query as verify.sh PG-004 and /health/ready's 'schema' check",
    "note": $(opt_str "$MIGRATIONS_NOTE")
  },
  "checkpointReader": {
    "maxVersion": $(opt_num "$CONTRACTS_MAX"),
    "source": "packages/contracts/src/memory.ts: highest checkpointSnapshotV<N>Schema in checkpointSnapshotSchema's discriminated union",
    "configFileValue": $(opt_num "$CHECKPOINT_CONFIG_VALUE"),
    "configFileSource": $(opt_str "$CHECKPOINT_CONFIG_SOURCE"),
    "consistent": $CHECKPOINT_CONSISTENT
  },
  "runner": {
    "version": $(opt_str "$RUNNER_VERSION"),
    "binaryPath": $(opt_str "$RUNNER_BIN"),
    "source": $(opt_str "$RUNNER_SOURCE_TEXT"),
    "matchesLiveProcess": $RUNNER_MATCHES_LIVE,
    "note": "stamped at build time from PC_STACK_VERSION via -ldflags -X main.version=...; there is no independent runner semver today"
  }
}
EOF

BACKUP_STATUS_FILE="${PC_CONFIG_DIR}/status/backup-status.json"
SECURITY_STATUS_FILE="${PC_CONFIG_DIR}/status/verification.json"

log_step "Merging backup and security status"
FINAL_JSON="$(python3 - "$FACTS_TMP" "$BACKUP_STATUS_FILE" "$SECURITY_STATUS_FILE" "$GENERATED_AT" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone

facts_path, backup_path, security_path, generated_at = sys.argv[1:5]

with open(facts_path, encoding="utf-8") as fh:
    doc = json.load(fh)

doc["generatedAt"] = generated_at


def read_json(path):
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError):
        return None


# --- backup status: reuse config/status/backup-status.json verbatim -------
backup = read_json(backup_path)
if backup is not None:
    doc["backupStatus"] = {"tracked": True, "source": backup_path, **backup}
else:
    doc["backupStatus"] = {
        "tracked": False,
        "source": backup_path,
        "note": "no backup status file found — run: sudo ./pcctl backup",
    }

# --- security status --------------------------------------------------------
# verify-security.sh itself writes no status file (stdout/--json only). The
# closest artifact is config/status/verification.json, written by
# record-verification-status.sh on the project-control-verify.timer, which
# embeds verify-security's last recorded overall/summary. That is a real gap
# relative to backup's own status file, so it is represented honestly here:
# "last known result", never fabricated freshness.
security = read_json(security_path)
verify_security = security.get("verifySecurity") if isinstance(security, dict) else None
if verify_security is not None:
    generated = security.get("generatedAt")
    age_hours = None
    stale = None
    if generated:
        try:
            dt = datetime.fromisoformat(generated.replace("Z", "+00:00"))
            age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
            stale = age_hours > 36
        except ValueError:
            pass
    doc["securityStatus"] = {
        "tracked": True,
        "source": (
            security_path
            + " (written by record-verification-status.sh on a timer; "
            + "verify-security.sh itself writes no status file)"
        ),
        "lastRecordedAt": generated,
        "overall": verify_security.get("overall"),
        "summary": verify_security.get("summary"),
        "ageHours": round(age_hours, 1) if age_hours is not None else None,
        "stale": stale,
        "note": "reflects the last recorded run, not a live check — run: sudo ./pcctl verify-security for a fresh result",
    }
else:
    doc["securityStatus"] = {
        "tracked": False,
        "source": security_path,
        "note": (
            "not tracked — no verification status file found. verify-security.sh "
            "writes no status file of its own; config/status/verification.json is "
            "written by record-verification-status.sh, normally on the "
            "project-control-verify.timer. Run: sudo ./pcctl verify-security"
        ),
    }

print(json.dumps(doc, indent=2))
PYEOF
)"
rm -f "$FACTS_TMP"

[[ -n "$FINAL_JSON" ]] || die "failed to assemble the release manifest"

printf '%s\n' "$FINAL_JSON"

if [[ -n "$OUT_FILE" ]]; then
  printf '%s\n' "$FINAL_JSON" >"$OUT_FILE"
  log_ok "release manifest also written to ${OUT_FILE}"
fi

log_ok "release manifest generated (version ${PC_STACK_VERSION:-unknown}, commit ${GIT_COMMIT_SHORT:-unknown})"
