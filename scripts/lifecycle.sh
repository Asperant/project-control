#!/usr/bin/env bash
# =============================================================================
# lifecycle.sh — start / stop / restart / status / health / logs
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_versions
load_stack_env

ACTION="${1:-status}"; shift || true

[[ -f "${PC_ROOT}/compose/compose.yaml" ]] || die "not installed; run: sudo ./pcctl install"

SERVICES=(postgres n8n control-api web caddy)

case "$ACTION" in

start)
  is_root || die "start modifies the host; run: sudo ./pcctl start"
  log_step "Starting the runner"
  systemctl start project-control-runner.service
  # The Control API mounts the runner socket, so it must exist before the
  # containers come up or Docker creates a directory in its place.
  for _ in $(seq 1 20); do
    [[ -S "$PC_RUNNER_SOCKET" ]] && break
    sleep 0.5
  done
  [[ -S "$PC_RUNNER_SOCKET" ]] || die "runner socket did not appear; check journalctl -u project-control-runner"
  log_ok "runner socket ready"

  log_step "Starting the container stack"
  compose up --detach --remove-orphans --wait --wait-timeout 240
  log_ok "stack started"
  ;;

stop)
  is_root || die "stop modifies the host; run: sudo ./pcctl stop"
  log_step "Stopping the container stack"
  # `stop`, not `down`: networks and containers stay in place, and no volume or
  # bind-mounted data is ever at risk.
  compose stop --timeout 60
  log_ok "containers stopped (all data preserved)"

  log_step "Stopping the runner"
  systemctl stop project-control-runner.service || true
  log_ok "runner stopped"
  ;;

restart)
  is_root || die "restart modifies the host; run: sudo ./pcctl restart"
  bash "$0" stop
  sleep 2
  bash "$0" start
  ;;

status)
  printf '\n%s\n' "══ Containers ═══════════════════════════════════════════════════"
  compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' 2>/dev/null || compose ps

  printf '\n%s\n' "══ Runner ═══════════════════════════════════════════════════════"
  if systemctl is-active --quiet project-control-runner.service 2>/dev/null; then
    printf '  service : active\n'
    printf '  since   : %s\n' "$(systemctl show -p ActiveEnterTimestamp --value project-control-runner.service)"
  else
    printf '  service : INACTIVE\n'
  fi
  if [[ -S "$PC_RUNNER_SOCKET" ]]; then
    printf '  socket  : %s (mode %s, group %s)\n' \
      "$PC_RUNNER_SOCKET" "$(stat -c '%a' "$PC_RUNNER_SOCKET")" "$(stat -c '%G' "$PC_RUNNER_SOCKET")"
  else
    printf '  socket  : MISSING\n'
  fi

  printf '\n%s\n' "══ Access URLs ══════════════════════════════════════════════════"
  if have tailscale && ts_json="$(tailscale status --json 2>/dev/null)"; then
    dns="$(printf '%s' "$ts_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))' 2>/dev/null || echo '')"
    if [[ -n "$dns" ]]; then
      printf '  Portal  : https://%s/\n' "$dns"
      printf '  n8n     : https://%s:8443/\n' "$dns"
    else
      printf '  Tailscale is connected but has no MagicDNS name yet.\n'
    fi
  else
    printf '  Tailscale is not configured — run: sudo ./pcctl configure-tailscale\n'
  fi
  printf '  Local   : http://127.0.0.1:8780/  (loopback only, not for daily use)\n'

  printf '\n%s\n' "══ Pending manual checkpoints ═══════════════════════════════════"
  pending=0
  secret_exists restic_password       || { printf '  • Google Drive / restic  — sudo ./pcctl configure-google-drive\n'; pending=1; }
  secret_exists telegram_bot_token    || { printf '  • Telegram notifications — sudo ./pcctl configure-telegram\n'; pending=1; }
  have tailscale && tailscale status >/dev/null 2>&1 || { printf '  • Tailscale              — sudo ./pcctl configure-tailscale\n'; pending=1; }
  (( pending )) || printf '  none\n'
  printf '\n'
  ;;

health)
  printf '\n'
  overall=0
  for service in "${SERVICES[@]}"; do
    state="$(container_health "$service")"
    case "$state" in
      healthy)  printf '  %-14s %s\n' "$service" "healthy" ;;
      running)  printf '  %-14s %s\n' "$service" "running (no healthcheck)" ;;
      starting) printf '  %-14s %s\n' "$service" "starting" ;;
      absent)   printf '  %-14s %s\n' "$service" "ABSENT"; overall=1 ;;
      *)        printf '  %-14s %s\n' "$service" "UNHEALTHY (${state})"; overall=1 ;;
    esac
  done

  if systemctl is-active --quiet project-control-runner.service 2>/dev/null; then
    printf '  %-14s %s\n' "runner" "active"
  else
    printf '  %-14s %s\n' "runner" "INACTIVE"; overall=1
  fi

  printf '\n  Endpoints:\n'
  for probe in "portal|http://127.0.0.1:8780/healthz" "api|http://127.0.0.1:8780/api/auth/me" "n8n|http://127.0.0.1:5678/healthz"; do
    label="${probe%%|*}"; url="${probe#*|}"
    code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 "$url" 2>/dev/null || echo 000)"
    # 401 from /api/auth/me is the correct, healthy answer for an anonymous call.
    if [[ "$code" == "200" || "$code" == "401" ]]; then
      printf '  %-14s HTTP %s\n' "$label" "$code"
    else
      printf '  %-14s HTTP %s  ← unexpected\n' "$label" "$code"; overall=1
    fi
  done
  printf '\n'
  exit "$overall"
  ;;

logs)
  service="${1:-}"; shift || true
  if [[ "$service" == "runner" ]]; then
    exec journalctl -u project-control-runner.service --no-pager "$@"
  fi
  if [[ -z "$service" ]]; then
    compose logs --tail 200 "$@"
  else
    compose logs --tail 200 "$@" "$service"
  fi
  ;;

*)
  die "unknown lifecycle action: ${ACTION}"
  ;;
esac
