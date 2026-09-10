#!/usr/bin/env bash
# =============================================================================
# verify-security-secret-whitespace-regression.sh
#
# SEC-006 (verify-security.sh) flags any secret file ending in a whitespace
# byte — except n8n_encryption_key, a documented exception: generate-
# secrets.sh's own SECRET_SPECS marks it "NEVER rotate casually" because
# every credential n8n has ever encrypted becomes unreadable the moment its
# effective value changes, so this check must never nudge an operator into
# "fixing" (rewriting) that one file, even for a trailing byte. Every other
# secret is a randomly generated token with no such constraint and must
# still be flagged.
#
# Drives the real, unmodified verify-security.sh against a synthetic
# PC_SECRETS_DIR with no live stack behind it — docker calls throughout the
# rest of the script return nothing for an absent project-control project,
# which every check already tolerates (the sections before secret
# permissions handle a missing/absent container by skipping, never by hard-
# failing) — so only the section 4 secret-permission checks this test cares
# about need to be real.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-verify-security-secret-ws.XXXXXXXX")"
trap 'rm -rf -- "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker is not available — cannot run this test"
  exit 0
fi

SRC="${SCRATCH}/source"; DEPLOY="${SCRATCH}/deploy"
mkdir -p "$SRC/scripts/lib" "$SRC/infra" "$DEPLOY/secrets" "$DEPLOY/config" "$DEPLOY/runner/bin"
cp "${REPO_ROOT}/scripts/verify-security.sh" "$SRC/scripts/verify-security.sh"
cp "${REPO_ROOT}/scripts/lib/common.sh" "$SRC/scripts/lib/common.sh"
# This synthetic run has no root privileges and no real project-control
# stack behind it — fake exactly the two seams needed to reach section 4
# (secret permissions) without a hard failure: is_root (SEC-002's block is
# gated on it) and load_versions/load_stack_env (need a minimal valid file).
printf '\nis_root() { return 0; }\n' >>"$SRC/scripts/lib/common.sh"

# The real repository lock file — it carries every PC_* key verify-
# security.sh's later (unrelated) sections dereference under `set -u`
# (PC_RUNNER_USER etc.); a minimal synthetic lock is missing most of them.
cp "${REPO_ROOT}/infra/versions.lock.env" "$SRC/infra/versions.lock.env"
cp "$SRC/infra/versions.lock.env" "$DEPLOY/config/versions.lock.env"
cp "$SRC/infra/versions.lock.env" "$DEPLOY/config/stack.env"

# Two ordinary secrets (whitespace-terminated) and n8n_encryption_key
# (also whitespace-terminated) — chmod 0600 root-owned is not achievable as
# a non-root test user, so SEC-002/003/004 will legitimately show findings
# for OTHER reasons; this test only asserts on SEC-006's own classification.
printf 'ordinary-secret-value\n'  >"$DEPLOY/secrets/session_secret"
printf 'other-ordinary-value\r'   >"$DEPLOY/secrets/pg_control_app_password"
printf 'the-encryption-key-value\n' >"$DEPLOY/secrets/n8n_encryption_key"
chmod 0600 "$DEPLOY/secrets"/* 2>/dev/null || true

PROJECT="pc-verify-security-secret-ws-test-$$"
(
  export PATH="${PATH}"
  export PC_ROOT="$DEPLOY" PC_COMPOSE_PROJECT="$PROJECT"
  bash "$SRC/scripts/verify-security.sh" >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr"
) || true

sec006_line="$(grep 'SEC-006' "${SCRATCH}/stderr" || true)"
[[ -n "$sec006_line" ]] || fail "SEC-006 did not run at all — test setup did not reach section 4"
grep -qE '2/3.*whitespace' <<<"$sec006_line" \
  || fail "SEC-006 did not report exactly 2 (of 3) ordinary secrets as whitespace-terminated — got: $sec006_line"
# The FAIL message's own fixed boilerplate always mentions n8n_encryption_key
# by name as a reminder — only the NAMED-FILES portion (before the em-dash
# reminder) must never include it, so isolate that portion before asserting.
named_files="${sec006_line%% — read docs*}"
grep -q 'session_secret' <<<"$named_files" || fail "SEC-006's finding did not name session_secret"
grep -q 'pg_control_app_password' <<<"$named_files" || fail "SEC-006's finding did not name pg_control_app_password"
grep -q 'n8n_encryption_key' <<<"$named_files" \
  && fail "SEC-006 named n8n_encryption_key among the FAILED files — it must never be nudged into an automated rewrite (got: $named_files)"
pass "SEC-006 flags whitespace-terminated ordinary secrets (session_secret, pg_control_app_password) by name, excluding n8n_encryption_key from the named list"

grep -qi 'n8n_encryption_key ends in a whitespace byte' "${SCRATCH}/stderr" \
  || fail "n8n_encryption_key's whitespace was not reported at all — a real, silent risk should still be visible, just not auto-remediated"
grep -qi 'never rotate or rewrite this file casually' "${SCRATCH}/stderr" \
  || fail "the n8n_encryption_key warning did not explain why it is not auto-remediated"
pass "n8n_encryption_key's whitespace is surfaced as a warning (visible, not silently ignored) without contributing to SEC-006's FAIL count"

printf 'PASS: SEC-006 correctly distinguishes n8n_encryption_key (never auto-remediated) from every other secret (still flagged)\n'
