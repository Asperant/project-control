#!/usr/bin/env bash
# =============================================================================
# preflight.sh — read-only host inspection.
#
# Makes NO changes to the host. Collects everything `install.sh` depends on and
# writes a Markdown report to reports/preflight-report.md.
#
# Exit codes:
#   0  safe to install
#   1  blocking condition found (port conflict, missing dependency, ...)
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

REPORT="${PC_REPO_ROOT}/reports/preflight-report.md"
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

# 443/8443 are not bound by this stack directly — they are published by
# Tailscale Serve (see scripts/configure-tailscale.sh), which forwards them to
# the loopback ports below. On an idempotent reinstall/update, tailscaled
# already legitimately holds both ports, so occupation alone must not FAIL;
# the actual Serve configuration is checked instead (see
# tailscale_serve_route_status below).
declare -A PC_TAILSCALE_SERVE_EXPECTED=(
  [443]="http://127.0.0.1:8780"
  [8443]="http://127.0.0.1:5678"
)

# 5678/8780 are the loopback ports this stack's own Compose services publish
# directly (infra/compose/compose.yaml: caddy -> 127.0.0.1:8780:8780, n8n ->
# 127.0.0.1:5678:5678). On an idempotent reinstall/update these are already
# held by this deployment's own containers, so occupation alone must not
# FAIL; Docker's own structured metadata is checked instead (see
# compose_port_ownership_status below) — never the process name reported by
# `ss`, which is frequently "docker-proxy" for every container on the host,
# or unresolvable at all without root.
declare -A PC_COMPOSE_EXPECTED_SERVICE=(
  [5678]="n8n"
  [8780]="caddy"
)

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

# tailscale_serve_route_status <port> <expected target, e.g. http://127.0.0.1:8780>
#
# Reads `tailscale serve status --json` (already fetched into
# TS_SERVE_JSON/TS_SERVE_QUERIED by the caller) and checks that Tailscale
# Serve is proxying <port> to exactly <expected target>, with Funnel disabled
# for that route. Read-only — issues no `tailscale` command that changes
# state. Prints a one-line reason and returns:
#   0  route matches expected target, Funnel disabled            -> PASS
#   1  no route configured, or it points somewhere else           -> FAIL
#   2  tailscale serve status could not be read/parsed            -> FAIL
#   3  route matches but Funnel is enabled for it                 -> FAIL
tailscale_serve_route_status() {
  local port="$1" expected="$2"
  if [[ -z "$TS_SERVE_JSON" ]]; then
    printf 'tailscale serve status is unavailable (daemon not running, or requires root)'
    return 2
  fi
  printf '%s' "$TS_SERVE_JSON" | python3 -c '
import json, sys
port, expected = sys.argv[1], sys.argv[2]
try:
    data = json.load(sys.stdin)
except Exception:
    print("tailscale serve status output could not be parsed")
    sys.exit(2)
tcp = data.get("TCP") or {}
if port not in tcp:
    print("no Tailscale Serve route is configured for port " + port)
    sys.exit(1)
web = data.get("Web") or {}
match_key = next((k for k in web if k.endswith(":" + port)), None)
if match_key is None:
    print("port " + port + " has a TCP listener but no Serve Web handler")
    sys.exit(1)
handlers = (web.get(match_key) or {}).get("Handlers") or {}
proxy = (handlers.get("/") or {}).get("Proxy", "")
if proxy.rstrip("/") != expected.rstrip("/"):
    print("port " + port + " is routed to " + (proxy or "(nothing)") + ", expected " + expected)
    sys.exit(1)
funnel = data.get("AllowFunnel") or {}
if funnel.get(match_key):
    print("Tailscale Funnel is enabled for " + match_key + " — Funnel publishes to the public internet")
    sys.exit(3)
print("port " + port + " is correctly routed to " + expected + " via Tailscale Serve (" + match_key + "), Funnel disabled")
sys.exit(0)
' "$port" "$expected" 2>/dev/null
  return $?
}

# tailscale_daemon_running_status
#
# Reads `tailscale status --json` (already fetched into TS_STATUS_JSON by the
# caller) and checks the daemon is actually running and connected to the
# tailnet. Never uses systemctl, so it works for a non-root user exactly like
# every other check here. Prints a one-line reason and returns 0 if running,
# nonzero (FAIL) otherwise.
tailscale_daemon_running_status() {
  if [[ -z "$TS_STATUS_JSON" ]]; then
    printf 'tailscale status is unavailable (daemon not running, or requires root)'
    return 2
  fi
  printf '%s' "$TS_STATUS_JSON" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    print("tailscale status output could not be parsed")
    sys.exit(2)
state = data.get("BackendState", "")
if state != "Running":
    print("tailscale daemon backend state is " + (state or "unknown") + ", not Running")
    sys.exit(1)
print("tailscale daemon is running and connected")
sys.exit(0)
' 2>/dev/null
  return $?
}

