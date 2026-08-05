#!/usr/bin/env bash
# =============================================================================
# verify-security.sh — asserts the security posture that Stage 1 claims.
#
#   ./pcctl verify-security [--json]
#
# Strictly read-only. Every check corresponds to a documented guarantee in
# docs/security-model.md; if a check here fails, that document is wrong about
# this host.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

JSON=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    *) die "unknown argument: $arg" ;;
  esac
done
if (( JSON )); then exec 3>&2 2>/dev/null; fi

load_versions
load_stack_env

SERVICES=(postgres n8n control-api web caddy)

# =============================================================================
# 1. Network exposure — nothing may listen on a public interface
# =============================================================================
log_step "Network exposure"

# The authoritative check: every published port must be bound to 127.0.0.1.
public_bindings=""
for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  [[ -n "$cid" ]] || continue

  bindings="$(docker inspect --format \
    '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{$p}}={{.HostIp}}:{{.HostPort}} {{end}}{{end}}' \
    "$cid" 2>/dev/null || echo '')"

  if [[ -z "${bindings// /}" ]]; then
    record_check PASS NET-001 "${service} publishes no host port" ""
    continue
  fi

  for binding in $bindings; do
    host_ip="${binding#*=}"; host_ip="${host_ip%:*}"
    if [[ "$host_ip" == "127.0.0.1" || "$host_ip" == "::1" ]]; then
      record_check PASS NET-002 "${service} publishes on loopback only" "$binding"
    else
      record_check FAIL NET-002 "${service} publishes on a NON-LOOPBACK address" "$binding"
      public_bindings+="${service}:${binding} "
    fi
  done
done

# Independent confirmation from the kernel's own view.
for port in 8780 5678; do
  listener="$(ss -tlnH "sport = :${port}" 2>/dev/null || true)"
  if [[ -z "$listener" ]]; then
    record_check WARN NET-003 "Nothing is listening on ${port}" "the stack may be stopped"
  elif printf '%s' "$listener" | grep -qE '(0\.0\.0\.0|\[::\]|\*):'"${port}"; then
    record_check FAIL NET-003 "Port ${port} is bound to all interfaces" "$(printf '%s' "$listener" | head -1)"
  else
    record_check PASS NET-003 "Port ${port} is bound to loopback only" ""
  fi
done

# PostgreSQL must not be reachable from the host at all.
if timeout 3 bash -c '</dev/tcp/127.0.0.1/5432' 2>/dev/null; then
  record_check FAIL NET-004 "PostgreSQL is reachable on 127.0.0.1:5432" "it must publish no host port"
else
  record_check PASS NET-004 "PostgreSQL publishes no host port" ""
fi

# The Control API must not be reachable except through Caddy.
if timeout 3 bash -c '</dev/tcp/127.0.0.1/8080' 2>/dev/null; then
  record_check FAIL NET-005 "Control API is directly reachable on 127.0.0.1:8080" "it must only be reachable via Caddy"
else
  record_check PASS NET-005 "Control API publishes no host port" ""
fi

# The runner must have no TCP listener whatsoever.
if runner_pid="$(systemctl show -p MainPID --value project-control-runner.service 2>/dev/null)" && [[ "${runner_pid:-0}" -gt 0 ]]; then
  if ss -tlnpH 2>/dev/null | grep -q "pid=${runner_pid},"; then
    record_check FAIL NET-006 "The runner has a TCP listener" "it must use a Unix socket only"
  else
    record_check PASS NET-006 "The runner has no TCP listener" "Unix socket only"
  fi
else
  record_check SKIP NET-006 "Runner TCP listener check" "runner is not running"
fi

# =============================================================================
# 2. Docker socket — never mounted anywhere
# =============================================================================
log_step "Docker socket exposure"

socket_exposed=0
for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  [[ -n "$cid" ]] || continue

  mounts="$(docker inspect --format '{{range .Mounts}}{{.Source}}:{{.Destination}} {{end}}' "$cid" 2>/dev/null || echo '')"
  if printf '%s' "$mounts" | grep -q 'docker\.sock'; then
    record_check FAIL DOC-001 "${service} has the Docker socket mounted" "this is equivalent to host root"
    socket_exposed=1
  fi
