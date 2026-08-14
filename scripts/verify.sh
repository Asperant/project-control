#!/usr/bin/env bash
# =============================================================================
# verify.sh — functional verification of a deployed stack.
#
#   ./pcctl verify           human-readable
#   ./pcctl verify --json    machine-readable
#
# Read-only apart from the artifact self-test, which writes one small
# content-addressed object through the real storage path — that is the point of
# it. Exits non-zero if any check fails.
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

# In JSON mode the human log must not contaminate stdout.
if (( JSON )); then exec 3>&2 2>/dev/null; fi

load_versions
load_stack_env

# -----------------------------------------------------------------------------
# Deployment presence
# -----------------------------------------------------------------------------
if [[ ! -d "$PC_ROOT" ]]; then
  record_check FAIL DEP-001 "Deployment root is missing" "$PC_ROOT — run: sudo ./pcctl install"
  if (( JSON )); then exec 2>&3; emit_checks_json; else print_check_summary; fi
  exit 1
fi
record_check PASS DEP-001 "Deployment root exists" "$PC_ROOT"

for required in compose/compose.yaml config/stack.env config/caddy/Caddyfile; do
  if [[ -f "${PC_ROOT}/${required}" ]]; then
    record_check PASS DEP-002 "Present: ${required}" ""
  else
    record_check FAIL DEP-002 "Missing: ${required}" "re-run sudo ./pcctl install"
  fi
done

# -----------------------------------------------------------------------------
# Containers and health
# -----------------------------------------------------------------------------
SERVICES=(postgres n8n control-api web caddy)

for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  if [[ -z "$cid" ]]; then
    record_check FAIL CNT-001 "Container ${service} does not exist" "run ./pcctl start"
    continue
  fi

  state="$(docker inspect --format '{{.State.Status}}' "$cid" 2>/dev/null || echo unknown)"
  if [[ "$state" != "running" ]]; then
    record_check FAIL CNT-001 "Container ${service} is not running" "state=${state}"
    continue
  fi

  health="$(container_health "$service")"
  case "$health" in
    healthy)   record_check PASS CNT-002 "Container ${service} is healthy" "" ;;
    starting)  record_check WARN CNT-002 "Container ${service} is still starting" "$health" ;;
    running)   record_check PASS CNT-002 "Container ${service} is running" "no healthcheck defined" ;;
    *)         record_check FAIL CNT-002 "Container ${service} is unhealthy" "$health" ;;
  esac

  # Restart-loop detection: a container that keeps dying looks "running" at any
  # given instant, so the counter is what actually reveals the problem.
  restarts="$(docker inspect --format '{{.RestartCount}}' "$cid" 2>/dev/null || echo 0)"
  if (( restarts > 5 )); then
    record_check WARN CNT-003 "Container ${service} has restarted ${restarts} times" "check ./pcctl logs ${service}"
  fi
done

# -----------------------------------------------------------------------------
# db-bootstrap — a one-shot role/database reconciliation job. Checked
# separately from the SERVICES loop above: "exited" is its correct end state,
# not a failure, so it would never pass a "must be running" check.
# -----------------------------------------------------------------------------
bootstrap_cid="$(container_id db-bootstrap)"
if [[ -z "$bootstrap_cid" ]]; then
  record_check FAIL CNT-004 "Container db-bootstrap does not exist" "run ./pcctl start"
else
  bootstrap_status="$(docker inspect --format '{{.State.Status}}' "$bootstrap_cid" 2>/dev/null || echo unknown)"
  bootstrap_exit="$(docker inspect --format '{{.State.ExitCode}}' "$bootstrap_cid" 2>/dev/null || echo unknown)"
  if [[ "$bootstrap_status" == "exited" && "$bootstrap_exit" == "0" ]]; then
    record_check PASS CNT-004 "db-bootstrap completed successfully" "role/database reconciliation"
  else
    record_check FAIL CNT-004 "db-bootstrap did not complete successfully" \
      "status=${bootstrap_status} exit=${bootstrap_exit} — check ./pcctl logs db-bootstrap"
  fi
fi

