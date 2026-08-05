#!/usr/bin/env bash
# =============================================================================
# configure-tailscale.sh — MANUAL CHECKPOINT 1
#
# Connects the host to the tailnet and publishes:
#
#   https://<host>.<tailnet>.ts.net/        → 127.0.0.1:8780  (portal / Caddy)
#   https://<host>.<tailnet>.ts.net:8443/   → 127.0.0.1:5678  (n8n admin)
#
# Uses `tailscale serve`, never `tailscale funnel`. Serve publishes only to the
# tailnet; Funnel would publish to the public internet, which this design
# forbids. The script refuses to enable Funnel and verifies afterwards that it
# is not enabled.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions

STATUS_FILE="${PC_ROOT}/config/status/tailscale-status.json"

write_status() {
  ensure_dir "$(dirname "$STATUS_FILE")" 0755 root root
  local tmp; tmp="$(mktemp)"
  cat >"$tmp" <<EOF
{
  "configured": ${1},
  "backendState": "${2}",
  "dnsName": "${3}",
  "httpsEnabled": ${4},
  "portalUrl": "${5}",
  "n8nUrl": "${6}",
  "updatedAt": "$(_pc_ts)"
}
EOF
  install_file "$tmp" "$STATUS_FILE" 0644
  rm -f "$tmp"
}

# -----------------------------------------------------------------------------
log_step "MANUAL CHECKPOINT 1 — Tailscale"
# -----------------------------------------------------------------------------

if ! have tailscale; then
  write_status false "not_installed" "" false "" ""
  cat >&2 <<'INSTALL'

  Tailscale is not installed. This deployment has no other supported access
  path, so it is required.

  Install it (official upstream repository):

      curl -fsSL https://tailscale.com/install.sh | sh

  Then re-run:

      sudo ./pcctl configure-tailscale

INSTALL
  die "MANUAL_CONFIGURATION_REQUIRED: install Tailscale first"
fi

log_ok "tailscale CLI present: $(tailscale version | head -1)"

# -----------------------------------------------------------------------------
# 1. Connect
# -----------------------------------------------------------------------------
backend="$(tailscale status --json 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin).get("BackendState","Unknown"))' 2>/dev/null || echo Unknown)"

if [[ "$backend" != "Running" ]]; then
  cat >&2 <<'LOGIN'

  This host is not connected to a tailnet.

  Run the following. It prints a URL — open it in a browser and approve the
  machine. This step needs a human and cannot be automated:

      sudo tailscale up --ssh=false --accept-routes=false

  Then re-run:

      sudo ./pcctl configure-tailscale

LOGIN
  write_status false "$backend" "" false "" ""
  die "MANUAL_CONFIGURATION_REQUIRED: complete the Tailscale browser login"
fi

log_ok "connected to the tailnet"

# -----------------------------------------------------------------------------
# 2. Discover the MagicDNS name
# -----------------------------------------------------------------------------
ts_json="$(tailscale status --json)"
DNS_NAME="$(printf '%s' "$ts_json" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("Self",{}).get("DNSName","").rstrip("."))')"

