#!/usr/bin/env bash
# =============================================================================
# uninstall.sh — remove the Project Control stack.
#
#   sudo ./pcctl uninstall                 stop and remove containers; KEEP data
#   sudo ./pcctl uninstall --delete-data   also destroy data (double confirmation)
#
# The default is deliberately non-destructive. Data removal requires an explicit
# flag AND two separate typed confirmations AND a final acknowledgement that no
# backup will be taken automatically — because this is the one command in the
# system that can lose everything irreversibly.
#
# Containers, images, volumes and networks belonging to any other Compose
# project are never touched: every removal is scoped by the
# com.docker.compose.project=project-control label or by an explicit name.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions
load_stack_env

DELETE_DATA=0
REMOVE_IMAGES=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --delete-data)   DELETE_DATA=1; shift ;;
    --remove-images) REMOVE_IMAGES=1; shift ;;
    *) die "unknown argument: $1" ;;
  esac
done

# -----------------------------------------------------------------------------
# Show exactly what exists before asking anything.
# -----------------------------------------------------------------------------
log_step "Uninstall — current state"

container_count="$(docker ps -aq --filter "label=com.docker.compose.project=${PC_COMPOSE_PROJECT}" 2>/dev/null | wc -l | tr -d ' ')"
data_size="$(du -sh "${PC_ROOT}/data" 2>/dev/null | cut -f1 || echo unknown)"
artifact_count="$(find "${PC_ROOT}/data/artifacts/objects" -type f 2>/dev/null | wc -l | tr -d ' ')"

cat >&2 <<STATE

  Compose project : ${PC_COMPOSE_PROJECT}
  Containers      : ${container_count}
  Deployment root : ${PC_ROOT}
  Data size       : ${data_size}
  Artifacts       : ${artifact_count} object(s)

  Other Docker projects on this host will NOT be touched.

STATE

if (( DELETE_DATA )); then
  cat >&2 <<'DANGER'
  ████████████████████████████████████████████████████████████████████
  ██  --delete-data WAS SPECIFIED                                   ██
  ██                                                                ██
  ██  This will PERMANENTLY DESTROY:                                ██
  ██    * both PostgreSQL databases (all users, sessions, audit)    ██
  ██    * every artifact object                                     ██
  ██    * all n8n workflows and credentials                         ██
  ██    * every secret, including the n8n encryption key            ██
  ██                                                                ██
  ██  Without the n8n encryption key, existing backups of n8n       ██
  ██  credentials become undecryptable even if you restore them.    ██
  ██                                                                ██
  ██  NO BACKUP IS TAKEN BY THIS COMMAND.                           ██
  ████████████████████████████████████████████████████████████████████

DANGER

  # First confirmation.
  confirm "Type the deployment root to confirm you understand" "${PC_ROOT}" \
    || die "aborted; nothing was changed"

  # Second, independent confirmation.
  confirm "Type DELETE ALL DATA to proceed" "DELETE ALL DATA" \
    || die "aborted; nothing was changed"

  # Third: force the operator to state the backup situation out loud.
  if secret_exists restic_password; then
    log_warn "A backup repository is configured. Consider running: sudo ./pcctl backup"
    confirm "Type I HAVE A BACKUP to continue" "I HAVE A BACKUP" \
      || die "aborted; take a backup first with: sudo ./pcctl backup"
  fi
else
  log_info "data will be PRESERVED (pass --delete-data to remove it)"
  confirm "Type uninstall to remove the stack" "uninstall" \
    || die "aborted; nothing was changed"
fi

# =============================================================================
log_step "1/5  Stopping services"
# =============================================================================
systemctl stop project-control-backup.timer       2>/dev/null || true
systemctl stop project-control-check.timer        2>/dev/null || true
systemctl stop project-control-restore-test.timer 2>/dev/null || true
systemctl stop project-control-verify.timer       2>/dev/null || true
systemctl stop project-control-stack.service      2>/dev/null || true
systemctl stop project-control-runner.service     2>/dev/null || true

systemctl disable project-control-backup.timer       2>/dev/null || true
systemctl disable project-control-check.timer        2>/dev/null || true
systemctl disable project-control-restore-test.timer 2>/dev/null || true
systemctl disable project-control-verify.timer       2>/dev/null || true
systemctl disable project-control-stack.service      2>/dev/null || true
systemctl disable project-control-runner.service     2>/dev/null || true
log_ok "services stopped and disabled"

