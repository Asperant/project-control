#!/usr/bin/env bash
# =============================================================================
# telegram-notify.sh — send one outbound notification.
#
#   telegram-notify.sh "message text"
#   echo "message" | telegram-notify.sh
#
# Exits 0 when the message is delivered, 2 when Telegram is not configured
# (which is not an error — it is a pending manual checkpoint), and 1 on a real
# delivery failure.
#
# The bot token never appears in the process argument list, in a log line, or in
# an error message: the API response is passed through the redactor before it is
# printed, because Telegram echoes the token back in some error payloads.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

MESSAGE="${1:-}"
if [[ -z "$MESSAGE" && ! -t 0 ]]; then
  MESSAGE="$(cat)"
fi
[[ -n "$MESSAGE" ]] || die "no message supplied"

if ! secret_exists telegram_bot_token || ! secret_exists telegram_chat_id; then
  log_warn "MANUAL_CONFIGURATION_REQUIRED: Telegram is not configured; notification skipped"
  log_info "configure it with: sudo ./pcctl configure-telegram"
  exit 2
fi

if ! is_root; then
  die "reading the Telegram secrets requires root"
fi

TOKEN="$(read_secret telegram_bot_token)"
CHAT_ID="$(read_secret telegram_chat_id)"

# Telegram caps a message at 4096 characters; truncate rather than let the API
# reject the whole notification.
if (( ${#MESSAGE} > 3900 )); then
  MESSAGE="${MESSAGE:0:3900}"$'\n…[truncated]'
fi

# The message is sent as a form field via --data-urlencode, so no shell quoting
# or JSON escaping issue can corrupt it or inject extra parameters.
response="$(curl -sS --max-time 20 \
  --retry 2 --retry-delay 3 \
  -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=${MESSAGE}" \
  --data-urlencode "disable_web_page_preview=true" \
  2>&1)" || {
    log_error "Telegram request failed: $(printf '%s' "$response" | redact_stream | head -c 200)"
    exit 1
  }

# Clear the token from this shell as soon as it is no longer needed.
TOKEN=""; unset TOKEN

if printf '%s' "$response" | grep -q '"ok":true'; then
  log_ok "notification sent"
  exit 0
fi

log_error "Telegram rejected the message: $(printf '%s' "$response" | redact_stream | head -c 300)"
exit 1
