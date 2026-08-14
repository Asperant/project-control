#!/usr/bin/env bash
# =============================================================================
# preflight-tailscale-port-regression.sh
#
# scripts/preflight.sh's NET-001 check must tell apart three situations on
# ports 443/8443:
#   1. genuinely free                                     -> PASS
#   2. held by some other, unexpected process              -> FAIL
#   3. held by Tailscale Serve, already publishing this
#      exact deployment's routes (the normal state on an
#      idempotent reinstall)                               -> PASS
#
# Case 3 must be provable WITHOUT trusting `ss`'s reported process name or
# PID at all — resolving the owner of a root-owned socket like tailscaled's
# routinely fails for a normal user (`ss` just omits the field, which the
# code below turns into "unknown"), and that must never itself cause a FAIL.
# Instead, three independent, read-only signals are cross-checked:
#   - the Tailscale daemon is actually running (`tailscale status --json`)
#   - Tailscale Serve proxies this exact port to this exact target,
#     tailnet-only, Funnel disabled (`tailscale serve status --json`)
#   - every real TCP listener on the port sits on this host's own Tailscale
#     IPv4/IPv6 address and nowhere else (`ss -H -ltn` cross-checked against
#     `tailscale ip -4`/`-6`)
#
# This is exercised against the real preflight.sh, with `ss` and `tailscale`
# shadowed by fakes on PATH so every scenario is deterministic and does not
# depend on, or alter, this machine's real Tailscale state.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-preflight-ts-test.XXXXXXXX")"

cleanup() {
  case "$SCRATCH" in
    "${TMPDIR:-/tmp}"/project-control-preflight-ts-test.*) rm -rf -- "$SCRATCH" ;;
  esac
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

FAKE_BIN="${SCRATCH}/bin"
mkdir -p "$FAKE_BIN"

# ss is called two different ways in preflight.sh, with two different column
# layouts, and this fake must return the right one for each:
#   - `ss -tulpnH` (has "p")   -> general occupancy/owner detection, 7 columns
#     including a trailing users:(("name",...)) field when resolvable.
#   - `ss -H -ltn` (no "p")    -> listener-address verification, 5 columns,
#     no process info at all (this is the one a normal user can always read).
cat >"${FAKE_BIN}/ss" <<'EOF'
#!/usr/bin/env bash
has_p=0
for arg in "$@"; do
  [[ "$arg" == -*p* ]] && has_p=1
done
if (( has_p )); then
  printf '%s\n' "${FAKE_SS_OUTPUT:-}"
else
  printf '%s\n' "${FAKE_SS_LTN_OUTPUT:-}"
fi
exit 0
EOF

cat >"${FAKE_BIN}/tailscale" <<'EOF'
#!/usr/bin/env bash
if [[ "$1 $2 $3" == "serve status --json" ]]; then
  if [[ "${FAKE_TS_SERVE_UNAVAILABLE:-0}" == "1" ]]; then
    exit 1
  fi
  if [[ -n "${FAKE_TS_SERVE_JSON:-}" ]]; then
    printf '%s' "$FAKE_TS_SERVE_JSON"
  else
    printf '{}'
  fi
  exit 0
fi
if [[ "$1 $2" == "status --json" ]]; then
  state="${FAKE_TS_BACKEND_STATE:-Running}"
  printf '{"BackendState":"%s","Self":{"DNSName":"test-host.test-tailnet.ts.net."}}' "$state"
  exit 0
fi
if [[ "$1 $2" == "ip -4" ]]; then
  [[ "${FAKE_TS_IP_UNAVAILABLE:-0}" == "1" ]] && exit 1
  [[ -n "${FAKE_TS_IP4:-}" ]] && printf '%s\n' "$FAKE_TS_IP4"
  exit 0
fi
if [[ "$1 $2" == "ip -6" ]]; then
  [[ "${FAKE_TS_IP_UNAVAILABLE:-0}" == "1" ]] && exit 1
  [[ -n "${FAKE_TS_IP6:-}" ]] && printf '%s\n' "$FAKE_TS_IP6"
  exit 0
fi
if [[ "$1" == "version" ]]; then
  printf '1.99.9\n'
  exit 0
fi
exit 1
EOF

chmod +x "${FAKE_BIN}/ss" "${FAKE_BIN}/tailscale"

# Default tailnet addresses used by every scenario unless overridden.
TS_IP4="REDACTED-TAILSCALE-IP"
TS_IP6="REDACTED-TAILSCALE-IPV6"
LAN_IP="192.168.1.50"