# tailscale_listener_addr_status <port>
#
# Confirms, using only `ss -H -ltn` (no -p — no process name or PID
# involved, so it works identically for any user) and this host's own
# Tailscale addresses (TS_OWN_IPS, from `tailscale ip -4`/`-6`), that every
# real TCP listener bound to <port> sits on one of those addresses and
# nothing else. A listener on 0.0.0.0, ::, loopback, a LAN IP, or any
# unexpected extra listener alongside a legitimate one, all FAIL — never
# silently accepted just because *a* listener also happens to be correct.
tailscale_listener_addr_status() {
  local port="$1"
  if [[ -z "$TS_OWN_IPS" ]]; then
    printf 'this host'\''s own Tailscale IP addresses could not be determined'
    return 2
  fi
  printf '%s' "$TS_LISTENERS" | python3 -c '
import sys
port = sys.argv[1]
own_ips = set(x.strip() for x in sys.argv[2].splitlines() if x.strip())
matched = []
for line in sys.stdin.read().splitlines():
    fields = line.split()
    if len(fields) < 4:
        continue
    local = fields[3]
    if local.startswith("["):
        if "]:" not in local:
            continue
        addr, _, p = local.partition("]:")
        addr = addr[1:]
    else:
        if ":" not in local:
            continue
        addr, _, p = local.rpartition(":")
    if p != port:
        continue
    matched.append(addr)
if not matched:
    print("no TCP listener found for port " + port)
    sys.exit(1)
unexpected = sorted(set(a for a in matched if a not in own_ips))
expected = sorted(set(a for a in matched if a in own_ips))
if unexpected:
    print("port " + port + " has a listener on an unexpected address: " + ", ".join(unexpected))
    sys.exit(1)
if not expected:
    print("port " + port + " has no listener on a Tailscale address of this host")
    sys.exit(1)
print("port " + port + " listens only on this host'"'"'s own Tailscale address(es): " + ", ".join(expected))
sys.exit(0)
' "$port" "$TS_OWN_IPS" 2>/dev/null
  return $?
}

# tailscale_port_status <port> <expected target>
#
# Confirms this port is legitimately served by THIS host's own Tailscale
# Serve configuration, without trusting any process name or PID:
#   1. the Tailscale daemon is actually running and connected
#      (`tailscale status --json`, never `systemctl`)
#   2. Tailscale Serve proxies exactly this port to exactly the expected
#      target, tailnet-only, with Funnel disabled
#      (`tailscale serve status --json`)
#   3. every real TCP listener on this port sits on this host's own
#      Tailscale IPv4/IPv6 address, and nowhere else
#      (`ss -H -ltn` cross-checked against `tailscale ip -4`/`-6`)
# All three read-only; none change Tailscale state. Prints a one-line reason
# and returns 0 only if all three hold.
tailscale_port_status() {
  local port="$1" expected="$2" reason status

  fetch_tailscale_status_json
  reason="$(tailscale_daemon_running_status)" && status=0 || status=$?
  if (( status != 0 )); then
    printf '%s' "$reason"
    return "$status"
  fi

  fetch_tailscale_serve_json
  reason="$(tailscale_serve_route_status "$port" "$expected")" && status=0 || status=$?
  if (( status != 0 )); then
    printf '%s' "$reason"
    return "$status"
  fi

  fetch_tailscale_own_ips
  fetch_tailscale_listeners
  local listener_reason listener_status
  listener_reason="$(tailscale_listener_addr_status "$port")" && listener_status=0 || listener_status=$?
  printf '%s; %s' "$reason" "$listener_reason"
  return "$listener_status"
}

# compose_port_ownership_status <port> <expected compose service> <container port, e.g. 5678/tcp>
#
# Verifies, using only Docker's own structured metadata (never a process
# name), that <port> is currently published by exactly one running
# container, that the container belongs to THIS deployment's Compose project
# (PC_COMPOSE_PROJECT, see lib/common.sh) and the expected service, and that
# it maps <container_port> to 127.0.0.1:<port> exactly — no 0.0.0.0, no IPv6
# loopback, no other host port. Read-only: issues no `docker` command that
# changes state. Prints a one-line reason and returns:
#   0  confirmed project-control/<service> owns the port as expected -> PASS
#   1  a different/foreign owner, or the mapping does not match      -> FAIL
#   2  Docker metadata could not be read                             -> FAIL
#   3  more than one container currently publishes this port         -> FAIL (ambiguous)
compose_port_ownership_status() {
  local port="$1" service="$2" container_port="$3"
  local publishers status

  publishers="$(docker ps --filter "publish=${port}" --format '{{.ID}}' 2>/dev/null)" && status=0 || status=$?
  if (( status != 0 )); then
    printf 'docker ps could not be queried (daemon unreachable or permission denied)'
    return 2
  fi

  local count
  count="$(printf '%s\n' "$publishers" | grep -c . || true)"
  if (( count == 0 )); then
    printf 'no Docker container publishes this port — held by a non-Docker process, or Docker cannot be queried'
    return 1
  fi
  if (( count > 1 )); then
    printf 'more than one container currently publishes this port: %s' "$(printf '%s' "$publishers" | tr '\n' ' ')"
    return 3
  fi

  local cid="$publishers"
  local proj svc
  proj="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' "$cid" 2>/dev/null)" && status=0 || status=$?
  if (( status != 0 )); then
    printf 'could not read Compose labels for container %s' "$cid"
    return 2
  fi
  svc="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$cid" 2>/dev/null)" || true

  if [[ -z "$proj" ]]; then
    printf 'container %s holding this port has no Compose project label' "$cid"
    return 1
  fi
  if [[ "$proj" != "$PC_COMPOSE_PROJECT" ]]; then
    printf 'port is held by a different Compose project: %s (container %s)' "$proj" "$cid"
    return 1
  fi
  if [[ "$svc" != "$service" ]]; then
    printf 'port is held by Compose service "%s", expected "%s" (container %s)' "${svc:-unknown}" "$service" "$cid"
    return 1
  fi

  local bindings_json
  bindings_json="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$cid" 2>/dev/null)" && status=0 || status=$?
  if (( status != 0 )) || [[ -z "$bindings_json" ]]; then
    printf 'could not read port bindings for container %s' "$cid"
    return 2
  fi

  printf '%s' "$bindings_json" | python3 -c '
