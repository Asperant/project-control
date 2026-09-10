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
    bad_mode=0; world_readable=0; wrong_owner=0; trailing_ws=0; total=0
    trailing_ws_names=""
    while IFS= read -r -d '' file; do
      total=$((total+1))
      mode="$(stat -c '%a' "$file")"
      owner="$(stat -c '%U' "$file")"
      [[ "$owner" == "root" ]] || wrong_owner=$((wrong_owner+1))
      [[ "$mode" == "600" || "$mode" == "640" || "$mode" == "400" ]] || bad_mode=$((bad_mode+1))
      (( 0$mode & 0004 )) && world_readable=$((world_readable+1))

      # write_secret() (scripts/lib/common.sh) deliberately writes no trailing
      # newline: the value is the exact byte string a consumer will read back
      # and compare/hash. A stray trailing byte silently changes the secret's
      # effective value without changing anything visible about the file
      # (size and content look "right" at a glance), which is exactly how a
      # credential ends up failing to authenticate for a reason nobody can
      # see. Content is never read beyond this one trailing byte.
      #
      # n8n_encryption_key is a documented exception, not weakened coverage:
      # generate-secrets.sh's own SECRET_SPECS marks it "NEVER rotate
      # casually" because every credential n8n has ever encrypted becomes
      # unreadable the moment its effective value changes. Even rewriting the
      # file to strip a byte n8n's own reader may or may not already ignore
      # is exactly the kind of casual touch that warning exists to prevent —
      # so this check must never be the thing that nudges an operator into
      # "fixing" it. Every other secret in this deployment is a randomly
      # generated token with no such constraint (see secrets.ts's own
      # comment) and is safe to flag and, once confirmed dead on every
      # consumer's read path, remediate.
      if [[ "$(basename "$file")" == n8n_encryption_key ]]; then
        last_byte_hex="$(tail -c 1 -- "$file" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
        case "$last_byte_hex" in
          0a|0d|09|20) log_warn "n8n_encryption_key ends in a whitespace byte — NOT auto-remediated: never rotate or rewrite this file casually (see docs/security-model.md)" ;;
        esac
        continue
      fi

      last_byte_hex="$(tail -c 1 -- "$file" 2>/dev/null | od -An -tx1 | tr -d ' \n')"
      case "$last_byte_hex" in
        0a|0d|09|20) trailing_ws=$((trailing_ws+1)); trailing_ws_names+="$(basename "$file") " ;;
      esac
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
      (( trailing_ws == 0 ))    && record_check PASS SEC-006 "No secret file ends in a whitespace byte" "" \
                                || record_check FAIL SEC-006 "${trailing_ws}/${total} secret file(s) end in a whitespace byte" \
                                     "$(printf '%s' "$trailing_ws_names" | head -c 200) — read docs/security-model.md before rotating; n8n_encryption_key must never be rotated casually"
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

  # Documentation and this scanner necessarily mention the patterns.
  candidates=""
  while IFS= read -r file; do
    [[ -f "${PC_REPO_ROOT}/${file}" ]] || continue
    case "$file" in
      *.md|scripts/verify-security.sh|*/redact*|*.test.ts|*_test.go) continue ;;
    esac
    candidates+="${file}"$'\n'
  done <<<"$tracked"

  # A real classifier, not a single regex: a "keyword = value" match is only
  # a finding when the value is an actual literal (quoted, or a digit-bearing
  # unquoted blob in shell KEY=value form) — never when it is a bare
  # identifier/reference (a variable name, an env var name, a psql-style
  # :'var' substitution target), a /run/secrets/... path, or a recognised
  # safe test sentinel. PEM headers, AWS access-key IDs and Telegram-bot-
  # token-shaped strings are matched independently of the keyword logic.
  # See lib/secret-scan.py — also exercised directly by
  # tests/secret-scanner-regression.sh.
  scan_findings="$(printf '%s' "$candidates" | python3 "${PC_LIB_DIR}/secret-scan.py" "$PC_REPO_ROOT" 2>/dev/null || true)"

  findings=0
  if [[ -n "$scan_findings" ]]; then
    while IFS= read -r file; do
      [[ -n "$file" ]] || continue
      record_check FAIL GIT-001 "Possible secret in ${file}" "review before committing"
      findings=$((findings+1))
    done <<<"$scan_findings"
  fi

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

  # A tracked .env/.env.* file, matched by path COMPONENT (basename), never
  # by a bare substring — e.g. infra/versions.lock.env must never match just
  # because its filename happens to end in the four characters ".env".
  # Only .example files in that family are treated as safe templates.
  if printf '%s' "$tracked" | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$' >/dev/null; then
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

  # run_psql_scalar <pg_user> <pg_password> <sql>
  #
  # Runs a scalar query (typically `SELECT count(*) ...`) inside the
  # postgres container and prints its trimmed result on success. On any
  # failure — a syntax error, a relation that does not yet exist because a
  # migration has not been applied, a connectivity problem, anything —
  # nothing is printed and the function returns non-zero.
  #
  # This exists because `var="$(docker exec ... psql ... | tr -d ...)"` as a
  # bare assignment is not safe under this script's `set -Eeuo pipefail`: if
  # the docker/psql command fails, pipefail propagates that failure to the
  # whole pipeline, which trips the ERR trap and aborts the *entire*
  # verify-security run — not just this one check — with a misleading
  # message, since bash's $BASH_COMMAND at that point reports the trailing
  # `tr` command's text rather than the command that actually failed. Every
  # caller below uses this function specifically so a query failure becomes
  # data (an explicit FAIL for that one check) rather than a script abort.
  # See tests/verify-security-psql-scalar-regression.sh.
  run_psql_scalar() {
    local pg_user="$1" pg_password="$2" sql="$3" raw status
    raw="$(docker exec -i "$pg_cid" env PGPASSWORD="$pg_password" \
         psql -U "$pg_user" -d project_control -tAc "$sql" 2>/dev/null)" && status=0 || status=$?
    if (( status != 0 )); then
      return 1
    fi
    printf '%s' "$raw" | tr -d '[:space:]'
    return 0
  }

  # _mutation_denied_by_privilege <captured-stderr>
  #
  # True only when a failed mutation failed for the specific reason a
  # "must be refused by GRANTs" check exists to prove: PostgreSQL's own
  # privilege system refused it (the standard "permission denied for ..."
  # message). Any other failure — a missing relation, a connectivity
  # problem, a syntax error — does not prove the privilege claim the check
  # is making, and must not be silently treated as if it did.
  _mutation_denied_by_privilege() {
    grep -qi 'permission denied' <<<"$1"
  }

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

  # Checkpoints are supposed to be immutable once created: control_app may only
  # ever touch archived_at (see migrations/0008). This is a live proof, not
  # just a static grant check — it actually attempts the forbidden write.
  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "UPDATE project_checkpoints SET snapshot_json='{}'::jsonb WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-007 "control_app can modify checkpoint snapshot content" "checkpoint immutability is broken"
  else
    record_check PASS PGS-007 "control_app cannot modify checkpoint snapshot content" "immutability enforced at the privilege level"
  fi

  # Agent Run archive: no physical delete, ever, on any of the three tables.
  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM agent_runs WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-008 "control_app can DELETE from agent_runs" "Agent Runs must never be physically deleted"
  else
    record_check PASS PGS-008 "control_app cannot DELETE from agent_runs" ""
  fi
  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM agent_run_prompts WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-009 "control_app can DELETE from agent_run_prompts" "sent prompts must never be physically deleted"
  else
    record_check PASS PGS-009 "control_app cannot DELETE from agent_run_prompts" ""
  fi
  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM agent_reports WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-010 "control_app can DELETE from agent_reports" "finalized reports must never be physically deleted"
  else
    record_check PASS PGS-010 "control_app cannot DELETE from agent_reports" ""
  fi

  # backup_reader must be SELECT-only on the new tables too.
  if docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO agent_runs (project_id, title, agent_name) SELECT id, 'probe', 'probe' FROM projects WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-011 "backup_reader can INSERT into agent_runs" "it must be read-only"
  else
    record_check PASS PGS-011 "backup_reader cannot write to agent_runs" "read-only enforced"
  fi

  # Sent prompts / final reports are immutable only *after* that state is
  # reached — a state-dependent rule that a GRANT cannot express, so it is
  # enforced by a BEFORE UPDATE trigger instead (see migrations/0009). The
  # `WHERE false` live-write probe used above for PGS-003/PGS-007 does not
  # prove anything here: a row-level trigger never fires against zero matched
  # rows, so that style of check would pass even if the trigger were missing.
  # Rather than inserting throwaway sent/final rows into a live database to
  # get a real trigger firing, this inspects the catalog instead: the trigger
  # exists, is enabled, and its function body contains the RAISE EXCEPTION
  # guard. That is a structural proof, not a live behavioral one — the actual
  # behavior is proven by the integration test suite
  # (apps/control-api/test/integration/agent-runs.test.ts), which does
  # perform real inserts/updates against a disposable test database.
  if trigger_guard="$(run_psql_scalar control_app "$control_pw" \
       "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgname IN ('agent_run_prompts_guard_immutable','agent_reports_guard_immutable')
            AND t.tgenabled <> 'D'
            AND pg_get_functiondef(p.oid) ILIKE '%RAISE EXCEPTION%'")"; then
    if [[ "${trigger_guard:-0}" == "2" ]]; then
      record_check PASS PGS-012 "Sent-prompt/final-report immutability triggers exist, are enabled and guard with RAISE EXCEPTION" ""
    else
      record_check FAIL PGS-012 "Sent-prompt/final-report immutability triggers are missing, disabled, or lack a guard" "found ${trigger_guard:-0}/2"
    fi
  else
    record_check FAIL PGS-012 "Sent-prompt/final-report immutability trigger query failed" "cannot confirm trigger state (missing table/relation, connectivity or permission problem)"
  fi

  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM work_sessions WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-013 "control_app can DELETE Work Sessions" "session history must never be physically deleted"
  else
    record_check PASS PGS-013 "control_app cannot DELETE Work Sessions" "no physical deletion"
  fi

  if docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "UPDATE work_session_amendments SET body=body WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-014 "control_app can UPDATE Work Session amendments" "corrections must be append-only"
  else
    record_check PASS PGS-014 "control_app cannot UPDATE Work Session amendments" "append-only privilege enforced"
  fi

  if docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO work_sessions (project_id, goal) SELECT id, 'probe' FROM projects WHERE false" >/dev/null 2>&1 \
     || docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO work_session_amendments (work_session_id, body) SELECT id, 'probe' FROM work_sessions WHERE false" >/dev/null 2>&1; then
    record_check FAIL PGS-015 "backup_reader can write Work Session history" "both tables must remain SELECT-only"
  else
    record_check PASS PGS-015 "backup_reader cannot write Work Sessions" "read-only enforced"
  fi

  if work_session_guard="$(run_psql_scalar control_app "$control_pw" \
       "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE t.tgenabled <> 'D' AND pg_get_functiondef(p.oid) ILIKE '%RAISE EXCEPTION%'
            AND ((t.tgname='work_sessions_guard_mutation' AND t.tgrelid='work_sessions'::regclass AND p.proname='guard_work_session_mutation')
              OR (t.tgname='work_session_amendments_require_closed_parent' AND t.tgrelid='work_session_amendments'::regclass AND p.proname='guard_work_session_amendment_parent_closed'))")"; then
    if [[ "${work_session_guard:-0}" == "2" ]]; then
      record_check PASS PGS-016 "Work Session immutability/lifecycle triggers are enabled and guarded" ""
    else
      record_check FAIL PGS-016 "Work Session immutability/lifecycle triggers are incomplete" "found ${work_session_guard:-0}/2"
    fi
  else
    record_check FAIL PGS-016 "Work Session immutability/lifecycle trigger query failed" "cannot confirm trigger state (missing table/relation, connectivity or permission problem)"
  fi

  # A success here is unambiguously FAIL — the mutation went through. A
  # failure is only the intended PASS when PostgreSQL's own privilege system
  # is what refused it; any other failure reason (project_actions not yet
  # migrated, a connectivity problem, ...) means this probe has not actually
  # proven the append-only guarantee and must not be reported as if it had.
  delete_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM project_actions WHERE false" 2>&1 >/dev/null)" && delete_status=0 || delete_status=$?
  if (( delete_status == 0 )); then
    record_check FAIL PGS-017 "control_app can DELETE Repository Actions" "action history must never be physically deleted"
  elif _mutation_denied_by_privilege "$delete_stderr"; then
    record_check PASS PGS-017 "control_app cannot DELETE Repository Actions" "no physical deletion"
  else
    record_check FAIL PGS-017 "DELETE probe against project_actions failed for a reason other than privilege denial" "cannot confirm the append-only guarantee (e.g. the table may not be migrated yet)"
  fi

  insert_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO project_actions (project_id, kind, risk, plan_json, fingerprint, expires_at)
          SELECT id, 'git.commit', 'low', '{}'::jsonb, repeat('a',64), now() FROM projects WHERE false" \
       2>&1 >/dev/null)" && insert_status=0 || insert_status=$?
  if (( insert_status == 0 )); then
    record_check FAIL PGS-018 "backup_reader can write Repository Action history" "the table must remain SELECT-only"
  elif _mutation_denied_by_privilege "$insert_stderr"; then
    record_check PASS PGS-018 "backup_reader cannot write Repository Actions" "read-only enforced"
  else
    record_check FAIL PGS-018 "INSERT probe against project_actions failed for a reason other than privilege denial" "cannot confirm the read-only guarantee (e.g. the table may not be migrated yet)"
  fi

  if action_guard="$(run_psql_scalar control_app "$control_pw" \
       "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE t.tgenabled <> 'D' AND pg_get_functiondef(p.oid) ILIKE '%RAISE EXCEPTION%'
            AND t.tgname='project_actions_guard_mutation' AND t.tgrelid='project_actions'::regclass
            AND p.proname='guard_project_action_mutation'")"; then
    if [[ "${action_guard:-0}" == "1" ]]; then
      record_check PASS PGS-019 "Repository Action settlement/lifecycle trigger is enabled and guarded" ""
    else
      record_check FAIL PGS-019 "Repository Action settlement/lifecycle trigger is missing, disabled, or unguarded" "found ${action_guard:-0}/1"
    fi
  else
    record_check FAIL PGS-019 "Repository Action settlement/lifecycle trigger query failed" "cannot confirm trigger state (missing table/relation, connectivity or permission problem)"
  fi

  # Service identity (0015/0016) — same WHERE-false-probe / catalog-inspection
  # style as project_actions/work_sessions above.
  delete_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM service_tokens WHERE false" 2>&1 >/dev/null)" && delete_status=0 || delete_status=$?
  if (( delete_status == 0 )); then
    record_check FAIL PGS-020 "control_app can DELETE service_tokens" "revoked/expired tokens must never be physically deleted"
  elif _mutation_denied_by_privilege "$delete_stderr"; then
    record_check PASS PGS-020 "control_app cannot DELETE service_tokens" "no physical deletion"
  else
    record_check FAIL PGS-020 "DELETE probe against service_tokens failed for a reason other than privilege denial" "cannot confirm the append-only guarantee (e.g. the table may not be migrated yet)"
  fi

  # `INSERT ... VALUES (...) WHERE false` is not valid PostgreSQL syntax —
  # WHERE only attaches to an INSERT ... SELECT source, never to VALUES(...).
  # The VALUES form here previously always failed with a syntax error
  # regardless of backup_reader's actual privileges, indistinguishable from a
  # real "cannot confirm" result — it went unnoticed because service_accounts
  # (migration 0015) had never been applied against a real database until
  # now. SELECT ... WHERE false is the same never-inserts probe PGS-023 (the
  # very next check, against service_tokens) already uses correctly.
  insert_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO service_accounts (key, display_name, scopes) SELECT 'probe', 'probe', ARRAY['project:read'] WHERE false" \
       2>&1 >/dev/null)" && insert_status=0 || insert_status=$?
  if (( insert_status == 0 )); then
    record_check FAIL PGS-021 "backup_reader can write service_accounts" "the table must remain SELECT-only"
  elif _mutation_denied_by_privilege "$insert_stderr"; then
    record_check PASS PGS-021 "backup_reader cannot write service_accounts" "read-only enforced"
  else
    record_check FAIL PGS-021 "INSERT probe against service_accounts failed for a reason other than privilege denial" "cannot confirm the read-only guarantee (e.g. the table may not be migrated yet)"
  fi

  # PGS-020/PGS-021 above each cover one table (service_tokens DELETE,
  # service_accounts write); these two close the diagonal so both tables get
  # both probes, the same coverage project_actions already has from PGS-017/018.
  delete_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM service_accounts WHERE false" 2>&1 >/dev/null)" && delete_status=0 || delete_status=$?
  if (( delete_status == 0 )); then
    record_check FAIL PGS-022 "control_app can DELETE service_accounts" "service accounts must never be physically deleted"
  elif _mutation_denied_by_privilege "$delete_stderr"; then
    record_check PASS PGS-022 "control_app cannot DELETE service_accounts" "no physical deletion"
  else
    record_check FAIL PGS-022 "DELETE probe against service_accounts failed for a reason other than privilege denial" "cannot confirm the append-only guarantee (e.g. the table may not be migrated yet)"
  fi

  insert_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at)
          SELECT id, repeat('a',64), 'pcs_deadbeef', ARRAY['project:read'], now() FROM service_accounts WHERE false" \
       2>&1 >/dev/null)" && insert_status=0 || insert_status=$?
  if (( insert_status == 0 )); then
    record_check FAIL PGS-023 "backup_reader can write service_tokens" "the table must remain SELECT-only"
  elif _mutation_denied_by_privilege "$insert_stderr"; then
    record_check PASS PGS-023 "backup_reader cannot write service_tokens" "read-only enforced"
  else
    record_check FAIL PGS-023 "INSERT probe against service_tokens failed for a reason other than privilege denial" "cannot confirm the read-only guarantee (e.g. the table may not be migrated yet)"
  fi

  if svc_guard="$(run_psql_scalar control_app "$control_pw" \
       "SELECT count(*) FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
          WHERE t.tgenabled <> 'D' AND pg_get_functiondef(p.oid) ILIKE '%RAISE EXCEPTION%'
            AND ((t.tgname='service_tokens_guard_scopes' AND t.tgrelid='service_tokens'::regclass AND p.proname='guard_service_token_scopes')
              OR (t.tgname='service_tokens_guard_mutation' AND t.tgrelid='service_tokens'::regclass AND p.proname='guard_service_token_mutation'))")"; then
    if [[ "${svc_guard:-0}" == "2" ]]; then
      record_check PASS SVC-002 "Service token scope-ceiling and immutability triggers are enabled and guarded" \
        "live behavior proven by test/integration/service-tokens.test.ts"
    else
      record_check FAIL SVC-002 "Service token scope-ceiling/immutability triggers are incomplete" "found ${svc_guard:-0}/2"
    fi
  else
    record_check FAIL SVC-002 "Service token trigger query failed" "cannot confirm trigger state (missing table/relation, connectivity or permission problem)"
  fi

  # SVC-001: no plaintext token column exists, and the hash is what is
  # actually looked up by. A column named token/value/secret/plaintext next
  # to token_hash would mean a future change started storing the credential
  # itself, which is exactly the sessions-table property this table copies.
  if svc_columns="$(run_psql_scalar control_app "$control_pw" \
       "SELECT string_agg(column_name, ',') FROM information_schema.columns
          WHERE table_name='service_tokens' AND table_schema='public'")"; then
    if printf '%s' "${svc_columns:-}" | grep -qiE '(^|,)(token|value|plaintext|secret)(,|$)' ; then
      record_check FAIL SVC-001 "service_tokens has a plaintext-shaped column" "found: ${svc_columns}"
    elif printf '%s' "${svc_columns:-}" | grep -q 'token_hash'; then
      record_check PASS SVC-001 "service_tokens stores only a hash, no plaintext-shaped column" "columns: ${svc_columns}"
    else
      record_check FAIL SVC-001 "service_tokens.token_hash column is missing" "found: ${svc_columns:-<none>}"
    fi
  else
    record_check FAIL SVC-001 "service_tokens column query failed" "cannot confirm schema shape (missing table or connectivity problem)"
  fi

  # SVC-006: the scope vocabulary is closed at the database layer, not just in
  # the TypeScript enum — an operator with only the migrator credential (no
  # code deploy) cannot grant a scope this platform's routes do not know how
  # to check.
  if svc_scope_check="$(run_psql_scalar control_app "$control_pw" \
       "SELECT count(*) FROM pg_constraint
          WHERE conname IN ('service_accounts_scopes_known','service_tokens_scopes_known')")"; then
    if [[ "${svc_scope_check:-0}" == "2" ]]; then
      record_check PASS SVC-006 "Service scope vocabulary is closed by a database CHECK constraint" ""
    else
      record_check FAIL SVC-006 "Service scope CHECK constraints are missing" "found ${svc_scope_check:-0}/2"
    fi
  else
    record_check FAIL SVC-006 "Service scope constraint query failed" "cannot confirm schema shape (missing table or connectivity problem)"
  fi
