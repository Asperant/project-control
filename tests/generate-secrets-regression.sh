#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"

# The production script correctly requires uid 0. Use an isolated user namespace
# when the test is launched by an unprivileged developer; no host root access is
# gained and the real deployment tree is never touched.
if [[ "${1:-}" != "--inside-userns" && "$(id -u)" -ne 0 ]]; then
  command -v unshare >/dev/null 2>&1 || {
    printf 'SKIP: unshare is required for root-ownership regression checks\n' >&2
    exit 77
  }
  exec unshare -Ur bash "$0" --inside-userns
fi

TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/project-control-secrets-test.XXXXXXXX")"
case "$TEST_ROOT" in
  "${TMPDIR:-/tmp}"/project-control-secrets-test.*) ;;
  *) printf 'FAIL: unsafe test root\n' >&2; exit 1 ;;
esac

cleanup() {
  case "$TEST_ROOT" in
    "${TMPDIR:-/tmp}"/project-control-secrets-test.*)
      chmod -R u+rwX "$TEST_ROOT" 2>/dev/null || true
      rm -rf -- "$TEST_ROOT"
      ;;
  esac
}
trap cleanup EXIT

SECRETS_DIR="${TEST_ROOT}/secrets"
LOG_FILE="${TEST_ROOT}/test.log"
SNAPSHOT_DIR="${TEST_ROOT}/snapshot"
TOKEN_FILE="${TEST_ROOT}/token"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
assert_file_meta() {
  local file="$1" expected_size="$2" expected_mode="$3" expected_gid="$4"
  [[ -f "$file" && ! -L "$file" ]] || fail "expected regular file is missing"
  [[ "$(stat -c '%s' "$file")" == "$expected_size" ]] || fail "unexpected secret length"
  [[ "$(stat -c '%u' "$file")" == "0" ]] || fail "unexpected secret owner"
  [[ "$(stat -c '%g' "$file")" == "$expected_gid" ]] || fail "unexpected secret group"
  [[ "$(stat -c '%a' "$file")" == "$expected_mode" ]] || fail "unexpected secret mode"
}
assert_no_newline() {
  [[ "$(wc -l <"$1")" == "0" ]] || fail "secret contains an unexpected newline"
}

run_generator() {
  PC_ROOT="$TEST_ROOT" \
  PC_POSTGRES_GID=0 \
  PC_APP_GID=0 \
  PC_N8N_GID=0 \
    bash "${REPO_ROOT}/scripts/generate-secrets.sh" >>"$LOG_FILE" 2>&1
}

# Direct regression for line 269: strict mode + pipefail, exit 0, exact bytes,
# and no implicit newline.
(
  set -eEuo pipefail
  umask 077
  # shellcheck source=../scripts/lib/common.sh
  source "${REPO_ROOT}/scripts/lib/common.sh"
  random_token 37 >"$TOKEN_FILE"
)
assert_file_meta "$TOKEN_FILE" 37 600 0
assert_no_newline "$TOKEN_FILE"

# Two simultaneous first runs share an empty root. The process lock must keep
# initial generation and bundle staging from overwriting each other's values.
run_generator &
first_pid=$!
run_generator &
second_pid=$!
wait "$first_pid"
wait "$second_pid"
[[ "$(grep -c 'secret written:' "$LOG_FILE")" == "7" ]] \
  || fail "concurrent first run generated a secret more than once"

declare -A EXPECTED_LENGTHS=(
  [pg_superuser_password]=32
  [pg_control_app_password]=32
  [pg_control_migrator_password]=32
  [pg_n8n_app_password]=32
  [pg_backup_reader_password]=32
  [session_secret]=48
  [n8n_encryption_key]=32
)

for name in "${!EXPECTED_LENGTHS[@]}"; do
  assert_file_meta "${SECRETS_DIR}/${name}" "${EXPECTED_LENGTHS[$name]}" 600 0
  assert_no_newline "${SECRETS_DIR}/${name}"
done