# -----------------------------------------------------------------------------
# Image digest pinning — the running containers must be the locked images
# -----------------------------------------------------------------------------
check_digest() {
  local service="$1" expected_image="$2"
  local cid; cid="$(container_id "$service")"
  [[ -n "$cid" ]] || return 0

  local running_ref
  running_ref="$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || echo '')"
  local expected_id
  expected_id="$(docker image inspect --format '{{.Id}}' "$expected_image" 2>/dev/null || echo '')"

  if [[ -n "$expected_id" && "$running_ref" == "$expected_id" ]]; then
    record_check PASS IMG-001 "${service} runs the pinned image" "${expected_image##*/}"
  else
    record_check FAIL IMG-001 "${service} is NOT running the pinned image" \
      "expected ${expected_image}; the container predates the current version lock"
  fi
}
check_digest postgres    "${PC_POSTGRES_IMAGE}"
check_digest n8n         "${PC_N8N_IMAGE}"
check_digest caddy       "${PC_CADDY_PROXY_IMAGE}"
check_digest control-api "${PC_CONTROL_API_IMAGE}"
check_digest web         "${PC_WEB_IMAGE}"

# -----------------------------------------------------------------------------
# PostgreSQL: databases, roles, isolation, migrations
# -----------------------------------------------------------------------------
psql_super() {
  docker exec -i "$(container_id postgres)" \
    env PGPASSWORD="$(read_secret pg_superuser_password)" \
    psql -U postgres -d "${1:-postgres}" -tAq -c "$2" 2>/dev/null
}

if [[ -n "$(container_id postgres)" ]] && is_root; then
  if databases="$(psql_super postgres "SELECT datname FROM pg_database WHERE datname IN ('project_control','n8n') ORDER BY 1")"; then
    if [[ "$databases" == *"n8n"* && "$databases" == *"project_control"* ]]; then
      record_check PASS PG-001 "Both databases exist" "project_control, n8n"
    else
      record_check FAIL PG-001 "A required database is missing" "found: ${databases//$'\n'/, }"
    fi
  else
    record_check FAIL PG-001 "Cannot query PostgreSQL" "superuser connection failed"
  fi

  roles="$(psql_super postgres "SELECT rolname FROM pg_roles WHERE rolname IN ('control_app','control_migrator','n8n_app','backup_reader') ORDER BY 1" || true)"
  role_count="$(printf '%s' "$roles" | grep -c . || true)"
  if [[ "$role_count" == "4" ]]; then
    record_check PASS PG-002 "All four roles exist" "control_app, control_migrator, n8n_app, backup_reader"
  else
    record_check FAIL PG-002 "Expected 4 roles, found ${role_count}" "${roles//$'\n'/, }"
  fi

  # No role may be a superuser.
  supers="$(psql_super postgres "SELECT rolname FROM pg_roles WHERE rolsuper AND rolname <> 'postgres'" || true)"
  if [[ -z "$supers" ]]; then
    record_check PASS PG-003 "No application role has superuser" ""
  else
    record_check FAIL PG-003 "An application role has superuser" "${supers//$'\n'/, }"
  fi

  migrations="$(psql_super project_control "SELECT count(*) FROM schema_migrations" || echo 0)"
  if [[ "${migrations:-0}" -gt 0 ]]; then
    record_check PASS PG-004 "Migrations applied" "${migrations} migration(s)"
  else
    record_check FAIL PG-004 "No migrations recorded" "the Control API may have failed to migrate"
  fi

  tables="$(psql_super project_control "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('users','sessions','audit_events','schema_migrations','system_settings','artifact_objects')" || echo 0)"
  if [[ "${tables:-0}" == "6" ]]; then
    record_check PASS PG-005 "All six Stage 1 tables exist" ""
  else
    record_check FAIL PG-005 "Expected 6 Stage 1 tables, found ${tables}" ""
  fi

  project_tables="$(psql_super project_control "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('projects','project_technologies','project_rules','project_commands','project_inspections')" || echo 0)"
  if [[ "${project_tables:-0}" == "5" ]]; then
    record_check PASS PG-006 "All five project-registration tables exist" ""
  else
    record_check FAIL PG-006 "Expected 5 project-registration tables, found ${project_tables}" ""
  fi

  project_migrations="$(psql_super project_control "SELECT count(*) FROM schema_migrations WHERE version IN ('0003','0004')" || echo 0)"
  if [[ "${project_migrations:-0}" == "2" ]]; then
    record_check PASS PG-007 "Project-registration migrations (0003, 0004) applied" ""
  else
    record_check FAIL PG-007 "Project-registration migrations not fully applied" "found ${project_migrations}/2"
  fi