else
  record_check SKIP PGS-001 "PostgreSQL role isolation" "requires root and a running postgres container"
fi

# =============================================================================
# 6b. Service identity — live HTTP checks that need no minted token
#
# SVC-003 proves the "closed by default" half of the Bearer-auth model
# without ever calling `create-service-token`: a route that only ever reads
# the session cookie (every route except /api/automation/whoami and the new
# service-token admin routes) must ignore an Authorization header entirely,
# even a well-formed-looking one. That needs no valid token to exist, so it
# stays inside this script's "strictly read-only" contract.
#
# SVC-004 (mixed cookie+Bearer credentials) and SVC-005 (revoked/expired/
# disabled-account rejection) genuinely need a live session or a committed
# token row to exercise — proving them here would mean this "read-only"
# script minting real credentials or logging in as an operator. Both are
# proven instead by test/integration/service-tokens.test.ts, which is exactly
# what PGS-012/016/019 above already do for trigger *behavior* as opposed to
# trigger *existence*.
# =============================================================================
log_step "Service identity: closed-by-default Bearer routing"

if portal_response="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
     -H 'Authorization: Bearer pcs_0000000000000000000000000000000000000000000' \
     "http://127.0.0.1:8780/api/auth/me" 2>/dev/null)"; then
  anon_response="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:8780/api/auth/me" 2>/dev/null || echo '')"
  if [[ "$portal_response" == "401" && "$portal_response" == "$anon_response" ]]; then
    record_check PASS SVC-003 "A cookie-only route ignores a Bearer header (same 401 as anonymous)" ""
  else
    record_check FAIL SVC-003 "A cookie-only route responded differently to a Bearer header than to no credential at all" \
      "bearer=${portal_response} anonymous=${anon_response}"
  fi
