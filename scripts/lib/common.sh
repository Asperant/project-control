#!/usr/bin/env bash
# =============================================================================
# scripts/lib/common.sh — shared helpers for every Project Control script
#
# Sourced, never executed. Provides:
#   * strict-mode setup and error trapping
#   * structured, colour-aware logging that NEVER prints secret values
#   * repository / deployment path discovery
#   * version-lock loading
#   * privilege, idempotency and safety helpers
# =============================================================================

# --- Strict mode -------------------------------------------------------------
set -Eeuo pipefail
IFS=$'\n\t'

# --- Paths -------------------------------------------------------------------
# PC_REPO_ROOT: the git checkout containing the source of truth.
# PC_ROOT:      the deployment root on the host (default /srv/project-control).
PC_LIB_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PC_SCRIPTS_DIR="$(dirname -- "$PC_LIB_DIR")"
PC_REPO_ROOT="$(dirname -- "$PC_SCRIPTS_DIR")"
export PC_REPO_ROOT PC_SCRIPTS_DIR

PC_ROOT="${PC_ROOT:-/srv/project-control}"
export PC_ROOT

PC_COMPOSE_PROJECT="project-control"
export PC_COMPOSE_PROJECT

PC_SECRETS_DIR="${PC_ROOT}/secrets"
PC_CONFIG_DIR="${PC_ROOT}/config"
PC_DATA_DIR="${PC_ROOT}/data"
PC_LOGS_DIR="${PC_ROOT}/logs"
PC_BACKUPS_DIR="${PC_ROOT}/backups"
PC_COMPOSE_DIR="${PC_ROOT}/compose"
PC_RUNNER_DIR="${PC_ROOT}/runner"
export PC_SECRETS_DIR PC_CONFIG_DIR PC_DATA_DIR PC_LOGS_DIR PC_BACKUPS_DIR PC_COMPOSE_DIR PC_RUNNER_DIR

PC_RUNTIME_DIR="/run/project-control"
PC_RUNNER_SOCKET="${PC_RUNTIME_DIR}/runner.sock"
export PC_RUNTIME_DIR PC_RUNNER_SOCKET

# --- Colour / logging --------------------------------------------------------
if [[ -t 2 && "${NO_COLOR:-}" == "" && "${TERM:-dumb}" != "dumb" ]]; then
  _C_RESET=$'\033[0m'; _C_RED=$'\033[31m'; _C_GRN=$'\033[32m'
  _C_YEL=$'\033[33m'; _C_BLU=$'\033[34m'; _C_DIM=$'\033[2m'; _C_BOLD=$'\033[1m'
else
  _C_RESET=''; _C_RED=''; _C_GRN=''; _C_YEL=''; _C_BLU=''; _C_DIM=''; _C_BOLD=''
fi

_pc_ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

log_info()  { printf '%s[ INFO]%s %s\n'  "$_C_BLU"  "$_C_RESET" "$*" >&2; }
log_ok()    { printf '%s[  OK ]%s %s\n'  "$_C_GRN"  "$_C_RESET" "$*" >&2; }
log_warn()  { printf '%s[ WARN]%s %s\n'  "$_C_YEL"  "$_C_RESET" "$*" >&2; }
log_error() { printf '%s[ FAIL]%s %s\n'  "$_C_RED"  "$_C_RESET" "$*" >&2; }
log_step()  { printf '\n%s==>%s %s%s%s\n' "$_C_BLU" "$_C_RESET" "$_C_BOLD" "$*" "$_C_RESET" >&2; }
log_debug() { [[ "${PC_DEBUG:-0}" == "1" ]] && printf '%s[DEBUG] %s%s\n' "$_C_DIM" "$*" "$_C_RESET" >&2 || true; }

# `die` always exits non-zero. Never interpolate secret material into it.
die() { log_error "$*"; exit 1; }

# Error trap: report the failing command and line, then abort.
_pc_on_err() {
  local exit_code=$? line=${1:-?} cmd=${2:-?}
  log_error "aborted at line ${line}: '${cmd}' exited ${exit_code}"
  exit "$exit_code"
}
trap '_pc_on_err "$LINENO" "$BASH_COMMAND"' ERR

# --- Secret-safe output ------------------------------------------------------
# Redacts anything that looks like a credential from a stream. Used whenever
# third-party command output might contain secret material.
redact_stream() {
  sed -E \
    -e 's/(password|passwd|pwd|secret|token|api[_-]?key|encryption[_-]?key|bot[_-]?token)([\"'\'']?[[:space:]]*[:=][[:space:]]*[\"'\'']?)[^[:space:]\"'\'',;]+/\1\2***REDACTED***/gI' \
    -e 's#postgres(ql)?://([^:@/]+):[^@]*@#postgres\1://\2:***REDACTED***@#g' \
    -e 's/\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b/***REDACTED-TELEGRAM-TOKEN***/g'
}