fmt_addr() {
  # Bracket the address only if it looks like IPv6 (contains 2+ colons).
  local addr="$1"
  if [[ "$addr" == *:*:* ]]; then printf '[%s]' "$addr"; else printf '%s' "$addr"; fi
}

# occ_line <addr> <port> [owner]
# `ss -tulpnH`-shaped line, used for the pre-existing occupancy/owner check.
# With no owner given, omits users:() entirely — exactly what real `ss`
# produces for a root-owned socket when run as a normal, non-root user.
occ_line() {
  local addr port owner; addr="$(fmt_addr "$1")"; port="$2"; owner="${3:-}"
  if [[ -n "$owner" ]]; then
    printf 'tcp LISTEN 0 4096 %s:%s 0.0.0.0:* users:(("%s",pid=1,fd=1))' "$addr" "$port" "$owner"
  else
    printf 'tcp LISTEN 0 4096 %s:%s 0.0.0.0:*' "$addr" "$port"
  fi
}

# ltn_line <addr> <port>
# `ss -H -ltn`-shaped line: exactly 5 columns, no protocol column, no
# process info — the format the new listener-address check actually reads.
ltn_line() {
  local addr port; addr="$(fmt_addr "$1")"; port="$2"
  printf 'LISTEN 0 4096 %s:%s 0.0.0.0:*' "$addr" "$port"
}

CORRECT_SERVE_JSON='{
  "TCP": {"443": {"HTTPS": true}, "8443": {"HTTPS": true}},
  "Web": {
    "test-host.test-tailnet.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8780"}}},
    "test-host.test-tailnet.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:5678"}}}
  },
  "AllowFunnel": {
    "test-host.test-tailnet.ts.net:443": false,
    "test-host.test-tailnet.ts.net:8443": false
  }
}'

WRONG_ROUTE_SERVE_JSON='{
  "TCP": {"443": {"HTTPS": true}, "8443": {"HTTPS": true}},
  "Web": {
    "test-host.test-tailnet.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:9999"}}},
    "test-host.test-tailnet.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:5678"}}}
  },
  "AllowFunnel": {}
}'

FUNNEL_ON_SERVE_JSON='{
  "TCP": {"443": {"HTTPS": true}, "8443": {"HTTPS": true}},
  "Web": {
    "test-host.test-tailnet.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8780"}}},
    "test-host.test-tailnet.ts.net:8443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:5678"}}}
  },
  "AllowFunnel": {
    "test-host.test-tailnet.ts.net:443": true
  }
}'

PARTIAL_SERVE_JSON='{
  "TCP": {"443": {"HTTPS": true}},
  "Web": {
    "test-host.test-tailnet.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:8780"}}}
  },
  "AllowFunnel": {}
}'

# run_scenario <name>
# Reads its configuration from the FAKE_* env vars the caller has already
# exported (set defaults below, override per-scenario before calling). Runs
# the real preflight.sh with ss/tailscale shadowed; writes stdout/stderr
# under ${SCRATCH}/<name>/ and leaves the exit code in $SCENARIO_EXIT.
run_scenario() {
  local name="$1"
  local dir="${SCRATCH}/${name}"
  mkdir -p "$dir"
  set +e
  (
    export PATH="${FAKE_BIN}:${PATH}"
    bash "${REPO_ROOT}/scripts/preflight.sh" --report="${dir}/report.md" \
      >"${dir}/stdout" 2>"${dir}/stderr"
  )
  SCENARIO_EXIT=$?
  set -e
}

reset_fakes() {
  export FAKE_SS_OUTPUT=""
  export FAKE_SS_LTN_OUTPUT=""
  export FAKE_TS_SERVE_UNAVAILABLE="0"
  export FAKE_TS_SERVE_JSON=""
  export FAKE_TS_BACKEND_STATE="Running"
  export FAKE_TS_IP4="$TS_IP4"
  export FAKE_TS_IP6="$TS_IP6"
  export FAKE_TS_IP_UNAVAILABLE="0"
}

assert_line() {
  local dir="$1" pattern="$2" label="$3"
  grep -qE "$pattern" "${SCRATCH}/${dir}/stderr" \
    || fail "${label}: expected a line matching /${pattern}/ in ${dir}/stderr"
}

assert_no_line() {
  local dir="$1" pattern="$2" label="$3"
  grep -qE "$pattern" "${SCRATCH}/${dir}/stderr" \
    && fail "${label}: unexpected line matching /${pattern}/ in ${dir}/stderr"
  return 0
}