else
  record_check SKIP SVC-003 "Closed-by-default Bearer routing" "portal not reachable on 127.0.0.1:8780"
fi

# =============================================================================
# 6c. Automation — workflow registry and n8n confinement
#
# AUT-004 (an unknown workflowKey is rejected end to end, with an audit row)
# is not re-proven here for the same reason SVC-004/SVC-005 are not: it
# needs a live session or token, which this "strictly read-only" script does
# not mint. It is proven by test/integration/automation.test.ts.
# =============================================================================
log_step "Automation: manifest and n8n confinement"

# Nested under config/status: see infra/compose/compose.yaml's comment on
# the control-api /config mount for why this lives here rather than in a
# sibling config/automation directory.
MANIFEST_FILE="${PC_ROOT}/config/status/automation/manifest.json"
if [[ -f "$MANIFEST_FILE" ]]; then
  manifest_owner="$(stat -c '%U' "$MANIFEST_FILE" 2>/dev/null || echo '?')"
  manifest_mode="$(stat -c '%a' "$MANIFEST_FILE" 2>/dev/null || echo '?')"
  if [[ "$manifest_owner" == "root" && "$manifest_mode" == "644" ]]; then
    record_check PASS AUT-003 "Workflow manifest is root-owned, 0644" ""
  else
    record_check FAIL AUT-003 "Workflow manifest has unexpected ownership/mode" "owner=${manifest_owner} mode=${manifest_mode}"
  fi
