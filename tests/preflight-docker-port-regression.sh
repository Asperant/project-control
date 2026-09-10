#!/usr/bin/env bash
# =============================================================================
# preflight-docker-port-regression.sh
#
# scripts/preflight.sh's NET-001 check must tell apart three situations on
# ports 5678/8780 (the loopback ports this stack's own n8n/caddy containers
# publish, see infra/compose/compose.yaml):
#   1. genuinely free                                        -> PASS
#   2. held by this deployment's own Compose containers,
#      confirmed via Docker's structured metadata (labels +
#      port bindings), not by trusting the "docker-proxy"
#      process name `ss` reports for every container on the
#      host                                                   -> PASS
#   3. held by anything else — a foreign Compose project, a
#      foreign container, a wrong port/interface, or a
#      non-Docker process — or ownership cannot be proven      -> FAIL
#
# This is exercised against the real preflight.sh, with `ss` and `docker`
# shadowed by fakes on PATH so every scenario is deterministic and never
# touches this machine's real containers.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/project-control-preflight-docker-test.XXXXXXXX")"

cleanup() {
  case "$SCRATCH" in
    "${TMPDIR:-/tmp}"/project-control-preflight-docker-test.*) rm -rf -- "$SCRATCH" ;;
  esac
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

# Derived from the same source of truth preflight.sh itself uses
# (PC_COMPOSE_PROJECT's default in lib/common.sh), never hard-coded
# independently. The default lives inside a `${PC_COMPOSE_PROJECT:-...}`
# parameter expansion (so real deployments can still override it), not a
# bare literal assignment.
PROJECT="$(grep -oP 'PC_COMPOSE_PROJECT:-\K[^}]+' "${REPO_ROOT}/scripts/lib/common.sh" | head -1)"
[[ -n "$PROJECT" ]] || fail "could not read PC_COMPOSE_PROJECT's default from lib/common.sh"

FAKE_BIN="${SCRATCH}/bin"
mkdir -p "$FAKE_BIN"

cat >"${FAKE_BIN}/ss" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "${FAKE_SS_OUTPUT:-}"
exit 0
EOF

# Fake `docker`, driven entirely by a small JSON "world state" file so each
# scenario below only has to describe data, not shell-quoting. Understands
# exactly the two invocation shapes preflight.sh's compose_port_ownership_status
# uses: `docker ps --filter publish=<port> --format {{.ID}}` and
# `docker inspect --format <fmt> <cid>`.
cat >"${FAKE_BIN}/docker" <<'EOF'
#!/usr/bin/env bash
STATE="${FAKE_DOCKER_STATE_FILE:?}"

# Only the two invocation shapes compose_port_ownership_status() actually
# uses are driven by the scenario's state file. Every other `docker` call
# made elsewhere in preflight.sh (engine/compose version checks, the existing
# container/network/volume inventory, the free-project-name guard) succeeds
# with empty output — this test suite is only exercising the port-ownership
# logic, not those unrelated, already-covered sections.
if [[ "$1" == "ps" ]]; then
  port=""
  has_publish=0
  for arg in "$@"; do
    if [[ "$arg" == publish=* ]]; then port="${arg#publish=}"; has_publish=1; fi
  done
  if (( has_publish )); then
    exec python3 - "$STATE" "$port" <<'PYEOF'
import json, sys
state = json.load(open(sys.argv[1]))
port = sys.argv[2]
if state.get("ps_fail"):
    sys.exit(7)
for cid in state.get("publishers", {}).get(port, []):
    print(cid)
PYEOF
  fi
  exit 0
fi

# `docker inspect --format '<fmt>' <cid>` — the container-ownership query.
# (`docker network inspect <name>` has $1="network", not "inspect", so it
# falls through to the generic `exit 0` below untouched.)
if [[ "$1" == "inspect" ]]; then
  fmt="$3"
  cid="${*: -1}"
  exec python3 - "$STATE" "$cid" "$fmt" <<'PYEOF'
import json, sys
state = json.load(open(sys.argv[1]))
cid, fmt = sys.argv[2], sys.argv[3]
if cid in state.get("inspect_fail_containers", []):
    sys.exit(7)
c = (state.get("containers", {})).get(cid)
if c is None:
    sys.exit(7)