PASS_443='\[  OK \] NET-001: Port 443 is correctly served by this host'\''s own Tailscale Serve configuration'
PASS_8443='\[  OK \] NET-001: Port 8443 is correctly served by this host'\''s own Tailscale Serve configuration'
FAIL_443='\[ FAIL\] NET-001: Port 443 is occupied but Tailscale verification failed'
FAIL_8443='\[ FAIL\] NET-001: Port 8443 is occupied but Tailscale verification failed'

# -----------------------------------------------------------------------------
# 1. Both ports free -> PASS
# -----------------------------------------------------------------------------
reset_fakes
run_scenario "free"
assert_line "free" '\[  OK \] NET-001: Port 443 is free' "free-ports"
assert_line "free" '\[  OK \] NET-001: Port 8443 is free' "free-ports"

# -----------------------------------------------------------------------------
# 2. owner = tailscaled, correct Serve config + correct Tailscale-IP
#    listeners -> PASS
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443 tailscaled)
$(occ_line "$TS_IP4" 8443 tailscaled)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
run_scenario "owner-tailscaled-correct"
assert_line "owner-tailscaled-correct" "$PASS_443" "owner=tailscaled, correct config"
assert_line "owner-tailscaled-correct" "$PASS_8443" "owner=tailscaled, correct config"

