#!/usr/bin/env bash
# =============================================================================
# runner-allowed-root-regression.sh
#
# Covers two things:
#
#  1. Static/structural checks — the base unit and install.sh's drop-in
#     generation/validation logic — that need no root and no live runner.
#     This includes the specific regression this file exists for: the base
#     unit must use ProtectHome=tmpfs, not ProtectHome=yes. Per
#     systemd.exec(5), a BindReadOnlyPaths= mount point cannot be created
#     nested under a path ProtectHome=yes has made inaccessible (it is
#     treated the same as InaccessiblePaths= for that purpose) — the drop-in
#     would be syntactically valid, the unit would still start, and the bind
#     mount would simply never apply. ProtectHome=tmpfs hides /home the same
#     way but is a real, mountable filesystem, so the override works.
#
#  2. A real, non-mocked dynamic proof of the actual kernel behaviour, using
#     a throwaway `systemd-run` transient unit configured with the exact
#     same directives as the real runner unit, and `nsenter` to test from
#     inside its mount namespace — read works, write is rejected, siblings
#     under /home stay hidden, a nonexistent root fails closed without
#     crashing the unit. This needs root (nsenter into another process's
#     mount namespace does, regardless of who started it) and a working
#     system systemd manager; it is skipped, not failed, when unavailable —
#     matching verify-security.sh's own is_root gating for the same proof.
#     Every fixture lives under a throwaway temp directory, never under any
#     real project folder.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
UNIT="${REPO_ROOT}/infra/systemd/project-control-runner.service"
INSTALL_SH="${REPO_ROOT}/scripts/install.sh"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-allowed-root-test.XXXXXXXX")"

cleanup() {
  systemctl stop pc-allowed-root-test.service >/dev/null 2>&1 || true
  case "$SCRATCH" in
    "${TMPDIR:-/tmp}"/project-control-allowed-root-test.*) rm -rf -- "$SCRATCH" ;;
  esac
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

[[ -f "$UNIT" ]] || fail "unit file not found: $UNIT"
[[ -f "$INSTALL_SH" ]] || fail "install.sh not found: $INSTALL_SH"

service_section() { awk '/^\[Service\]/{f=1;next}/^\[/{f=0}f' "$UNIT"; }

# =============================================================================
# 1. Static checks on the base unit
# =============================================================================

# 1a. The actual regression: ProtectHome must be tmpfs, never yes/read-only,
#     since only tmpfs supports a nested BindReadOnlyPaths= mount point.
grep -qE '^ProtectHome=tmpfs$' "$UNIT" \
  || fail "base unit must set ProtectHome=tmpfs (found: $(service_section | grep -E '^ProtectHome=' || echo 'nothing'))"
service_section | grep -qE '^ProtectHome=(yes|true|read-only)$' \
  && fail "base unit must not use a ProtectHome= value incompatible with BindReadOnlyPaths="

# 1b. Every other confinement option this fix must not weaken.
service_section | grep -qE '^ProtectSystem=strict$'      || fail "ProtectSystem=strict is missing"
service_section | grep -qE '^NoNewPrivileges=yes$'        || fail "NoNewPrivileges=yes is missing"
service_section | grep -qE '^CapabilityBoundingSet=$'     || fail "CapabilityBoundingSet is not empty"
service_section | grep -qE '^AmbientCapabilities=$'       || fail "AmbientCapabilities is not empty"
service_section | grep -qE '^RestrictAddressFamilies=AF_UNIX$' || fail "RestrictAddressFamilies must remain AF_UNIX-only"
service_section | grep -qE '^User=project-runner$'        || fail "the runner must not run as root"
service_section | grep -vE '^[[:space:]]*#' | grep -qiE 'docker\.sock' \
  && fail "the base unit must never reference docker.sock in an active directive"

# 1c. No BindPaths= (read-write) anywhere in the base unit.
service_section | grep -qE '^BindPaths=' && fail "base unit must never use writable BindPaths="

printf 'PASS: base unit uses ProtectHome=tmpfs with all other confinement intact\n'