import json, sys
container_port, expected_port, cid = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    data = json.load(sys.stdin)
except Exception:
    print("port binding metadata could not be parsed")
    sys.exit(2)
entries = data.get(container_port)
if not entries:
    print(container_port + " is not published by this container at all")
    sys.exit(1)
if len(entries) != 1:
    print(container_port + " has ambiguous/multiple host bindings: " + json.dumps(entries))
    sys.exit(3)
binding = entries[0]
host_ip = binding.get("HostIp", "")
host_port = binding.get("HostPort", "")
if host_ip != "127.0.0.1":
    print(container_port + " is bound to " + (host_ip or "(empty)") + ", not exactly 127.0.0.1")
    sys.exit(1)
if host_port != expected_port:
    print(container_port + " is bound to host port " + host_port + ", expected " + expected_port)
    sys.exit(1)
print(container_port + " is correctly published as 127.0.0.1:" + expected_port + " (container " + cid + ")")
sys.exit(0)
' "$container_port" "$port" "$cid" 2>/dev/null
  return $?
}

# -----------------------------------------------------------------------------
log_step "Port availability"
# -----------------------------------------------------------------------------
PORT_TABLE=""
PORT_CONFLICT=0
LISTENERS="$(ss -tulpnH 2>/dev/null || ss -tulpn 2>/dev/null || echo '')"

# Fetched lazily, at most once, only if 443/8443 turn out to be occupied —
# most runs (fresh install, or those ports genuinely free) never need them.
# All four are read-only Tailscale/`ss` queries; none change any state, and
# none require root (unlike resolving a socket's owning PID/process name).
TS_SERVE_JSON=""
TS_SERVE_QUERIED=0
fetch_tailscale_serve_json() {
  (( TS_SERVE_QUERIED )) && return
  TS_SERVE_QUERIED=1
  have tailscale || return
  TS_SERVE_JSON="$(tailscale serve status --json 2>/dev/null || true)"
}

TS_STATUS_JSON=""
TS_STATUS_QUERIED=0
fetch_tailscale_status_json() {
  (( TS_STATUS_QUERIED )) && return
  TS_STATUS_QUERIED=1
  have tailscale || return
  TS_STATUS_JSON="$(tailscale status --json 2>/dev/null || true)"
}

