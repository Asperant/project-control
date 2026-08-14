#!/usr/bin/env bash
# =============================================================================
# runner-confinement-hardened-value-regression.sh
#
# scripts/verify-security.sh's RNR-002 check reads five systemd hardening
# directives off the live project-control-runner.service unit and must
# accept each one's OWN set of genuinely hardened values — never a single
# shared allowlist, and never by substring. This is the regression this
# file exists for: ProtectHome=tmpfs (this deployment's deliberate choice —
# see infra/systemd/project-control-runner.service and
# docs/security-model.md, and RNR-010/011/012/013, which independently
# prove the resulting bind mount is real, read-only and correctly scoped)
# used to FAIL here because the old check only accepted a single shared
# {yes, strict, true} set that had no room for ProtectHome's own hardened
# values ("yes", "read-only", "tmpfs").
#
# The exact per-directive accepted-value logic is mirrored from
# verify-security.sh (matched against the live source below, so this test
# cannot silently validate stale logic), then driven with both literal
# strings (covering malformed/empty/wrong-directive values no real systemd
# unit would ever report) and, where systemd-run is usable, real transient
# units — the same technique already used by
# runner-allowed-root-regression.sh.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
VERIFY_SECURITY_SH="${REPO_ROOT}/scripts/verify-security.sh"