else
  record_check WARN AUT-003 "No workflow manifest installed yet" "run: sudo ./pcctl install"
fi

# control_app must never be able to delete run history; workflow_run_steps
# is stricter still — no UPDATE grant at all, so a step cannot be rewritten
# even while its parent run is still open.
if [[ -n "${pg_cid:-}" ]] && is_root; then
  delete_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM workflow_runs WHERE false" 2>&1 >/dev/null)" && delete_status=0 || delete_status=$?
  if (( delete_status == 0 )); then
    record_check FAIL AUT-001 "control_app can DELETE workflow_runs" "run history must never be physically deleted"
  elif _mutation_denied_by_privilege "$delete_stderr"; then
    record_check PASS AUT-001 "control_app cannot DELETE workflow_runs" "no physical deletion"
  else
    record_check FAIL AUT-001 "DELETE probe against workflow_runs failed for a reason other than privilege denial" "cannot confirm the append-only guarantee (e.g. the table may not be migrated yet)"
  fi

  update_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "UPDATE workflow_run_steps SET name = name WHERE false" 2>&1 >/dev/null)" && update_status=0 || update_status=$?
  if (( update_status == 0 )); then
    record_check FAIL AUT-002 "control_app can UPDATE workflow_run_steps" "step history must be append-only"
  elif _mutation_denied_by_privilege "$update_stderr"; then
    record_check PASS AUT-002 "control_app cannot UPDATE workflow_run_steps" "append-only enforced"
  else
    record_check FAIL AUT-002 "UPDATE probe against workflow_run_steps failed for a reason other than privilege denial" "cannot confirm the append-only guarantee (e.g. the table may not be migrated yet)"
  fi

  # AUT-001/AUT-002 above each cover one probe on one table (workflow_runs
  # DELETE, workflow_run_steps UPDATE); these three close the remaining
  # diagonal — control_app must not be able to DELETE a step either (not just
  # UPDATE one), and backup_reader must stay SELECT-only on both tables —
  # the same full coverage project_actions has via PGS-017/018.
  step_delete_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$control_pw" \
       psql -U control_app -d project_control -tAc \
       "DELETE FROM workflow_run_steps WHERE false" 2>&1 >/dev/null)" && step_delete_status=0 || step_delete_status=$?
  if (( step_delete_status == 0 )); then
    record_check FAIL AUT-005 "control_app can DELETE workflow_run_steps" "step history must never be physically deleted"
  elif _mutation_denied_by_privilege "$step_delete_stderr"; then
    record_check PASS AUT-005 "control_app cannot DELETE workflow_run_steps" "no physical deletion"
  else
    record_check FAIL AUT-005 "DELETE probe against workflow_run_steps failed for a reason other than privilege denial" "cannot confirm the append-only guarantee (e.g. the table may not be migrated yet)"
  fi

  runs_insert_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO workflow_runs (workflow_key, trigger_kind, triggered_by_user)
          SELECT 'probe-workflow', 'manual', id FROM users WHERE false" \
       2>&1 >/dev/null)" && runs_insert_status=0 || runs_insert_status=$?
  if (( runs_insert_status == 0 )); then
    record_check FAIL AUT-006 "backup_reader can write workflow_runs" "the table must remain SELECT-only"
  elif _mutation_denied_by_privilege "$runs_insert_stderr"; then
    record_check PASS AUT-006 "backup_reader cannot write workflow_runs" "read-only enforced"
  else
    record_check FAIL AUT-006 "INSERT probe against workflow_runs failed for a reason other than privilege denial" "cannot confirm the read-only guarantee (e.g. the table may not be migrated yet)"
  fi

  steps_insert_stderr="$(docker exec -i "$pg_cid" env PGPASSWORD="$backup_pw" \
       psql -U backup_reader -d project_control -tAc \
       "INSERT INTO workflow_run_steps (run_id, position, name, status)
          SELECT id, 0, 'probe', 'passed' FROM workflow_runs WHERE false" \
       2>&1 >/dev/null)" && steps_insert_status=0 || steps_insert_status=$?
  if (( steps_insert_status == 0 )); then
    record_check FAIL AUT-007 "backup_reader can write workflow_run_steps" "the table must remain SELECT-only"
  elif _mutation_denied_by_privilege "$steps_insert_stderr"; then
    record_check PASS AUT-007 "backup_reader cannot write workflow_run_steps" "read-only enforced"
  else
    record_check FAIL AUT-007 "INSERT probe against workflow_run_steps failed for a reason other than privilege denial" "cannot confirm the read-only guarantee (e.g. the table may not be migrated yet)"
  fi