# --- Privilege helpers -------------------------------------------------------
is_root() { [[ "$(id -u)" -eq 0 ]]; }

require_root() {
  if ! is_root; then
    die "this command must run as root: sudo $0 $*"
  fi
}

# Returns 0 if we can obtain root non-interactively (or already are root).
can_sudo_noninteractive() {
  is_root && return 0
  command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null
}

have() { command -v "$1" >/dev/null 2>&1; }

require_cmd() {
  local missing=()
  for c in "$@"; do have "$c" || missing+=("$c"); done
  (( ${#missing[@]} == 0 )) || die "missing required command(s): ${missing[*]}"
}

# --- Version lock ------------------------------------------------------------
load_versions() {
  local lock="${1:-${PC_REPO_ROOT}/infra/versions.lock.env}"
  [[ -r "$lock" ]] || die "version lock not readable: $lock"
  # shellcheck disable=SC1090
  set -a; source "$lock"; set +a
  [[ -n "${PC_POSTGRES_IMAGE:-}" ]] || die "version lock is incomplete: PC_POSTGRES_IMAGE unset"
}

# --- Deployment env ----------------------------------------------------------
# Loads the deployed stack environment (non-secret) if present.
load_stack_env() {
  local f="${PC_CONFIG_DIR}/stack.env"
  if [[ -r "$f" ]]; then
    # shellcheck disable=SC1090
    set -a; source "$f"; set +a
  fi
}

# --- Secret file access ------------------------------------------------------
# Reads a secret file, stripping the trailing newline. Never logs the value.
read_secret() {
  local name="$1" path="${PC_SECRETS_DIR}/$1"
  [[ -r "$path" ]] || die "secret not readable (missing or insufficient privilege): ${name}"
  local mode; mode="$(stat -c '%a' "$path")"
  [[ "$mode" == "600" || "$mode" == "400" ]] || die "secret ${name} has unsafe mode ${mode}, expected 600"
  printf '%s' "$(cat -- "$path")"
}

secret_exists() {
  local path="${PC_SECRETS_DIR}/$1" size mode uid gid
  [[ -f "$path" && ! -L "$path" ]] || return 1
  size="$(stat -c '%s' "$path" 2>/dev/null)" || return 1
  mode="$(stat -c '%a' "$path" 2>/dev/null)" || return 1
  uid="$(stat -c '%u' "$path" 2>/dev/null)" || return 1
  gid="$(stat -c '%g' "$path" 2>/dev/null)" || return 1
  [[ "$size" =~ ^[0-9]+$ ]] || return 1
  (( size > 0 )) || return 1
  [[ "$uid" == "0" && "$gid" == "0" && "$mode" == "600" ]]
}

# Writes a secret atomically with 0600 permissions, never echoing the value.
# Secret files deliberately contain no trailing newline.
# Usage: write_secret <name> <value>
write_secret() {
  local name="$1" value="$2"
  local dest="${PC_SECRETS_DIR}/${name}"
  local tmp
  tmp="$(mktemp "${PC_SECRETS_DIR}/.${name}.XXXXXXXX")"
  chmod 0600 "$tmp"
  if is_root; then chown root:root "$tmp"; fi
  printf '%s' "$value" >"$tmp"
  sync -f "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$dest"
  chmod 0600 "$dest"
  if is_root; then chown root:root "$dest"; fi
  sync -f "$PC_SECRETS_DIR" 2>/dev/null || true
  log_ok "secret written: ${name} (0600)"
}

# --- Idempotent filesystem helpers -------------------------------------------
# ensure_dir <path> <mode> [owner] [group]
ensure_dir() {
  local path="$1" mode="$2" owner="${3:-}" group="${4:-}"
  if [[ ! -d "$path" ]]; then
    mkdir -p "$path"
    log_info "created ${path}"
  fi
  chmod "$mode" "$path"
  if [[ -n "$owner" ]] && is_root; then
    chown "${owner}:${group:-$owner}" "$path"
  fi
}

# install_file <src> <dest> <mode> — copies only when content differs.
install_file() {
  local src="$1" dest="$2" mode="${3:-0644}"
  [[ -r "$src" ]] || die "source file missing: $src"
  if [[ -f "$dest" ]] && cmp -s "$src" "$dest"; then
    chmod "$mode" "$dest"
    log_debug "unchanged ${dest}"
    return 0
  fi
  mkdir -p "$(dirname -- "$dest")"
  local tmp; tmp="$(mktemp "${dest}.XXXXXXXX")"
  cat -- "$src" >"$tmp"
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$dest"
  log_ok "installed ${dest}"
}

# --- Docker / compose --------------------------------------------------------
compose() {
  local file="${PC_COMPOSE_DIR}/compose.yaml"
  [[ -f "$file" ]] || file="${PC_REPO_ROOT}/infra/compose/compose.yaml"
  docker compose \
    --project-name "$PC_COMPOSE_PROJECT" \
    --project-directory "$PC_ROOT" \
    --env-file "${PC_CONFIG_DIR}/stack.env" \
    --file "$file" "$@"
}

container_id() {
  docker ps -a --filter "label=com.docker.compose.project=${PC_COMPOSE_PROJECT}" \
               --filter "label=com.docker.compose.service=$1" \
               --format '{{.ID}}' | head -1
}

container_health() {
  local cid; cid="$(container_id "$1")"
  [[ -n "$cid" ]] || { echo "absent"; return 0; }
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo "unknown"
}

# --- Reporting ---------------------------------------------------------------
# Machine-readable check accumulation used by verify / preflight.
PC_CHECK_PASS=0
PC_CHECK_FAIL=0
PC_CHECK_WARN=0
PC_CHECK_SKIP=0
declare -a PC_CHECK_ROWS=()

# record_check <status:PASS|FAIL|WARN|SKIP> <id> <description> [detail]
record_check() {
  local status="$1" id="$2" desc="$3" detail="${4:-}"
  case "$status" in
    PASS) PC_CHECK_PASS=$((PC_CHECK_PASS+1)); log_ok   "${id}: ${desc}" ;;
    FAIL) PC_CHECK_FAIL=$((PC_CHECK_FAIL+1)); log_error "${id}: ${desc}${detail:+ — $detail}" ;;
    WARN) PC_CHECK_WARN=$((PC_CHECK_WARN+1)); log_warn  "${id}: ${desc}${detail:+ — $detail}" ;;
    SKIP) PC_CHECK_SKIP=$((PC_CHECK_SKIP+1)); log_info  "${id}: ${desc} (skipped${detail:+: $detail})" ;;
  esac
  PC_CHECK_ROWS+=("${status}|${id}|${desc}|${detail}")
}

