#!/usr/bin/env bash
# =============================================================================
# create-admin.sh — MANUAL CHECKPOINT: create the first administrator.
#
# This is the only way an account is ever created. There is no seeded user, no
# default password, and no environment variable that produces one — so an
# installed-but-unbootstrapped deployment has no credential to guess.
#
# The prompt runs inside the Control API container, which already holds the
# migrator credential; the password never touches the host shell's history,
# never appears in `ps`, and is never echoed to the terminal.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_stack_env

cid="$(container_id control-api)"
[[ -n "$cid" ]] || die "the control-api container is not running; run: sudo ./pcctl start"

state="$(docker inspect --format '{{.State.Status}}' "$cid")"
[[ "$state" == "running" ]] || die "the control-api container is ${state}, not running"

if [[ ! -t 0 ]]; then
  log_error "create-admin needs an interactive terminal."
  log_info  "Run it directly from a shell: sudo ./pcctl create-admin"
  log_info  "It cannot be automated by design — a password supplied by a script would end up in that script."
  exit 1
fi

log_step "MANUAL CHECKPOINT — create the first administrator"

cat >&2 <<'NOTE'

  You will be asked for an email address, a display name and a password.

  Requirements:
    * at least 12 characters
    * the password is hashed with Argon2id before it is stored
    * input is not echoed and is not written to shell history

NOTE

# `docker exec -it` gives the Node CLI a real TTY, which is what lets it disable
# echo for the password prompt.
docker exec -it "$cid" node dist/cli/create-admin.js

log_ok "checkpoint complete"
log_info "sign in at the portal URL shown by: ./pcctl status"
