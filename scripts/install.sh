#!/usr/bin/env bash
# =============================================================================
# install.sh — idempotent installation of the Project Control deployment.
#
# Safe to run repeatedly. It creates what is missing, corrects permissions, and
# reconciles the running stack with the version lock. It never deletes user data
# and never touches a container, volume or network belonging to another project.
#
#   sudo ./pcctl install [--skip-build] [--skip-start]
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

SKIP_BUILD=0
SKIP_START=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-start) SKIP_START=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

require_root
load_versions

# -----------------------------------------------------------------------------
log_step "1/9  Preflight"
# -----------------------------------------------------------------------------
# Installation refuses to proceed on a host that failed preflight. Port
# conflicts in particular are reported, never worked around by choosing a
# different port — a silently relocated portal is worse than a failed install.
if ! bash "${PC_SCRIPTS_DIR}/preflight.sh" >/dev/null 2>&1; then
  log_error "preflight reported blocking issues"
  log_info  "review reports/stage1-preflight.md, resolve them, then re-run"
  bash "${PC_SCRIPTS_DIR}/preflight.sh" 2>&1 | grep -E '^\[ FAIL\]' || true
  exit 1
fi
log_ok "preflight passed"

# -----------------------------------------------------------------------------
log_step "2/9  Users and groups"
# -----------------------------------------------------------------------------
# `project-control` group: shared between the runner (which owns the socket) and
# the Control API container (which joins it via group_add). This shared GID is
# the entire access-control mechanism for the runner socket.
if getent group project-control >/dev/null; then
  existing_gid="$(getent group project-control | cut -d: -f3)"
  if [[ "$existing_gid" != "${PC_CONTROL_GID}" ]]; then
    log_warn "group project-control exists with GID ${existing_gid}, lock expects ${PC_CONTROL_GID}"
    log_warn "using the existing GID; update infra/versions.lock.env to match"
    PC_CONTROL_GID="$existing_gid"
  fi
  log_ok "group project-control (GID ${PC_CONTROL_GID}) already exists"
else
  groupadd --system --gid "${PC_CONTROL_GID}" project-control
  log_ok "created group project-control (GID ${PC_CONTROL_GID})"
fi

# `project-runner`: the unprivileged account the runner service runs as. No
# login shell, no home directory, no sudoers entry — and this script never
# creates one.
if id -u "${PC_RUNNER_USER}" >/dev/null 2>&1; then
  log_ok "user ${PC_RUNNER_USER} already exists"
else
  useradd --system \
          --gid project-control \
          --home-dir "${PC_ROOT}/runner" \
          --no-create-home \
          --shell /usr/sbin/nologin \
          --comment "Project Control runner" \
          "${PC_RUNNER_USER}"
  log_ok "created system user ${PC_RUNNER_USER} (no shell, no home, no sudo)"
fi

RUNNER_UID="$(id -u "${PC_RUNNER_USER}")"
RUNNER_GID="$(id -g "${PC_RUNNER_USER}")"

# -----------------------------------------------------------------------------
log_step "3/9  Directory structure"
# -----------------------------------------------------------------------------
ensure_dir "$PC_ROOT" 0755 root root

# Structure, mode, owner
DIRECTORIES=(
  "compose|0755|root|root"
  "config|0755|root|root"
  "config/caddy|0755|root|root"
  "config/postgres|0755|root|root"
  "config/postgres/reconcile|0755|root|root"
  "config/status|0755|root|root"
  "secrets|0700|root|root"
  "data|0755|root|root"
  "data/postgres|0700|${PC_POSTGRES_UID}|${PC_POSTGRES_GID}"
  "data/n8n|0700|${PC_N8N_UID}|${PC_N8N_GID}"
  "data/artifacts|0750|${PC_APP_UID}|${PC_APP_GID}"
  "data/artifacts/objects|0750|${PC_APP_UID}|${PC_APP_GID}"
  "data/artifacts/temporary|0750|${PC_APP_UID}|${PC_APP_GID}"
  "backups|0750|root|root"
  "backups/staging|0700|root|root"
  "backups/restore-tests|0700|root|root"
  "backups/logs|0750|root|root"
  "logs|0755|root|root"
  "logs/caddy|0755|${PC_APP_UID}|${PC_APP_GID}"
  "runner|0750|${RUNNER_UID}|${RUNNER_GID}"
  "runner/bin|0750|${RUNNER_UID}|${RUNNER_GID}"
  "scripts|0755|root|root"
  "migrations|0755|root|root"
  "docs|0755|root|root"
)