cleanup() {
  systemctl stop pc-rnr002-test.service >/dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$VERIFY_SECURITY_SH" ]] || fail "scripts/verify-security.sh not found"

# =============================================================================
# 1. Source-level self-consistency: the exact accepted-value strings this
#    test relies on must still be present in the live script.
# =============================================================================
grep -qF '[ProtectHome]="yes read-only tmpfs"' "$VERIFY_SECURITY_SH" \
  || fail "verify-security.sh's ProtectHome accepted-value list changed — update this test's mirror to match"
grep -qF '[ProtectSystem]="strict"' "$VERIFY_SECURITY_SH" \
  || fail "verify-security.sh's ProtectSystem accepted-value list changed — update this test's mirror to match"
grep -qF '[NoNewPrivileges]="yes"' "$VERIFY_SECURITY_SH" \
  || fail "verify-security.sh's NoNewPrivileges accepted-value list changed — update this test's mirror to match"
grep -qF '[PrivateTmp]="yes"' "$VERIFY_SECURITY_SH" \
  || fail "verify-security.sh's PrivateTmp accepted-value list changed — update this test's mirror to match"
grep -qF '[RestrictSUIDSGID]="yes"' "$VERIFY_SECURITY_SH" \
  || fail "verify-security.sh's RestrictSUIDSGID accepted-value list changed — update this test's mirror to match"
grep -qF '"$accepted" == *" ${value} "*' "$VERIFY_SECURITY_SH" \
  || fail "verify-security.sh no longer uses exact, space-delimited token matching — update this test's mirror to match"

printf 'PASS: verify-security.sh RNR-002 accepted-value source matches this test'"'"'s mirror\n'

# =============================================================================
# 2. Mirrored matcher, driven by literal (possibly malformed) strings
# =============================================================================
declare -A RUNNER_HARDENED_VALUES=(
  [NoNewPrivileges]="yes"
  [ProtectSystem]="strict"
  [PrivateTmp]="yes"
  [ProtectHome]="yes read-only tmpfs"
  [RestrictSUIDSGID]="yes"
)

# rnr002_verdict <directive> <value>
rnr002_verdict() {
  local directive="$1" value="$2"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  local accepted=" ${RUNNER_HARDENED_VALUES[$directive]} "
  if [[ -n "$value" && "$accepted" == *" ${value} "* ]]; then
    printf 'PASS'
  else
    printf 'FAIL'
  fi
}

assert_verdict() {
  local directive="$1" value="$2" expected="$3" label="$4"
  local got; got="$(rnr002_verdict "$directive" "$value")"
  [[ "$got" == "$expected" ]] \
    || fail "${label}: ProtectHome=${value@Q} expected ${expected}, got ${got}"
}

[[ "$(rnr002_verdict ProtectHome tmpfs)" == "PASS" ]] || fail "ProtectHome=tmpfs must PASS"
[[ "$(rnr002_verdict ProtectHome yes)" == "PASS" ]] || fail "ProtectHome=yes must PASS"
[[ "$(rnr002_verdict ProtectHome read-only)" == "PASS" ]] || fail "ProtectHome=read-only must PASS"
[[ "$(rnr002_verdict ProtectHome no)" == "FAIL" ]] || fail "ProtectHome=no must FAIL"
[[ "$(rnr002_verdict ProtectHome false)" == "FAIL" ]] || fail "ProtectHome=false must FAIL"
[[ "$(rnr002_verdict ProtectHome '')" == "FAIL" ]] || fail "ProtectHome=(empty) must FAIL"

printf 'PASS: ProtectHome literal-value matrix (tmpfs/yes/read-only PASS; no/false/empty FAIL)\n'

# Malformed values, including ones crafted specifically to defeat a
# substring-based (rather than exact-token) check.
for malformed in "tmpfsx" "xtmpfs" "TMPFS" "Tmpfs" "yesno" "noyes" "full" "read_only" "readonly" "yes,tmpfs"; do
  [[ "$(rnr002_verdict ProtectHome "$malformed")" == "FAIL" ]] \
    || fail "malformed ProtectHome value ${malformed@Q} must FAIL, not be accepted by a loose/substring match"
done

printf 'PASS: malformed/near-miss ProtectHome values all FAIL (substring-safety proven)\n'

# Incidental leading/trailing whitespace IS normalized away before the exact
# match (task requirement: normalize, then compare exactly) — this is
# intentional robustness, not a loophole, so these must still PASS.
[[ "$(rnr002_verdict ProtectHome ' tmpfs')" == "PASS" ]] || fail "leading whitespace around a valid value must still PASS after normalization"
[[ "$(rnr002_verdict ProtectHome 'tmpfs ')" == "PASS" ]] || fail "trailing whitespace around a valid value must still PASS after normalization"

# A value valid for ProtectHome must not leak into acceptance for a
# different directive — proves the fix is genuinely per-directive, not a
# single shared allowlist that happens to have grown a new entry.
[[ "$(rnr002_verdict ProtectSystem tmpfs)" == "FAIL" ]] \
  || fail "ProtectSystem=tmpfs must FAIL — tmpfs is not a valid ProtectSystem value, only ProtectHome's"
[[ "$(rnr002_verdict ProtectSystem read-only)" == "FAIL" ]] \
  || fail "ProtectSystem=read-only must FAIL"
[[ "$(rnr002_verdict NoNewPrivileges tmpfs)" == "FAIL" ]] \
  || fail "NoNewPrivileges=tmpfs must FAIL — tmpfs means nothing for a boolean directive"
[[ "$(rnr002_verdict PrivateTmp read-only)" == "FAIL" ]] \
  || fail "PrivateTmp=read-only must FAIL"
[[ "$(rnr002_verdict RestrictSUIDSGID tmpfs)" == "FAIL" ]] \
  || fail "RestrictSUIDSGID=tmpfs must FAIL"

# The other four directives' own hardened values still work.
[[ "$(rnr002_verdict NoNewPrivileges yes)" == "PASS" ]] || fail "NoNewPrivileges=yes must PASS"
[[ "$(rnr002_verdict ProtectSystem strict)" == "PASS" ]] || fail "ProtectSystem=strict must PASS"
[[ "$(rnr002_verdict PrivateTmp yes)" == "PASS" ]] || fail "PrivateTmp=yes must PASS"
[[ "$(rnr002_verdict RestrictSUIDSGID yes)" == "PASS" ]] || fail "RestrictSUIDSGID=yes must PASS"

printf 'PASS: per-directive isolation (a value hardened for one directive does not leak into another)\n'

# =============================================================================
# 3. Real transient systemd units (no root needed beyond what systemd-run
#    itself requires — see runner-allowed-root-regression.sh for the same
#    technique and its own root/permission notes). Skipped, not failed, if
#    this session cannot manage transient units.
# =============================================================================
have_systemd_run_permission() {
  systemd-run --quiet --unit=pc-rnr002-probe --collect --wait --pipe -- true >/dev/null 2>&1
}

check_real_unit() {
  local protect_home="$1" expected="$2" label="$3"
  systemctl stop pc-rnr002-test.service >/dev/null 2>&1 || true
  systemd-run --quiet --unit=pc-rnr002-test --collect \
    -p NoNewPrivileges=yes -p ProtectSystem=strict -p PrivateTmp=yes -p RestrictSUIDSGID=yes \
    -p "ProtectHome=${protect_home}" \
    -- sleep 5 >/dev/null 2>&1
  sleep 0.3
  local reported; reported="$(systemctl show -p ProtectHome --value pc-rnr002-test.service 2>/dev/null || echo '')"
  local got; got="$(rnr002_verdict ProtectHome "$reported")"
  systemctl stop pc-rnr002-test.service >/dev/null 2>&1 || true
  [[ "$got" == "$expected" ]] \
    || fail "${label}: real unit reported ProtectHome=${reported@Q}, verdict ${got}, expected ${expected}"
}

if ! command -v systemd-run >/dev/null 2>&1; then
  printf 'SKIP: systemd-run is not available\n'
elif ! have_systemd_run_permission; then
  printf 'SKIP: this session is not permitted to manage transient systemd units\n'
else
  check_real_unit tmpfs PASS "real unit, ProtectHome=tmpfs"
  check_real_unit yes PASS "real unit, ProtectHome=yes"
  check_real_unit read-only PASS "real unit, ProtectHome=read-only"
  check_real_unit no FAIL "real unit, ProtectHome=no"
  printf 'PASS: real transient systemd units confirm tmpfs/yes/read-only PASS, no FAILs\n'
fi

printf 'PASS: runner confinement hardened-value regression suite\n'