else
  record_check SKIP PG-001 "PostgreSQL checks" "requires root (to read secrets) and a running container"
fi

# -----------------------------------------------------------------------------
# Control API through Caddy
# -----------------------------------------------------------------------------
PORTAL="http://127.0.0.1:8780"

if code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${PORTAL}/healthz" 2>/dev/null)"; then
  if [[ "$code" == "200" ]]; then
    record_check PASS API-001 "Caddy answers on 127.0.0.1:8780" "HTTP ${code}"
  else
    record_check FAIL API-001 "Caddy returned HTTP ${code}" ""
  fi
else
  record_check FAIL API-001 "Caddy is not reachable on 127.0.0.1:8780" ""
fi

# The API must be reachable *through* Caddy, and must reject an unauthenticated
# request — a 200 here would mean the route is not protected.
if code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${PORTAL}/api/auth/me" 2>/dev/null)"; then
  if [[ "$code" == "401" ]]; then
    record_check PASS API-002 "/api/auth/me requires authentication" "HTTP 401"
  else
    record_check FAIL API-002 "/api/auth/me returned HTTP ${code}" "expected 401 for an anonymous request"
  fi
else
  record_check FAIL API-002 "/api is not routed through Caddy" ""
fi

if code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${PORTAL}/api/projects" 2>/dev/null)"; then
  if [[ "$code" == "401" ]]; then
    record_check PASS API-005 "/api/projects requires authentication" "HTTP 401"
  else
    record_check FAIL API-005 "/api/projects returned HTTP ${code}" "expected 401 for an anonymous request"
  fi
else
  record_check FAIL API-005 "/api/projects is not routed through Caddy" ""
fi

# Health endpoints must NOT be exposed through the proxy.
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${PORTAL}/health/ready" 2>/dev/null || echo 000)"
if [[ "$code" == "404" ]]; then
  record_check PASS API-003 "/health/* is not exposed through Caddy" "HTTP 404"
else
  record_check FAIL API-003 "/health/ready is reachable through Caddy" "HTTP ${code}"
fi

# The web panel must be served for a non-API path.
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "${PORTAL}/" 2>/dev/null || echo 000)"
if [[ "$code" == "200" ]]; then
  record_check PASS WEB-001 "Web panel is served at /" "HTTP 200"
else
  record_check FAIL WEB-001 "Web panel returned HTTP ${code}" ""
fi

# Readiness, from inside the container network.
if cid="$(container_id control-api)" && [[ -n "$cid" ]]; then
  if ready="$(docker exec "$cid" node -e "fetch('http://127.0.0.1:8080/health/ready').then(async r=>{console.log(r.status);process.exit(0)}).catch(()=>{console.log('000');process.exit(0)})" 2>/dev/null)"; then
    if [[ "$ready" == "200" ]]; then
      record_check PASS API-004 "Control API reports ready" "HTTP 200"
    else
      record_check FAIL API-004 "Control API readiness returned HTTP ${ready}" "a dependency is unhealthy"
    fi
  fi
fi

# -----------------------------------------------------------------------------
# Runner
# -----------------------------------------------------------------------------
if systemctl is-active --quiet project-control-runner.service 2>/dev/null; then
  record_check PASS RUN-001 "project-control-runner.service is active" ""
else
  record_check FAIL RUN-001 "project-control-runner.service is not active" "journalctl -u project-control-runner -n 50"
fi

if [[ -S "$PC_RUNNER_SOCKET" ]]; then
  mode="$(stat -c '%a' "$PC_RUNNER_SOCKET")"
  group="$(stat -c '%G' "$PC_RUNNER_SOCKET")"
  record_check PASS RUN-002 "Runner socket exists" "mode ${mode}, group ${group}"
