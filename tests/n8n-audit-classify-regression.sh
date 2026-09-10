#!/usr/bin/env bash
# =============================================================================
# n8n-audit-classify-regression.sh
#
# scripts/lib/n8n-audit-classify.py (N8N-004/N8N-005/N8N-006) must classify
# `n8n audit` output on real semantics, not a string grep for one setting
# name: community packages enabled/disabled/unreadable, the accepted
# "outdated instance" notice, and — the property a narrow grep cannot have —
# ANY unrecognised finding (a Credentials/Database/Nodes/Filesystem Risk
# Report, or a new, unrecognised section inside Instance Risk Report) must
# fail closed rather than be silently ignored.
#
# Every fixture here is synthetic; none of it touches a live n8n instance.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
CLASSIFIER="${REPO_ROOT}/scripts/lib/n8n-audit-classify.py"

command -v python3 >/dev/null 2>&1 || { echo "FAIL: python3 is required" >&2; exit 1; }
[[ -f "$CLASSIFIER" ]] || { echo "FAIL: ${CLASSIFIER} not found" >&2; exit 1; }

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

# classify_field <fixture-json> <check-id> -> the STATUS field for that id
classify_field() {
  local json="$1" id="$2"
  printf '%s' "$json" | python3 "$CLASSIFIER" | awk -F'|' -v id="$id" '$2==id {print $1; exit}'
}

# --- Community packages disabled: PASS ---------------------------------------
disabled_json='{"Instance Risk Report":{"risk":"instance","sections":[{"title":"Security settings","description":"d","recommendation":"r","settings":{"features":{"communityPackagesEnabled":false}}}]}}'
status="$(classify_field "$disabled_json" N8N-004)"
[[ "$status" == "PASS" ]] || fail "community packages disabled should classify N8N-004 as PASS, got: ${status:-<none>}"

# --- Community packages enabled: FAIL ----------------------------------------
enabled_json='{"Instance Risk Report":{"risk":"instance","sections":[{"title":"Security settings","description":"d","recommendation":"r","settings":{"features":{"communityPackagesEnabled":true}}}]}}'
status="$(classify_field "$enabled_json" N8N-004)"
[[ "$status" == "FAIL" ]] || fail "community packages enabled should classify N8N-004 as FAIL, got: ${status:-<none>}"

# --- No Security settings section at all: WARN, never a silent PASS ---------
no_security_json='{"Instance Risk Report":{"risk":"instance","sections":[{"title":"Outdated instance","description":"d","recommendation":"r"}]}}'
status="$(classify_field "$no_security_json" N8N-004)"
[[ "$status" == "WARN" ]] || fail "a missing Security settings section should classify N8N-004 as WARN, got: ${status:-<none>}"

# --- No Instance Risk Report at all: WARN ------------------------------------
empty_json='{}'
status="$(classify_field "$empty_json" N8N-004)"
[[ "$status" == "WARN" ]] || fail "an empty audit document should classify N8N-004 as WARN, got: ${status:-<none>}"

# --- Outdated instance present: WARN (accepted, documented), never FAIL -----
status="$(classify_field "$no_security_json" N8N-005)"
[[ "$status" == "WARN" ]] || fail "an 'Outdated instance' section should classify N8N-005 as WARN, got: ${status:-<none>}"

# --- Outdated instance absent: PASS ------------------------------------------
status="$(classify_field "$disabled_json" N8N-005)"
[[ "$status" == "PASS" ]] || fail "no 'Outdated instance' section should classify N8N-005 as PASS, got: ${status:-<none>}"

# --- No unexpected findings: PASS --------------------------------------------
status="$(classify_field "$disabled_json" N8N-006)"
[[ "$status" == "PASS" ]] || fail "a document with only known sections should classify N8N-006 as PASS, got: ${status:-<none>}"

# --- An unrecognised Instance Risk Report section: FAIL, not silently dropped
unknown_instance_section='{"Instance Risk Report":{"risk":"instance","sections":[{"title":"Something n8n added later","description":"d","recommendation":"r"}]}}'
status="$(classify_field "$unknown_instance_section" N8N-006)"
[[ "$status" == "FAIL" ]] || fail "an unrecognised Instance Risk Report section should classify N8N-006 as FAIL, got: ${status:-<none>}"

# --- A Credentials Risk Report present at all: FAIL, this is the case a plain
#     "grep communityPackagesEnabled" could never catch.
credentials_json='{"Instance Risk Report":{"risk":"instance","sections":[{"title":"Security settings","settings":{"features":{"communityPackagesEnabled":false}}}]},"Credentials Risk Report":{"risk":"credentials","sections":[{"title":"Unused credentials","description":"d"}]}}'
status="$(classify_field "$credentials_json" N8N-006)"
[[ "$status" == "FAIL" ]] || fail "a Credentials Risk Report should classify N8N-006 as FAIL, got: ${status:-<none>}"
# And community packages, an unrelated finding, must still be classified
# correctly and independently — one bad category must not mask another.
status="$(classify_field "$credentials_json" N8N-004)"
[[ "$status" == "PASS" ]] || fail "an unrelated Credentials Risk Report must not change the N8N-004 classification, got: ${status:-<none>}"

# --- A Database Risk Report present: FAIL -------------------------------------
database_json='{"Database Risk Report":{"risk":"database","sections":[{"title":"Expressions in queries","description":"possible SQL injection"}]}}'
status="$(classify_field "$database_json" N8N-006)"
[[ "$status" == "FAIL" ]] || fail "a Database Risk Report should classify N8N-006 as FAIL, got: ${status:-<none>}"

