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

# --- runner.env ---------------------------------------------------------------
tmp_runner="$(mktemp)"
cat >"$tmp_runner" <<EOF
# Generated by install.sh. Consumed by project-control-runner.service.
PC_CONTROL_GID=${PC_CONTROL_GID}
PC_RUNNER_SOCKET=${PC_RUNNER_SOCKET}
PC_RUNNER_WORKING_DIR=${PC_ROOT}/runner
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

if (( units_changed )); then
  systemctl daemon-reload
  log_ok "systemd daemon reloaded"
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
