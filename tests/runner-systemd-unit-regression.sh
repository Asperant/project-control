#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
UNIT="${REPO_ROOT}/infra/systemd/project-control-runner.service"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$UNIT" ]] || fail "unit file not found: $UNIT"

# StartLimitIntervalSec/StartLimitBurst must live in [Unit]. Systemd silently
# ignores them in [Service] on the versions this project targets, which
# defeats the crash-loop backoff the operator relies on.
unit_section="$(awk '/^\[Unit\]/{f=1;next}/^\[/{f=0}f' "$UNIT")"
service_section="$(awk '/^\[Service\]/{f=1;next}/^\[/{f=0}f' "$UNIT")"

echo "$unit_section" | grep -qE '^StartLimitIntervalSec=' \
  || fail "StartLimitIntervalSec is missing from [Unit]"
echo "$unit_section" | grep -qE '^StartLimitBurst=' \
  || fail "StartLimitBurst is missing from [Unit]"
echo "$service_section" | grep -qE '^StartLimit' \
  && fail "StartLimit* directive found in [Service]; it belongs in [Unit]"

# The runner's own identity must carry the controlling group so the socket
# gets the right group ownership for free at creation time.
echo "$service_section" | grep -qE '^Group=project-control$' \
  || fail "Group=project-control is missing from [Service]"

# No capability may be added — CAP_CHOWN in particular must never come back,
# since the runner is required to verify socket group ownership rather than
# chown it.
caps_line="$(echo "$service_section" | grep -E '^CapabilityBoundingSet=' || true)"
[[ -n "$caps_line" ]] || fail "CapabilityBoundingSet= is missing from [Service]"
[[ "$caps_line" == "CapabilityBoundingSet=" ]] \
  || fail "CapabilityBoundingSet grants capabilities: ${caps_line}"
echo "$service_section" | grep -qE '^AmbientCapabilities=$' \
  || fail "AmbientCapabilities is not empty"

# A restrictive process umask closes the window between socket creation and
# the explicit chmod(0660) in code.
echo "$service_section" | grep -qE '^UMask=[0-7]{3,4}$' \
  || fail "UMask is missing from [Service]"

# RuntimeDirectory keeps the low-privilege /run/project-control ownership model.
echo "$service_section" | grep -qE '^RuntimeDirectory=project-control$' \
  || fail "RuntimeDirectory=project-control is missing from [Service]"

if command -v systemd-analyze >/dev/null 2>&1; then
  # This host will not have project-runner/project-control users or the
  # /srv/project-control tree, so a failure here is only ever informational.
  systemd-analyze verify "$UNIT" 2>&1 | tee /dev/stderr \
    | grep -qE 'Failed to add path|No such file or directory|Unknown user|Unknown group' \
    && printf 'NOTE: systemd-analyze verify reported host-specific misses above; expected outside a real deployment\n' >&2
fi

printf 'PASS: runner systemd unit regression suite\n'
