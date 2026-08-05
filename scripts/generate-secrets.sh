#!/usr/bin/env bash
# =============================================================================
# generate-secrets.sh — create the deployment's secret material.
#
# Rules this script enforces:
#   * Values come from the kernel CSPRNG (/dev/urandom), never from $RANDOM,
#     never from a timestamp, never from a default.
#   * Files are written atomically (temp file + rename) at mode 0600, owned by
#     root, inside a 0700 directory.
#   * An existing secret is NEVER overwritten without an explicit
#     `--rotate <name>`. A silent regeneration would orphan every credential
#     encrypted with the old n8n key and lock every user out of the database.
#   * No secret value is ever printed, logged, or passed as a command argument.
#
# Usage:
#   generate-secrets.sh                    create anything missing
#   generate-secrets.sh --rotate <name>    regenerate one secret
#   generate-secrets.sh --list             show names, status and mode only
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

ROTATE=""
LIST_ONLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --rotate) ROTATE="${2:-}"; [[ -n "$ROTATE" ]] || die "--rotate needs a secret name"; shift 2 ;;
    --list)   LIST_ONLY=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

# -----------------------------------------------------------------------------
# Secret catalogue.
#
#   name|kind|bytes|description
#
# kind:
#   random  — generated here
#   manual  — supplied by the operator at a checkpoint; only a placeholder path
#             is prepared, never a value
# -----------------------------------------------------------------------------
SECRETS=(
  "pg_superuser_password|random|32|PostgreSQL superuser (cluster bootstrap only)"
  "pg_control_app_password|random|32|Control API runtime role"
  "pg_control_migrator_password|random|32|Migration role (DDL)"
  "pg_n8n_app_password|random|32|n8n database role"
  "pg_backup_reader_password|random|32|Read-only role used by pg_dump"
  "session_secret|random|48|Control API session/cookie signing key"
  "n8n_encryption_key|random|32|n8n credential encryption key — NEVER rotate casually"
  "restic_password|manual|0|Restic repository password (checkpoint: Google Drive)"
  "telegram_bot_token|manual|0|Telegram bot token (checkpoint: Telegram)"
  "telegram_chat_id|manual|0|Telegram chat id (checkpoint: Telegram)"
)

# -----------------------------------------------------------------------------
# Secret distribution.
#
# Each container gets a directory containing only the secrets it actually needs,
# mounted read-only. postgres never sees the session secret; the Control API
# never sees the n8n encryption key; nothing sees the restic password except the
# host backup script.
# -----------------------------------------------------------------------------
declare -A DISTRIBUTION=(
  [postgres]="pg_superuser_password pg_control_app_password pg_control_migrator_password pg_n8n_app_password pg_backup_reader_password"
  [control-api]="pg_control_app_password pg_control_migrator_password session_secret"
  [n8n]="pg_n8n_app_password n8n_encryption_key"
)

declare -A SECRET_MIN_LENGTH=()
for entry in "${SECRETS[@]}"; do
  IFS='|' read -r name kind bytes _ <<<"$entry"
  if [[ "$kind" == "random" ]]; then
    SECRET_MIN_LENGTH["$name"]="$bytes"
  else
    SECRET_MIN_LENGTH["$name"]=1
  fi
done

# Validity is intentionally metadata-only: regular/non-empty file, minimum byte
# length, root ownership and mode 0600. Secret content is never read or reported.
secret_is_valid() {
  local path="$1" min_length="$2" size mode uid gid
  [[ -f "$path" && ! -L "$path" ]] || return 1
  size="$(stat -c '%s' "$path" 2>/dev/null)" || return 1
  mode="$(stat -c '%a' "$path" 2>/dev/null)" || return 1
  uid="$(stat -c '%u' "$path" 2>/dev/null)" || return 1
  gid="$(stat -c '%g' "$path" 2>/dev/null)" || return 1
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  (( size > 0 && size >= min_length )) || return 1
  [[ "$uid" == "0" && "$gid" == "0" && "$mode" == "600" ]]
}