else
  record_check FAIL RUN-002 "Runner socket is missing" "$PC_RUNNER_SOCKET"
fi

# The Control API container must actually be able to reach the runner.
if cid="$(container_id control-api)" && [[ -n "$cid" ]]; then
  if docker exec "$cid" test -S /run/project-control/runner.sock 2>/dev/null; then
    record_check PASS RUN-003 "Runner socket is mounted in the Control API container" ""
  else
    record_check FAIL RUN-003 "Runner socket is not usable inside the Control API container" ""
  fi
fi

# -----------------------------------------------------------------------------
# Project registration — allowed roots configuration
# -----------------------------------------------------------------------------
ALLOWED_ROOTS_FILE="${PC_ROOT}/config/allowed-project-roots.conf"
if [[ -f "$ALLOWED_ROOTS_FILE" ]]; then
  mode="$(stat -c '%a' "$ALLOWED_ROOTS_FILE" 2>/dev/null || echo '')"
  owner="$(stat -c '%U' "$ALLOWED_ROOTS_FILE" 2>/dev/null || echo '')"
  if [[ "$mode" == "644" && "$owner" == "root" ]]; then
    record_check PASS PRJ-001 "allowed-project-roots.conf is 0644 root-owned" ""
  else
    record_check FAIL PRJ-001 "allowed-project-roots.conf is ${mode:-unknown} owned by ${owner:-unknown}" "expected 644 root"
  fi
  root_count="$(grep -vcE '^[[:space:]]*(#|$)' "$ALLOWED_ROOTS_FILE" 2>/dev/null || echo 0)"
  if (( root_count > 0 )); then
    record_check PASS PRJ-002 "${root_count} allowed project root(s) configured" ""
  else
    record_check WARN PRJ-002 "No allowed project roots configured" "project registration will report no_allowed_roots_configured"
  fi
else
  record_check WARN PRJ-001 "allowed-project-roots.conf does not exist yet" "run: sudo ./pcctl install"
fi

DROPIN_FILE="/etc/systemd/system/project-control-runner.service.d/10-allowed-roots.conf"
if [[ -f "$DROPIN_FILE" ]]; then
  record_check PASS PRJ-003 "systemd allowed-roots drop-in is installed" "$DROPIN_FILE"
else
  record_check WARN PRJ-003 "systemd allowed-roots drop-in is missing" "run: sudo ./pcctl install"
fi

# -----------------------------------------------------------------------------
# n8n
# -----------------------------------------------------------------------------
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:5678/healthz" 2>/dev/null || echo 000)"
if [[ "$code" == "200" ]]; then
  record_check PASS N8N-001 "n8n answers on 127.0.0.1:5678" "HTTP 200"
else
  record_check FAIL N8N-001 "n8n health returned HTTP ${code}" ""
fi

# n8n must be using PostgreSQL, not SQLite. A database.sqlite file in its data
# directory means the Postgres configuration silently failed.
if [[ -f "${PC_ROOT}/data/n8n/database.sqlite" ]]; then
  record_check FAIL N8N-002 "n8n created a SQLite database" "DB_TYPE did not take effect"
else
  record_check PASS N8N-002 "n8n is not using SQLite" ""
fi

if [[ -n "$(container_id postgres)" ]] && is_root; then
  n8n_tables="$(psql_super n8n "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" || echo 0)"
  if [[ "${n8n_tables:-0}" -gt 0 ]]; then
    record_check PASS N8N-003 "n8n has created its schema in PostgreSQL" "${n8n_tables} table(s)"
  else
    record_check WARN N8N-003 "n8n has no tables in PostgreSQL yet" "expected after first start"
  fi
fi

# Encryption key persistence: the file n8n writes must exist and be private.
if [[ -f "${PC_ROOT}/data/n8n/config" ]]; then
  cfg_mode="$(stat -c '%a' "${PC_ROOT}/data/n8n/config")"
  if [[ "$cfg_mode" == "600" ]]; then
    record_check PASS N8N-004 "n8n config file is private" "mode 600"
  else
    record_check WARN N8N-004 "n8n config file mode is ${cfg_mode}" "expected 600"
  fi