if [[ -z "$DNS_NAME" || "$DNS_NAME" != *.ts.net ]]; then
  cat >&2 <<'MAGICDNS'

  This machine has no MagicDNS name, so HTTPS cannot be issued for it.

  In the Tailscale admin console (https://login.tailscale.com/admin/dns):
    1. Enable MagicDNS
    2. Enable HTTPS Certificates

  Then re-run:

      sudo ./pcctl configure-tailscale

MAGICDNS
  write_status false "Running" "$DNS_NAME" false "" ""
  die "MANUAL_CONFIGURATION_REQUIRED: enable MagicDNS and HTTPS certificates"
fi

log_ok "MagicDNS name: ${DNS_NAME}"

# -----------------------------------------------------------------------------
# 3. Verify a certificate can be issued
# -----------------------------------------------------------------------------
HTTPS_OK=true
if ! tailscale cert --cert-file /dev/null --key-file /dev/null "$DNS_NAME" >/dev/null 2>&1; then
  HTTPS_OK=false
  log_warn "could not obtain a TLS certificate for ${DNS_NAME}"
  log_warn "enable 'HTTPS Certificates' at https://login.tailscale.com/admin/dns and re-run"
else
  log_ok "TLS certificate available for ${DNS_NAME}"
fi

# -----------------------------------------------------------------------------
# 4. Publish both services with Tailscale Serve
# -----------------------------------------------------------------------------
log_step "Configuring Tailscale Serve"

PORTAL_URL="https://${DNS_NAME}/"
N8N_URL="https://${DNS_NAME}:8443/"

# `--bg` makes the configuration persistent across reboots; without it the
# mapping disappears when the invoking shell exits.
log_info "portal: 443 → 127.0.0.1:8780"
tailscale serve --bg --https=443 http://127.0.0.1:8780

log_info "n8n:    8443 → 127.0.0.1:5678"
tailscale serve --bg --https=8443 http://127.0.0.1:5678

log_ok "Tailscale Serve configured"

# -----------------------------------------------------------------------------
# 5. Confirm Funnel is NOT enabled
# -----------------------------------------------------------------------------
if serve_status="$(tailscale serve status --json 2>/dev/null)"; then
  if printf '%s' "$serve_status" | grep -qi 'AllowFunnel'; then
    if printf '%s' "$serve_status" | python3 -c '
import sys, json
data = json.load(sys.stdin)
funnel = data.get("AllowFunnel") or {}
sys.exit(0 if any(funnel.values()) else 1)
' 2>/dev/null; then
      log_error "Tailscale Funnel is enabled — this would expose the portal to the public internet."
      log_error "Disable it with: sudo tailscale funnel --https=443 off"
      die "Funnel must not be used with this deployment"
    fi
  fi
  log_ok "Funnel is not enabled; the portal is tailnet-only"
fi

# -----------------------------------------------------------------------------
# 6. Update stack configuration so n8n builds correct URLs
# -----------------------------------------------------------------------------
STACK_ENV="${PC_ROOT}/config/stack.env"
if [[ -f "$STACK_ENV" ]]; then
  tmp="$(mktemp)"
  grep -vE '^(PC_TAILSCALE_HOSTNAME|PC_N8N_PUBLIC_URL|PC_N8N_SECURE_COOKIE)=' "$STACK_ENV" >"$tmp" || true
  {
    printf 'PC_TAILSCALE_HOSTNAME=%s\n' "$DNS_NAME"
    printf 'PC_N8N_PUBLIC_URL=%s\n' "$N8N_URL"
    # Now that the browser reaches n8n over HTTPS, the secure cookie flag is
    # correct; before this it would have blocked login over plain loopback HTTP.
    printf 'PC_N8N_SECURE_COOKIE=%s\n' "$($HTTPS_OK && echo true || echo false)"
  } >>"$tmp"
  install_file "$tmp" "$STACK_ENV" 0640
  rm -f "$tmp"
  chown root:root "$STACK_ENV"
  log_ok "stack.env updated with the Tailscale hostname"

  log_info "recreating n8n so it picks up the new editor URL"
  load_stack_env
  compose up --detach --wait --wait-timeout 180 n8n 2>/dev/null || \
    log_warn "could not recreate n8n automatically; run: sudo ./pcctl restart"
fi

write_status true "Running" "$DNS_NAME" "$HTTPS_OK" "$PORTAL_URL" "$N8N_URL"

# -----------------------------------------------------------------------------
cat >&2 <<BANNER

$(printf '═%.0s' {1..70})
  Tailscale configured
$(printf '═%.0s' {1..70})

  Portal : ${PORTAL_URL}
  n8n    : ${N8N_URL}

  Both are reachable ONLY from devices on your tailnet. Nothing is published
  to the public internet, and no port was opened on the router.

  Verify from another tailnet device:
      curl -I ${PORTAL_URL}

  Next checkpoints:
      sudo ./pcctl create-admin
      Open ${N8N_URL} to create the n8n owner account

$(printf '═%.0s' {1..70})

BANNER

$HTTPS_OK || log_warn "HTTPS certificates are not yet enabled for this tailnet — see the note above"