# =============================================================================
log_step "2/5  Removing containers and networks"
# =============================================================================
if [[ -f "${PC_ROOT}/compose/compose.yaml" ]]; then
  # `down` without -v: named volumes would be removed, but this stack has none,
  # and every bind mount is left completely untouched.
  compose down --remove-orphans --timeout 60 2>/dev/null || true
fi

# Belt and braces, strictly scoped by the project label.
while IFS= read -r cid; do
  [[ -n "$cid" ]] || continue
  docker rm -f "$cid" >/dev/null 2>&1 || true
done < <(docker ps -aq --filter "label=com.docker.compose.project=${PC_COMPOSE_PROJECT}" 2>/dev/null)

for network in "${PC_COMPOSE_PROJECT}_edge" "${PC_COMPOSE_PROJECT}_application" "${PC_COMPOSE_PROJECT}_data"; do
  docker network rm "$network" >/dev/null 2>&1 || true
done
log_ok "containers and networks removed"

# =============================================================================
log_step "3/5  Removing systemd units"
# =============================================================================
for unit in project-control-runner.service project-control-stack.service \
            project-control-backup.service project-control-backup.timer \
            project-control-check.service project-control-check.timer \
            project-control-restore-test.service project-control-restore-test.timer \
            project-control-verify.service project-control-verify.timer; do
  rm -f "/etc/systemd/system/${unit}"
done
rm -rf /etc/systemd/system/project-control-runner.service.d
systemctl daemon-reload
systemctl reset-failed 2>/dev/null || true
log_ok "systemd units removed"

# =============================================================================
log_step "4/5  Tailscale Serve"
# =============================================================================
if have tailscale; then
  # Only the two mappings this deployment created are withdrawn. Any other Serve
  # configuration on this host is left alone.
  tailscale serve --https=443  off 2>/dev/null || true
  tailscale serve --https=8443 off 2>/dev/null || true
  log_ok "Tailscale Serve mappings for 443 and 8443 withdrawn"
  log_info "the host remains connected to the tailnet (run 'tailscale down' yourself if you want that removed)"
fi

# =============================================================================
log_step "5/5  Filesystem"
# =============================================================================
if (( DELETE_DATA )); then
  # Shred secrets rather than merely unlinking them.
  if [[ -d "$PC_SECRETS_DIR" ]]; then
    find "$PC_SECRETS_DIR" -type f -exec shred -u {} \; 2>/dev/null || true
    log_ok "secret files shredded"
  fi

  # Guard against a catastrophic PC_ROOT.
  case "$PC_ROOT" in
    /|/usr|/etc|/var|/home|/root|/srv|"") die "refusing to delete PC_ROOT=${PC_ROOT}" ;;
  esac

  rm -rf "${PC_ROOT:?}"
  log_ok "deployment root removed: ${PC_ROOT}"

  if (( REMOVE_IMAGES )); then
    docker image rm -f "${PC_CONTROL_API_IMAGE}" "${PC_WEB_IMAGE}" >/dev/null 2>&1 || true
    log_ok "locally built images removed"
    log_info "pinned third-party images were kept (they may be shared with other projects)"
  fi

  # Remove the accounts this installation created.
  if id -u "${PC_RUNNER_USER}" >/dev/null 2>&1; then
    userdel "${PC_RUNNER_USER}" 2>/dev/null || true
    log_ok "user ${PC_RUNNER_USER} removed"
  fi
  if getent group project-control >/dev/null 2>&1; then
    groupdel project-control 2>/dev/null || true
    log_ok "group project-control removed"
  fi
else
  log_ok "deployment root PRESERVED: ${PC_ROOT}"
  log_info "  databases  : ${PC_ROOT}/data/postgres"
  log_info "  artifacts  : ${PC_ROOT}/data/artifacts (${artifact_count} object(s))"
  log_info "  n8n data   : ${PC_ROOT}/data/n8n"
  log_info "  secrets    : ${PC_ROOT}/secrets"
  log_info "reinstall over it at any time with: sudo ./pcctl install"
fi

# =============================================================================
cat >&2 <<DONE

$(printf '═%.0s' {1..70})
  Uninstall complete
$(printf '═%.0s' {1..70})

  Data deleted : $( (( DELETE_DATA )) && echo "YES — permanently" || echo "no — preserved at ${PC_ROOT}")

  Untouched:
    * every other Docker container, image, volume and network on this host
    * the Docker daemon configuration
    * the Tailscale tailnet membership

$(printf '═%.0s' {1..70})

DONE
