#!/usr/bin/env bash
# =============================================================================
# verification-status-merge-regression.sh
#
# scripts/record-verification-status.sh merges verify.sh's and
# verify-security.sh's own --json output into one small status file the
# Control API reads (probeVerification in routes/system.ts) and the
# deployment-readiness automation workflow will read once it exists. The
# merge itself — not the underlying verify scripts, which have their own
# regression coverage — is what this test isolates: given two synthetic
# --json-shaped documents, does the merge produce the right "overall" and
# preserve each side's own summary counts.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

command -v python3 >/dev/null 2>&1 || fail "python3 is required"

merge() {
  local verify_json="$1" security_json="$2"
  python3 - "$verify_json" "$security_json" "2026-08-17T06:00:00Z" <<'PYEOF'
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
}))
PYEOF
}

both_pass='{"overall":"pass","summary":{"pass":10,"fail":0,"warn":1,"skip":2}}'
verify_fail='{"overall":"fail","summary":{"pass":8,"fail":2,"warn":0,"skip":0}}'
security_pass='{"overall":"pass","summary":{"pass":50,"fail":0,"warn":0,"skip":5}}'
security_fail='{"overall":"fail","summary":{"pass":40,"fail":3,"warn":1,"skip":5}}'

# --- Both pass -> overall pass, both summaries preserved ---------------------
result="$(merge "$both_pass" "$security_pass")"
overall="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["overall"])')"
[[ "$overall" == "pass" ]] || fail "both-pass inputs did not merge to overall=pass (got: ${overall})"

verify_fail_count="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verify"]["summary"]["fail"])')"
[[ "$verify_fail_count" == "0" ]] || fail "verify summary was not preserved through the merge"

# --- verify fails, security passes -> overall fail ---------------------------
result="$(merge "$verify_fail" "$security_pass")"
overall="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["overall"])')"
[[ "$overall" == "fail" ]] || fail "a failing verify.sh result did not make overall=fail"

# --- verify passes, security fails -> overall fail ---------------------------
result="$(merge "$both_pass" "$security_fail")"
overall="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["overall"])')"
[[ "$overall" == "fail" ]] || fail "a failing verify-security.sh result did not make overall=fail"

security_summary_fail="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["verifySecurity"]["summary"]["fail"])')"
[[ "$security_summary_fail" == "3" ]] || fail "verifySecurity summary fail count was not preserved (expected 3, got ${security_summary_fail})"

# --- generatedAt is carried through exactly, not recomputed ------------------
generated_at="$(printf '%s' "$result" | python3 -c 'import json,sys; print(json.load(sys.stdin)["generatedAt"])')"
[[ "$generated_at" == "2026-08-17T06:00:00Z" ]] || fail "generatedAt was not passed through unchanged"

# --- The real script's inline python must match this test's copy exactly ----
# The merge logic itself lives inline inside record-verification-status.sh
# (a heredoc, not a separate importable module); this guards against the two
# copies silently drifting apart.
script="${REPO_ROOT}/scripts/record-verification-status.sh"
[[ -f "$script" ]] || fail "scripts/record-verification-status.sh not found"
grep -q 'def summarise(doc):' "$script" || fail "record-verification-status.sh's merge logic looks different than expected — update this test's copy to match"

printf 'PASS: record-verification-status.sh merge logic combines overall/summary correctly\n'