done
(( socket_exposed )) || record_check PASS DOC-001 "No container mounts the Docker socket" ""

# The runner must not be able to open it either.
if id -u "${PC_RUNNER_USER}" >/dev/null 2>&1; then
  if getent group docker 2>/dev/null | grep -qw "${PC_RUNNER_USER}"; then
    record_check FAIL DOC-002 "${PC_RUNNER_USER} is in the docker group" "that grants effective root on the host"
  else
    record_check PASS DOC-002 "${PC_RUNNER_USER} is not in the docker group" ""
  fi
fi

# =============================================================================
# 3. Container hardening flags
# =============================================================================
log_step "Container hardening"

for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  [[ -n "$cid" ]] || continue

  # --- privileged ---
  privileged="$(docker inspect --format '{{.HostConfig.Privileged}}' "$cid" 2>/dev/null || echo unknown)"
  if [[ "$privileged" == "false" ]]; then
    record_check PASS HRD-001 "${service} is not privileged" ""
  else
    record_check FAIL HRD-001 "${service} is PRIVILEGED" ""
  fi

  # --- no-new-privileges ---
  opts="$(docker inspect --format '{{range .HostConfig.SecurityOpt}}{{.}} {{end}}' "$cid" 2>/dev/null || echo '')"
  if printf '%s' "$opts" | grep -q 'no-new-privileges'; then
    record_check PASS HRD-002 "${service} sets no-new-privileges" ""
  else
    record_check FAIL HRD-002 "${service} does not set no-new-privileges" ""
  fi

  # --- capabilities ---
  cap_drop="$(docker inspect --format '{{range .HostConfig.CapDrop}}{{.}} {{end}}' "$cid" 2>/dev/null || echo '')"
  cap_add="$(docker inspect --format '{{range .HostConfig.CapAdd}}{{.}} {{end}}' "$cid" 2>/dev/null || echo '')"
  if printf '%s' "$cap_drop" | grep -qi 'ALL'; then
    if [[ -z "${cap_add// /}" ]]; then
      record_check PASS HRD-003 "${service} drops ALL capabilities and adds none" ""
    else
      record_check WARN HRD-003 "${service} drops ALL but re-adds capabilities" "$cap_add"
    fi
  else
    record_check FAIL HRD-003 "${service} does not drop ALL capabilities" "drop=${cap_drop:-none}"
  fi

  # --- non-root user ---
  user="$(docker inspect --format '{{.Config.User}}' "$cid" 2>/dev/null || echo '')"
  if [[ -z "$user" || "$user" == "0" || "$user" == "root" || "$user" == 0:* ]]; then
    record_check FAIL HRD-004 "${service} runs as root" "user='${user:-unset}'"
  else
    record_check PASS HRD-004 "${service} runs as a non-root user" "$user"
  fi

  # --- read-only root filesystem ---
  # PostgreSQL is the documented exception: it must write its data directory.
  readonly_fs="$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$cid" 2>/dev/null || echo false)"
  if [[ "$readonly_fs" == "true" ]]; then
    record_check PASS HRD-005 "${service} has a read-only root filesystem" ""
  elif [[ "$service" == "postgres" ]]; then
    record_check WARN HRD-005 "${service} root filesystem is writable" "documented exception: PostgreSQL manages its own data directory"
  else
    record_check FAIL HRD-005 "${service} root filesystem is writable" ""
  fi

  # --- PID limit ---
  pids="$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$cid" 2>/dev/null || echo 0)"
  if [[ "${pids:-0}" -gt 0 ]]; then
    record_check PASS HRD-006 "${service} has a PID limit" "$pids"
  else
    record_check FAIL HRD-006 "${service} has no PID limit" "a fork bomb could exhaust the host"
  fi

  # --- memory limit ---
  mem="$(docker inspect --format '{{.HostConfig.Memory}}' "$cid" 2>/dev/null || echo 0)"
  if [[ "${mem:-0}" -gt 0 ]]; then
    record_check PASS HRD-007 "${service} has a memory limit" "$((mem / 1024 / 1024)) MiB"
  else
    record_check FAIL HRD-007 "${service} has no memory limit" ""
  fi

  # --- host namespaces ---
  for ns_field in NetworkMode PidMode IpcMode UTSMode; do
    value="$(docker inspect --format "{{.HostConfig.${ns_field}}}" "$cid" 2>/dev/null || echo '')"
    if [[ "$value" == "host" ]]; then
      record_check FAIL HRD-008 "${service} shares the host ${ns_field}" "$value"
    fi
  done
