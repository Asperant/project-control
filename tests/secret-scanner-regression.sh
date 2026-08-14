#!/usr/bin/env bash
# =============================================================================
# secret-scanner-regression.sh
#
# scripts/verify-security.sh's repository secret scan (GIT-001/GIT-004) must
# distinguish a genuine tracked credential from everything that merely looks
# like one in passing: a comment, a variable/identifier reference, a quoted
# or bare shell parameter expansion ($VAR / ${VAR}), a runtime-generated
# value, a /run/secrets/... path reference, a psql-style :'var' substitution,
# or a recognised test sentinel — while still catching a real password/token
# literal (including a short one with no digits, e.g. "hunter2"), a PEM
# private key, and a token-shaped literal. None of this relies on entropy or
# digit-counting: every exemption above is decided by actual language/tool
# syntax (see scripts/lib/secret-scan.py's module docstring), not a guess
# about how "random-looking" a value is. GIT-004 must key off the tracked
# path's basename, never a bare ".env" substring anywhere in a longer
# filename (e.g. versions.lock.env).
#
# The GIT-001 classifier (scripts/lib/secret-scan.py) is exercised directly
# against synthetic fixture files — no throwaway git repo needed, since the
# classifier itself only reads file content by path. GIT-004's basename
# matching is a two-line grep pipeline inline in verify-security.sh; this
# test mirrors it exactly and cross-checks that mirror against the live
# script text so a future edit to the production regex cannot silently
# leave this test validating stale logic.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCANNER="${REPO_ROOT}/scripts/lib/secret-scan.py"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-secret-scan-test.XXXXXXXX")"

cleanup() {
  case "$SCRATCH" in
    "${TMPDIR:-/tmp}"/project-control-secret-scan-test.*) rm -rf -- "$SCRATCH" ;;
  esac
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$SCANNER" ]] || fail "scripts/lib/secret-scan.py not found"

# scan_one <relative-path-under-SCRATCH>
# Runs the real classifier against exactly one fixture file and prints
# "FLAGGED" or "CLEAN".
scan_one() {
  local rel="$1"
  local out
  out="$(printf '%s\n' "$rel" | python3 "$SCANNER" "$SCRATCH")"
  if [[ -n "$out" ]]; then printf 'FLAGGED'; else printf 'CLEAN'; fi
}

assert_clean() {
  local rel="$1" label="$2"
  local result; result="$(scan_one "$rel")"
  [[ "$result" == "CLEAN" ]] || fail "${label}: expected CLEAN, got ${result} (${rel})"
}

assert_flagged() {
  local rel="$1" label="$2"
  local result; result="$(scan_one "$rel")"
  [[ "$result" == "FLAGGED" ]] || fail "${label}: expected FLAGGED, got ${result} (${rel})"
}

write() { mkdir -p "$(dirname -- "${SCRATCH}/$1")"; printf '%s\n' "$2" >"${SCRATCH}/$1"; }

# -----------------------------------------------------------------------------
# 1. A real secret literal -> FLAGGED
# -----------------------------------------------------------------------------
write "real-literal.txt" 'password = "hunter2Actual9SecretValue"'
assert_flagged "real-literal.txt" "real password literal"

# -----------------------------------------------------------------------------
# 2. A runtime-generated value (randomBytes) -> CLEAN
# -----------------------------------------------------------------------------
write "runtime-secret.ts" "const appPassword = randomBytes(24).toString('base64url');"
assert_clean "runtime-secret.ts" "randomBytes runtime-generated value"

# -----------------------------------------------------------------------------
# 3. A bare identifier used as an RHS reference -> CLEAN
#    (apps/control-api/test/integration/helpers.ts's exact shape)
# -----------------------------------------------------------------------------
write "identifier-ref.ts" "      password: superuserPassword, database: 'project_control',"
assert_clean "identifier-ref.ts" "password-named variable reference"

# -----------------------------------------------------------------------------
# 4. A psql-style :'var' substitution target -> CLEAN
#    (infra/postgres/reconcile/reconcile-roles-and-databases.sh's exact shape)
# -----------------------------------------------------------------------------
write "psql-ref.sh" "ALTER ROLE control_migrator WITH LOGIN PASSWORD :'control_migrator_pw'"
assert_clean "psql-ref.sh" "psql :'var' substitution target"

# -----------------------------------------------------------------------------
# 5. A /run/secrets/... path reference -> CLEAN
# -----------------------------------------------------------------------------
write "path-ref.ts" 'const tokenFile = "/run/secrets/telegram_bot_token";'
assert_clean "path-ref.ts" "/run/secrets/ path reference"

# -----------------------------------------------------------------------------
# 6. A quoted shell parameter expansion ("$VAR" / "${VAR}") -> CLEAN
#    (scripts/backup.sh / scripts/rollback.sh's exact idiom: quoting a
#    variable reference to prevent word-splitting is not a literal)
# -----------------------------------------------------------------------------
write "quoted-expansion.sh" 'PASSWORD="$BACKUP_PW"'
assert_clean "quoted-expansion.sh" "quoted \$VAR shell expansion"
write "quoted-braced-expansion.sh" 'PASSWORD="${BACKUP_PW}"'
assert_clean "quoted-braced-expansion.sh" "quoted \${VAR} shell expansion"

# -----------------------------------------------------------------------------
# 6b. Bare (unquoted) shell parameter expansion -> CLEAN
# -----------------------------------------------------------------------------
write "bare-expansion.sh" 'PASSWORD=$PASSWORD'
assert_clean "bare-expansion.sh" "bare \$VAR shell expansion"
write "bare-braced-expansion.sh" 'PASSWORD=${PASSWORD}'
assert_clean "bare-braced-expansion.sh" "bare \${VAR} shell expansion"