# Emits the accumulated checks as JSON on stdout.
emit_checks_json() {
  local overall="pass"
  (( PC_CHECK_FAIL > 0 )) && overall="fail"
  printf '{\n'
  printf '  "schema": 1,\n'
  printf '  "generated_at": "%s",\n' "$(_pc_ts)"
  printf '  "overall": "%s",\n' "$overall"
  printf '  "summary": { "pass": %d, "fail": %d, "warn": %d, "skip": %d },\n' \
    "$PC_CHECK_PASS" "$PC_CHECK_FAIL" "$PC_CHECK_WARN" "$PC_CHECK_SKIP"
  printf '  "checks": [\n'
  local first=1 row status id desc detail
  for row in "${PC_CHECK_ROWS[@]+"${PC_CHECK_ROWS[@]}"}"; do
    IFS='|' read -r status id desc detail <<<"$row"
    (( first )) || printf ',\n'; first=0
    printf '    { "status": "%s", "id": "%s", "description": %s, "detail": %s }' \
      "$status" "$id" "$(json_string "$desc")" "$(json_string "$detail")"
  done
  printf '\n  ]\n}\n'
}

# json_string <text> — minimal but correct JSON string escaping.
json_string() {
  local s="${1:-}"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"; s="${s//$'\r'/\\r}"; s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

print_check_summary() {
  printf '\n%s%s%s\n' "$_C_BOLD" "──────────────────────────────────────────────────" "$_C_RESET" >&2
  printf '  %spass%s %-4d  %sfail%s %-4d  %swarn%s %-4d  skip %d\n' \
    "$_C_GRN" "$_C_RESET" "$PC_CHECK_PASS" \
    "$_C_RED" "$_C_RESET" "$PC_CHECK_FAIL" \
    "$_C_YEL" "$_C_RESET" "$PC_CHECK_WARN" \
    "$PC_CHECK_SKIP" >&2
  printf '%s%s%s\n' "$_C_BOLD" "──────────────────────────────────────────────────" "$_C_RESET" >&2
}

# --- Misc --------------------------------------------------------------------
# Cryptographically secure random string, URL-safe, from the kernel CSPRNG.
random_token() {
  local length="${1:-32}" raw_bytes token
  [[ "$length" =~ ^[1-9][0-9]*$ ]] || die "random token length must be a positive integer"

  # Read a finite amount from the kernel CSPRNG and format it in-memory. Unlike
  # `... | head -c ...`, every process reaches normal EOF under pipefail.
  raw_bytes=$(( (length + 1) / 2 ))
  token="$(LC_ALL=C od -An -v -tx1 -N "$raw_bytes" /dev/urandom)"
  token="${token//[[:space:]]/}"
  [[ ${#token} -ge $length ]] || die "kernel CSPRNG returned insufficient data"
  printf '%s' "${token:0:length}"
}

random_hex() {
  local bytes="${1:-32}"
  od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
}

confirm() {
  local prompt="$1" expect="${2:-yes}" answer
  if [[ "${PC_ASSUME_YES:-0}" == "1" ]]; then return 0; fi
  read -r -p "${prompt} [type '${expect}' to continue]: " answer || return 1
  [[ "$answer" == "$expect" ]]
}
