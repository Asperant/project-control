#!/usr/bin/env bash
# =============================================================================
# service-tokens.sh — create-service-token / list-service-tokens / revoke-service-token
#
# Machine identity is minted only here, at a host terminal, via `docker exec`
# into the already-running control-api container — the same pattern
# create-admin.sh uses for the same reason: the credential must never touch
# this host shell's history, a script argument list, or a log line.
#
# create-service-token is otherwise non-interactive: unlike create-admin,
# nothing here is typed by a human, so no TTY is required. See
# docs/service-accounts.md.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_stack_env

cid="$(container_id control-api)"
[[ -n "$cid" ]] || die "the control-api container is not running; run: sudo ./pcctl start"

state="$(docker inspect --format '{{.State.Status}}' "$cid")"
[[ "$state" == "running" ]] || die "the control-api container is ${state}, not running"

MODE="${1:-}"; shift || true

case "$MODE" in
  create)
    [[ $# -ge 1 ]] || die "usage: sudo ./pcctl create-service-token <account-key> [--ttl-days N]"
    log_step "minting a service token for '$1'"
    docker exec "$cid" node dist/cli/create-service-token.js "$@"
    log_ok "checkpoint complete — paste the value above into the consumer's credential store now"
    ;;
  list)
    docker exec "$cid" node dist/cli/list-service-tokens.js
    ;;
  revoke)
    [[ $# -eq 1 ]] || die "usage: sudo ./pcctl revoke-service-token <token-id>  (see: sudo ./pcctl list-service-tokens)"
    docker exec "$cid" node dist/cli/revoke-service-token.js "$1"
    ;;
  *)
    die "internal error: service-tokens.sh requires create|list|revoke"
    ;;
esac