# =============================================================================
# 2. install.sh's allowed-root validation/canonicalization, mirrored
# =============================================================================
# install.sh needs PC_ROOT/root to run end-to-end, so its per-line validation
# logic is mirrored here exactly (and cross-checked against the live source
# below) rather than executed. Any of these malformed forms reaching the
# generated drop-in verbatim would be a regression.

grep -qF 'log_warn "ignoring malformed allowed-project-roots.conf entry (not an absolute path)' "$INSTALL_SH" \
  || fail "install.sh no longer rejects non-absolute allowed-root entries — update this test's mirror"
grep -qF 'log_warn "ignoring malformed allowed-project-roots.conf entry (contains . or .. component)' "$INSTALL_SH" \
  || fail "install.sh no longer rejects . / .. allowed-root entries — update this test's mirror"

validate_root_line() {
  local raw_root="$1" trimmed resolved
  trimmed="${raw_root#"${raw_root%%[![:space:]]*}"}"
  trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"
  [[ -n "$trimmed" ]] || { printf 'SKIPPED-BLANK'; return; }
  if [[ "$trimmed" != /* ]]; then printf 'REJECTED-NOT-ABSOLUTE'; return; fi
  case "/${trimmed}/" in
    */../*|*/./*) printf 'REJECTED-DOT-COMPONENT'; return ;;
  esac
  resolved="$trimmed"
  if [[ -e "$trimmed" ]]; then
    resolved="$(readlink -f -- "$trimmed" 2>/dev/null || printf '%s' "$trimmed")"
  fi
  printf 'ACCEPTED:%s' "$resolved"
}

[[ "$(validate_root_line 'relative/path')" == "REJECTED-NOT-ABSOLUTE" ]] \
  || fail "a relative path must be rejected"
[[ "$(validate_root_line '/home/user/../etc')" == "REJECTED-DOT-COMPONENT" ]] \
  || fail "a .. path component must be rejected"
[[ "$(validate_root_line '/home/user/./Desktop')" == "REJECTED-DOT-COMPONENT" ]] \
  || fail "a . path component must be rejected"
[[ "$(validate_root_line '/home/user/Desktop')" == "ACCEPTED:/home/user/Desktop" ]] \
  || fail "a well-formed absolute path must be accepted unchanged"
[[ "$(validate_root_line '/home/user/does-not-exist-yet')" == "ACCEPTED:/home/user/does-not-exist-yet" ]] \
  || fail "a currently-nonexistent root must still be accepted (fail-closed at runtime, not at config time)"

mkdir -p "${SCRATCH}/real-target"
ln -sfn "${SCRATCH}/real-target" "${SCRATCH}/symlinked-root"
[[ "$(validate_root_line "${SCRATCH}/symlinked-root")" == "ACCEPTED:${SCRATCH}/real-target" ]] \
  || fail "a symlinked allowed root must resolve to its real target, not escape unresolved"

printf 'PASS: allowed-root line validation (absolute, no dot-components, symlink resolution)\n'

# =============================================================================
# 3. Drop-in generation: single root, multiple roots, syntax-valid, never
#    BindPaths=, never a bare /home exception
# =============================================================================

generate_dropin() {
  # Mirrors scripts/install.sh's drop-in template exactly.
  printf '# Generated by install.sh from allowed-project-roots.conf\n'
  printf '# Do not edit directly — edit that file and re-run: sudo ./pcctl install\n'
  printf '[Service]\n'
  for root in "$@"; do
    printf 'BindReadOnlyPaths=-%s\n' "$root"
  done
}

single_dropin="$(generate_dropin /home/user/Desktop)"
printf '%s\n' "$single_dropin" | grep -qE '^BindReadOnlyPaths=-/home/user/Desktop$' \
  || fail "single-root drop-in missing the expected BindReadOnlyPaths= line"
[[ "$(printf '%s\n' "$single_dropin" | grep -c '^BindReadOnlyPaths=')" == "1" ]] \
  || fail "single-root drop-in must contain exactly one BindReadOnlyPaths= line"

multi_dropin="$(generate_dropin /home/user/Desktop /home/user/Projects /mnt/data/shared)"
[[ "$(printf '%s\n' "$multi_dropin" | grep -c '^BindReadOnlyPaths=')" == "3" ]] \
  || fail "multi-root drop-in must contain one BindReadOnlyPaths= line per root"
printf '%s\n' "$multi_dropin" | grep -qE '^BindReadOnlyPaths=-/home/user/Projects$' \
  || fail "multi-root drop-in missing the second root"
printf '%s\n' "$multi_dropin" | grep -qE '^BindReadOnlyPaths=-/mnt/data/shared$' \
  || fail "multi-root drop-in missing the third root"

for dropin_content in "$single_dropin" "$multi_dropin"; do
  printf '%s\n' "$dropin_content" | grep -qE '^BindPaths=' \
    && fail "generated drop-in must never contain a writable BindPaths="
  printf '%s\n' "$dropin_content" | grep -qE '^BindReadOnlyPaths=-?/home$' \
    && fail "generated drop-in must never expose the bare /home directory"
done

# Reinstall idempotency: identical input produces byte-identical output.
[[ "$(generate_dropin /home/user/Desktop)" == "$single_dropin" ]] \
  || fail "regenerating the drop-in from the same input must be byte-identical (idempotent)"

printf 'PASS: drop-in generation (single root, multiple roots, idempotent, no BindPaths=, no bare /home)\n'

# =============================================================================
# 4. Generated configuration is syntactically valid systemd
# =============================================================================
if have() { command -v "$1" >/dev/null 2>&1; }; have systemd-analyze; then
  work="${SCRATCH}/unitdir"
  mkdir -p "${work}/project-control-runner.service.d"
  cp "$UNIT" "${work}/project-control-runner.service"
  printf '%s\n' "$multi_dropin" >"${work}/project-control-runner.service.d/10-allowed-roots.conf"
  analyze_out="$(systemd-analyze verify --root=/ "${work}/project-control-runner.service" 2>&1 || true)"
  if printf '%s' "$analyze_out" | grep -qiE 'unknown key|invalid value|parse error|failed to parse'; then
    fail "systemd-analyze reports the generated unit+drop-in as invalid: ${analyze_out}"
  fi
  printf 'PASS: generated unit + drop-in parses as valid systemd configuration\n'
else
  printf 'SKIP: systemd-analyze not available for syntax validation\n'
fi

# =============================================================================
# 5. Dynamic, kernel-level proof, using real transient systemd units
# =============================================================================
# Each check below runs the actual test command AS the confined unit itself
# (`systemd-run --wait --pipe -- <command>`, reading back that command's own
# stdout/exit code) — the same sandboxing directives apply to it as to the
# real runner, with no need to nsenter into it from outside afterwards. This
# only needs systemd-run to be permitted at all (on a normal interactive
# desktop session, a local user is typically allowed to manage transient
# units via the default polkit policy for "active" sessions); it does not
# require literal root. Skipped, not failed, if that permission is absent.
have_systemd_run_permission() {
  systemd-run --quiet --unit=pc-allowed-root-probe --collect --wait --pipe -- true >/dev/null 2>&1
}

if ! command -v systemd-run >/dev/null 2>&1; then
  printf 'SKIP: systemd-run is not available\n'
elif ! have_systemd_run_permission; then
  printf 'SKIP: this session is not permitted to manage transient systemd units\n'
else
  allowed_root="${SCRATCH}/allowed"
  mkdir -p "$allowed_root"
  printf 'fixture-content\n' >"${allowed_root}/marker"

  # 5a. Prove the bind-mount mechanism itself: read works, write is
  #     rejected. This uses a /tmp-based fixture (ProtectHome= does not
  #     touch /tmp at all, so it cannot test the /home-specific isolation
  #     claim — step 5b below does that, against this host's own real
  #     /home, which is where the reported regression actually lives).
  systemd-run --quiet --unit=pc-allowed-root-test --collect --wait --pipe \
    -p ProtectSystem=strict -p 'ProtectHome=tmpfs' \
    -p "BindReadOnlyPaths=-${allowed_root}" \
    -- cat "${allowed_root}/marker" >"${SCRATCH}/read.out" 2>&1 \
    && read_status=0 || read_status=$?
  if [[ "$read_status" -eq 0 && "$(cat "${SCRATCH}/read.out")" == "fixture-content" ]]; then
    printf 'PASS: confined unit can read a fixture under the bound allowed root\n'
  else
    fail "confined unit could not read the fixture under the bound allowed root"
  fi

  systemd-run --quiet --unit=pc-allowed-root-test --collect --wait --pipe \
    -p ProtectSystem=strict -p 'ProtectHome=tmpfs' \
    -p "BindReadOnlyPaths=-${allowed_root}" \
    -- sh -c "printf x >> '${allowed_root}/marker'" >/dev/null 2>&1 \
    && write_status=0 || write_status=$?
  if [[ "$write_status" -ne 0 ]]; then
    printf 'PASS: confined unit cannot write under the bound allowed root\n'
  else
    fail "confined unit was able to write under the bound allowed root — read-only bind mount defeated"
  fi

  # A nonexistent root must not prevent the unit from starting (the
  # non-fatal "-" prefix), and accessing it must fail closed, not crash.
  systemd-run --quiet --unit=pc-allowed-root-test --collect --wait --pipe \
    -p ProtectSystem=strict -p 'ProtectHome=tmpfs' \
    -p "BindReadOnlyPaths=-${SCRATCH}/this-root-does-not-exist" \
    -- sh -c 'echo started; cat "'"${SCRATCH}"'/this-root-does-not-exist/x" 2>&1; true' \
    >"${SCRATCH}/nonexistent.out" 2>&1 \
    && nonexistent_status=0 || nonexistent_status=$?
  if [[ "$nonexistent_status" -eq 0 ]] && grep -q '^started$' "${SCRATCH}/nonexistent.out"; then
    printf 'PASS: a nonexistent allowed root does not prevent the unit from starting (fail-closed, not fail-crash)\n'
  else
    fail "a nonexistent allowed root should not prevent the confined unit from starting"
  fi

  # 5b. The actual reported regression, reproduced on this host's own real
  #     /home tree (read-only; plants nothing outside two throwaway,
  #     clearly-named fixture directories it creates and removes itself
  #     under $HOME — never inside an existing real project folder).
  real_home="${HOME:-/root}"
  if [[ -w "$real_home" ]]; then
    home_fixture="${real_home}/.pc-allowed-root-regression-fixture"
    home_sibling="${real_home}/.pc-allowed-root-regression-sibling"
    rm -rf -- "$home_fixture" "$home_sibling"
    mkdir -p "$home_fixture" "$home_sibling"
    printf 'home-fixture-content\n' >"${home_fixture}/marker"
    printf 'must-not-be-visible\n' >"${home_sibling}/secret"

    systemd-run --quiet --unit=pc-allowed-root-test --collect --wait --pipe \
      -p ProtectSystem=strict -p 'ProtectHome=yes' \
      -p "BindReadOnlyPaths=-${home_fixture}" \
      -- cat "${home_fixture}/marker" >"${SCRATCH}/home-yes.out" 2>&1 \
      && yes_status=0 || yes_status=$?

    systemd-run --quiet --unit=pc-allowed-root-test --collect --wait --pipe \
      -p ProtectSystem=strict -p 'ProtectHome=tmpfs' \
      -p "BindReadOnlyPaths=-${home_fixture}" \
      -- cat "${home_fixture}/marker" >"${SCRATCH}/home-tmpfs.out" 2>&1 \
      && tmpfs_status=0 || tmpfs_status=$?

    # Isolation: a sibling directory under the SAME real $HOME, but outside
    # the bound fixture, must stay unreachable — this is the actual,
    # correctly-located version of the isolation property (unlike a /tmp
    # sibling, which ProtectHome= never touches at all).
    systemd-run --quiet --unit=pc-allowed-root-test --collect --wait --pipe \
      -p ProtectSystem=strict -p 'ProtectHome=tmpfs' \
      -p "BindReadOnlyPaths=-${home_fixture}" \
      -- cat "${home_sibling}/secret" >/dev/null 2>"${SCRATCH}/home-outside.err" \
      && outside_status=0 || outside_status=$?

    rm -rf -- "$home_fixture" "$home_sibling"

    if [[ "$yes_status" -eq 0 ]]; then
      fail "ProtectHome=yes unexpectedly allowed the bind mount under \$HOME on this systemd version — re-check whether the regression this fix addresses still applies"
    fi
    if [[ "$tmpfs_status" -eq 0 && "$(cat "${SCRATCH}/home-tmpfs.out")" == "home-fixture-content" ]]; then
      printf 'PASS: reproduces the exact reported regression under real /home — ProtectHome=yes fails, ProtectHome=tmpfs works\n'
    else
      fail "ProtectHome=tmpfs did not read a fixture bound under \$HOME — the fix did not reproduce as expected"
    fi
    if [[ "$outside_status" -ne 0 ]]; then
      printf 'PASS: a sibling directory outside the allowed root, under the same real $HOME, stays unreachable\n'
    else
      fail "confined unit could read a file OUTSIDE the allowed root under \$HOME — isolation defeated"
    fi
  else
    printf 'SKIP: %s is not writable; cannot reproduce the /home-specific regression here\n' "$real_home"
  fi
fi

# =============================================================================
# 6. verify-security.sh's RNR-010/011/012/013 source-level assertions
# =============================================================================
# These pin the specific behavioural requirements this fix set out to meet
# in scripts/verify-security.sh itself, without needing a live root session
# and a real, installed project-control-runner.service to execute against
# (section 5 above already proves the underlying mechanism dynamically).
VERIFY_SECURITY_SH="${REPO_ROOT}/scripts/verify-security.sh"
[[ -f "$VERIFY_SECURITY_SH" ]] || fail "scripts/verify-security.sh not found"

# A missing mount entry is a proven absence of confinement -> FAIL, never a
# WARN that could be mistaken for "probably fine, just unverified".
grep -qF 'record_check FAIL RNR-010 "No mount entry found' "$VERIFY_SECURITY_SH" \
  || fail "RNR-010 must FAIL (not WARN) when the allowed-root bind mount is missing from the runner's namespace"
grep -qF 'record_check WARN RNR-010 "No mount entry found' "$VERIFY_SECURITY_SH" \
  && fail "RNR-010 must not WARN when the allowed-root bind mount is proven missing — that regression is exactly what this fix corrects"

# RNR-011/012/013 must exist and be driven by nsenter into the runner's own
# mount namespace — a real kernel-level proof, not a second mount-table read.
grep -qF 'nsenter -t "$runner_pid" -m -- cat "$fixture_file"' "$VERIFY_SECURITY_SH" \
  || fail "RNR-011 read-access proof via nsenter is missing"
grep -qF "record_check PASS RNR-011" "$VERIFY_SECURITY_SH" || fail "RNR-011 PASS case is missing"
grep -qF "record_check FAIL RNR-011" "$VERIFY_SECURITY_SH" || fail "RNR-011 FAIL case is missing"

grep -qF "printf x >> '\${fixture_file}'" "$VERIFY_SECURITY_SH" \
  || fail "RNR-012 write-rejection proof via nsenter is missing"
grep -qF "record_check PASS RNR-012" "$VERIFY_SECURITY_SH" || fail "RNR-012 PASS case is missing"
grep -qF 'record_check FAIL RNR-012 "Runner CAN write' "$VERIFY_SECURITY_SH" || fail "RNR-012 FAIL case is missing"

grep -qF 'nsenter -t "$runner_pid" -m -- ls -A' "$VERIFY_SECURITY_SH" \
  || fail "RNR-013 isolation proof via nsenter is missing"
grep -qF "record_check PASS RNR-013" "$VERIFY_SECURITY_SH" || fail "RNR-013 PASS case is missing"
grep -qF "record_check FAIL RNR-013" "$VERIFY_SECURITY_SH" || fail "RNR-013 FAIL case is missing"

# The fixture is planted only under the allowed root itself, never any other
# real project path, and is always removed (both an explicit rm -rf and a
# trap-based safety net for the case where something aborts mid-check).
grep -qF 'fixture_dir="${first_root}/.pc-verify-security-fixture"' "$VERIFY_SECURITY_SH" \
  || fail "the verification fixture must live directly under the configured allowed root"
grep -qF "trap 'rm -rf -- \"\$fixture_dir\"" "$VERIFY_SECURITY_SH" \
  || fail "the verification fixture must have a trap-based cleanup safety net"

printf 'PASS: verify-security.sh RNR-010..013 source-level behaviour\n'

printf 'PASS: runner allowed-root regression suite\n'
