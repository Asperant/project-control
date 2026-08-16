#!/usr/bin/env bash
# =============================================================================
# repo-writes.sh — enable-repo-writes / disable-repo-writes
#
# Opts one project's .git directory into project.git.commit (Repository
# Actions). Every other project's confinement is unaffected: the shipped
# default is an empty write-enabled list, and this script is the only way
# that list ever grows — never the web panel, never the Control API. See
# docs/repository-actions.md and docs/security-model.md.
#
# What "enable" actually changes, in order:
#   1. Validates the target is a real, existing directory under a configured
#      allowed root, and a plain (non-worktree, non-submodule) git repository.
#   2. Adds its canonical path to config/write-enabled-projects.conf.
#   3. Grants project-runner rwX on <project>/.git via POSIX ACL — the
#      runner's own filesystem uid otherwise has no access to it at all, since
#      every registered project is owned by the desktop user, not the runner.
#   4. Regenerates the write-enabled systemd drop-in (BindPaths=, .git only —
#      never the project directory itself) and restarts the runner.
#   5. Verifies, from the kernel's own view of the runner's live mount
#      namespace, that .git is writable and the working tree is still not.
#
# "disable" reverses steps 2-4 and removes the ACL grant.
# =============================================================================
set -Eeuo pipefail

# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MODE="${1:-}"; shift || true
TARGET="${1:-}"

[[ "$MODE" == "enable" || "$MODE" == "disable" ]] || die "internal error: repo-writes.sh requires enable|disable"
is_root || die "${MODE}-repo-writes modifies the host; run: sudo ./pcctl ${MODE}-repo-writes <path>"
[[ -n "$TARGET" ]] || die "usage: sudo ./pcctl ${MODE}-repo-writes <absolute project path>"
have setfacl || die "setfacl is required (package: acl); install it and retry"
have getfacl || die "getfacl is required (package: acl); install it and retry"

load_versions
load_stack_env

ALLOWED_ROOTS_FILE="${PC_ROOT}/config/allowed-project-roots.conf"
WRITE_ENABLED_FILE="${PC_ROOT}/config/write-enabled-projects.conf"
WRITE_DROPIN_DIR="/etc/systemd/system/project-control-runner.service.d"
WRITE_DROPIN_FILE="${WRITE_DROPIN_DIR}/20-write-enabled-projects.conf"
RUNNER_USER="${PC_RUNNER_USER:-project-runner}"

[[ -f "$ALLOWED_ROOTS_FILE" ]] || die "no allowed project roots are configured; run: sudo ./pcctl install"