for entry in "${DIRECTORIES[@]}"; do
  IFS='|' read -r rel mode owner group <<<"$entry"
  ensure_dir "${PC_ROOT}/${rel}" "$mode" "$owner" "$group"
done

log_ok "directory structure created and permissions applied"

# -----------------------------------------------------------------------------
log_step "4/9  Secrets"
# -----------------------------------------------------------------------------
PC_POSTGRES_GID="$PC_POSTGRES_GID" \
PC_APP_GID="$PC_APP_GID" \
PC_N8N_GID="$PC_N8N_GID" \
  bash "${PC_SCRIPTS_DIR}/generate-secrets.sh"

# -----------------------------------------------------------------------------
log_step "5/9  Configuration files"
# -----------------------------------------------------------------------------
install_file "${PC_REPO_ROOT}/infra/compose/compose.yaml" "${PC_ROOT}/compose/compose.yaml" 0644
install_file "${PC_REPO_ROOT}/infra/caddy/Caddyfile"      "${PC_ROOT}/config/caddy/Caddyfile" 0644
install_file "${PC_REPO_ROOT}/infra/versions.lock.env"    "${PC_ROOT}/config/versions.lock.env" 0644

install_file "${PC_REPO_ROOT}/infra/postgres/reconcile/reconcile-roles-and-databases.sh" \
             "${PC_ROOT}/config/postgres/reconcile/reconcile-roles-and-databases.sh" 0755

# Stale layout from before the db-bootstrap reconciliation service existed:
# the old directory is unmounted by the current compose.yaml, and it holds
# nothing but a copy of config this installer regenerates, never data.
if [[ -d "${PC_ROOT}/config/postgres/init" ]]; then
  rm -f "${PC_ROOT}/config/postgres/init/10-roles-and-databases.sh"
  rmdir "${PC_ROOT}/config/postgres/init" 2>/dev/null || true
  log_info "removed superseded config/postgres/init (replaced by config/postgres/reconcile)"
fi