# --- A Nodes Risk Report present: FAIL ---------------------------------------
nodes_json='{"Nodes Risk Report":{"risk":"nodes","sections":[{"title":"Deprecated nodes","description":"d"}]}}'
status="$(classify_field "$nodes_json" N8N-006)"
[[ "$status" == "FAIL" ]] || fail "a Nodes Risk Report should classify N8N-006 as FAIL, got: ${status:-<none>}"

# --- "Official risky nodes" naming ONLY httpRequest/code: accepted (WARN
#     N8N-007), and this alone must not fail N8N-006 — the shipped, reviewed
#     Project Control workflows are built on exactly these two node types.
accepted_risky_nodes_json='{"Nodes Risk Report":{"risk":"nodes","sections":[{"title":"Official risky nodes","description":"d","recommendation":"r","location":[{"kind":"node","workflowId":"w1","workflowName":"Project Control — System Health","nodeId":"n1","nodeName":"Open Run","nodeType":"n8n-nodes-base.httpRequest"},{"kind":"node","workflowId":"w1","workflowName":"Project Control — System Health","nodeId":"n2","nodeName":"Evaluate","nodeType":"n8n-nodes-base.code"}]}]}}'
status="$(classify_field "$accepted_risky_nodes_json" N8N-006)"
[[ "$status" == "PASS" ]] || fail "Official risky nodes naming only httpRequest/code should still classify N8N-006 as PASS, got: ${status:-<none>}"
status="$(classify_field "$accepted_risky_nodes_json" N8N-007)"
[[ "$status" == "WARN" ]] || fail "Official risky nodes naming only httpRequest/code should classify N8N-007 as WARN (visible, accepted), got: ${status:-<none>}"

# --- "Official risky nodes" naming an UNEXPECTED node type (e.g. Execute
#     Command, despite NODES_EXCLUDE): must still fail closed, not be swept
#     into the same acceptance as the two reviewed node types.
unexpected_risky_node_json='{"Nodes Risk Report":{"risk":"nodes","sections":[{"title":"Official risky nodes","description":"d","recommendation":"r","location":[{"kind":"node","workflowId":"w2","workflowName":"Some other workflow","nodeId":"n3","nodeName":"Run Shell","nodeType":"n8n-nodes-base.executeCommand"}]}]}}'
status="$(classify_field "$unexpected_risky_node_json" N8N-006)"
[[ "$status" == "FAIL" ]] || fail "Official risky nodes naming an unreviewed node type (executeCommand) should classify N8N-006 as FAIL, got: ${status:-<none>}"
status="$(classify_field "$unexpected_risky_node_json" N8N-007)"
[[ -z "$status" ]] || fail "N8N-007 must not be emitted when the Official risky nodes finding was not fully accepted, got: ${status}"

# --- A Nodes Risk Report with a DIFFERENT section title alongside an
#     accepted-shaped one: the report as a whole is not accepted (every
#     section must be "Official risky nodes" for acceptance).
mixed_nodes_json='{"Nodes Risk Report":{"risk":"nodes","sections":[{"title":"Official risky nodes","location":[{"nodeType":"n8n-nodes-base.httpRequest"}]},{"title":"Deprecated nodes","description":"d"}]}}'
status="$(classify_field "$mixed_nodes_json" N8N-006)"
[[ "$status" == "FAIL" ]] || fail "a Nodes Risk Report mixing an accepted section with an unrecognised one should classify N8N-006 as FAIL, got: ${status:-<none>}"

# --- A Filesystem Risk Report present: FAIL ----------------------------------
filesystem_json='{"Filesystem Risk Report":{"risk":"filesystem","sections":[{"title":"Filesystem interaction node used","description":"d"}]}}'
status="$(classify_field "$filesystem_json" N8N-006)"
[[ "$status" == "FAIL" ]] || fail "a Filesystem Risk Report should classify N8N-006 as FAIL, got: ${status:-<none>}"

# --- Malformed / non-JSON input: WARN on every id, never a crash or a PASS --
garbage="not json at all"
lines="$(printf '%s' "$garbage" | python3 "$CLASSIFIER")"
[[ -n "$lines" ]] || fail "malformed input produced no output at all"
if printf '%s' "$lines" | grep -q '^PASS|'; then
  fail "malformed input must never classify as PASS; got:\n${lines}"
fi

# --- The n8n CLI's own pre-JSON status line must not break parsing ----------
prefixed_json="Acquiring database migration lock...
${disabled_json}"
status="$(classify_field "$prefixed_json" N8N-004)"
[[ "$status" == "PASS" ]] || fail "a status line before the JSON report should not break parsing, got: ${status:-<none>}"

# --- Every emitted line matches the STATUS|ID|DESC|DETAIL shape verify-
#     security.sh's own record_check/PC_CHECK_ROWS convention expects.
malformed_lines=0
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  IFS='|' read -r status id _desc _detail <<<"$line"
  case "$status" in PASS|FAIL|WARN|SKIP) ;; *) malformed_lines=$((malformed_lines+1)) ;; esac
  [[ "$id" =~ ^N8N-00[4567]$ ]] || malformed_lines=$((malformed_lines+1))
done < <(printf '%s' "$disabled_json" | python3 "$CLASSIFIER")
(( malformed_lines == 0 )) || fail "${malformed_lines} emitted line(s) did not match the STATUS|ID|DESC|DETAIL convention"

printf 'PASS: n8n-audit-classify.py correctly classifies community-packages, outdated-version and unexpected-finding cases\n'