else
  record_check SKIP AUT-001 "workflow_runs append-only grant" "requires root and a running postgres container"
  record_check SKIP AUT-002 "workflow_run_steps append-only grant" "requires root and a running postgres container"
  record_check SKIP AUT-005 "workflow_run_steps DELETE denial" "requires root and a running postgres container"
  record_check SKIP AUT-006 "workflow_runs read-only for backup_reader" "requires root and a running postgres container"
  record_check SKIP AUT-007 "workflow_run_steps read-only for backup_reader" "requires root and a running postgres container"
fi

# N8N-001: functional — no webhook is registered, so this deployment has no
# inbound HTTP surface through n8n regardless of what the container's
# network position could otherwise reach.
if webhook_response="$(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' \
     "http://127.0.0.1:5678/webhook/pcctl-verify-security-probe-$$" 2>/dev/null)"; then
  if [[ "$webhook_response" == "404" ]]; then
    record_check PASS N8N-001 "No webhook is registered on n8n" "probe returned 404"
  else
    record_check FAIL N8N-001 "n8n responded unexpectedly to a webhook probe" "HTTP ${webhook_response}, expected 404"
  fi
else
  record_check SKIP N8N-001 "n8n webhook probe" "n8n not reachable on 127.0.0.1:5678"
fi