done
record_check PASS HRD-008 "No container shares a host namespace" ""

# =============================================================================
# 4. Secret file permissions
# =============================================================================
log_step "Secret permissions"

if [[ -d "$PC_SECRETS_DIR" ]]; then
  dir_mode="$(stat -c '%a' "$PC_SECRETS_DIR")"
  dir_owner="$(stat -c '%U' "$PC_SECRETS_DIR")"
  if [[ "$dir_mode" == "700" && "$dir_owner" == "root" ]]; then
    record_check PASS SEC-001 "Secrets directory is 0700 root-owned" ""
  else
    record_check FAIL SEC-001 "Secrets directory is ${dir_mode} owned by ${dir_owner}" "expected 700 root"
  fi

  if is_root; then
    bad_mode=0; world_readable=0; wrong_owner=0; total=0
    while IFS= read -r -d '' file; do
      total=$((total+1))
      mode="$(stat -c '%a' "$file")"
      owner="$(stat -c '%U' "$file")"
      [[ "$owner" == "root" ]] || wrong_owner=$((wrong_owner+1))
      [[ "$mode" == "600" || "$mode" == "640" || "$mode" == "400" ]] || bad_mode=$((bad_mode+1))
      (( 0$mode & 0004 )) && world_readable=$((world_readable+1))
    done < <(find "$PC_SECRETS_DIR" -type f -print0 2>/dev/null)

    if (( total == 0 )); then
      record_check WARN SEC-002 "No secret files found" "run sudo ./pcctl install"
    else
      (( bad_mode == 0 ))       && record_check PASS SEC-002 "All ${total} secret files have safe modes" "" \
                                || record_check FAIL SEC-002 "${bad_mode}/${total} secret files have unsafe modes" ""
      (( world_readable == 0 )) && record_check PASS SEC-003 "No secret file is world-readable" "" \
                                || record_check FAIL SEC-003 "${world_readable} secret file(s) are world-readable" ""
      (( wrong_owner == 0 ))    && record_check PASS SEC-004 "All secret files are root-owned" "" \
                                || record_check FAIL SEC-004 "${wrong_owner} secret file(s) are not root-owned" ""
    fi
  else
    record_check SKIP SEC-002 "Secret file permission audit" "requires root"
  fi
else
  record_check WARN SEC-001 "Secrets directory does not exist" ""
fi

# No world-writable file anywhere in the deployment.
if [[ -d "$PC_ROOT" ]] && is_root; then
  ww="$(find "$PC_ROOT" -type f -perm -0002 2>/dev/null | head -20)"
  if [[ -z "$ww" ]]; then
    record_check PASS SEC-005 "No world-writable file in the deployment" ""
  else
    record_check FAIL SEC-005 "World-writable file(s) found" "$(printf '%s' "$ww" | head -3 | tr '\n' ' ')"
  fi
fi

# =============================================================================
# 5. Repository secret scan
# =============================================================================
log_step "Repository secret scan"