# This host's own tailnet addresses — the only addresses 443/8443 may
# legitimately listen on. `tailscale ip` needs no privilege beyond the
# CLI-to-daemon socket every other `tailscale` command here already uses.
TS_OWN_IPS=""
TS_OWN_IPS_QUERIED=0
fetch_tailscale_own_ips() {
  (( TS_OWN_IPS_QUERIED )) && return
  TS_OWN_IPS_QUERIED=1
  have tailscale || return
  local v4 v6
  v4="$(tailscale ip -4 2>/dev/null || true)"
  v6="$(tailscale ip -6 2>/dev/null || true)"
  TS_OWN_IPS="$(printf '%s\n%s\n' "$v4" "$v6" | sed '/^$/d')"
}

# `ss -H -ltn`: TCP listeners only, no header, no DNS lookups, and
# deliberately no `-p` — process/PID resolution is exactly the signal this
# fix stops depending on, since it silently fails for a root-owned process
# when preflight runs as a normal user.
TS_LISTENERS=""
TS_LISTENERS_QUERIED=0
fetch_tailscale_listeners() {
  (( TS_LISTENERS_QUERIED )) && return
  TS_LISTENERS_QUERIED=1
  TS_LISTENERS="$(ss -H -ltn 2>/dev/null || true)"
}

for port in "${PC_REQUIRED_PORTS[@]}"; do
  # Match ":<port> " at the end of a Local Address:Port field only.
  hit="$(printf '%s\n' "$LISTENERS" | awk -v p=":${port}" '$5 ~ (p "$") {print}' || true)"
  if [[ -z "$hit" ]]; then
    PORT_TABLE+="| ${port} | free | — |"$'\n'
    record_check PASS NET-001 "Port ${port} is free" ""
    continue
  fi

  owner="$(printf '%s' "$hit" | grep -oP 'users:\(\("\K[^"]+' | head -1 || echo 'unknown')"
  expected_target="${PC_TAILSCALE_SERVE_EXPECTED[$port]:-}"
  expected_service="${PC_COMPOSE_EXPECTED_SERVICE[$port]:-}"

  if [[ -n "$expected_target" ]]; then
    # Never gate on the `ss`-reported owner: resolving the name/PID of a
    # root-owned process like tailscaled routinely fails for a normal user,
    # which is exactly the bug this branch used to have (owner: "unknown"
    # FAILed a perfectly healthy deployment). Instead verify the daemon,
    # the Serve route/Funnel state and the real listener addresses — all
    # read-only, all usable without root. The owner string is kept only as
    # extra diagnostic detail below, never as a precondition.
    reason="$(tailscale_port_status "$port" "$expected_target")" && route_status=0 || route_status=$?
    if [[ "$route_status" -eq 0 ]]; then
      PORT_TABLE+="| ${port} | in use by Tailscale Serve (expected) | \`tailnet -> ${expected_target}\` |"$'\n'
      record_check PASS NET-001 "Port ${port} is correctly served by this host's own Tailscale Serve configuration" "$reason"
    else
      PORT_CONFLICT=1
      PORT_TABLE+="| ${port} | **OCCUPIED** | \`${owner}\` |"$'\n'
      record_check FAIL NET-001 "Port ${port} is occupied but Tailscale verification failed" "${reason:-unable to verify Tailscale configuration} (ss-reported owner: ${owner}) — run: sudo ./pcctl configure-tailscale"
    fi
  elif [[ -n "$expected_service" ]]; then
    # Do not trust the process name alone here either — `ss` reports every
    # container's proxy as "docker-proxy" (or nothing at all without root)
    # regardless of which container or Compose project it belongs to. Ask
    # Docker's own metadata instead.
    reason="$(compose_port_ownership_status "$port" "$expected_service" "${port}/tcp")" && route_status=0 || route_status=$?
    if [[ "$route_status" -eq 0 ]]; then
      PORT_TABLE+="| ${port} | in use by project-control (expected) | \`${expected_service} -> 127.0.0.1:${port}\` |"$'\n'
      record_check PASS NET-001 "Port ${port} is held by the project-control ${expected_service} container, as expected" "$reason"
    else
      PORT_CONFLICT=1
      PORT_TABLE+="| ${port} | **OCCUPIED** | \`${owner}\` |"$'\n'
      record_check FAIL NET-001 "Port ${port} is occupied but not by the expected project-control ${expected_service} container" "${reason:-unable to verify Docker ownership} — install aborts; free the port manually"
    fi
  else
    PORT_CONFLICT=1
    PORT_TABLE+="| ${port} | **OCCUPIED** | \`${owner}\` |"$'\n'
    record_check FAIL NET-001 "Port ${port} is already in use" "owner: ${owner} — install aborts; free the port manually"
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
  printf '# Preflight Report\n\n'
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