fi

# -----------------------------------------------------------------------------
# Artifact store
# -----------------------------------------------------------------------------
if [[ -d "${PC_ROOT}/data/artifacts/objects" && -d "${PC_ROOT}/data/artifacts/temporary" ]]; then
  record_check PASS ART-001 "Artifact directory layout is present" ""
  object_count="$(find "${PC_ROOT}/data/artifacts/objects" -type f 2>/dev/null | wc -l | tr -d ' ')"
  record_check PASS ART-002 "Artifact objects counted" "${object_count} object(s)"

  # Every stored object's filename must equal the SHA-256 of its content. This
  # is the integrity guarantee of the whole store, so it is verified rather than
  # assumed.
  mismatches=0; checked=0
  while IFS= read -r object; do
    (( checked >= 25 )) && break
    expected="$(basename "$object")"
    actual="$(sha256sum "$object" 2>/dev/null | cut -d' ' -f1)"
    [[ "$expected" == "$actual" ]] || mismatches=$((mismatches+1))
    checked=$((checked+1))
  done < <(find "${PC_ROOT}/data/artifacts/objects" -type f 2>/dev/null)

  if (( checked == 0 )); then
    record_check SKIP ART-003 "Artifact content integrity" "no objects stored yet"
  elif (( mismatches == 0 )); then
    record_check PASS ART-003 "Artifact content matches its digest" "${checked} object(s) verified"
  else
    record_check FAIL ART-003 "Artifact content does not match its digest" "${mismatches}/${checked} corrupt"
  fi

  # Nothing should be left in the staging area.
  staging="$(find "${PC_ROOT}/data/artifacts/temporary" -type f 2>/dev/null | wc -l | tr -d ' ')"
  if (( staging == 0 )); then
    record_check PASS ART-004 "Artifact staging area is clean" ""
  else
    record_check WARN ART-004 "${staging} stale staging file(s)" "swept automatically every 30 min"
  fi
else
  record_check FAIL ART-001 "Artifact directories are missing" ""
fi

# -----------------------------------------------------------------------------
# Tailscale
# -----------------------------------------------------------------------------
if have tailscale; then
  if ts_json="$(tailscale status --json 2>/dev/null)"; then
    backend="$(printf '%s' "$ts_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("BackendState",""))' 2>/dev/null || echo '')"
    dns="$(printf '%s' "$ts_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || echo '')"
    if [[ "$backend" == "Running" ]]; then
      record_check PASS TS-001 "Tailscale is connected" "${dns:-unknown}"
    else
      record_check FAIL TS-001 "Tailscale is not running" "state=${backend:-unknown} — checkpoint 1 pending"
    fi
  else
    record_check FAIL TS-001 "tailscale status is unavailable" "checkpoint 1 pending"
  fi

  if serve_json="$(tailscale serve status --json 2>/dev/null)"; then
    if printf '%s' "$serve_json" | grep -q '8780'; then
      record_check PASS TS-002 "Tailscale Serve routes the portal to 127.0.0.1:8780" ""
    else
      record_check FAIL TS-002 "Tailscale Serve is not routing the portal" "run: sudo ./pcctl configure-tailscale"
    fi
    if printf '%s' "$serve_json" | grep -q '5678'; then
      record_check PASS TS-003 "Tailscale Serve routes n8n to 127.0.0.1:5678" ""
    else
      record_check FAIL TS-003 "Tailscale Serve is not routing n8n on :8443" "run: sudo ./pcctl configure-tailscale"
    fi
    # Funnel exposes a service to the public internet, which this design forbids.
    if printf '%s' "$serve_json" | grep -qi '"funnel"[[:space:]]*:[[:space:]]*true\|AllowFunnel'; then
      record_check FAIL TS-004 "Tailscale Funnel appears to be enabled" "Funnel publishes to the public internet and must not be used"
    else
      record_check PASS TS-004 "Tailscale Funnel is not enabled" ""
    fi
  else
    record_check WARN TS-002 "tailscale serve status unavailable" "may require root"
  fi
