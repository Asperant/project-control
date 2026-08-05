#!/usr/bin/env bash
# =============================================================================
# preflight.sh — read-only host inspection.
#
# Makes NO changes to the host. Collects everything `install.sh` depends on and
# writes a Markdown report to reports/stage1-preflight.md.
#
# Exit codes:
#   0  safe to install
#   1  blocking condition found (port conflict, missing dependency, ...)
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

REPORT="${PC_REPO_ROOT}/reports/stage1-preflight.md"
JSON_OUT=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON_OUT=1 ;;
    --report=*) REPORT="${arg#--report=}" ;;
    *) die "unknown argument: $arg" ;;
  esac
done

mkdir -p "$(dirname -- "$REPORT")"

# Ports that this stack binds on the loopback interface.
PC_REQUIRED_PORTS=(443 8443 5678 8780)

# Collected free-form sections for the Markdown report.
declare -a SECTIONS=()
section() { SECTIONS+=("$1"); }

fence() { printf '```%s\n%s\n```\n' "${2:-text}" "$1"; }

# -----------------------------------------------------------------------------
log_step "Operating system and architecture"
# -----------------------------------------------------------------------------
OS_PRETTY="$(. /etc/os-release 2>/dev/null && printf '%s' "${PRETTY_NAME:-unknown}")"
OS_ID="$(. /etc/os-release 2>/dev/null && printf '%s' "${ID:-unknown}")"
OS_VER="$(. /etc/os-release 2>/dev/null && printf '%s' "${VERSION_ID:-unknown}")"
ARCH="$(uname -m)"
KERNEL="$(uname -r)"

if [[ "$OS_ID" == "ubuntu" && "$OS_VER" == "22.04" ]]; then
  record_check PASS OS-001 "Ubuntu 22.04 detected" "$OS_PRETTY"
elif [[ "$OS_ID" == "ubuntu" ]]; then
  record_check WARN OS-001 "Ubuntu detected but not 22.04" "$OS_PRETTY"
else
  record_check WARN OS-001 "Non-Ubuntu host" "$OS_PRETTY — scripts are only validated on Ubuntu 22.04"
fi

if [[ "$ARCH" == "x86_64" ]]; then
  record_check PASS OS-002 "Architecture is x86_64/amd64" "$ARCH"
else
  record_check FAIL OS-002 "Unsupported architecture" "$ARCH — pinned image digests are linux/amd64"
fi

INIT_SYSTEM="$(ps -p 1 -o comm= 2>/dev/null || echo unknown)"
if [[ "$INIT_SYSTEM" == "systemd" ]]; then
  record_check PASS OS-003 "systemd is PID 1" "$(systemctl --version | head -1)"
else
  record_check FAIL OS-003 "systemd is not PID 1" "found: $INIT_SYSTEM — runner and timers require systemd"
fi

CGROUP_FS="$(stat -fc %T /sys/fs/cgroup 2>/dev/null || echo unknown)"
if [[ "$CGROUP_FS" == "cgroup2fs" ]]; then
  record_check PASS OS-004 "cgroup v2 unified hierarchy active" "$CGROUP_FS"
else
  record_check WARN OS-004 "cgroup v2 not detected" "$CGROUP_FS — container CPU/memory limits may be partially enforced"
fi

section "## Operating system