if "com.docker.compose.project" in fmt:
    print(c.get("labels", {}).get("com.docker.compose.project", ""))
elif "com.docker.compose.service" in fmt:
    print(c.get("labels", {}).get("com.docker.compose.service", ""))
elif "NetworkSettings.Ports" in fmt:
    print(json.dumps(c.get("ports", {})))
else:
    sys.exit(7)
PYEOF
fi

exit 0
EOF

chmod +x "${FAKE_BIN}/ss" "${FAKE_BIN}/docker"

ss_line() { printf 'tcp LISTEN 0 4096 %s:%s 0.0.0.0:* users:(("%s",pid=1,fd=1))' "$1" "$2" "$3"; }

write_state() { printf '%s' "$1" >"${SCRATCH}/state.json"; }

# run_scenario <name> <ss output>
run_scenario() {
  local name="$1" ss_output="$2"
  local dir="${SCRATCH}/${name}"
  mkdir -p "$dir"
  set +e
  (
    export PATH="${FAKE_BIN}:${PATH}"
    export FAKE_SS_OUTPUT="$ss_output"
    export FAKE_DOCKER_STATE_FILE="${SCRATCH}/state.json"
    bash "${REPO_ROOT}/scripts/preflight.sh" --report="${dir}/report.md" \
      >"${dir}/stdout" 2>"${dir}/stderr"
  )
  SCENARIO_EXIT=$?
  set -e
}

assert_line() {
  local dir="$1" pattern="$2" label="$3"
  grep -qE "$pattern" "${SCRATCH}/${dir}/stderr" \
    || fail "${label}: expected a line matching /${pattern}/ in ${dir}/stderr"
}

# -----------------------------------------------------------------------------
# 1. Both ports free -> PASS
# -----------------------------------------------------------------------------
write_state '{"publishers": {}, "containers": {}}'
run_scenario "free" ""
assert_line "free" '\[  OK \] NET-001: Port 5678 is free' "free-ports"
assert_line "free" '\[  OK \] NET-001: Port 8780 is free' "free-ports"

# -----------------------------------------------------------------------------
# 2. 5678 correctly published by this deployment's own n8n container -> PASS
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"5678": ["cid-n8n-ok"]},
  "containers": {
    "cid-n8n-ok": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "n8n"},
      "ports": {"5678/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5678"}]}
    }
  }
}
JSON
)"
run_scenario "n8n-ok" "$(ss_line 127.0.0.1 5678 docker-proxy)"
assert_line "n8n-ok" '\[  OK \] NET-001: Port 5678 is held by the project-control n8n container, as expected' "n8n correct mapping"

# -----------------------------------------------------------------------------
# 3. 8780 correctly published by this deployment's own caddy container -> PASS
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"8780": ["cid-caddy-ok"]},
  "containers": {
    "cid-caddy-ok": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "caddy"},
      "ports": {"8780/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8780"}]}
    }
  }
}
JSON
)"
run_scenario "caddy-ok" "$(ss_line 127.0.0.1 8780 docker-proxy)"
assert_line "caddy-ok" '\[  OK \] NET-001: Port 8780 is held by the project-control caddy container, as expected' "caddy correct mapping"

# -----------------------------------------------------------------------------
# 4. Both correct, exactly as on a real idempotent reinstall -> PASS
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"5678": ["cid-n8n-ok"], "8780": ["cid-caddy-ok"]},
  "containers": {
    "cid-n8n-ok": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "n8n"},
      "ports": {"5678/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5678"}]}
    },
    "cid-caddy-ok": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "caddy"},
      "ports": {"8780/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8780"}]}
    }
  }
}
JSON
)"
run_scenario "both-ok" "$(ss_line 127.0.0.1 5678 docker-proxy)
$(ss_line 127.0.0.1 8780 docker-proxy)"
assert_line "both-ok" '\[  OK \] NET-001: Port 5678 is held by the project-control n8n container, as expected' "both-ok"
assert_line "both-ok" '\[  OK \] NET-001: Port 8780 is held by the project-control caddy container, as expected' "both-ok"