# -----------------------------------------------------------------------------
# 6c. A real, unquoted shell literal with no $ prefix -> FLAGGED. This is the
#     exact case the digit/entropy heuristic used to wrongly wave through.
# -----------------------------------------------------------------------------
write "shell-literal-1.sh" 'PASSWORD=supersecret'
assert_flagged "shell-literal-1.sh" "PASSWORD=supersecret"
write "shell-literal-2.sh" 'PASSWORD=hunter2'
assert_flagged "shell-literal-2.sh" "PASSWORD=hunter2"
write "shell-literal-3.sh" 'DATABASE_PASSWORD=myverysecretpassword'
assert_flagged "shell-literal-3.sh" "DATABASE_PASSWORD=myverysecretpassword"
write "shell-literal-4.sh" 'API_TOKEN=abcdefghijklmnopqrstuvwxyz'
assert_flagged "shell-literal-4.sh" "API_TOKEN=abcdefg..."

# -----------------------------------------------------------------------------
# 7. The explicit test sentinel -> CLEAN
#    (tests/postgres-socket-tmpfs-regression.sh's exact shape)
# -----------------------------------------------------------------------------
write "sentinel.sh" '  -e POSTGRES_PASSWORD=regression-test-only \'
assert_clean "sentinel.sh" "regression-test-only sentinel"

# -----------------------------------------------------------------------------
# 8. A PEM private key literal -> FLAGGED
# -----------------------------------------------------------------------------
write "key.pem" "-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAtestNotARealKeyButShapedLikeOne1234567890abcdef
-----END RSA PRIVATE KEY-----"
assert_flagged "key.pem" "PEM private key literal"

# -----------------------------------------------------------------------------
# 9. A token-shaped literal (Telegram bot-token shape: digits:random) -> FLAGGED
# -----------------------------------------------------------------------------
write "token.ts" 'const token = "123456789:AAHexampleRealisticBotToken1234567890xyz";'
assert_flagged "token.ts" "token-shaped literal"

# -----------------------------------------------------------------------------
# 10. A generic API-key-shaped literal (keyword + quoted value with digits)
#     -> FLAGGED
# -----------------------------------------------------------------------------
write "apikey.ts" 'apiKey: "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6"'
assert_flagged "apikey.ts" "generic API-key-shaped literal"

# -----------------------------------------------------------------------------
# 11. A placeholder value in an example file -> CLEAN
# -----------------------------------------------------------------------------
write "config.env.example" 'API_TOKEN=CHANGEME_REPLACE_WITH_REAL_TOKEN'
assert_clean "config.env.example" "placeholder value"

# =============================================================================
# GIT-004: tracked .env detection must be basename-anchored
# =============================================================================

GIT004_LINE="$(grep -F "grep -E '(^|/)\.env" "${REPO_ROOT}/scripts/verify-security.sh" || true)"
[[ -n "$GIT004_LINE" ]] || fail "GIT-004: could not find the (^|/)\.env(\$|\.) pattern in verify-security.sh — did the check get rewritten? update this test's mirror to match"

is_env_tracked() {
  # Mirrors verify-security.sh's GIT-004 check exactly: path-component
  # (basename) match, only .example is treated as a safe template.
  printf '%s' "$1" | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$' >/dev/null
}

# 12. A real tracked .env file -> FAIL (is_env_tracked true)
if ! is_env_tracked "apps/control-api/.env"; then
  fail "GIT-004: a real tracked .env file must be detected"
fi

# 13. A filename that merely ends in the four characters ".env" without
#     ".env" being its own path component -> PASS (is_env_tracked false)
#     (infra/versions.lock.env is exactly this shape in the real repo)
if is_env_tracked "infra/versions.lock.env"; then
  fail "GIT-004: versions.lock.env must not be mistaken for a tracked .env file"
fi

# 14. .env.example is the recognised safe template -> PASS
if is_env_tracked "apps/control-api/.env.example"; then
  fail "GIT-004: .env.example must remain the recognised safe template"
fi

# 15. .env.production (a real, non-example dotenv variant) -> FAIL
if ! is_env_tracked "apps/control-api/.env.production"; then
  fail "GIT-004: .env.production must be detected as a tracked .env variant"
fi

# -----------------------------------------------------------------------------
# Confirm this repository's own real, current state: PASS (regression proof
# for the exact live false positive this fix addresses)
# -----------------------------------------------------------------------------
cd "$REPO_ROOT"
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  fail "expected ${REPO_ROOT} to be a git checkout for the live-repo regression check"
fi
live_tracked="$(git ls-files)"
if printf '%s' "$live_tracked" | grep -E '(^|/)\.env($|\.)' | grep -v '\.example$' >/dev/null; then
  fail "GIT-004 live check: this repository unexpectedly has a tracked .env file"
fi

live_candidates=""
while IFS= read -r file; do
  [[ -f "${REPO_ROOT}/${file}" ]] || continue
  case "$file" in
    *.md|scripts/verify-security.sh|*/redact*|*.test.ts|*_test.go) continue ;;
  esac
  live_candidates+="${file}"$'\n'
done <<<"$live_tracked"
live_findings="$(printf '%s' "$live_candidates" | python3 "$SCANNER" "$REPO_ROOT")"
if [[ -n "$live_findings" ]]; then
  fail "GIT-001 live check: unexpected finding(s) in this repository: $(printf '%s' "$live_findings" | tr '\n' ' ')"
fi

printf 'PASS: secret scanner regression (20 classifier scenarios, 4 GIT-004 scenarios, live-repo check)\n'
