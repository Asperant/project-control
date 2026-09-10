#!/usr/bin/env bash
# =============================================================================
# verify-security-service-accounts-insert-probe-regression.sh
#
# verify-security.sh's PGS-021 probe against service_accounts used to read:
#
#   INSERT INTO service_accounts (key, display_name, scopes)
#     VALUES ('probe','probe',ARRAY['project:read']) WHERE false
#
# `WHERE` only ever attaches to an INSERT ... SELECT source in PostgreSQL —
# never to a VALUES(...) list. That statement is a syntax error regardless of
# who runs it, which is indistinguishable from PGS-021's own "cannot confirm"
# fail-closed path. It went unnoticed because service_accounts (migration
# 0015) had never actually been applied against a real database before this
# turn's recovery finally let 0015-0018 commit — the exact live host finding
# that surfaced it.
#
# This drives BOTH the old (broken) and the fixed query against a real,
# disposable PostgreSQL and proves: the old form is a syntax error (not a
# permission-shaped failure — the two must never be confused, which is the
# whole reason PGS-021 fails closed instead of just checking the exit code),
# and the fixed form is valid, inserts nothing (WHERE false), and correctly
# surfaces a privilege-denied error for a role with no INSERT grant.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not available/usable — cannot run this test"
  exit 0
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CID="$(docker run -d --rm -e POSTGRES_PASSWORD=x -e POSTGRES_DB=probe postgres:17-alpine)"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  docker exec -e PGPASSWORD=x "$CID" pg_isready -U postgres -d probe >/dev/null 2>&1 && break
  sleep 1
done

psql_as() {
  local user="$1" pw="$2" sql="$3"
  docker exec -i -e PGPASSWORD="$pw" "$CID" psql -U "$user" -d probe -tAc "$sql" 2>&1
}

docker exec -e PGPASSWORD=x "$CID" psql -U postgres -d probe -c \
  "CREATE TABLE service_accounts (id serial primary key, key text, display_name text, scopes text[]);
   CREATE ROLE probe_writer LOGIN PASSWORD 'w';
   CREATE ROLE probe_reader LOGIN PASSWORD 'r';
   GRANT SELECT ON service_accounts TO probe_reader;
   GRANT INSERT ON service_accounts TO probe_writer;
   GRANT USAGE, SELECT ON SEQUENCE service_accounts_id_seq TO probe_writer;" >/dev/null

# -----------------------------------------------------------------------------
# 1: the OLD query is a syntax error for EVERY role, including one with full
#    INSERT privilege — proving the failure was never about permissions.
# -----------------------------------------------------------------------------
old_query="INSERT INTO service_accounts (key, display_name, scopes) VALUES ('probe','probe',ARRAY['project:read']) WHERE false"
out="$(psql_as probe_writer w "$old_query")" && rc=0 || rc=$?
[[ "$rc" != "0" ]] || fail "1: the old VALUES-WHERE query unexpectedly succeeded — this test's PostgreSQL version tolerates syntax this fix assumes is invalid"
grep -qi 'syntax error' <<<"$out" || fail "1: expected a syntax error from the old query, got: $out"
pass "1: the old 'INSERT ... VALUES (...) WHERE false' is a syntax error even for a role with full INSERT privilege — confirms the historical PGS-021 failure was never permission-shaped"

# -----------------------------------------------------------------------------
# 2: the fixed query is valid, inserts nothing, and succeeds for a role with
#    INSERT privilege.
# -----------------------------------------------------------------------------
new_query="INSERT INTO service_accounts (key, display_name, scopes) SELECT 'probe', 'probe', ARRAY['project:read'] WHERE false"
out="$(psql_as probe_writer w "$new_query")" && rc=0 || rc=$?
[[ "$rc" == "0" ]] || fail "2: the fixed query failed for a role with INSERT privilege: $out"
row_count="$(psql_as postgres x 'SELECT count(*) FROM service_accounts' | tr -d '[:space:]')"
[[ "$row_count" == "0" ]] || fail "2: the fixed query inserted a row despite WHERE false (count=${row_count})"
pass "2: the fixed 'INSERT ... SELECT ... WHERE false' is valid PostgreSQL, inserts nothing, and matches the never-inserts probe pattern PGS-023 already uses"

# -----------------------------------------------------------------------------
# 3: the fixed query correctly reports a privilege-denied error for a role
#    with no INSERT grant — the actual guarantee PGS-021 exists to prove.
# -----------------------------------------------------------------------------
out="$(psql_as probe_reader r "$new_query")" && rc=0 || rc=$?
[[ "$rc" != "0" ]] || fail "3: a read-only role was able to run the INSERT probe"
grep -qi 'permission denied' <<<"$out" || fail "3: expected a permission-denied error for the read-only role, got: $out"
pass "3: the fixed query correctly surfaces a real permission-denied error for a role with no INSERT grant — PGS-021 can now actually confirm the read-only guarantee"

# -----------------------------------------------------------------------------
# 4: the repository's verify-security.sh no longer contains the broken form.
# -----------------------------------------------------------------------------
grep -q "VALUES ('probe','probe',ARRAY\['project:read'\]) WHERE false" "${REPO_ROOT}/scripts/verify-security.sh" \
  && fail "4: verify-security.sh still contains the broken VALUES-WHERE query"
grep -q "SELECT 'probe', 'probe', ARRAY\['project:read'\] WHERE false" "${REPO_ROOT}/scripts/verify-security.sh" \
  || fail "4: verify-security.sh does not contain the fixed query"
pass "4: verify-security.sh's PGS-021 probe uses the fixed, valid query"

printf 'PASS: PGS-021 service_accounts INSERT probe uses valid SQL that actually distinguishes a privilege denial from any other failure\n'
