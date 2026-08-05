#!/usr/bin/env bash
# =============================================================================
# backup.sh — encrypted off-site backup via restic + rclone + Google Drive.
#
#   backup.sh              run a backup now
#   backup.sh --scheduled  same, but notify on failure (used by the timer)
#   backup.sh --check      verify repository integrity instead of backing up
#
# What is backed up:
#   * a consistent logical dump of BOTH databases
#   * the artifact object store
#   * n8n's persistent data
#   * compose / config / migrations / scripts
#   * the encrypted secrets needed to restore
#   * documentation, the runner binary and unit definitions
#
# What is excluded: staging areas, caches, restore-test scratch, rotatable logs
# and build output — all reconstructible, and all large.
#
# This script has no dependency on n8n. If the automation engine is broken,
# backups still run, which is exactly when they matter most.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions
load_stack_env

MODE="backup"
SCHEDULED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scheduled) SCHEDULED=1; shift ;;
    --check)     MODE="check"; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

STAGING="${PC_ROOT}/backups/staging"
LOG_DIR="${PC_ROOT}/backups/logs"
STATUS_FILE="${PC_ROOT}/config/status/backup-status.json"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
LOG_FILE="${LOG_DIR}/backup-${RUN_ID}.log"

ensure_dir "$STAGING" 0700 root root
ensure_dir "$LOG_DIR" 0750 root root

# --- Preconditions -----------------------------------------------------------
if ! secret_exists restic_password || [[ ! -f "${PC_ROOT}/config/rclone.conf" ]]; then
  log_warn "MANUAL_CONFIGURATION_REQUIRED: backup is not configured"
  log_info "run: sudo ./pcctl configure-google-drive"
  exit 2
fi
require_cmd restic rclone docker

export RESTIC_REPOSITORY="rclone:gdrive:Project-Control-Backups/restic"
export RESTIC_PASSWORD_FILE="${PC_SECRETS_DIR}/restic_password"
export RCLONE_CONFIG="${PC_ROOT}/config/rclone.conf"

write_status() {
  local result="$1" detail="${2:-}"
  local snapshots
  snapshots="$(restic snapshots --json 2>/dev/null | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"
  local tmp; tmp="$(mktemp)"
  cat >"$tmp" <<EOF
{
  "configured": true,
  "repository": "${RESTIC_REPOSITORY}",
  "lastRunAt": "$(_pc_ts)",
  "lastResult": "${result}",
  "lastDetail": "${detail}",
  "snapshotCount": ${snapshots},
  "updatedAt": "$(_pc_ts)"
}
EOF
  install_file "$tmp" "$STATUS_FILE" 0644
  rm -f "$tmp"
}

notify() {
  # Never fatal: a missing Telegram configuration must not fail a backup.
  bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" "$1" >/dev/null 2>&1 || true
}