# --- Resolve and validate the target -----------------------------------------
[[ "$TARGET" == /* ]] || die "path must be absolute: ${TARGET}"
[[ -d "$TARGET" ]] || die "not a directory: ${TARGET}"
CANONICAL="$(readlink -f -- "$TARGET")" || die "cannot resolve ${TARGET}"

mapfile -t ALLOWED_ROOTS < <(grep -vE '^[[:space:]]*(#|$)' "$ALLOWED_ROOTS_FILE" 2>/dev/null || true)
under_allowed_root=0
for root in "${ALLOWED_ROOTS[@]}"; do
  [[ "$CANONICAL" == "${root}"/* ]] && { under_allowed_root=1; break; }
done
(( under_allowed_root )) || die "${CANONICAL} is not under a configured allowed project root (see ${ALLOWED_ROOTS_FILE})"

for root in "${ALLOWED_ROOTS[@]}"; do
  [[ "$CANONICAL" == "$root" ]] && die "the allowed root itself cannot be write-enabled"
done

GIT_DIR="${CANONICAL}/.git"
[[ -d "$GIT_DIR" ]] || die "${CANONICAL} does not have a plain .git directory (worktrees and submodules are not supported)"

id -u "$RUNNER_USER" >/dev/null 2>&1 || die "runner user ${RUNNER_USER} does not exist; run: sudo ./pcctl install"

# --- Load current list, add/remove target, write back ------------------------
mkdir -p "$(dirname -- "$WRITE_ENABLED_FILE")"
mapfile -t CURRENT < <([[ -f "$WRITE_ENABLED_FILE" ]] && grep -vE '^[[:space:]]*(#|$)' "$WRITE_ENABLED_FILE" || true)

NEW=()
already_present=0
for entry in "${CURRENT[@]+"${CURRENT[@]}"}"; do
  if [[ "$entry" == "$CANONICAL" ]]; then
    already_present=1
    [[ "$MODE" == "enable" ]] && NEW+=("$entry")
    continue
  fi
  NEW+=("$entry")
done
if [[ "$MODE" == "enable" && "$already_present" -eq 0 ]]; then
  NEW+=("$CANONICAL")
fi
if [[ "$MODE" == "disable" && "$already_present" -eq 0 ]]; then
  log_warn "${CANONICAL} was not write-enabled; nothing to disable"
fi

if [[ "$MODE" == "enable" ]]; then
  confirm "About to grant project.git.commit write access to ${CANONICAL}" \
    || die "aborted"
fi

tmp_list="$(mktemp)"
{
  printf '# Write-enabled project directories — one absolute path per line.\n'
  printf '# Root-owned (0644). Managed only by:\n'
  printf '#   sudo ./pcctl enable-repo-writes <path>\n'
  printf '#   sudo ./pcctl disable-repo-writes <path>\n'
  printf '# Never edit directly: this file must stay in sync with the ACL grants\n'
  printf '# and the systemd drop-in this script also manages.\n'
  for entry in "${NEW[@]+"${NEW[@]}"}"; do printf '%s\n' "$entry"; done
} >"$tmp_list"
install -m 0644 -o root -g root "$tmp_list" "$WRITE_ENABLED_FILE"
rm -f "$tmp_list"
log_ok "updated ${WRITE_ENABLED_FILE} (${#NEW[@]} project(s))"

# --- ACL: grant or revoke project-runner access to .git only -----------------
# Default ACL entries (-d) apply to every new file/directory .git gains after
# this point (new objects, new refs, a rewritten index) — without them, the
# grant would silently stop covering the repository the moment git creates
# anything not present at the time setfacl ran.
if [[ "$MODE" == "enable" ]]; then
  setfacl -R -m "u:${RUNNER_USER}:rwX" -m "d:u:${RUNNER_USER}:rwX" -- "$GIT_DIR"
  log_ok "granted ${RUNNER_USER} rwX on ${GIT_DIR} (recursive, with default ACL)"
else
  setfacl -R -x "u:${RUNNER_USER}" -x "d:u:${RUNNER_USER}" -- "$GIT_DIR" 2>/dev/null || true
  log_ok "revoked ${RUNNER_USER}'s ACL grant on ${GIT_DIR}"
fi

# --- Regenerate the write-enabled systemd drop-in -----------------------------
mkdir -p "$WRITE_DROPIN_DIR"
chmod 0755 "$WRITE_DROPIN_DIR"

tmp_dropin="$(mktemp)"
{
  printf '# Generated by repo-writes.sh from %s\n' "$WRITE_ENABLED_FILE"
  printf '# Do not edit directly — use: sudo ./pcctl enable-repo-writes|disable-repo-writes <path>\n'
  printf '[Service]\n'
  for entry in "${NEW[@]+"${NEW[@]}"}"; do
    printf 'BindPaths=-%s/.git\n' "$entry"
  done
} >"$tmp_dropin"

dropin_changed=0
if (( ${#NEW[@]} == 0 )); then
  if [[ -f "$WRITE_DROPIN_FILE" ]]; then
    rm -f "$WRITE_DROPIN_FILE"
    dropin_changed=1
    log_ok "removed ${WRITE_DROPIN_FILE} (no write-enabled projects remain)"
  fi
  rm -f "$tmp_dropin"
elif [[ -f "$WRITE_DROPIN_FILE" ]] && cmp -s "$tmp_dropin" "$WRITE_DROPIN_FILE"; then
  rm -f "$tmp_dropin"
  log_debug "write-enabled drop-in unchanged"
else
  install -m 0644 -o root -g root "$tmp_dropin" "$WRITE_DROPIN_FILE"
  rm -f "$tmp_dropin"
  dropin_changed=1
  log_ok "installed ${WRITE_DROPIN_FILE} (${#NEW[@]} project(s))"
fi

# --- Apply: reload and restart the runner -------------------------------------
if (( dropin_changed )); then
  systemctl daemon-reload
  if systemctl is-active --quiet project-control-runner.service; then
    systemctl restart project-control-runner.service
    wait_for_runner_ready || die "runner failed readiness after applying write-enabled configuration"
    log_ok "restarted project-control-runner.service"
  fi
else
  log_debug "no drop-in change; runner restart not required"
fi

# --- Verify: the mount actually took effect in the runner's own namespace ----
if [[ "$MODE" == "enable" ]] && have nsenter; then
  runner_pid="$(systemctl show -p MainPID --value project-control-runner.service 2>/dev/null || echo 0)"
  if [[ "$runner_pid" =~ ^[0-9]+$ ]] && (( runner_pid > 0 )) && [[ -r "/proc/${runner_pid}/ns/mnt" ]]; then
    probe="${GIT_DIR}/.pcctl-enable-verify"
    if nsenter -t "$runner_pid" -m -- sh -c "printf x > '${probe}' && rm -f '${probe}'" >/dev/null 2>&1; then
      log_ok "verified: the runner can write ${GIT_DIR} in its live mount namespace"
    else
      rm -f "$probe" 2>/dev/null || true
      log_warn "could not verify runner write access to ${GIT_DIR}; check: sudo ./pcctl verify-security"
    fi
    tree_probe="${CANONICAL}/.pcctl-enable-verify"
    if nsenter -t "$runner_pid" -m -- sh -c "printf x > '${tree_probe}'" >/dev/null 2>&1; then
      rm -f "$tree_probe" 2>/dev/null || true
      log_error "the runner can ALSO write the working tree of ${CANONICAL} — this must never happen; run: sudo ./pcctl verify-security"
    else
      log_ok "verified: the runner still cannot write the working tree of ${CANONICAL}"
    fi
  else
    log_warn "runner not running; write access could not be verified live — it will apply the next time it starts"
  fi
fi

if [[ "$MODE" == "enable" ]]; then
  log_ok "${CANONICAL} is now write-enabled for Repository Actions commits"
else
  log_ok "${CANONICAL} is no longer write-enabled"
fi
log_info "run 'sudo ./pcctl verify-security' to confirm the full security posture"