# -----------------------------------------------------------------------------
# 3. owner unresolvable ("unknown"), correct Serve config + correct
#    Tailscale-IP listeners (IPv4 + IPv6, matching the real reported bug)
#    -> PASS. This is the exact scenario that used to FAIL.
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line "$TS_IP6" 443)
$(occ_line "$TS_IP4" 8443)
$(occ_line "$TS_IP6" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP6" 443)
$(ltn_line "$TS_IP4" 8443)
$(ltn_line "$TS_IP6" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
run_scenario "owner-unknown-correct"
assert_line "owner-unknown-correct" "$PASS_443" "owner=unknown, correct config"
assert_line "owner-unknown-correct" "$PASS_8443" "owner=unknown, correct config"
assert_no_line "owner-unknown-correct" 'already in use — owner' "owner=unknown must not fall back to the generic FAIL path"

# -----------------------------------------------------------------------------
# 4. owner unknown, wrong Serve route -> FAIL
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$WRONG_ROUTE_SERVE_JSON"
run_scenario "owner-unknown-wrong-route"
assert_line "owner-unknown-wrong-route" "$FAIL_443" "owner=unknown, wrong route"
assert_line "owner-unknown-wrong-route" "$PASS_8443" "owner=unknown, wrong route (8443 unaffected)"

# -----------------------------------------------------------------------------
# 5. owner unknown, Funnel enabled -> FAIL
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$FUNNEL_ON_SERVE_JSON"
run_scenario "funnel-enabled"
assert_line "funnel-enabled" "$FAIL_443" "funnel-enabled"
grep -qi 'funnel' "${SCRATCH}/funnel-enabled/stderr" || fail "funnel-enabled: FAIL detail should mention Funnel"
assert_line "funnel-enabled" "$PASS_8443" "funnel-enabled (8443 unaffected)"

# -----------------------------------------------------------------------------
# 6. Serve route correct, but 443 actually listens on 0.0.0.0 -> FAIL
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line 0.0.0.0 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line 0.0.0.0 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
run_scenario "listener-0000"
assert_line "listener-0000" "$FAIL_443" "listener on 0.0.0.0"
grep -qi 'unexpected address' "${SCRATCH}/listener-0000/stderr" \
  || fail "listener on 0.0.0.0: detail should call out the unexpected address"
assert_line "listener-0000" "$PASS_8443" "listener on 0.0.0.0 (8443 unaffected)"

# -----------------------------------------------------------------------------
# 7. Serve route correct, but 443 listens on a LAN IP -> FAIL
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$LAN_IP" 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$LAN_IP" 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
run_scenario "listener-lan"
assert_line "listener-lan" "$FAIL_443" "listener on LAN IP"
assert_line "listener-lan" "$PASS_8443" "listener on LAN IP (8443 unaffected)"

# -----------------------------------------------------------------------------
# 8. Serve route correct, 443 has the correct Tailscale-IP listener AND an
#    extra, unexpected listener on the same port -> FAIL, not silently PASS
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line 0.0.0.0 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line 0.0.0.0 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
run_scenario "listener-extra"
assert_line "listener-extra" "$FAIL_443" "extra unexpected listener alongside a correct one"
assert_line "listener-extra" "$PASS_8443" "extra unexpected listener (8443 unaffected)"

# -----------------------------------------------------------------------------
# 9. Serve route correct + only an IPv4 Tailscale listener (no IPv6 at all)
#    -> PASS
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
run_scenario "listener-ipv4-only"
assert_line "listener-ipv4-only" "$PASS_443" "IPv4-only Tailscale listener"
assert_line "listener-ipv4-only" "$PASS_8443" "IPv4-only Tailscale listener"

# -----------------------------------------------------------------------------
# 10. Serve route correct + both IPv4 and IPv6 Tailscale listeners -> PASS
#     (this is exactly the real, live host's behaviour)
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line "$TS_IP6" 443)
$(occ_line "$TS_IP4" 8443)
$(occ_line "$TS_IP6" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP6" 443)
$(ltn_line "$TS_IP4" 8443)
$(ltn_line "$TS_IP6" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
run_scenario "listener-ipv4-ipv6"
assert_line "listener-ipv4-ipv6" "$PASS_443" "IPv4+IPv6 Tailscale listeners"
assert_line "listener-ipv4-ipv6" "$PASS_8443" "IPv4+IPv6 Tailscale listeners"

# -----------------------------------------------------------------------------
# 11. This host's own Tailscale IP addresses cannot be determined -> FAIL,
#     never silently accepted
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
export FAKE_TS_IP_UNAVAILABLE="1"
run_scenario "ip-unavailable"
assert_line "ip-unavailable" "$FAIL_443" "Tailscale IP info unavailable"
grep -qi 'could not be determined' "${SCRATCH}/ip-unavailable/stderr" \
  || fail "Tailscale IP info unavailable: detail should say so"

# -----------------------------------------------------------------------------
# 12. `tailscale serve status --json` cannot be read -> FAIL
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)"
export FAKE_TS_SERVE_UNAVAILABLE="1"
run_scenario "serve-status-unavailable"
assert_line "serve-status-unavailable" "$FAIL_443" "serve status unavailable"

# -----------------------------------------------------------------------------
# 13. Only 443's route is configured; 8443 is missing entirely -> 443 PASSes,
#     8443 FAILs independently
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)
$(occ_line "$TS_IP4" 8443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)
$(ltn_line "$TS_IP4" 8443)"
export FAKE_TS_SERVE_JSON="$PARTIAL_SERVE_JSON"
run_scenario "partial-route"
assert_line "partial-route" "$PASS_443" "partial route (443 configured)"
assert_line "partial-route" "$FAIL_8443" "partial route (8443 missing)"

# -----------------------------------------------------------------------------
# Extra coverage beyond the minimum list: the Tailscale daemon itself is not
# running/connected -> FAIL (checked without ever calling systemctl).
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line "$TS_IP4" 443)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line "$TS_IP4" 443)"
export FAKE_TS_SERVE_JSON="$CORRECT_SERVE_JSON"
export FAKE_TS_BACKEND_STATE="Stopped"
run_scenario "daemon-not-running"
assert_line "daemon-not-running" "$FAIL_443" "daemon not running"
grep -qi 'not Running' "${SCRATCH}/daemon-not-running/stderr" \
  || fail "daemon not running: detail should mention the backend state"

# -----------------------------------------------------------------------------
# A foreign process (not Tailscale, not routed by Tailscale Serve) holds 443
# -> FAIL. 443/8443 always go through Tailscale verification now — there is
# no other legitimate occupant — so an interloper fails because it has no
# matching Serve route, not because of its (here, resolvable) process name.
# -----------------------------------------------------------------------------
reset_fakes
export FAKE_SS_OUTPUT="$(occ_line 127.0.0.1 443 nginx)"
export FAKE_SS_LTN_OUTPUT="$(ltn_line 127.0.0.1 443)"
run_scenario "foreign-process"
assert_line "foreign-process" "$FAIL_443" "foreign process"
grep -qi 'no Tailscale Serve route' "${SCRATCH}/foreign-process/stderr" \
  || fail "foreign process: detail should say no Serve route is configured"

# -----------------------------------------------------------------------------
# Unrelated preflight checks still run (no regression from this change)
# -----------------------------------------------------------------------------
assert_line "free" 'TOOL-001' "unrelated checks (git toolchain) still ran"
assert_line "free" 'OS-00' "unrelated checks (OS detection) still ran"

printf 'PASS: preflight Tailscale Serve port-conflict regression (16 scenarios)\n'