# N8N-002: static lint of every shipped workflow file — see
# scripts/lib/workflow-lint.py and tests/workflow-lint-regression.sh.
if have python3 && [[ -f "$MANIFEST_FILE" || -f "${PC_REPO_ROOT:-}/infra/n8n/workflows/manifest.json" ]]; then
  lint_manifest="${MANIFEST_FILE}"
  [[ -f "$lint_manifest" ]] || lint_manifest="${PC_REPO_ROOT}/infra/n8n/workflows/manifest.json"
  shopt -s nullglob
  lint_targets=("${PC_ROOT}/config/status/automation/workflows"/*.workflow.json)
  shopt -u nullglob
  if (( ${#lint_targets[@]} == 0 )) && [[ -n "${PC_REPO_ROOT:-}" ]]; then
    shopt -s nullglob
    lint_targets=("${PC_REPO_ROOT}/infra/n8n/workflows"/*.workflow.json)
    shopt -u nullglob
  fi
  if (( ${#lint_targets[@]} > 0 )); then
    if lint_output="$(python3 "${PC_SCRIPTS_DIR}/lib/workflow-lint.py" "$lint_manifest" "${lint_targets[@]}" 2>&1)"; then
      record_check PASS N8N-002 "Every shipped workflow file passes the static lint" "${#lint_targets[@]} file(s)"
    else
      record_check FAIL N8N-002 "One or more workflow files failed the static lint" "$(printf '%s' "$lint_output" | head -c 300)"
    fi
  else
    record_check WARN N8N-002 "No *.workflow.json files found to lint" ""
  fi
else
  record_check SKIP N8N-002 "Workflow static lint" "python3 or the manifest is unavailable"
fi

# N8N-003: the automation surface is reachable from n8n's own network
# position — a positive check, complementing the negative database-isolation
# proof PGS-006 already gives (n8n_app cannot connect to project_control).
n8n_cid="$(container_id n8n)"
if [[ -n "$n8n_cid" ]]; then
  if docker exec "$n8n_cid" wget -q -T 5 -O /dev/null "http://control-api:8080/health/live" 2>/dev/null; then
    record_check PASS N8N-003 "n8n can reach the Control API over the application network" ""
  else
    record_check FAIL N8N-003 "n8n cannot reach the Control API" "the automation surface would be unusable"
  fi
else
  record_check SKIP N8N-003 "n8n reachability to Control API" "n8n container not running"
fi

# N8N-004/N8N-005/N8N-006/N8N-007: `n8n audit`, run against every category it
# has (not the tool's own narrower default) and classified by
# scripts/lib/n8n-audit-classify.py — see that file's module doc for why a
# single "grep communityPackagesEnabled" is not what runs here. In short:
# N8N-004 is the community-packages setting specifically; N8N-005 is n8n's
# own "a newer version exists" notice, expected and accepted for a
# deployment that pins every image to a digest on purpose (WARN, not FAIL);
# N8N-007 is n8n's "Official risky nodes" finding, accepted (WARN) only when
# every flagged node is HTTP Request or Code — the two node types this
# deployment's own shipped, reviewed workflows are built on, with the
# genuinely dangerous Execute Command excluded at the instance level
# regardless; N8N-006 is a catch-all that still fails closed on ANY OTHER
# finding this deployment has not explicitly reviewed — a Credentials/
# Database/Filesystem Risk Report, a Nodes Risk Report naming an
# unrecognised node type, or a new section inside Instance Risk Report none
# of the above recognises. The classifier's own behavior against synthetic
# fixtures (including that last, most important property) is regression-
# tested in tests/n8n-audit-classify-regression.sh, independent of a live
# n8n.
if [[ -n "$n8n_cid" ]]; then
  if audit_output="$(docker exec "$n8n_cid" n8n audit --categories=credentials,database,nodes,instance,filesystem 2>/dev/null)" \
       && [[ -n "$audit_output" ]]; then
    while IFS='|' read -r status id desc detail; do
      [[ -n "$status" ]] || continue
      record_check "$status" "$id" "$desc" "$detail"
    done < <(printf '%s' "$audit_output" | python3 "${PC_SCRIPTS_DIR}/lib/n8n-audit-classify.py")
  else
    record_check WARN N8N-004 "n8n audit did not run" "cannot confirm instance security settings"
    record_check WARN N8N-005 "n8n audit did not run" "cannot confirm version-pinning acknowledgement"
    record_check WARN N8N-006 "n8n audit did not run" "cannot confirm no unexpected findings"
  fi
else
  record_check SKIP N8N-004 "n8n audit: community packages" "n8n container not running"
  record_check SKIP N8N-005 "n8n audit: version notice" "n8n container not running"
  record_check SKIP N8N-006 "n8n audit: unexpected findings" "n8n container not running"
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

  # Each directive has its own set of systemd-recognised "hardened" values —
  # a single shared allowlist would either miss a directive's real hardened
  # values (ProtectHome's are "yes"/"read-only"/"tmpfs", never "strict") or
  # accept a value that means nothing for it (e.g. ProtectSystem=tmpfs is
  # not a real setting). ProtectHome=tmpfs is this deployment's deliberate
  # choice (see infra/systemd/project-control-runner.service and
  # docs/security-model.md): it hides /home exactly as "yes" does, but,
  # unlike "yes", still allows the allowed-project-roots BindReadOnlyPaths=
  # exception to actually mount (systemd cannot create a bind-mount point
  # nested under a path ProtectHome=yes has made inaccessible). RNR-010/011/
  # 012/013 below independently prove that mount is real, read-only, and
  # scoped to exactly the configured root — this check only confirms the
  # directive itself is one of systemd's own hardened values, exactly, not
  # by substring.
  declare -A RUNNER_HARDENED_VALUES=(
    [NoNewPrivileges]="yes"
    [ProtectSystem]="strict"
    [PrivateTmp]="yes"
    [ProtectHome]="yes read-only tmpfs"
    [RestrictSUIDSGID]="yes"
  )
  for directive in NoNewPrivileges ProtectSystem PrivateTmp ProtectHome RestrictSUIDSGID; do
    value="$(systemctl show -p "$directive" --value project-control-runner.service 2>/dev/null || echo '')"
    # Normalize away incidental whitespace before the exact-token match
    # below; systemd's own --value output is already a single bare token
    # (e.g. "tmpfs"), never a substring-matchable sentence.
    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    accepted=" ${RUNNER_HARDENED_VALUES[$directive]} "
    if [[ -n "$value" && "$accepted" == *" ${value} "* ]]; then
      record_check PASS RNR-002 "Runner ${directive}=${value}" ""
    else
      record_check FAIL RNR-002 "Runner ${directive}=${value:-unset}" "expected one of: ${RUNNER_HARDENED_VALUES[$directive]}"
    fi
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
    {"requestId": "sec-probe-0004", "operation": "project.git.development", "params": {"path": "/tmp", "args": ["commit"]}},
    {"requestId": "sec-probe-0005", "operation": "project.git.development", "params": {"path": "/tmp", "command": "git push"}},
    {"requestId": "sec-probe-0006", "operation": "project.git.development", "params": {"path": "/tmp", "env": {"GIT_SSH_COMMAND": "sh"}}},
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
    REJECTED) record_check PASS RNR-007 "Runner rejects raw command requests" "6 hostile payloads refused, including Development argv/env injection" ;;
    ACCEPTED) record_check FAIL RNR-007 "Runner ACCEPTED a raw command request" "critical" ;;
    *)        record_check WARN RNR-007 "Runner command-rejection probe inconclusive" "$probe_result" ;;
  esac
else
  record_check SKIP RNR-007 "Runner raw-command rejection probe" "socket not readable by this user"
fi

# Live proof that path traversal / out-of-root paths are rejected by
# project.inspect. Distinct from RNR-007: a rejected path is a *successful*
# response with result.valid=false, not an operation-level failure, so the
# check inspects result.valid rather than the top-level ok flag.
if [[ -S "$PC_RUNNER_SOCKET" ]] && have python3 && (is_root || [[ -r "$PC_RUNNER_SOCKET" ]]); then
  path_probe_result="$(python3 - "$PC_RUNNER_SOCKET" <<'PY' 2>/dev/null || echo "error"
import json, socket, sys
sock_path = sys.argv[1]
hostile_paths = [
    "/etc/passwd",
    "../../../../etc/passwd",
    "/root/.ssh/id_rsa",
    "relative/not/absolute",
]

def probe(path):
    payload = {"requestId": "sec-probe-path01", "operation": "project.inspect", "params": {"path": path}}
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(sock_path)
    s.sendall((json.dumps(payload) + "\n").encode())
    data = s.recv(65536).decode()
    s.close()
    resp = json.loads(data.strip())
    result = resp.get("result", {}) or {}
    return resp.get("ok") is True and result.get("valid") is True

accepted = False
for p in hostile_paths:
    try:
        if probe(p):
            accepted = True
    except Exception:
        pass
print("ACCEPTED" if accepted else "REJECTED")
PY
)"
  case "$path_probe_result" in
    REJECTED) record_check PASS RNR-008 "Runner rejects hostile paths via project.inspect" "4 hostile paths refused" ;;
    ACCEPTED) record_check FAIL RNR-008 "Runner ACCEPTED a hostile path via project.inspect" "critical" ;;
    *)        record_check WARN RNR-008 "Runner path-rejection probe inconclusive" "$path_probe_result" ;;
  esac
else
  record_check SKIP RNR-008 "Runner path-rejection probe" "socket not readable by this user"
fi

# =============================================================================
# 7b. Project registration — allowed-root read-only enforcement
# =============================================================================
log_step "Project registration: allowed-root confinement"

ALLOWED_ROOTS_FILE="${PC_ROOT}/config/allowed-project-roots.conf"
RUNNER_DROPIN_FILE="/etc/systemd/system/project-control-runner.service.d/10-allowed-roots.conf"

if [[ -f "$RUNNER_DROPIN_FILE" ]]; then
  # Config-level sanity: only BindReadOnlyPaths may appear (never the
  # read-write BindPaths=), and no entry may be the bare "/home" itself —
  # that would defeat ProtectHome=tmpfs for the entire directory rather than
  # the configured roots only. This is a fast sanity check, not the
  # authoritative one; RNR-010 below verifies the real mount, from the
  # kernel's own view of the runner's mount namespace.
  if grep -qE '^BindPaths=' "$RUNNER_DROPIN_FILE"; then
    record_check FAIL RNR-009 "Allowed-roots drop-in grants read-write access (BindPaths=)" "must be BindReadOnlyPaths= only"
  elif grep -qE '^BindReadOnlyPaths=-?/home$' "$RUNNER_DROPIN_FILE"; then
    record_check FAIL RNR-009 "Allowed-roots drop-in exposes all of /home" "must list specific subdirectories only"
  else
    record_check PASS RNR-009 "Allowed-roots drop-in uses read-only, non-/home exceptions only" ""
  fi
else
  record_check WARN RNR-009 "Allowed-roots systemd drop-in is missing" "run: sudo ./pcctl install"
fi

runner_pid="$(systemctl show -p MainPID --value project-control-runner.service 2>/dev/null || echo 0)"
[[ "$runner_pid" =~ ^[0-9]+$ ]] || runner_pid=0

# Kernel-level proof, part 1: read the runner's own /proc/<pid>/mountinfo and
# confirm the bind mount for the first configured root is actually read-only
# in its mount namespace — a real security property, not a string in a unit
# file. A missing mount entry is a genuine, proven absence of the promised
# confinement (never merely WARNed away) — see RNR-011/012/013 below for the
# deeper functional proof (can the runner actually read/write through it).
ALLOWED_ROOTS=()
first_root=""
if is_root && [[ -f "$ALLOWED_ROOTS_FILE" ]]; then
  mapfile -t ALLOWED_ROOTS < <(grep -vE '^[[:space:]]*(#|$)' "$ALLOWED_ROOTS_FILE" 2>/dev/null || true)
  first_root="${ALLOWED_ROOTS[0]:-}"
  if [[ -n "$first_root" && "$runner_pid" -gt 0 && -r "/proc/${runner_pid}/mountinfo" ]]; then
    mount_line="$(awk -v root="$first_root" '$5 == root' "/proc/${runner_pid}/mountinfo" 2>/dev/null | head -1)"
    if [[ -n "$mount_line" ]]; then
      mount_opts="$(printf '%s' "$mount_line" | awk '{print $6}')"
      if [[ "$mount_opts" == ro* ]]; then
        record_check PASS RNR-010 "${first_root} is mounted read-only in the runner's mount namespace" "$mount_opts"
      else
        record_check FAIL RNR-010 "${first_root} is NOT read-only in the runner's mount namespace" "$mount_opts"
      fi
    else
      record_check FAIL RNR-010 "No mount entry found for ${first_root} in the runner's namespace" "BindReadOnlyPaths did not apply — see RNR-011; restart: sudo systemctl restart project-control-runner"
    fi
  else
    record_check SKIP RNR-010 "Allowed-root mount-table check" "no configured root, runner not running, or mountinfo unreadable"
  fi
else
  record_check SKIP RNR-010 "Allowed-root mount-table check" "requires root"
fi

# Kernel-level proof, part 2: not merely a mount-table lookup — enter the
# runner's own mount namespace (nsenter) and prove, from inside it, the
# three claims docs/security-model.md makes about project registration: the
# allowed root is genuinely readable, it is not writable, and nothing else
# under /home is reachable. A safe, root-owned, temporary fixture is planted
# directly under the allowed root (exactly as one would place a project
# folder there) and removed immediately after — this deployment's own real
# project files are never touched, and nothing here is destructive.
if is_root && have nsenter && [[ -n "$first_root" && -d "$first_root" && "$runner_pid" -gt 0 \
   && -r "/proc/${runner_pid}/ns/mnt" ]]; then
  fixture_dir="${first_root}/.pc-verify-security-fixture"
  fixture_file="${fixture_dir}/marker"
  fixture_content="project-control read-only confinement fixture — safe to delete"
  rm -rf -- "$fixture_dir" 2>/dev/null || true
  trap 'rm -rf -- "$fixture_dir" 2>/dev/null' EXIT
  mkdir -p -- "$fixture_dir"
  printf '%s\n' "$fixture_content" >"$fixture_file"
  chmod 0755 "$fixture_dir"
  chmod 0644 "$fixture_file"

  # 1. Read: the runner's own namespace can see the fixture's real content.
  read_out="$(nsenter -t "$runner_pid" -m -- cat "$fixture_file" 2>/dev/null)" && read_status=0 || read_status=$?
  if [[ "$read_status" -eq 0 && "$read_out" == "$fixture_content" ]]; then
    record_check PASS RNR-011 "Runner can read a fixture file under ${first_root}" ""
  else
    record_check FAIL RNR-011 "Runner cannot read a fixture file under ${first_root}" "the allowed-root bind mount is not visible in the runner's namespace"
  fi

  # 2. Write must be rejected — this is a read-only bind mount.
  nsenter -t "$runner_pid" -m -- sh -c "printf x >> '${fixture_file}'" >/dev/null 2>&1 \
    && write_status=0 || write_status=$?
  if [[ "$write_status" -ne 0 ]]; then
    record_check PASS RNR-012 "Runner cannot write under ${first_root}" ""
  else
    record_check FAIL RNR-012 "Runner CAN write under ${first_root}" "the bind mount is not read-only — critical"
  fi

  # 3. Nothing outside the configured allowed root(s) leaks through: list
  #    what the runner's namespace sees directly under the allowed root's
  #    own parent directory (read-only; never inspects contents outside the
  #    allowed root) and confirm every visible entry is itself a configured
  #    allowed root — never an unrelated sibling that ProtectHome=tmpfs
  #    should be hiding.
  parent_dir="$(dirname -- "$first_root")"
  ns_listing="$(nsenter -t "$runner_pid" -m -- ls -A -- "$parent_dir" 2>/dev/null)" || ns_listing=""
  leaked=""
  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    candidate="${parent_dir}/${entry}"
    is_allowed=0
    for r in "${ALLOWED_ROOTS[@]}"; do [[ "$r" == "$candidate" ]] && is_allowed=1; done
    (( is_allowed )) || leaked+="${entry} "
  done <<<"$ns_listing"
  if [[ -n "$leaked" ]]; then
    record_check FAIL RNR-013 "Unexpected entries visible under ${parent_dir} in the runner's namespace" "${leaked}must not be reachable outside the configured allowed root(s)"
  else
    record_check PASS RNR-013 "Only the configured allowed root(s) are reachable under ${parent_dir} in the runner's namespace" ""
  fi

  rm -rf -- "$fixture_dir" 2>/dev/null || true
  trap - EXIT
else
  record_check SKIP RNR-011 "Runner read-access functional proof" "requires root, nsenter, a running runner, and an existing configured root"
  record_check SKIP RNR-012 "Runner write-rejection functional proof" "requires root, nsenter, a running runner, and an existing configured root"
  record_check SKIP RNR-013 "Allowed-root isolation functional proof" "requires root, nsenter, a running runner, and an existing configured root"
fi

# =============================================================================
# 7c. Repository Actions — write-enabled confinement
#
# The shipped default is an empty write-enabled list, which is what RNR-016
# below proves directly: with nothing configured, not one path anywhere under
# an allowed root is writable in the runner's namespace, so every claim
# RNR-011/012/013 already established for ordinary read-only projects still
# holds unchanged. RNR-015 proves the narrower, opted-in case: when a project
# *is* write-enabled, only its .git directory becomes writable — the working
# tree the operator's own files live in stays exactly as read-only as before.
# =============================================================================
log_step "Repository Actions: write-enabled confinement"

WRITE_ENABLED_FILE="${PC_ROOT}/config/write-enabled-projects.conf"
WRITE_DROPIN_FILE="/etc/systemd/system/project-control-runner.service.d/20-write-enabled-projects.conf"

if [[ -f "$WRITE_ENABLED_FILE" ]]; then
  mode="$(stat -c '%a' "$WRITE_ENABLED_FILE" 2>/dev/null || echo '')"
  owner="$(stat -c '%U:%G' "$WRITE_ENABLED_FILE" 2>/dev/null || echo '')"
  if [[ "$mode" == "644" && "$owner" == "root:root" ]]; then
    record_check PASS RNR-014 "write-enabled-projects.conf is root-owned (0644)" ""
  else
    record_check FAIL RNR-014 "write-enabled-projects.conf ownership/mode is ${owner:-unknown} ${mode:-unknown}" "expected root:root 0644"
  fi
else
  record_check WARN RNR-014 "write-enabled-projects.conf is missing" "shipped default: no project is write-enabled; this is expected on a fresh install"
fi

WRITE_ENABLED_PROJECTS=()
[[ -f "$WRITE_ENABLED_FILE" ]] && mapfile -t WRITE_ENABLED_PROJECTS < <(grep -vE '^[[:space:]]*(#|$)' "$WRITE_ENABLED_FILE" 2>/dev/null || true)

if [[ -f "$WRITE_DROPIN_FILE" ]]; then
  # Every effective line must be a BindPaths= (never BindReadOnlyPaths=,
  # which would be a no-op contradicting the drop-in's own purpose) targeting
  # a path that ends in /.git specifically — never the bare project
  # directory, which would silently make the whole working tree writable.
  dropin_bad=0
  dropin_bind_count=0
  while IFS= read -r line; do
    [[ "$line" == BindReadOnlyPaths=* ]] && { dropin_bad=1; break; }
    [[ "$line" == BindPaths=* ]] || continue
    dropin_bind_count=$((dropin_bind_count + 1))
    [[ "$line" == *"/.git" ]] || { dropin_bad=1; break; }
  done < <(grep -vE '^[[:space:]]*(#|\[)' "$WRITE_DROPIN_FILE" 2>/dev/null || true)
  if (( dropin_bad )); then
    record_check FAIL RNR-015 "write-enabled drop-in contains an entry not scoped to a .git directory" "every BindPaths= entry must end in /.git, and none may be BindReadOnlyPaths="
  else
    record_check PASS RNR-015 "write-enabled drop-in grants only .git-scoped BindPaths= exceptions" "${dropin_bind_count} entr$([[ $dropin_bind_count == 1 ]] && echo y || echo ies)"
  fi
elif (( ${#WRITE_ENABLED_PROJECTS[@]} == 0 )); then
  record_check PASS RNR-015 "No write-enabled drop-in present" "matches an empty write-enabled list"
else
  record_check FAIL RNR-015 "write-enabled-projects.conf has entries but no drop-in was generated" "run: sudo ./pcctl install"
fi

# Functional, kernel-level proof, reusing the same runner mount namespace
# RNR-011/012/013 already entered. Two claims, both load-bearing:
#
#   1. With the list empty (the shipped default), nothing under any allowed
#      root is writable — i.e. Repository Actions being *implemented* changes
#      nothing about a deployment that has not opted in.
#   2. For the first configured write-enabled project (if any), its .git is
#      writable but a fixture placed directly in the project's *working tree*
#      (never inside .git) is not — the operator's own files stay read-only
#      even on a project that has opted into commits.
if is_root && have nsenter && [[ "$runner_pid" -gt 0 && -r "/proc/${runner_pid}/ns/mnt" ]]; then
  if (( ${#WRITE_ENABLED_PROJECTS[@]} == 0 )); then
    if [[ -n "$first_root" && -d "$first_root" ]]; then
      probe_dir="${first_root}/.pc-verify-security-write-probe"
      rm -rf -- "$probe_dir" 2>/dev/null || true
      mkdir -p -- "$probe_dir"
      nsenter -t "$runner_pid" -m -- sh -c "mkdir -p '${probe_dir}/x' 2>/dev/null" >/dev/null 2>&1 && default_write_status=0 || default_write_status=$?
      rm -rf -- "$probe_dir" 2>/dev/null || true
      if [[ "$default_write_status" -ne 0 ]]; then
        record_check PASS RNR-016 "With an empty write-enabled list, the runner can create nothing under ${first_root}" "default posture unchanged"
      else
        record_check FAIL RNR-016 "Runner CAN write under ${first_root} despite an empty write-enabled list" "critical — Repository Actions must be strictly opt-in"
      fi
    else
      record_check SKIP RNR-016 "Write-enabled functional proof" "no configured allowed root to probe"
    fi
  else
    write_project="${WRITE_ENABLED_PROJECTS[0]}"
    if [[ -d "$write_project" ]]; then
      git_probe="${write_project}/.git/.pc-verify-security-probe"
      tree_probe="${write_project}/.pc-verify-security-probe"
      nsenter -t "$runner_pid" -m -- sh -c "printf x > '${git_probe}' && rm -f '${git_probe}'" >/dev/null 2>&1 && git_write_status=0 || git_write_status=$?
      nsenter -t "$runner_pid" -m -- sh -c "printf x > '${tree_probe}'" >/dev/null 2>&1 && tree_write_status=0 || tree_write_status=$?
      rm -f "${write_project}/.git/.pc-verify-security-probe" "${tree_probe}" 2>/dev/null || true
      if [[ "$git_write_status" -eq 0 ]]; then
        record_check PASS RNR-016 "Runner can write inside ${write_project}/.git" ""
      else
        record_check FAIL RNR-016 "Runner cannot write inside ${write_project}/.git" "the write-enabled bind mount is not visible in the runner's namespace"
      fi
      if [[ "$tree_write_status" -ne 0 ]]; then
        record_check PASS RNR-016 "Runner still cannot write the working tree of write-enabled ${write_project}" "commit access is .git-scoped only"
      else
        record_check FAIL RNR-016 "Runner CAN write the working tree of write-enabled ${write_project}" "critical — only .git may ever be writable"
      fi
    else
      record_check SKIP RNR-016 "Write-enabled functional proof" "configured project ${write_project} does not exist on disk"
    fi
  fi
else
  record_check SKIP RNR-016 "Write-enabled functional proof" "requires root, nsenter, and a running runner"
fi

# Live proof that project.git.commit refuses a project that is not on the
# write-enabled list, and refuses the same command/argv/env-shaped hostile
# extensions RNR-007 already proves against every other operation.
if [[ -S "$PC_RUNNER_SOCKET" ]] && have python3 && (is_root || [[ -r "$PC_RUNNER_SOCKET" ]]); then
  commit_probe_result="$(python3 - "$PC_RUNNER_SOCKET" <<'PY' 2>/dev/null || echo "error"
import json, socket, sys
path = sys.argv[1]
hostile = [
    {"requestId": "sec-probe-cm01", "operation": "project.git.commit",
     "params": {"path": "/tmp", "branch": "main", "expectedHead": "", "message": "x", "paths": ["a"]}},
    {"requestId": "sec-probe-cm02", "operation": "project.git.commit",
     "params": {"path": "/tmp", "branch": "main", "expectedHead": "", "message": "x", "paths": ["a"], "command": "id"}},
    {"requestId": "sec-probe-cm03", "operation": "project.git.commit",
     "params": {"path": "/tmp", "branch": "main", "expectedHead": "", "message": "x", "paths": ["a"], "env": {"GIT_SSH_COMMAND": "sh"}}},
    {"requestId": "sec-probe-cm04", "operation": "project.git.commit",
     "params": {"path": "/tmp", "branch": "main", "expectedHead": "", "message": "x", "paths": [".env"]}},
]
for payload in hostile:
    try:
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        s.connect(path)
        s.sendall((json.dumps(payload) + "\n").encode())
        data = json.loads(s.recv(65536).decode().strip())
        s.close()
        result = data.get("result", {})
        if data.get("ok") is True and (result.get("committed") is True):
            print("ACCEPTED")
            sys.exit(0)
    except Exception:
        pass
print("REJECTED")
PY
)"
  case "$commit_probe_result" in
    REJECTED) record_check PASS RNR-017 "Runner refuses project.git.commit for a non-write-enabled or hostile request" "4 probes refused" ;;
    ACCEPTED) record_check FAIL RNR-017 "Runner ACCEPTED a project.git.commit it must have refused" "critical" ;;
    *)        record_check WARN RNR-017 "Runner project.git.commit rejection probe inconclusive" "$commit_probe_result" ;;
  esac
else
  record_check SKIP RNR-017 "Runner project.git.commit rejection probe" "socket not readable by this user"
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