# Staging holds plaintext database dumps. It is wiped on every exit path,
# including failure — a dump left behind would be an unencrypted copy of the
# entire database sitting on disk.
cleanup() {
  local exit_code=$?
  if [[ -d "$STAGING" ]]; then
    find "$STAGING" -mindepth 1 -delete 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

# =============================================================================
# --check mode
# =============================================================================
if [[ "$MODE" == "check" ]]; then
  log_step "Verifying the restic repository"
  # --read-data-subset actually reads and decrypts pack files. An index-only
  # check would pass on a repository whose data is silently corrupt.
  if restic check --read-data-subset=5% 2>&1 | tee -a "$LOG_FILE" | redact_stream; then
    log_ok "repository check passed"
    (( SCHEDULED )) && notify "✅ Project Control: weekly restic check passed on $(hostname -s)"
    exit 0
  fi
  log_error "repository check FAILED"
  (( SCHEDULED )) && notify "🔴 Project Control: weekly restic check FAILED on $(hostname -s) — see journalctl -u project-control-check"
  exit 1
fi

# =============================================================================
# Backup
# =============================================================================
log_step "Backup run ${RUN_ID}"
STARTED_AT="$(date +%s)"

# -----------------------------------------------------------------------------
# 1. Database dumps
#
# `pg_dump` inside a single transaction gives a snapshot consistent as of the
# moment it started, without locking writers out. Both databases are dumped with
# the read-only backup_reader role.
# -----------------------------------------------------------------------------
log_step "1/4  Dumping databases"

pg_cid="$(container_id postgres)"
[[ -n "$pg_cid" ]] || die "the postgres container is not running; cannot take a consistent dump"

BACKUP_PW="$(read_secret pg_backup_reader_password)"

dump_database() {
  local database="$1"
  local target="${STAGING}/${database}.dump"

  log_info "dumping ${database}"
  # Custom format (-Fc): compressed, and restorable selectively with pg_restore.
  # --no-owner/--no-privileges keep the dump portable into the restore-test
  # sandbox, where the roles do not exist.
  if docker exec -i "$pg_cid" \
      env PGPASSWORD="$BACKUP_PW" \
      pg_dump --username=backup_reader --dbname="$database" \
              --format=custom --compress=6 \
              --no-owner --no-privileges \
              --serializable-deferrable \
      >"$target" 2>>"$LOG_FILE"; then
    chmod 0600 "$target"
    local size; size="$(stat -c '%s' "$target")"
    if (( size < 1024 )); then
      die "dump of ${database} is only ${size} bytes; refusing to back up a truncated dump"
    fi
    log_ok "${database}: $((size / 1024)) KiB"
  else
    die "pg_dump failed for ${database}; see ${LOG_FILE}"
  fi
}

dump_database project_control
dump_database n8n
BACKUP_PW=""; unset BACKUP_PW

# Record what produced these dumps, so a restorer knows what they are holding.
cat >"${STAGING}/manifest.json" <<EOF
{
  "runId": "${RUN_ID}",
  "createdAt": "$(_pc_ts)",
  "hostname": "$(hostname -f 2>/dev/null || hostname)",
  "stackVersion": "${PC_STACK_VERSION}",
  "postgresImage": "${PC_POSTGRES_IMAGE}",
  "n8nImage": "${PC_N8N_IMAGE}",
  "databases": ["project_control", "n8n"],
  "artifactObjectCount": $(find "${PC_ROOT}/data/artifacts/objects" -type f 2>/dev/null | wc -l),
  "schemaVersion": 1
}
EOF
chmod 0600 "${STAGING}/manifest.json"

# -----------------------------------------------------------------------------
# 2. Snapshot
# -----------------------------------------------------------------------------
log_step "2/4  Uploading to Google Drive"

# Exclusions. Everything here is either reconstructible or is scratch space.
EXCLUDES=(
  --exclude "${PC_ROOT}/data/artifacts/temporary"
  --exclude "${PC_ROOT}/backups/restore-tests"
  --exclude "${PC_ROOT}/backups/logs"
  --exclude "${PC_ROOT}/logs"
  --exclude "${PC_ROOT}/data/postgres"          # the dump is the backup, not the raw data dir
  --exclude "**/node_modules"
  --exclude "**/.cache"
  --exclude "**/*.tmp"
  --exclude "**/*.part"
  --exclude "**/.git"
)

# Note what IS included: secrets/ is deliberately in scope. Restoring without
# the n8n encryption key would leave every stored credential unreadable, and the
# restic repository is itself encrypted, so this does not weaken anything.
BACKUP_PATHS=(
  "$STAGING"                        # database dumps + manifest
  "${PC_ROOT}/data/artifacts"       # artifact object store
  "${PC_ROOT}/data/n8n"             # n8n persistent data
  "${PC_ROOT}/compose"
  "${PC_ROOT}/config"
  "${PC_ROOT}/migrations"
  "${PC_ROOT}/scripts"
  "${PC_ROOT}/docs"
  "${PC_ROOT}/secrets"
  "${PC_ROOT}/runner"
)

EXISTING_PATHS=()
for path in "${BACKUP_PATHS[@]}"; do
  [[ -e "$path" ]] && EXISTING_PATHS+=("$path")
done

if restic backup \
      --tag "project-control" \
      --tag "stage1" \
      --tag "run:${RUN_ID}" \
      --host "$(hostname -s)" \
      "${EXCLUDES[@]}" \
      "${EXISTING_PATHS[@]}" \
      2>&1 | tee -a "$LOG_FILE" | redact_stream; then
  log_ok "snapshot created"
else
  write_status "failure" "restic backup failed"
  notify "🔴 Project Control backup FAILED on $(hostname -s) at $(_pc_ts). See journalctl -u project-control-backup"
  die "restic backup failed"
fi

# -----------------------------------------------------------------------------
# 3. Retention
# -----------------------------------------------------------------------------
log_step "3/4  Applying the retention policy"

# 14 daily / 8 weekly / 12 monthly. `--prune` reclaims the space rather than
# only removing the snapshot references.
if restic forget \
      --keep-daily 14 \
      --keep-weekly 8 \
      --keep-monthly 12 \
      --prune \
      2>&1 | tee -a "$LOG_FILE" | redact_stream; then
  log_ok "retention applied (14 daily / 8 weekly / 12 monthly)"
else
  log_warn "retention pass failed; the snapshot itself is safe"
fi

# -----------------------------------------------------------------------------
# 4. Verify
# -----------------------------------------------------------------------------
log_step "4/4  Verifying the new snapshot"

latest="$(restic snapshots --latest 1 --json 2>/dev/null \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d[0]["short_id"] if d else "")' 2>/dev/null || echo '')"

if [[ -z "$latest" ]]; then
  write_status "failure" "no snapshot found after backup"
  die "the backup reported success but no snapshot is present"
fi

# Structural verification of the repository index.
if restic check 2>&1 | tee -a "$LOG_FILE" | redact_stream; then
  log_ok "repository structure verified"
else
  log_warn "restic check reported problems"
fi

ELAPSED=$(( $(date +%s) - STARTED_AT ))
snapshot_count="$(restic snapshots --json 2>/dev/null | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"

write_status "success" "snapshot ${latest} in ${ELAPSED}s"

# Keep the last 30 run logs; they are small but unbounded otherwise.
find "$LOG_DIR" -name 'backup-*.log' -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | tail -n +31 | cut -d' ' -f2- | xargs -r rm -f

log_ok "backup complete: snapshot ${latest}, ${ELAPSED}s, ${snapshot_count} snapshot(s) retained"

if (( SCHEDULED )); then
  notify "✅ Project Control backup OK on $(hostname -s)
snapshot: ${latest}
duration: ${ELAPSED}s
retained: ${snapshot_count}"
fi