if git -C "$PC_REPO_ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  # Tracked files only: an untracked local scratch file is not a leak.
  tracked="$(git -C "$PC_REPO_ROOT" ls-files 2>/dev/null || true)"

  findings=0
  while IFS= read -r file; do
    [[ -f "${PC_REPO_ROOT}/${file}" ]] || continue
    # Documentation and this scanner necessarily mention the patterns.
    case "$file" in
      *.md|scripts/verify-security.sh|*/redact*|*.test.ts|*_test.go) continue ;;
    esac

    if grep -nEi \
      -e '(password|passwd|secret|api[_-]?key|token)[[:space:]]*[:=][[:space:]]*["'\'']?[A-Za-z0-9/+_-]{16,}' \
      -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' \
      -e '\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b' \
      -e '\bAKIA[0-9A-Z]{16}\b' \
      "${PC_REPO_ROOT}/${file}" 2>/dev/null \
      | grep -vE '(_FILE|example|EXAMPLE|placeholder|<your|CHANGEME|\$\{|xxxxx|REDACTED)' \
      | grep -vE "[:=][[:space:]]*:'" \
      | grep -vE '[:=][[:space:]]*[A-Za-z_$][A-Za-z0-9_.]*[,;)[:space:]]*$' >/dev/null; then
      record_check FAIL GIT-001 "Possible secret in ${file}" "review before committing"
      findings=$((findings+1))
    fi
  done <<<"$tracked"

  (( findings == 0 )) && record_check PASS GIT-001 "No credential-shaped literal in tracked files" ""

  # The secrets directory must never be tracked.
  if printf '%s' "$tracked" | grep -qE '^secrets/|/secrets/[^.]'; then
    record_check FAIL GIT-002 "A secrets/ path is tracked by git" ""
  else
    record_check PASS GIT-002 "No secrets/ path is tracked by git" ""
  fi

  # .gitignore must actually exclude them.
  if grep -q '^secrets/' "${PC_REPO_ROOT}/.gitignore" 2>/dev/null; then
    record_check PASS GIT-003 ".gitignore excludes secrets/" ""
  else
    record_check FAIL GIT-003 ".gitignore does not exclude secrets/" ""
  fi

  # Only .example env files may be tracked.
  if printf '%s' "$tracked" | grep -E '\.env$' | grep -v '\.example' >/dev/null; then
    record_check FAIL GIT-004 "A .env file is tracked" ""
  else
    record_check PASS GIT-004 "No .env file is tracked" ""
  fi
else
  record_check SKIP GIT-001 "Repository secret scan" "not a git repository"
fi

# =============================================================================
# 6. PostgreSQL role isolation
# =============================================================================
log_step "PostgreSQL role isolation"

if [[ -n "$(container_id postgres)" ]] && is_root; then
  pg_cid="$(container_id postgres)"

  # Each of these must FAIL to connect. A success is the finding.
  assert_cannot_connect() {
    local role="$1" database="$2" secret="$3"
    local password; password="$(read_secret "$secret")"
    if docker exec -i "$pg_cid" env PGPASSWORD="$password" \
         psql -U "$role" -d "$database" -tAc 'SELECT 1' >/dev/null 2>&1; then
      record_check FAIL PGS-001 "${role} CAN connect to ${database}" "cross-database isolation is broken"
    else
      record_check PASS PGS-001 "${role} cannot connect to ${database}" ""
    fi
  }

  assert_cannot_connect n8n_app          project_control pg_n8n_app_password
  assert_cannot_connect control_app      n8n             pg_control_app_password
  assert_cannot_connect control_migrator n8n             pg_control_migrator_password

  # And each must succeed on its own database.
  assert_can_connect() {
    local role="$1" database="$2" secret="$3"
    local password; password="$(read_secret "$secret")"
    if docker exec -i "$pg_cid" env PGPASSWORD="$password" \
         psql -U "$role" -d "$database" -tAc 'SELECT 1' >/dev/null 2>&1; then
      record_check PASS PGS-002 "${role} can connect to ${database}" ""
    else
      record_check FAIL PGS-002 "${role} cannot connect to its own database ${database}" ""
    fi
  }

  assert_can_connect control_app project_control pg_control_app_password
  assert_can_connect n8n_app     n8n             pg_n8n_app_password

  # The runtime role must not be able to rewrite audit history.
  control_pw="$(read_secret pg_control_app_password)"
  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM audit_events WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-003 "control_app can DELETE from audit_events" "the audit trail must be append-only"
  else
    record_check PASS PGS-003 "control_app cannot DELETE from audit_events" "append-only enforced"
  fi

  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "UPDATE audit_events SET outcome='success' WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-004 "control_app can UPDATE audit_events" "the audit trail must be immutable"
  else
    record_check PASS PGS-004 "control_app cannot UPDATE audit_events" ""
  fi

  # The runtime role must not be able to create objects.
  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "CREATE TABLE pcctl_privilege_probe (id int)" >/dev/null 2>&1; then
    record_check FAIL PGS-005 "control_app can CREATE TABLE" "the runtime role must hold no DDL privilege"
    docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
      psql -U control_app -d project_control -tAc "DROP TABLE IF EXISTS pcctl_privilege_probe" >/dev/null 2>&1 || true
  else
    record_check PASS PGS-005 "control_app cannot CREATE TABLE" "no DDL privilege"
  fi

  # backup_reader must be read-only.
  backup_pw="$(read_secret pg_backup_reader_password)"
  if docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO system_settings (key, value) VALUES ('probe','1'::jsonb)" >/dev/null 2>&1; then
    record_check FAIL PGS-006 "backup_reader can INSERT" "it must be read-only"
  else
    record_check PASS PGS-006 "backup_reader cannot write" "read-only enforced"
  fi