| Property | Value |
| --- | --- |
| Distribution | \`${OS_PRETTY}\` |
| Version ID | \`${OS_VER}\` |
| Kernel | \`${KERNEL}\` |
| Architecture | \`${ARCH}\` |
| Init system | \`${INIT_SYSTEM}\` |
| cgroup filesystem | \`${CGROUP_FS}\` |
"

# -----------------------------------------------------------------------------
log_step "Docker Engine and Compose"
# -----------------------------------------------------------------------------
DOCKER_VER="unavailable"; COMPOSE_VER="unavailable"; DOCKER_ROOTLESS="unknown"; DOCKER_STORAGE="unknown"
if have docker; then
  DOCKER_VER="$(docker --version 2>/dev/null || echo unavailable)"
  if docker info >/dev/null 2>&1; then
    record_check PASS DOC-001 "Docker daemon reachable" "$DOCKER_VER"
    DOCKER_STORAGE="$(docker info --format '{{.Driver}}' 2>/dev/null || echo unknown)"
    if docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q 'rootless'; then
      DOCKER_ROOTLESS="yes"
    else
      DOCKER_ROOTLESS="no"
    fi
  else
    record_check FAIL DOC-001 "Docker daemon not reachable" "is the service running and is the user in the docker group?"
  fi
  if docker compose version >/dev/null 2>&1; then
    COMPOSE_VER="$(docker compose version --short 2>/dev/null || docker compose version 2>/dev/null | head -1)"
    record_check PASS DOC-002 "Docker Compose v2 plugin present" "$COMPOSE_VER"
  else
    record_check FAIL DOC-002 "Docker Compose v2 plugin missing" "install docker-compose-plugin"
  fi
else
  record_check FAIL DOC-001 "Docker not installed" "install Docker Engine before proceeding"
  record_check FAIL DOC-002 "Docker Compose not installed" ""
fi

EXISTING_CONTAINERS="$(docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || echo '(unavailable)')"
EXISTING_NETWORKS="$(docker network ls --format '{{.Name}}\t{{.Driver}}' 2>/dev/null || echo '(unavailable)')"
EXISTING_VOLUMES="$(docker volume ls --format '{{.Name}}' 2>/dev/null || echo '(unavailable)')"
EXISTING_PROJECTS="$(docker compose ls -a --format table 2>/dev/null || echo '(unavailable)')"
CONTAINER_COUNT="$(docker ps -aq 2>/dev/null | wc -l | tr -d ' ')"
VOLUME_COUNT="$(docker volume ls -q 2>/dev/null | wc -l | tr -d ' ')"

# Guard: refuse to proceed if a foreign stack already owns our compose project name.
if docker ps -aq --filter "label=com.docker.compose.project=${PC_COMPOSE_PROJECT}" 2>/dev/null | grep -q .; then
  record_check WARN DOC-003 "Compose project '${PC_COMPOSE_PROJECT}' already has containers" "install will reconcile them in place, not delete them"
else
  record_check PASS DOC-003 "Compose project name '${PC_COMPOSE_PROJECT}' is free" ""
fi

for net in edge application data; do
  full="${PC_COMPOSE_PROJECT}_${net}"
  if docker network inspect "$full" >/dev/null 2>&1; then
    record_check WARN DOC-004 "Network ${full} already exists" "will be reused"
  fi
done
record_check PASS DOC-005 "Existing Docker resources inventoried and preserved" \
  "${CONTAINER_COUNT} container(s), ${VOLUME_COUNT} volume(s) left untouched"

section "## Docker

| Property | Value |
| --- | --- |
| Engine | \`${DOCKER_VER}\` |
| Compose | \`${COMPOSE_VER}\` |
| Storage driver | \`${DOCKER_STORAGE}\` |
| Rootless mode | \`${DOCKER_ROOTLESS}\` |
| Containers present | ${CONTAINER_COUNT} |
| Volumes present | ${VOLUME_COUNT} |

### Existing containers (preserved)

$(fence "$EXISTING_CONTAINERS")

### Existing networks (preserved)

$(fence "$EXISTING_NETWORKS")

### Existing volumes (preserved)

$(fence "$EXISTING_VOLUMES")

### Existing Compose projects (preserved)

$(fence "$EXISTING_PROJECTS")
"

# -----------------------------------------------------------------------------
log_step "Port availability"
# -----------------------------------------------------------------------------
PORT_TABLE=""
PORT_CONFLICT=0
LISTENERS="$(ss -tulpnH 2>/dev/null || ss -tulpn 2>/dev/null || echo '')"
for port in "${PC_REQUIRED_PORTS[@]}"; do
  # Match ":<port> " at the end of a Local Address:Port field only.
  hit="$(printf '%s\n' "$LISTENERS" | awk -v p=":${port}" '$5 ~ (p "$") {print}' || true)"
  if [[ -n "$hit" ]]; then
    PORT_CONFLICT=1
    owner="$(printf '%s' "$hit" | grep -oP 'users:\(\("\K[^"]+' | head -1 || echo 'unknown')"
    PORT_TABLE+="| ${port} | **OCCUPIED** | \`${owner}\` |"$'\n'
    record_check FAIL NET-001 "Port ${port} is already in use" "owner: ${owner} — install aborts; free the port manually"
  else
    PORT_TABLE+="| ${port} | free | — |"$'\n'
    record_check PASS NET-001 "Port ${port} is free" ""
  fi
done

section "## Required ports

The stack binds only to the loopback interface; Tailscale Serve terminates TLS
on the tailnet interface. No port is published to a public interface.

| Port | Status | Current owner |
| --- | --- | --- |
${PORT_TABLE}
### All current listeners

$(fence "$(ss -tulpn 2>/dev/null || echo '(ss unavailable)')")
"

# -----------------------------------------------------------------------------
log_step "Tailscale"
# -----------------------------------------------------------------------------
TS_INSTALLED="no"; TS_VERSION="—"; TS_STATE="—"; TS_HOSTNAME="—"; TS_DNSNAME="—"; TS_HTTPS="unknown"
if have tailscale; then
  TS_INSTALLED="yes"
  TS_VERSION="$(tailscale version 2>/dev/null | head -1 || echo unknown)"
  record_check PASS TS-001 "Tailscale CLI installed" "$TS_VERSION"
  if TS_JSON="$(tailscale status --json 2>/dev/null)"; then
    TS_STATE="$(printf '%s' "$TS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("BackendState","unknown"))' 2>/dev/null || echo unknown)"
    TS_DNSNAME="$(printf '%s' "$TS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || echo '')"
    TS_HOSTNAME="$(printf '%s' "$TS_JSON" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Self",{}).get("HostName",""))' 2>/dev/null || echo '')"
    if [[ "$TS_STATE" == "Running" ]]; then
      record_check PASS TS-002 "Tailscale is connected" "state=${TS_STATE} host=${TS_DNSNAME:-unknown}"
    else
      record_check WARN TS-002 "Tailscale not connected" "state=${TS_STATE} — manual checkpoint 1 required"
    fi
    if [[ -n "$TS_DNSNAME" && "$TS_DNSNAME" == *.ts.net ]]; then
      TS_HTTPS="MagicDNS name present"
      record_check PASS TS-003 "MagicDNS name available" "$TS_DNSNAME"
    else
      TS_HTTPS="no MagicDNS name"
      record_check WARN TS-003 "No MagicDNS name yet" "enable MagicDNS + HTTPS certificates in the tailnet admin console"
    fi
  else
    record_check WARN TS-002 "tailscale status unavailable" "daemon not running or permission denied — manual checkpoint 1 required"
  fi
else
  record_check FAIL TS-001 "Tailscale is not installed" "required for the only supported access path; see docs/manual-checkpoints.md"
fi

section "## Tailscale

| Property | Value |
| --- | --- |
| CLI installed | \`${TS_INSTALLED}\` |
| Version | \`${TS_VERSION}\` |
| Backend state | \`${TS_STATE}\` |
| Host name | \`${TS_HOSTNAME}\` |
| MagicDNS name | \`${TS_DNSNAME}\` |
| HTTPS readiness | \`${TS_HTTPS}\` |
"

# -----------------------------------------------------------------------------
log_step "Host toolchain"
# -----------------------------------------------------------------------------
TOOL_TABLE=""
check_tool() {
  local cmd="$1" label="$2" required="$3" ver="—" status
  if have "$cmd"; then
    ver="$($cmd --version 2>&1 | head -1 || echo present)"
    status="present"
    record_check PASS TOOL-"$label" "${cmd} available" "$ver"
  else
    status="**MISSING**"
    if [[ "$required" == "required" ]]; then
      record_check FAIL TOOL-"$label" "${cmd} is missing" "required — see docs/installation.md"
    else
      record_check WARN TOOL-"$label" "${cmd} is missing" "${required}"
    fi
  fi
  TOOL_TABLE+="| \`${cmd}\` | ${required} | ${status} | \`${ver}\` |"$'\n'
}
check_tool git      001 required
check_tool node     002 "development/test only; install builds with pinned Node inside Docker"
check_tool pnpm     003 "development/test only; install uses pinned pnpm inside Docker"
check_tool openssl  004 required
check_tool curl     005 required
check_tool python3  006 required
check_tool go       007 optional
check_tool restic   008 optional
check_tool rclone   009 optional
check_tool shellcheck 010 optional
check_tool flock    011 required

section "## Host toolchain

| Command | Requirement | Status | Version |
| --- | --- | --- | --- |
${TOOL_TABLE}"

# -----------------------------------------------------------------------------
log_step "Resources"
# -----------------------------------------------------------------------------
DISK_AVAIL_KB="$(df -Pk /srv 2>/dev/null | awk 'NR==2{print $4}' || df -Pk / | awk 'NR==2{print $4}')"
DISK_AVAIL_GB=$(( DISK_AVAIL_KB / 1024 / 1024 ))
MEM_TOTAL_MB="$(awk '/MemTotal/{print int($2/1024)}' /proc/meminfo)"
CPU_THREADS="$(nproc)"

if (( DISK_AVAIL_GB >= 20 )); then
  record_check PASS RES-001 "Sufficient free disk space" "${DISK_AVAIL_GB} GiB available on /srv"
else
  record_check FAIL RES-001 "Insufficient free disk space" "${DISK_AVAIL_GB} GiB available, 20 GiB minimum"
fi
if (( MEM_TOTAL_MB >= 4096 )); then
  record_check PASS RES-002 "Sufficient RAM" "${MEM_TOTAL_MB} MiB"
else
  record_check WARN RES-002 "Low RAM" "${MEM_TOTAL_MB} MiB — container limits assume >= 4 GiB"
fi

section "## Resources

| Property | Value |
| --- | --- |
| CPU threads | ${CPU_THREADS} |
| Total RAM | ${MEM_TOTAL_MB} MiB |
| Free disk (/srv) | ${DISK_AVAIL_GB} GiB |

$(fence "$(free -h 2>/dev/null || echo '(free unavailable)')")

$(fence "$(df -h / /srv 2>/dev/null || true)")
"

# -----------------------------------------------------------------------------
log_step "Deployment root"
# -----------------------------------------------------------------------------
SRV_STATE="absent"
if [[ -e "$PC_ROOT" ]]; then
  SRV_STATE="$(stat -c 'exists mode=%a owner=%U:%G' "$PC_ROOT")"
  if [[ -d "$PC_ROOT" ]]; then
    entries="$(find "$PC_ROOT" -mindepth 1 -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')"
    record_check WARN FS-001 "${PC_ROOT} already exists" "${entries} entry/entries — install is idempotent and will not delete data"
  else
    record_check FAIL FS-001 "${PC_ROOT} exists but is not a directory" "$SRV_STATE"
  fi
else
  record_check PASS FS-001 "${PC_ROOT} does not exist yet" "will be created by install"
fi

if [[ -w "$(dirname -- "$PC_ROOT")" ]] || is_root; then
  record_check PASS FS-002 "Parent of deployment root is writable" "$(dirname -- "$PC_ROOT")"
else
  if can_sudo_noninteractive; then
    record_check PASS FS-002 "Parent of deployment root writable via sudo" "$(dirname -- "$PC_ROOT")"
  else
    record_check FAIL FS-002 "Cannot write to $(dirname -- "$PC_ROOT")" "install must be run as root (sudo ./pcctl install)"
  fi
fi

# Privilege availability — install/uninstall/systemd all require root.
if is_root; then
  record_check PASS PRIV-001 "Running as root" ""
elif can_sudo_noninteractive; then
  record_check PASS PRIV-001 "Passwordless sudo available" ""
else
  record_check FAIL PRIV-001 "Root privileges unavailable non-interactively" \
    "sudo requires a password; run 'sudo ./pcctl install' from an interactive terminal"
fi

section "## Deployment root

| Property | Value |
| --- | --- |
| Path | \`${PC_ROOT}\` |
| State | \`${SRV_STATE}\` |
| Effective user | \`$(id -un) (uid $(id -u))\` |
| Root available non-interactively | \`$(can_sudo_noninteractive && echo yes || echo no)\` |
"

# -----------------------------------------------------------------------------
log_step "Firewall"
# -----------------------------------------------------------------------------
FW_STATE="none detected"
if have ufw; then
  if ufw_out="$(ufw status 2>/dev/null)"; then
    FW_STATE="ufw: $(printf '%s' "$ufw_out" | head -1)"
  elif can_sudo_noninteractive && ufw_out="$(sudo -n ufw status 2>/dev/null)"; then
    FW_STATE="ufw: $(printf '%s' "$ufw_out" | head -1)"
  else
    FW_STATE="ufw present (status requires root)"
  fi
  record_check PASS FW-001 "Firewall inspected" "$FW_STATE"
elif have firewall-cmd; then
  FW_STATE="firewalld: $(firewall-cmd --state 2>/dev/null || echo 'requires root')"
  record_check PASS FW-001 "Firewall inspected" "$FW_STATE"
else
  record_check PASS FW-001 "No host firewall manager detected" "stack binds loopback only, so no rules are required"
fi
record_check PASS FW-002 "No firewall changes required" "no port is exposed on a public interface"

section "## Firewall

| Property | Value |
| --- | --- |
| Detected | \`${FW_STATE}\` |
| Changes required | none — the stack publishes only on \`127.0.0.1\` |
"

# -----------------------------------------------------------------------------
log_step "Git repository"
# -----------------------------------------------------------------------------
GIT_STATE="not a git repository"
if git -C "$PC_REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  GIT_BRANCH="$(git -C "$PC_REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(no commits)')"
  GIT_DIRTY="$(git -C "$PC_REPO_ROOT" status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
  GIT_HEAD="$(git -C "$PC_REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo '(none)')"
  GIT_STATE="branch=${GIT_BRANCH} head=${GIT_HEAD} changed_files=${GIT_DIRTY}"
  record_check PASS GIT-001 "Git repository detected" "$GIT_STATE"
else
  record_check WARN GIT-001 "Not a git repository" "version tracking and secret scanning are degraded"
fi

section "## Git repository

| Property | Value |
| --- | --- |
| Path | \`${PC_REPO_ROOT}\` |
| State | \`${GIT_STATE}\` |
"

# -----------------------------------------------------------------------------
# Emit
# -----------------------------------------------------------------------------
print_check_summary

if (( JSON_OUT )); then
  emit_checks_json
fi

{
  printf '# Stage 1 — Preflight Report\n\n'
  printf '> Generated by `scripts/preflight.sh` at `%s`.\n' "$(_pc_ts)"
  printf '> This script is strictly read-only: it made **no** changes to the host.\n\n'
  printf '## Result\n\n'
  printf '| Outcome | Count |\n| --- | --- |\n'
  printf '| Pass | %d |\n| Fail | %d |\n| Warn | %d |\n| Skipped | %d |\n\n' \
    "$PC_CHECK_PASS" "$PC_CHECK_FAIL" "$PC_CHECK_WARN" "$PC_CHECK_SKIP"
  if (( PC_CHECK_FAIL > 0 )); then
    printf '**Verdict: BLOCKED.** Resolve every failing check below before running `./pcctl install`.\n\n'
  else
    printf '**Verdict: READY.** No blocking condition detected.\n\n'
  fi

  printf '## Checks\n\n'
  printf '| Status | ID | Check | Detail |\n| --- | --- | --- | --- |\n'
  for row in "${PC_CHECK_ROWS[@]+"${PC_CHECK_ROWS[@]}"}"; do
    IFS='|' read -r status id desc detail <<<"$row"
    printf '| %s | `%s` | %s | %s |\n' "$status" "$id" "$desc" "${detail:-—}"
  done
  printf '\n'

  for s in "${SECTIONS[@]}"; do printf '%s\n' "$s"; done

  printf '## Guarantees\n\n'
  printf -- '- No existing container, image, volume, network or Compose project was modified or removed.\n'
  printf -- '- No package was installed and no Docker daemon setting was changed.\n'
  printf -- '- No port was opened on a public interface.\n'
  printf -- '- Port conflicts are reported, never auto-resolved by picking a different port.\n'
} >"$REPORT"

log_info "report written to ${REPORT}"

if (( PC_CHECK_FAIL > 0 )); then
  log_error "preflight FAILED with ${PC_CHECK_FAIL} blocking issue(s); install must not proceed"
  exit 1
fi
log_ok "preflight passed"
exit 0