for migration in "${PC_REPO_ROOT}"/migrations/*.sql; do
  [[ -f "$migration" ]] || continue
  install_file "$migration" "${PC_ROOT}/migrations/$(basename "$migration")" 0644
done

for script in backup.sh restore-test.sh verify.sh verify-security.sh telegram-notify.sh; do
  if [[ -f "${PC_SCRIPTS_DIR}/${script}" ]]; then
    install_file "${PC_SCRIPTS_DIR}/${script}" "${PC_ROOT}/scripts/${script}" 0750
  fi
done
ensure_dir "${PC_ROOT}/scripts/lib" 0755 root root
install_file "${PC_SCRIPTS_DIR}/lib/common.sh" "${PC_ROOT}/scripts/lib/common.sh" 0644

for doc in "${PC_REPO_ROOT}"/docs/*.md; do
  [[ -f "$doc" ]] || continue
  install_file "$doc" "${PC_ROOT}/docs/$(basename "$doc")" 0644
done

# --- stack.env: non-secret runtime configuration ------------------------------
# Written fresh each install so it always matches the version lock, but any
# operator-tunable value already present is preserved.
STACK_ENV="${PC_ROOT}/config/stack.env"
PREV_TAILSCALE_HOSTNAME=""
PREV_N8N_PUBLIC_URL=""
if [[ -f "$STACK_ENV" ]]; then
  PREV_TAILSCALE_HOSTNAME="$(grep -E '^PC_TAILSCALE_HOSTNAME=' "$STACK_ENV" | cut -d= -f2- || true)"
  PREV_N8N_PUBLIC_URL="$(grep -E '^PC_N8N_PUBLIC_URL=' "$STACK_ENV" | cut -d= -f2- || true)"
fi

tmp_env="$(mktemp)"
cat >"$tmp_env" <<EOF
# Generated by install.sh on $(_pc_ts). Non-secret runtime configuration.
# Secrets live in ${PC_SECRETS_DIR} and are never placed in this file.
COMPOSE_PROJECT_NAME=${PC_COMPOSE_PROJECT}
PC_ROOT=${PC_ROOT}

# --- Pinned images (from versions.lock.env) ---
PC_POSTGRES_IMAGE=${PC_POSTGRES_IMAGE}
PC_N8N_IMAGE=${PC_N8N_IMAGE}
PC_CADDY_IMAGE=${PC_CADDY_IMAGE}
PC_CADDY_PROXY_IMAGE=${PC_CADDY_PROXY_IMAGE}
PC_CONTROL_API_IMAGE=${PC_CONTROL_API_IMAGE}
PC_WEB_IMAGE=${PC_WEB_IMAGE}
PC_STACK_VERSION=${PC_STACK_VERSION}

# --- Fixed identity map ---
PC_POSTGRES_UID=${PC_POSTGRES_UID}
PC_POSTGRES_GID=${PC_POSTGRES_GID}
PC_N8N_UID=${PC_N8N_UID}
PC_N8N_GID=${PC_N8N_GID}
PC_APP_UID=${PC_APP_UID}
PC_APP_GID=${PC_APP_GID}
PC_WEB_UID=${PC_WEB_UID}
PC_CONTROL_GID=${PC_CONTROL_GID}

# --- Tunables ---
PC_LOG_LEVEL=info
PC_N8N_LOG_LEVEL=info
PC_TIMEZONE=UTC
PC_SESSION_ABSOLUTE_TTL_SECONDS=43200
PC_SESSION_IDLE_TTL_SECONDS=3600
PC_LOGIN_RATE_LIMIT_MAX=5
PC_LOGIN_RATE_LIMIT_WINDOW_SECONDS=300
PC_ARTIFACT_MAX_BYTES=268435456

# --- Set by ./pcctl configure-tailscale ---
PC_TAILSCALE_HOSTNAME=${PREV_TAILSCALE_HOSTNAME:-localhost}
PC_N8N_PUBLIC_URL=${PREV_N8N_PUBLIC_URL:-http://127.0.0.1:5678}
PC_N8N_SECURE_COOKIE=${PREV_N8N_PUBLIC_URL:+true}
EOF
# Default N8N_SECURE_COOKIE to false until Tailscale HTTPS is configured, or the
# browser will refuse the cookie over plain http://127.0.0.1.
if [[ -z "$PREV_N8N_PUBLIC_URL" ]]; then
  printf 'PC_N8N_SECURE_COOKIE=false\n' >>"$tmp_env"
fi

install_file "$tmp_env" "$STACK_ENV" 0640
rm -f "$tmp_env"
chown root:root "$STACK_ENV"

# --- allowed-project-roots.conf ------------------------------------------------
# Root-owned, non-secret list of directories the runner may read project
# folders under — the entire "allowed roots" mechanism for project
# registration. Web panel and Control API never write this file; it is
# managed here and directly by an operator with root access. Preserved
# verbatim on every reinstall; only created (with the Stage default) the
# first time this host is installed.
ALLOWED_ROOTS_FILE="${PC_ROOT}/config/allowed-project-roots.conf"
DEFAULT_ALLOWED_ROOT="/home/asrin/Desktop"

if [[ ! -f "$ALLOWED_ROOTS_FILE" ]]; then
  tmp_roots="$(mktemp)"
  cat >"$tmp_roots" <<EOF
# Allowed project registration roots — one absolute path per line.
# Root-owned (0644, not writable by the web panel or the Control API
# container). To add or remove a root: edit this file, then re-run
#   sudo ./pcctl install
# which regenerates the systemd read-only bind-mount exception below and
# restarts the runner so the change takes effect.
${DEFAULT_ALLOWED_ROOT}
EOF
  install -m 0644 -o root -g root "$tmp_roots" "$ALLOWED_ROOTS_FILE"
  rm -f "$tmp_roots"
  log_ok "created ${ALLOWED_ROOTS_FILE} with default root ${DEFAULT_ALLOWED_ROOT}"
else
  chmod 0644 "$ALLOWED_ROOTS_FILE"
  chown root:root "$ALLOWED_ROOTS_FILE"
  log_debug "allowed-project-roots.conf already present; preserved unchanged"
fi

mapfile -t ALLOWED_ROOTS_RAW < <(grep -vE '^[[:space:]]*(#|$)' "$ALLOWED_ROOTS_FILE" || true)

# Validate and canonicalize each configured line before it ever reaches the
# generated systemd drop-in: a malformed entry (not absolute, containing a
# literal ".." component) is rejected with a visible warning rather than
# silently emitted into BindReadOnlyPaths= as-is, and a root that is itself
# a symlink is resolved to its real target so the bind mount and every log
# line about it refer to the same, unambiguous path.
ALLOWED_ROOTS=()
for raw_root in "${ALLOWED_ROOTS_RAW[@]+"${ALLOWED_ROOTS_RAW[@]}"}"; do
  trimmed="${raw_root#"${raw_root%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  if [[ -z "$trimmed" ]]; then
    continue
  fi
  if [[ "$trimmed" != /* ]]; then
    log_warn "ignoring malformed allowed-project-roots.conf entry (not an absolute path): ${trimmed}"
    continue
  fi
  case "/${trimmed}/" in
    */../*|*/./*)
      log_warn "ignoring malformed allowed-project-roots.conf entry (contains . or .. component): ${trimmed}"
      continue
      ;;
  esac
  resolved="$trimmed"
  if [[ -e "$trimmed" ]]; then
    resolved="$(readlink -f -- "$trimmed" 2>/dev/null || printf '%s' "$trimmed")"
    if [[ "$resolved" != "$trimmed" ]]; then
      log_info "allowed root ${trimmed} resolves through a symlink to ${resolved}; binding the resolved path"
    fi
  fi
  ALLOWED_ROOTS+=("$resolved")
done

if (( ${#ALLOWED_ROOTS[@]} == 0 )); then
  log_warn "allowed-project-roots.conf has no valid entries; project registration will be disabled"
fi

# --- systemd drop-in: BindReadOnlyPaths for each allowed root ------------------
# ProtectHome=tmpfs (in infra/systemd/project-control-runner.service) hides
# all of /home from the runner by default. This drop-in punches exactly one
# read-only exception per configured root — never a write exception, never a
# hole in the rest of /home — using systemd's own documented mechanism for
# adding narrow exceptions to ProtectHome/ProtectSystem=strict. The leading
# "-" makes a currently-missing root (e.g. an unmounted drive) non-fatal to
# the runner's startup; project.path.validate independently rejects anything
# under a root that turns out to be inaccessible at request time.
RUNNER_DROPIN_DIR="/etc/systemd/system/project-control-runner.service.d"
RUNNER_DROPIN_FILE="${RUNNER_DROPIN_DIR}/10-allowed-roots.conf"
mkdir -p "$RUNNER_DROPIN_DIR"
chmod 0755 "$RUNNER_DROPIN_DIR"

tmp_dropin="$(mktemp)"
{
  printf '# Generated by install.sh from %s\n' "$ALLOWED_ROOTS_FILE"
  printf '# Do not edit directly — edit that file and re-run: sudo ./pcctl install\n'
  printf '[Service]\n'
  for root in "${ALLOWED_ROOTS[@]+"${ALLOWED_ROOTS[@]}"}"; do
    printf 'BindReadOnlyPaths=-%s\n' "$root"
  done
} >"$tmp_dropin"

runner_dropin_changed=0
if [[ -f "$RUNNER_DROPIN_FILE" ]] && cmp -s "$tmp_dropin" "$RUNNER_DROPIN_FILE"; then
  rm -f "$tmp_dropin"
  log_debug "systemd allowed-roots drop-in unchanged"
else
  install -m 0644 -o root -g root "$tmp_dropin" "$RUNNER_DROPIN_FILE"
  rm -f "$tmp_dropin"
  runner_dropin_changed=1
  log_ok "installed ${RUNNER_DROPIN_FILE} (${#ALLOWED_ROOTS[@]} root(s))"
fi

# --- runner.env ---------------------------------------------------------------
tmp_runner="$(mktemp)"
cat >"$tmp_runner" <<EOF
# Generated by install.sh. Consumed by project-control-runner.service.
PC_CONTROL_GID=${PC_CONTROL_GID}
PC_RUNNER_SOCKET=${PC_RUNNER_SOCKET}
PC_RUNNER_WORKING_DIR=${PC_ROOT}/runner
PC_RUNNER_ALLOWED_PROJECT_ROOTS_FILE=${ALLOWED_ROOTS_FILE}
PC_RUNNER_MAX_CONCURRENT=4
PC_RUNNER_LOG_LEVEL=info
EOF
install_file "$tmp_runner" "${PC_ROOT}/config/runner.env" 0644
rm -f "$tmp_runner"

# --- Initial status files -----------------------------------------------------
# Written as "not configured" so the dashboard reports
# MANUAL_CONFIGURATION_REQUIRED rather than an error before the checkpoints run.
for status_file in tailscale-status.json backup-status.json; do
  target="${PC_ROOT}/config/status/${status_file}"
  if [[ ! -f "$target" ]]; then
    printf '{"configured": false}\n' >"$target"
    chmod 0644 "$target"
  fi
done

log_ok "configuration installed"

# -----------------------------------------------------------------------------
log_step "6/9  Building images and the runner binary"
# -----------------------------------------------------------------------------
if (( SKIP_BUILD )); then
  log_warn "--skip-build: assuming images and the runner binary are already present"
else
  bash "${PC_SCRIPTS_DIR}/build.sh"
fi

# Install the runner binary.
if [[ -f "${PC_REPO_ROOT}/apps/runner/bin/project-control-runner" ]]; then
  install_file "${PC_REPO_ROOT}/apps/runner/bin/project-control-runner" \
               "${PC_ROOT}/runner/bin/project-control-runner" 0750
  chown "${RUNNER_UID}:${RUNNER_GID}" "${PC_ROOT}/runner/bin/project-control-runner"
  log_ok "runner binary installed"
else
  log_warn "runner binary not built; the runner service will not start"
fi

# -----------------------------------------------------------------------------
log_step "7/9  systemd units"
# -----------------------------------------------------------------------------
UNITS=(
  project-control-runner.service
  project-control-stack.service
  project-control-backup.service
  project-control-backup.timer
  project-control-check.service
  project-control-check.timer
  project-control-restore-test.service
  project-control-restore-test.timer
)

units_changed=0
for unit in "${UNITS[@]}"; do
  src="${PC_REPO_ROOT}/infra/systemd/${unit}"
  [[ -f "$src" ]] || { log_warn "unit ${unit} missing from the repository"; continue; }
  dst="/etc/systemd/system/${unit}"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    log_debug "unit ${unit} unchanged"
  else
    install -m 0644 -o root -g root "$src" "$dst"
    log_ok "installed ${unit}"
    units_changed=1
  fi
done

if (( units_changed )) || (( runner_dropin_changed )); then
  systemctl daemon-reload
  log_ok "systemd daemon reloaded"
fi

# `enable --now` on an already-running service does not restart it, so a
# changed unit file or allowed-roots drop-in needs an explicit restart to
# actually take effect on a host that is being re-installed rather than
# installed fresh.
if systemctl is-active --quiet project-control-runner.service \
   && { (( units_changed )) || (( runner_dropin_changed )); }; then
  systemctl restart project-control-runner.service
  log_ok "restarted project-control-runner.service to apply configuration changes"
fi

# The runner must be up before the Control API container starts, because the
# socket it mounts has to exist.
systemctl enable --now project-control-runner.service
sleep 2
if systemctl is-active --quiet project-control-runner.service; then
  log_ok "project-control-runner.service is running"
else
  log_error "runner failed to start; inspect: journalctl -u project-control-runner -n 50"
  exit 1
fi

if [[ ! -S "$PC_RUNNER_SOCKET" ]]; then
  die "runner socket ${PC_RUNNER_SOCKET} was not created"
fi
socket_mode="$(stat -c '%a' "$PC_RUNNER_SOCKET")"
socket_group="$(stat -c '%G' "$PC_RUNNER_SOCKET")"
log_ok "runner socket present (mode ${socket_mode}, group ${socket_group})"

# --- Verify the allowed-roots bind mounts actually took effect ----------------
# The drop-in file being present and syntactically valid does not prove the
# running process's mount namespace actually has it: if the drop-in already
# had this exact content from an earlier install (so runner_dropin_changed
# stayed 0 and no restart was triggered above), while the runner was started
# at some point before that content ever applied, the live namespace would
# still be missing the bind mount with no other symptom — the unit is simply
# "active". Verify directly against /proc/<pid>/mountinfo, the same
# kernel-level evidence `./pcctl verify-security`'s RNR-010 checks, and
# self-heal with one more restart before giving up and warning loudly. A
# root that does not currently exist on disk (e.g. an unmounted drive) is
# skipped here, matching the non-fatal "-" prefix on BindReadOnlyPaths=.
if (( ${#ALLOWED_ROOTS[@]} > 0 )); then
  verify_allowed_root_mounts() {
    local pid; pid="$(systemctl show project-control-runner.service -p MainPID --value 2>/dev/null || echo 0)"
    [[ "$pid" =~ ^[0-9]+$ ]] && (( pid > 0 )) || return 1
    [[ -r "/proc/${pid}/mountinfo" ]] || return 1
    local root canon opts
    for root in "${ALLOWED_ROOTS[@]}"; do
      [[ -d "$root" ]] || continue
      canon="$(readlink -f -- "$root" 2>/dev/null || printf '%s' "$root")"
      opts="$(awk -v t="$canon" '$5 == t {print $6; exit}' "/proc/${pid}/mountinfo" 2>/dev/null || true)"
      [[ -n "$opts" && "$opts" == ro* ]] || return 1
    done
    return 0
  }

  if verify_allowed_root_mounts; then
    log_ok "allowed-roots bind mount(s) verified read-only in the runner's live mount namespace"
  else
    log_warn "allowed-roots bind mount not yet visible in the runner's namespace; restarting once to apply"
    systemctl restart project-control-runner.service
    sleep 2
    if verify_allowed_root_mounts; then
      log_ok "allowed-roots bind mount(s) verified read-only in the runner's live mount namespace after restart"
    else
      # A configured, existing allowed root that still cannot be proven
      # read-only after one controlled restart is not a successful install:
      # project registration would silently be non-functional. This is
      # fail-closed and needs no rollback — nothing destructive has run yet
      # (the stack is started in the next step), so any already-running
      # containers, Tailscale and n8n are left exactly as they were; the
      # runner itself keeps running (just without the extra read access),
      # which is the same safe-by-default state a missing bind mount always
      # produces.
      log_error "one or more configured allowed roots are still not visible read-only in the runner's mount namespace after a restart"
      log_error "project registration will not be able to read these folders until this is resolved"
      log_error "inspect: sudo ./pcctl verify-security | grep -E 'RNR-01[0-3]'"
      log_error "and:     journalctl -u project-control-runner -n 50"
      log_error "installation aborted: a configured allowed root failed to apply"
      exit 1
    fi
  fi
fi

systemctl enable project-control-stack.service   >/dev/null 2>&1 || true
systemctl enable project-control-backup.timer    >/dev/null 2>&1 || true
systemctl enable project-control-check.timer     >/dev/null 2>&1 || true
systemctl enable project-control-restore-test.timer >/dev/null 2>&1 || true
log_ok "boot units and backup timers enabled"

# -----------------------------------------------------------------------------
log_step "8/9  Starting the stack"
# -----------------------------------------------------------------------------
if (( SKIP_START )); then
  log_warn "--skip-start: not starting containers"
else
  load_stack_env
  compose up --detach --remove-orphans --wait --wait-timeout 240 || {
    log_error "the stack did not become healthy"
    compose ps
    exit 1
  }
  log_ok "all containers are healthy"
fi

# -----------------------------------------------------------------------------
log_step "9/9  Post-install checks"
# -----------------------------------------------------------------------------
if ! (( SKIP_START )); then
  bash "${PC_SCRIPTS_DIR}/verify.sh" || log_warn "verification reported issues; see output above"
fi

cat >&2 <<BANNER

$(printf '═%.0s' {1..70})
  Project Control — installation complete
$(printf '═%.0s' {1..70})

  Deployment root : ${PC_ROOT}
  Compose project : ${PC_COMPOSE_PROJECT}
  Stack version   : ${PC_STACK_VERSION}

  REMAINING MANUAL CHECKPOINTS — Stage 1 is not complete until all are done:

    1. sudo ./pcctl configure-tailscale     Tailscale login + HTTPS
    2. sudo ./pcctl create-admin            First administrator account
    3. sudo ./pcctl configure-google-drive  Google Drive OAuth + restic password
    4. sudo ./pcctl configure-telegram      Telegram bot token and chat id
    5. n8n first owner account              via the n8n UI once Tailscale is up

  Then:  ./pcctl verify  &&  ./pcctl verify-security

$(printf '═%.0s' {1..70})

BANNER