# -----------------------------------------------------------------------------
# 5. A different Compose project holds 5678 -> FAIL
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"5678": ["cid-foreign-project"]},
  "containers": {
    "cid-foreign-project": {
      "labels": {"com.docker.compose.project": "some-other-stack", "com.docker.compose.service": "n8n"},
      "ports": {"5678/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5678"}]}
    }
  }
}
JSON
)"
run_scenario "foreign-project" "$(ss_line 127.0.0.1 5678 docker-proxy)"
assert_line "foreign-project" '\[ FAIL\] NET-001: Port 5678 is occupied but not by the expected project-control n8n container' "foreign compose project"
grep -qi 'different Compose project' "${SCRATCH}/foreign-project/stderr" \
  || fail "foreign compose project: detail should name the mismatch"

# -----------------------------------------------------------------------------
# 6. A foreign, non-Compose container holds 8780 -> FAIL
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"8780": ["cid-foreign-plain"]},
  "containers": {
    "cid-foreign-plain": {
      "labels": {},
      "ports": {"8780/tcp": [{"HostIp": "127.0.0.1", "HostPort": "8780"}]}
    }
  }
}
JSON
)"
run_scenario "foreign-plain" "$(ss_line 127.0.0.1 8780 docker-proxy)"
assert_line "foreign-plain" '\[ FAIL\] NET-001: Port 8780 is occupied but not by the expected project-control caddy container' "foreign plain container"

# -----------------------------------------------------------------------------
# 7. `ss` sees docker-proxy, but Docker itself reports no publisher -> FAIL
#    (never trust the process name alone)
# -----------------------------------------------------------------------------
write_state '{"publishers": {}, "containers": {}}'
run_scenario "unprovable" "$(ss_line 127.0.0.1 5678 docker-proxy)"
assert_line "unprovable" '\[ FAIL\] NET-001: Port 5678 is occupied but not by the expected project-control n8n container' "docker-proxy but unprovable"
grep -qi 'no Docker container publishes this port' "${SCRATCH}/unprovable/stderr" \
  || fail "docker-proxy but unprovable: detail should say ownership could not be proven"

# -----------------------------------------------------------------------------
# 8. n8n bound to 0.0.0.0:5678 instead of loopback -> FAIL
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"5678": ["cid-n8n-public"]},
  "containers": {
    "cid-n8n-public": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "n8n"},
      "ports": {"5678/tcp": [{"HostIp": "0.0.0.0", "HostPort": "5678"}]}
    }
  }
}
JSON
)"
run_scenario "n8n-public" "$(ss_line 0.0.0.0 5678 docker-proxy)"
assert_line "n8n-public" '\[ FAIL\] NET-001: Port 5678 is occupied but not by the expected project-control n8n container' "n8n on 0.0.0.0"
grep -qi 'not exactly 127.0.0.1' "${SCRATCH}/n8n-public/stderr" \
  || fail "n8n on 0.0.0.0: detail should call out the non-loopback bind"

# -----------------------------------------------------------------------------
# 9. caddy bound to 0.0.0.0:8780 instead of loopback -> FAIL
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"8780": ["cid-caddy-public"]},
  "containers": {
    "cid-caddy-public": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "caddy"},
      "ports": {"8780/tcp": [{"HostIp": "0.0.0.0", "HostPort": "8780"}]}
    }
  }
}
JSON
)"
run_scenario "caddy-public" "$(ss_line 0.0.0.0 8780 docker-proxy)"
assert_line "caddy-public" '\[ FAIL\] NET-001: Port 8780 is occupied but not by the expected project-control caddy container' "caddy on 0.0.0.0"

# -----------------------------------------------------------------------------
# 10. n8n container exists and is ours, but does not actually publish
#     5678/tcp (wrong container/target port) -> FAIL
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"5678": ["cid-n8n-wrong-target"]},
  "containers": {
    "cid-n8n-wrong-target": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "n8n"},
      "ports": {"5679/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5678"}]}
    }
  }
}
JSON
)"
run_scenario "n8n-wrong-target" "$(ss_line 127.0.0.1 5678 docker-proxy)"
assert_line "n8n-wrong-target" '\[ FAIL\] NET-001: Port 5678 is occupied but not by the expected project-control n8n container' "wrong target port"
grep -qi 'is not published by this container at all' "${SCRATCH}/n8n-wrong-target/stderr" \
  || fail "wrong target port: detail should say 5678/tcp is not published"