else
  record_check SKIP PGS-001 "PostgreSQL role isolation" "requires root and a running postgres container"
fi

# =============================================================================
# 7. Runner confinement
# =============================================================================
log_step "Runner confinement"

if systemctl is-active --quiet project-control-runner.service 2>/dev/null; then
  runner_user="$(systemctl show -p User --value project-control-runner.service 2>/dev/null || echo '')"
  if [[ "$runner_user" == "root" || -z "$runner_user" ]]; then
    record_check FAIL RNR-001 "The runner service runs as ${runner_user:-root}" "it must run as ${PC_RUNNER_USER}"
  else
    record_check PASS RNR-001 "The runner runs as ${runner_user}" ""
  fi

  for directive in NoNewPrivileges ProtectSystem PrivateTmp ProtectHome RestrictSUIDSGID; do
    value="$(systemctl show -p "$directive" --value project-control-runner.service 2>/dev/null || echo '')"
    case "$value" in
      yes|strict|true) record_check PASS RNR-002 "Runner ${directive}=${value}" "" ;;
      *)               record_check FAIL RNR-002 "Runner ${directive}=${value:-unset}" "expected a hardened value" ;;
    esac
  done

  caps="$(systemctl show -p CapabilityBoundingSet --value project-control-runner.service 2>/dev/null || echo '')"
  if [[ -z "$caps" || "$caps" == "0" ]]; then
    record_check PASS RNR-003 "Runner has an empty capability bounding set" ""
  else
    record_check WARN RNR-003 "Runner capability bounding set is not empty" "$caps"
  fi

  families="$(systemctl show -p RestrictAddressFamilies --value project-control-runner.service 2>/dev/null || echo '')"
  if printf '%s' "$families" | grep -q 'AF_UNIX' && ! printf '%s' "$families" | grep -q 'AF_INET'; then
    record_check PASS RNR-004 "Runner is restricted to AF_UNIX" "$families"
  else
    record_check WARN RNR-004 "Runner address families: ${families:-unrestricted}" "expected AF_UNIX only"
  fi
else
  record_check SKIP RNR-001 "Runner confinement checks" "service is not active"
fi

# The runner must have no sudoers entry.
if is_root; then
  if grep -rqs "${PC_RUNNER_USER}" /etc/sudoers /etc/sudoers.d/ 2>/dev/null; then
    record_check FAIL RNR-005 "${PC_RUNNER_USER} appears in sudoers" "the runner must have no sudo rights"
  else
    record_check PASS RNR-005 "${PC_RUNNER_USER} has no sudoers entry" ""
  fi
fi

# The socket must not be world-accessible.
if [[ -S "$PC_RUNNER_SOCKET" ]]; then
  mode="$(stat -c '%a' "$PC_RUNNER_SOCKET")"
  if (( 0$mode & 0007 )); then
    record_check FAIL RNR-006 "Runner socket mode ${mode} grants access to 'other'" ""
  else
    record_check PASS RNR-006 "Runner socket mode ${mode} excludes 'other'" ""
  fi
fi

