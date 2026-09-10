#!/usr/bin/env bash
# =============================================================================
# configure-telegram.sh — MANUAL CHECKPOINT 3
#
# Stores the Telegram bot token and chat id as root-only secrets and sends one
# test notification.
#
# Telegram is OUTBOUND ONLY. This deployment:
#   * never registers a webhook,
#   * never polls getUpdates,
#   * never parses an incoming message,
#   * exposes no endpoint for Telegram to call.
#
# The bot is a notification sink, nothing more. That removes the entire class of
# "attacker messages the bot to run a command" risk.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root

log_step "MANUAL CHECKPOINT 3 — Telegram notifications"

# Mirrors the chat id (never the bot token) into stack.env so n8n's shipped
# workflows can read it via $env.PC_TELEGRAM_CHAT_ID in an expression — the
# chat id identifies a notification destination, not a credential; the bot
# token stays file-only forever and is never referenced by a workflow
# expression, only by n8n's own encrypted credential store. Idempotent:
# called from both the "already configured" and the fresh-configuration path
# below so re-running this script (with or without --force) always leaves
# stack.env in sync with the secret file. Does not itself restart n8n — the
# running container only picks this up on its next recreation (`sudo ./pcctl
# update` or a targeted `recover-deployment`).
sync_telegram_chat_id_to_stack_env() {
  local chat_id; chat_id="$(read_secret telegram_chat_id)"
  local stack_env="${PC_CONFIG_DIR}/stack.env"
  [[ -f "$stack_env" ]] || return 0
  local tmp; tmp="$(mktemp)"
  grep -v '^PC_TELEGRAM_CHAT_ID=' "$stack_env" >"$tmp" || true
  printf 'PC_TELEGRAM_CHAT_ID=%s\n' "$chat_id" >>"$tmp"
  install_file "$tmp" "$stack_env" 0640
  rm -f "$tmp"
  chown root:root "$stack_env"
}

if secret_exists telegram_bot_token && secret_exists telegram_chat_id; then
  log_ok "Telegram credentials are already configured"
  sync_telegram_chat_id_to_stack_env
  if [[ "${1:-}" != "--force" ]]; then
    log_info "re-run with --force to replace them"
    log_info "sending a test notification with the existing credentials…"
    bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" \
      "Project Control test notification — $(hostname -s) at $(_pc_ts)" && exit 0
    die "test notification failed"
  fi
fi

if [[ ! -t 0 ]]; then
  log_warn "MANUAL_CONFIGURATION_REQUIRED: Telegram credentials"
  log_info "run interactively: sudo ./pcctl configure-telegram"
  # Not an installation failure — Telegram is optional and its absence is
  # reported as a pending checkpoint, not a broken deployment.
  exit 0
fi

cat >&2 <<'HOWTO'

  You need two values:

  1. BOT TOKEN
     In Telegram, message @BotFather → /newbot → follow the prompts.
     The token looks like  123456789:AAH...  (keep it secret).

  2. CHAT ID
     Message your new bot once, then open:
       https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
     and read  result[0].message.chat.id  (may be negative for a group).

  Neither value is echoed as you type, and neither is written to shell history.

HOWTO

# -----------------------------------------------------------------------------
read -r -s -p "Bot token: " BOT_TOKEN; printf '\n' >&2
[[ -n "$BOT_TOKEN" ]] || die "bot token must not be empty"

# Validate the shape before spending a network round trip on it.
if [[ ! "$BOT_TOKEN" =~ ^[0-9]{6,12}:[A-Za-z0-9_-]{30,}$ ]]; then
  die "that does not look like a Telegram bot token (expected <digits>:<35+ chars>)"
fi

read -r -p "Chat id: " CHAT_ID
[[ -n "$CHAT_ID" ]] || die "chat id must not be empty"
if [[ ! "$CHAT_ID" =~ ^-?[0-9]{1,20}$ ]]; then
  die "chat id must be an integer (it may be negative for a group)"
fi

# -----------------------------------------------------------------------------
# Validate against the API before storing, so a typo is caught now rather than
# at 03:00 when a backup fails and the alert silently goes nowhere.
# -----------------------------------------------------------------------------
log_step "Validating the credentials"

# The token goes in the URL path, which Telegram requires. It is passed via
# --url on stdin-free curl; it does not appear in this script's own log output.
if ! response="$(curl -sS --max-time 15 "https://api.telegram.org/bot${BOT_TOKEN}/getMe" 2>&1)"; then
  die "could not reach api.telegram.org"
fi

if ! printf '%s' "$response" | grep -q '"ok":true'; then
  # The response can echo the token back; redact before it reaches the terminal.
  log_error "Telegram rejected the token: $(printf '%s' "$response" | redact_stream | head -c 200)"
  die "invalid bot token"
fi

bot_username="$(printf '%s' "$response" | python3 -c 'import sys,json;print(json.load(sys.stdin)["result"]["username"])' 2>/dev/null || echo unknown)"
log_ok "token valid for bot @${bot_username}"

# -----------------------------------------------------------------------------
ensure_dir "$PC_SECRETS_DIR" 0700 root root
write_secret telegram_bot_token "$BOT_TOKEN"
write_secret telegram_chat_id   "$CHAT_ID"
sync_telegram_chat_id_to_stack_env

# Scrub the values from this shell's memory as soon as they are persisted.
BOT_TOKEN=""; CHAT_ID=""
unset BOT_TOKEN CHAT_ID

log_step "Sending a test notification"
if bash "${PC_SCRIPTS_DIR}/telegram-notify.sh" \
     "✅ Project Control — Telegram configured on $(hostname -s) at $(_pc_ts)"; then
  log_ok "test notification delivered"
else
  die "credentials were stored but the test notification failed"
fi

cat >&2 <<'DONE'

  Telegram is configured as an OUTBOUND notification channel.

  No webhook was registered and no inbound endpoint exists. Messages sent to
  the bot are never read or acted on by this system.

  An example n8n workflow is available at:
      infra/n8n/workflows/telegram-notification.example.json

DONE