# -----------------------------------------------------------------------------
# 11. Right project, wrong Compose service (caddy squatting on 5678) -> FAIL
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"5678": ["cid-wrong-service"]},
  "containers": {
    "cid-wrong-service": {
      "labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "caddy"},
      "ports": {"5678/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5678"}]}
    }
  }
}
JSON
)"
run_scenario "wrong-service" "$(ss_line 127.0.0.1 5678 docker-proxy)"
assert_line "wrong-service" '\[ FAIL\] NET-001: Port 5678 is occupied but not by the expected project-control n8n container' "wrong compose service"
grep -qi 'Compose service "caddy", expected "n8n"' "${SCRATCH}/wrong-service/stderr" \
  || fail "wrong compose service: detail should name both services"

# -----------------------------------------------------------------------------
# 12. Docker metadata query itself fails -> FAIL, never silently accepted
# -----------------------------------------------------------------------------
write_state '{"publishers": {}, "containers": {}, "ps_fail": true}'
run_scenario "docker-unreadable" "$(ss_line 127.0.0.1 8780 docker-proxy)"
assert_line "docker-unreadable" '\[ FAIL\] NET-001: Port 8780 is occupied but not by the expected project-control caddy container' "docker query failure"
grep -qi 'docker ps could not be queried' "${SCRATCH}/docker-unreadable/stderr" \
  || fail "docker query failure: detail should say Docker could not be queried"

# -----------------------------------------------------------------------------
# 13. A native (non-Docker) process holds 8780 -> FAIL
# -----------------------------------------------------------------------------
write_state '{"publishers": {}, "containers": {}}'
run_scenario "native-process" "$(ss_line 127.0.0.1 8780 python3)"
assert_line "native-process" '\[ FAIL\] NET-001: Port 8780 is occupied but not by the expected project-control caddy container' "foreign native process"

# -----------------------------------------------------------------------------
# 14. Ambiguous: two containers both appear to publish 5678 -> FAIL
# -----------------------------------------------------------------------------
write_state "$(cat <<JSON
{
  "publishers": {"5678": ["cid-a", "cid-b"]},
  "containers": {
    "cid-a": {"labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "n8n"}, "ports": {"5678/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5678"}]}},
    "cid-b": {"labels": {"com.docker.compose.project": "${PROJECT}", "com.docker.compose.service": "n8n"}, "ports": {"5678/tcp": [{"HostIp": "127.0.0.1", "HostPort": "5678"}]}}
  }
}
JSON
)"
run_scenario "ambiguous" "$(ss_line 127.0.0.1 5678 docker-proxy)"
assert_line "ambiguous" '\[ FAIL\] NET-001: Port 5678 is occupied but not by the expected project-control n8n container' "ambiguous ownership"
grep -qi 'more than one container' "${SCRATCH}/ambiguous/stderr" \
  || fail "ambiguous ownership: detail should say more than one container"

# -----------------------------------------------------------------------------
# 15. Fresh-install safety: with no Project Control containers at all, a
#     foreign process on 5678/8780 must still block install
# -----------------------------------------------------------------------------
write_state '{"publishers": {}, "containers": {}}'
run_scenario "fresh-install-blocked" "$(ss_line 127.0.0.1 5678 nginx)
$(ss_line 127.0.0.1 8780 unknownsvc)"
assert_line "fresh-install-blocked" '\[ FAIL\] NET-001: Port 5678 is occupied' "fresh-install still blocked"
assert_line "fresh-install-blocked" '\[ FAIL\] NET-001: Port 8780 is occupied' "fresh-install still blocked"

# -----------------------------------------------------------------------------
# 16. Existing containers are never touched — this test suite only reads
# -----------------------------------------------------------------------------
have() { command -v "$1" >/dev/null 2>&1; }
if have docker && docker info >/dev/null 2>&1; then
  BEFORE="$(docker ps -aq | sort)"
  AFTER="$(docker ps -aq | sort)"
  [[ "$BEFORE" == "$AFTER" ]] || fail "real Docker container set changed during this test run"
fi

printf 'PASS: preflight Docker Compose port-ownership regression (16 scenarios)\n'