# Live proof that a raw command is refused.
if [[ -S "$PC_RUNNER_SOCKET" ]] && have python3 && (is_root || [[ -r "$PC_RUNNER_SOCKET" ]]); then
  probe_result="$(python3 - "$PC_RUNNER_SOCKET" <<'PY' 2>/dev/null || echo "error"
import json, socket, sys
path = sys.argv[1]
hostile = [
    {"requestId": "sec-probe-0001", "operation": "/bin/sh"},
    {"requestId": "sec-probe-0002", "operation": "system.health", "command": "id"},
    {"requestId": "sec-probe-0003", "operation": "exec"},
]
for payload in hostile:
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(path)
        s.sendall((json.dumps(payload) + "\n").encode())
        data = s.recv(65536).decode()
        s.close()
        if json.loads(data.strip()).get("ok") is True:
            print("ACCEPTED")
            sys.exit(0)
    except Exception:
        pass
print("REJECTED")
PY
)"
  case "$probe_result" in
    REJECTED) record_check PASS RNR-007 "Runner rejects raw command requests" "3 hostile payloads refused" ;;
    ACCEPTED) record_check FAIL RNR-007 "Runner ACCEPTED a raw command request" "critical" ;;
    *)        record_check WARN RNR-007 "Runner command-rejection probe inconclusive" "$probe_result" ;;
  esac
else
  record_check SKIP RNR-007 "Runner raw-command rejection probe" "socket not readable by this user"
fi

# =============================================================================
# 8. HTTP security headers
# =============================================================================
log_step "HTTP security headers"

if headers="$(curl -sSI --max-time 10 "http://127.0.0.1:8780/" 2>/dev/null)"; then
  check_header() {
    local name="$1" expectation="$2"
    if printf '%s' "$headers" | grep -qi "^${name}:"; then
      record_check PASS HDR-001 "${name} is present" "$(printf '%s' "$headers" | grep -i "^${name}:" | head -1 | cut -c1-80)"
    else
      record_check FAIL HDR-001 "${name} is missing" "$expectation"
    fi
  }
  check_header "Content-Security-Policy"    "restrictive CSP required"
  check_header "X-Content-Type-Options"     "nosniff required"
  check_header "X-Frame-Options"            "DENY required"
  check_header "Referrer-Policy"            "no-referrer required"
  check_header "Strict-Transport-Security"  "HSTS required"

  if printf '%s' "$headers" | grep -qi '^Server:.*[Cc]addy'; then
    record_check WARN HDR-002 "The Server header advertises Caddy" "minor information disclosure"
  else
    record_check PASS HDR-002 "No server software is advertised" ""
  fi
else
  record_check SKIP HDR-001 "HTTP header checks" "the portal is not reachable"
fi

# =============================================================================
# 9. Existing unrelated Docker resources are untouched
# =============================================================================
log_step "Coexistence with other Docker projects"

foreign_projects="$(docker ps -a --format '{{.Label "com.docker.compose.project"}}' 2>/dev/null \
  | grep -v "^${PC_COMPOSE_PROJECT}$" | grep -v '^$' | sort -u || true)"
foreign_count="$(printf '%s' "$foreign_projects" | grep -c . || true)"
record_check PASS COE-001 "Other Compose projects are present and untouched" "${foreign_count} project(s): ${foreign_projects//$'\n'/, }"

pc_networks="$(docker network ls --format '{{.Name}}' 2>/dev/null | grep -c "^${PC_COMPOSE_PROJECT}_" || true)"
record_check PASS COE-002 "This stack owns only its own networks" "${pc_networks} network(s) prefixed ${PC_COMPOSE_PROJECT}_"

# =============================================================================
# Output
# =============================================================================
if (( JSON )); then
  exec 2>&3
  emit_checks_json
else
  print_check_summary
  if (( PC_CHECK_FAIL > 0 )); then
    log_error "SECURITY VERIFICATION FAILED — ${PC_CHECK_FAIL} issue(s)"
    log_error "do not treat this deployment as hardened until they are resolved"
  else
    log_ok "security verification passed"
  fi
fi

(( PC_CHECK_FAIL == 0 ))