write_random_secret() {
  local name="$1" length="$2" token
  token="$(random_token "$length")"
  [[ ${#token} -eq $length ]] || die "generated secret ${name} has an invalid length"
  write_secret "$name" "$token"
  unset token
}

list_secrets() {
  printf '\n%-32s %-8s %-6s %s\n' "SECRET" "STATUS" "MODE" "PURPOSE"
  printf '%s\n' "$(printf '─%.0s' {1..96})"
  local entry name kind bytes description status mode
  for entry in "${SECRETS[@]}"; do
    IFS='|' read -r name kind bytes description <<<"$entry"
    if secret_is_valid "${PC_SECRETS_DIR}/${name}" "${SECRET_MIN_LENGTH[$name]}"; then
      status="valid"
      mode="$(stat -c '%a' "${PC_SECRETS_DIR}/${name}" 2>/dev/null || echo '????')"
    elif [[ -e "${PC_SECRETS_DIR}/${name}" || -L "${PC_SECRETS_DIR}/${name}" ]]; then
      status="INVALID"
      mode="$(stat -c '%a' "${PC_SECRETS_DIR}/${name}" 2>/dev/null || echo '????')"
    else
      status=$([[ "$kind" == "manual" ]] && echo "pending" || echo "MISSING")
      mode="—"
    fi
    printf '%-32s %-8s %-6s %s\n' "$name" "$status" "$mode" "$description"
  done
  printf '\n'
  # Values are deliberately not shown. There is no flag to show them.
  log_info "secret values are never displayed; read them with sudo cat if you must"
}

if (( LIST_ONLY )); then
  list_secrets
  exit 0
fi

require_root

# -----------------------------------------------------------------------------
# Prepare the secrets directory: 0700, root-owned.
# -----------------------------------------------------------------------------
ensure_dir "$PC_SECRETS_DIR" 0700 root root
require_cmd flock

# Serialise generation and bundle staging. Without this lock, two simultaneous
# first runs could both observe a missing file and the later atomic rename could
# overwrite the first valid value without an explicit rotation.
lock_path="${PC_SECRETS_DIR}/.generate-secrets.lock"
exec {secret_lock_fd}>"$lock_path"
chmod 0600 "$lock_path"
chown root:root "$lock_path"
flock -x "$secret_lock_fd"

log_step "Generating secrets in ${PC_SECRETS_DIR}"

created=0
kept=0
rotated=0

for entry in "${SECRETS[@]}"; do
  IFS='|' read -r name kind bytes description <<<"$entry"
  path="${PC_SECRETS_DIR}/${name}"

  if [[ "$kind" == "manual" ]]; then
    if [[ "$ROTATE" == "$name" ]]; then
      die "${name} is operator supplied; use its configure command to replace it"
    fi
    # Manual secrets are never invented here. The configure-* checkpoints write
    # them; this loop only reports on them.
    if secret_is_valid "$path" 1; then
      log_ok "${name}: present (operator supplied)"
    elif [[ -s "$path" && ! -L "$path" ]]; then
      # Preserve operator-supplied material; repair metadata without reading it.
      chmod 0600 "$path"; chown root:root "$path"
      log_warn "${name}: ownership/mode repaired (operator supplied value preserved)"
    else
      log_warn "${name}: MANUAL_CONFIGURATION_REQUIRED — ${description}"
    fi
    continue
  fi

  if secret_is_valid "$path" "$bytes"; then
    if [[ "$ROTATE" == "$name" ]]; then
      if [[ "$name" == "n8n_encryption_key" ]]; then
        log_error "Refusing to rotate n8n_encryption_key with this command."
        log_error "Every stored n8n credential is encrypted with it and would become unreadable."
        log_error "See docs/operations.md 'Rotating the n8n encryption key' for the supported procedure."
        exit 1
      fi
      # Keep the old value so a failed rollout can be reversed.
      backup="${path}.rotated-$(date -u +%Y%m%dT%H%M%SZ)"
      cp -p "$path" "$backup"
      chmod 0600 "$backup"
      write_random_secret "$name" "$bytes"
      log_warn "${name}: ROTATED (previous value kept at ${backup##*/})"
      log_warn "restart the affected service and update the database role password — see docs/operations.md"
      rotated=$((rotated+1))
    else
      # The normal path: leave it alone.
      kept=$((kept+1))
      log_debug "${name}: unchanged"
    fi
    continue
  fi

  if [[ -e "$path" || -L "$path" ]]; then
    log_warn "${name}: invalid metadata/length; regenerating without reporting its value"
  fi

  if [[ -n "$ROTATE" && "$ROTATE" != "$name" ]]; then
    # A targeted rotation should not create unrelated missing secrets.
    log_warn "${name}: missing, but --rotate was targeted at ${ROTATE}; skipping"
    continue
  fi

  write_random_secret "$name" "$bytes"
  created=$((created+1))
done

if [[ -n "$ROTATE" ]]; then
  found=0
  for entry in "${SECRETS[@]}"; do
    IFS='|' read -r name _ _ _ <<<"$entry"
    [[ "$name" == "$ROTATE" ]] && found=1
  done
  (( found )) || die "unknown secret name for --rotate: ${ROTATE}"
fi

# -----------------------------------------------------------------------------
# Distribute per-service copies.
#
# Copies rather than symlinks: a symlink into the 0700 secrets directory would
# not be readable from inside a container, because the container user cannot
# traverse the parent.
# -----------------------------------------------------------------------------
log_step "Distributing per-service secret bundles"

for service in "${!DISTRIBUTION[@]}"; do
  target="${PC_SECRETS_DIR}/${service}"
  ensure_dir "$target" 0710 root root

  # The container user must be able to read the files, so group ownership is
  # granted to that service's group and the directory is g+x (0710) — traversable
  # but not listable.
  case "$service" in
    postgres)    svc_gid="${PC_POSTGRES_GID:-999}" ;;
    control-api) svc_gid="${PC_APP_GID:-10001}" ;;
    n8n)         svc_gid="${PC_N8N_GID:-1000}" ;;
    *)           svc_gid=0 ;;
  esac
  chown "root:${svc_gid}" "$target"

  IFS=' ' read -r -a service_secrets <<<"${DISTRIBUTION[$service]}"
  staged=0
  for name in "${service_secrets[@]}"; do
    src="${PC_SECRETS_DIR}/${name}"
    secret_is_valid "$src" "${SECRET_MIN_LENGTH[$name]}" \
      || die "${service}: required secret ${name} is not valid"
    dst="${target}/${name}"
    tmp="$(mktemp "${target}/.${name}.XXXXXXXX")"
    cat -- "$src" >"$tmp"
    chmod 0640 "$tmp"
    chown "root:${svc_gid}" "$tmp"
    mv -f "$tmp" "$dst"
    staged=$((staged+1))
  done
  log_ok "${service}: ${staged} secret(s) staged (0640 root:${svc_gid})"