else
  record_check FAIL TS-001 "Tailscale is not installed" "the portal has no supported access path without it"
fi

# -----------------------------------------------------------------------------
# Backup configuration
# -----------------------------------------------------------------------------
if secret_exists restic_password && [[ -f "${PC_ROOT}/config/rclone.conf" ]]; then
  record_check PASS BAK-001 "Backup credentials are configured" ""
  if [[ -f "${PC_ROOT}/config/status/backup-status.json" ]]; then
    last="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("lastResult","never"))' \
             "${PC_ROOT}/config/status/backup-status.json" 2>/dev/null || echo unknown)"
    if [[ "$last" == "success" ]]; then
      record_check PASS BAK-002 "Last backup succeeded" ""
    else
      record_check WARN BAK-002 "Last backup result: ${last}" "run: sudo ./pcctl backup"
    fi
  else
    record_check WARN BAK-002 "No backup has run yet" "run: sudo ./pcctl backup"
  fi
else
  record_check WARN BAK-001 "MANUAL_CONFIGURATION_REQUIRED: backup" "run: sudo ./pcctl configure-google-drive"
fi

for timer in project-control-backup.timer project-control-check.timer project-control-restore-test.timer; do
  if systemctl is-enabled --quiet "$timer" 2>/dev/null; then
    record_check PASS BAK-003 "Timer ${timer} is enabled" ""
  else
    record_check WARN BAK-003 "Timer ${timer} is not enabled" "systemctl enable --now ${timer}"
  fi
done

# -----------------------------------------------------------------------------
# Telegram
# -----------------------------------------------------------------------------
if secret_exists telegram_bot_token && secret_exists telegram_chat_id; then
  record_check PASS TG-001 "Telegram credentials are configured" ""
else
  record_check WARN TG-001 "MANUAL_CONFIGURATION_REQUIRED: Telegram" "run: sudo ./pcctl configure-telegram"
fi

# -----------------------------------------------------------------------------
# Log rotation
# -----------------------------------------------------------------------------
for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  [[ -n "$cid" ]] || continue
  driver="$(docker inspect --format '{{.HostConfig.LogConfig.Type}}' "$cid" 2>/dev/null || echo '')"
  max_size="$(docker inspect --format '{{index .HostConfig.LogConfig.Config "max-size"}}' "$cid" 2>/dev/null || echo '')"
  if [[ "$driver" == "json-file" && -n "$max_size" ]]; then
    record_check PASS LOG-001 "${service} has bounded logs" "${driver}, max-size ${max_size}"
  else
    record_check FAIL LOG-001 "${service} has unbounded logs" "driver=${driver} max-size=${max_size:-unset}"
  fi
done

# -----------------------------------------------------------------------------
# Resource limits
# -----------------------------------------------------------------------------
for service in "${SERVICES[@]}"; do
  cid="$(container_id "$service")"
  [[ -n "$cid" ]] || continue
  mem="$(docker inspect --format '{{.HostConfig.Memory}}' "$cid" 2>/dev/null || echo 0)"
  pids="$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$cid" 2>/dev/null || echo 0)"
  if [[ "${mem:-0}" -gt 0 && "${pids:-0}" -gt 0 ]]; then
    record_check PASS RES-001 "${service} has memory and PID limits" "$((mem / 1024 / 1024)) MiB, ${pids} pids"
  else
    record_check FAIL RES-001 "${service} is missing a resource limit" "memory=${mem} pids=${pids}"
  fi
done

# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
if (( JSON )); then
  exec 2>&3
  emit_checks_json
else
  print_check_summary
  if (( PC_CHECK_FAIL > 0 )); then
    log_error "verification FAILED with ${PC_CHECK_FAIL} issue(s)"
  else
    log_ok "verification passed"
    if (( PC_CHECK_WARN > 0 )); then
      log_warn "${PC_CHECK_WARN} warning(s) — usually pending manual checkpoints"
    fi
  fi
fi

(( PC_CHECK_FAIL == 0 ))