# A second run must preserve every valid secret byte-for-byte.
mkdir -p "$SNAPSHOT_DIR"
chmod 0700 "$SNAPSHOT_DIR"
for name in "${!EXPECTED_LENGTHS[@]}"; do
  cp -p "${SECRETS_DIR}/${name}" "${SNAPSHOT_DIR}/${name}"
done
run_generator
for name in "${!EXPECTED_LENGTHS[@]}"; do
  cmp -s "${SNAPSHOT_DIR}/${name}" "${SECRETS_DIR}/${name}" \
    || fail "valid secret changed on repeated run"
done

# A valid operator-provided value is never overwritten without explicit
# rotation. Its value is deliberately not printed or passed to a subprocess.
printf '%032d' 0 >"${SECRETS_DIR}/pg_control_app_password"
chmod 0600 "${SECRETS_DIR}/pg_control_app_password"
cp -p "${SECRETS_DIR}/pg_control_app_password" "${SNAPSHOT_DIR}/no-rotation"
run_generator
cmp -s "${SNAPSHOT_DIR}/no-rotation" "${SECRETS_DIR}/pg_control_app_password" \
  || fail "valid secret was overwritten without rotation"

# Invalid length is regenerated safely.
printf 'x' >"${SECRETS_DIR}/pg_control_migrator_password"
chmod 0600 "${SECRETS_DIR}/pg_control_migrator_password"
run_generator
assert_file_meta "${SECRETS_DIR}/pg_control_migrator_password" 32 600 0

# Valid length with an invalid mode is independently regenerated.
printf '%032d' 1 >"${SECRETS_DIR}/pg_n8n_app_password"
chmod 0644 "${SECRETS_DIR}/pg_n8n_app_password"
run_generator
assert_file_meta "${SECRETS_DIR}/pg_n8n_app_password" 32 600 0

# Bundle staging must include exactly the declared files with matching bytes.
declare -A DISTRIBUTION=(
  [postgres]='pg_superuser_password pg_control_app_password pg_control_migrator_password pg_n8n_app_password pg_backup_reader_password'
  [control-api]='pg_control_app_password pg_control_migrator_password session_secret'
  [n8n]='pg_n8n_app_password n8n_encryption_key'
)
for service in "${!DISTRIBUTION[@]}"; do
  IFS=' ' read -r -a names <<<"${DISTRIBUTION[$service]}"
  [[ "$(find "${SECRETS_DIR}/${service}" -maxdepth 1 -type f | wc -l)" == "${#names[@]}" ]] \
    || fail "bundle file count mismatch"
  for name in "${names[@]}"; do
    assert_file_meta "${SECRETS_DIR}/${service}/${name}" "$(stat -c '%s' "${SECRETS_DIR}/${name}")" 640 0
    cmp -s "${SECRETS_DIR}/${name}" "${SECRETS_DIR}/${service}/${name}" \
      || fail "bundle content does not match source"
  done
done

# Search captured output using file contents internally. awk receives only file
# paths as arguments and emits nothing, so test output cannot reveal a secret.
while IFS= read -r -d '' secret_file; do
  awk 'NR == FNR { needle = substr($0, 1, 12); next } index($0, needle) { found = 1 } END { exit found ? 1 : 0 }' \
    "$secret_file" "$LOG_FILE" || fail "secret material appeared in logs"
done < <(find "$SNAPSHOT_DIR" "$SECRETS_DIR" -maxdepth 1 -type f ! -name '.*' -print0)
awk 'NR == FNR { needle = substr($0, 1, 12); next } index($0, needle) { found = 1 } END { exit found ? 1 : 0 }' \
  "$TOKEN_FILE" "$LOG_FILE" || fail "random token appeared in logs"

if grep -E '^[^#]*\|[[:space:]]*head[[:space:]]+-c' \
  "${REPO_ROOT}/scripts/lib/common.sh" "${REPO_ROOT}/scripts/generate-secrets.sh" >/dev/null; then
  fail "unsafe head -c secret pipeline remains"
fi

printf 'PASS: secret generation regression suite\n'