done

# -----------------------------------------------------------------------------
# Final permission sweep — assert rather than assume.
# -----------------------------------------------------------------------------
log_step "Verifying permissions"

bad=0
while IFS= read -r -d '' file; do
  mode="$(stat -c '%a' "$file")"
  owner="$(stat -c '%U' "$file")"
  if [[ "$owner" != "root" ]]; then
    log_error "$(basename "$file"): owned by ${owner}, expected root"; bad=1
  fi
  if [[ "$mode" != "600" && "$mode" != "640" ]]; then
    log_error "$(basename "$file"): mode ${mode}, expected 600 or 640"; bad=1
  fi
  # World-readable is always wrong.
  if (( 0$mode & 0004 )); then
    log_error "$(basename "$file"): is world-readable"; bad=1
  fi
done < <(find "$PC_SECRETS_DIR" -type f -print0)

dir_mode="$(stat -c '%a' "$PC_SECRETS_DIR")"
[[ "$dir_mode" == "700" ]] || { log_error "${PC_SECRETS_DIR}: mode ${dir_mode}, expected 700"; bad=1; }

(( bad == 0 )) || die "secret permission check failed"

log_ok "all secret files are root-owned with safe permissions"
log_info "created=${created} unchanged=${kept} rotated=${rotated}"

list_secrets
