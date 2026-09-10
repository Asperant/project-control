#!/usr/bin/env bash
# =============================================================================
# record-verification-status.sh — runs verify + verify-security and writes
# their overall result to config/status/verification.json.
#
# This is what makes the `deployment-readiness` automation workflow possible
# without giving n8n (or anything else) the ability to run verify.sh itself:
# n8n cannot exec, cannot reach systemd, and cannot nsenter. This script runs
# on the host, on a timer, the same way backup.sh does, and the Control API
# only ever reads the small JSON file it produces — see
# apps/control-api/src/routes/system.ts's probeVerification.
#
# Full check output (every individual check id) is deliberately NOT written
# to this file: it would duplicate ./pcctl verify's own terminal output for
# no operational benefit, and would grow the file with every new check this
# repository ever adds. Only each run's overall result and pass/fail/warn/
# skip counts are recorded.
#
# Exit code always reflects the underlying verify runs, so this can also be
# invoked directly by an operator to see the same status update in the log.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_stack_env

STATUS_FILE="${PC_ROOT}/config/status/verification.json"

run_and_capture() {
  local script="$1"
  bash "${PC_SCRIPTS_DIR}/${script}" --json 2>/dev/null || true
}

verify_json="$(run_and_capture verify.sh)"
security_json="$(run_and_capture verify-security.sh)"

if [[ -z "$verify_json" || -z "$security_json" ]]; then
  die "one or both verification scripts produced no JSON output; nothing was recorded"
fi

tmp="$(mktemp)"
if ! python3 - "$verify_json" "$security_json" "$(_pc_ts)" >"$tmp" <<'PYEOF'
import json, sys

verify = json.loads(sys.argv[1])
security = json.loads(sys.argv[2])
generated_at = sys.argv[3]

def summarise(doc):
    return {"overall": doc.get("overall", "unknown"), "summary": doc.get("summary", {})}

overall = "pass"
if verify.get("overall") == "fail" or security.get("overall") == "fail":
    overall = "fail"

print(json.dumps({
    "generatedAt": generated_at,
    "overall": overall,
    "verify": summarise(verify),
    "verifySecurity": summarise(security),
}, indent=2))
PYEOF
then
  rm -f "$tmp"
  die "failed to merge verify/verify-security JSON output"
fi

install_file "$tmp" "$STATUS_FILE" 0644
rm -f "$tmp"

overall="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["overall"])' "$STATUS_FILE")"
if [[ "$overall" == "fail" ]]; then
  log_error "verification recorded: FAIL — see ${STATUS_FILE}"
  exit 1
fi
log_ok "verification recorded: ${overall} — ${STATUS_FILE}"
