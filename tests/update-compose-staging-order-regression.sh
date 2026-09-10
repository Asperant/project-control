#!/usr/bin/env bash
# =============================================================================
# update-compose-staging-order-regression.sh
#
# Reproduces, then proves fixed, the live retry failure: `sudo ./pcctl
# update` reached "4/8 Migration dry-run" and hit the exact same OCI mount
# error the previous fix was supposed to have closed — because compose()
# (lib/common.sh) reads ${PC_ROOT}/compose/compose.yaml, the DEPLOYED copy,
# and update.sh used to stage the new compose.yaml onto that path only in
# "6/8 Applying the update", which runs AFTER the dry-run. Fixing the
# repository's infra/compose/compose.yaml alone was not enough while the
# deployed copy still lagged behind it by two steps.
#
# This test drives the real, unmodified scripts/update.sh against a
# synthetic deployment root whose compose.yaml starts as the OLD, broken
# (nested /config/automation mount) version -- exactly what a live host
# that has not yet been updated looks like -- and a synthetic repository
# whose infra/compose/compose.yaml is the NEW version being deployed.
#
# `docker compose ... config --format json` is NOT faked: it is delegated
# to the real docker binary, so this test inspects the actual resolved
# compose model update.sh's own assert-config-mount.py check would see --
# not a re-implementation, not a grep of the YAML source. Everything else
# unrelated to compose-file currency (image pulls, container health,
# the migration SQL itself, runner liveness) is faked, the same way
# tests/deployment-incident-behavior-regression.sh already fakes them --
# this test's own claim is narrower and specific: is the compose file
# current by the time it is used, and does the deterministic check
# actually gate the dry-run on that.
#
# Two scenarios:
#   POSITIVE — the new repository compose.yaml is the real, fixed, single-
#              mount version. Staging must replace the old deployed copy
#              before the dry-run step, the resolved-model check must pass,
#              and "4/8 Migration dry-run" must be reached and pass, with
#              no OCI mount error anywhere in the output.
#   NEGATIVE — the new repository compose.yaml is ALSO broken (simulating a
#              future regression that reintroduces the nested mount). The
#              staged copy is therefore also broken; the resolved-model
#              check must fail and update.sh must abort BEFORE ever
#              printing "4/8 Migration dry-run" -- proving the check is a
#              real gate, not decoration after the fact.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-update-staging-order-test.XXXXXXXX")"
trap 'rm -rf -- "$SCRATCH"' EXIT

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$1"; }

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "SKIP: docker is not available/usable — cannot run this test"
  exit 0
fi
REAL_DOCKER="$(command -v docker)"

# A trimmed, self-contained compose file: just the control-api service's
# shape (image, mounts, hardening) that matters for this bug, not the full
# multi-service stack -- what's under test is the /config mount topology
# and where it comes from, not the other services' definitions.
write_compose() {
  local path="$1" broken="$2"   # broken: 1 = reintroduce the nested mount, 0 = fixed
  {
    cat <<'EOF'
name: pc-staging-order-test
services:
  control-api:
    image: alpine:3
    read_only: true
    tmpfs:
      - /tmp:rw
    volumes:
      - type: bind
        source: ${PC_ROOT}/config/status
        target: /config
        read_only: true
EOF
    if (( broken )); then
      cat <<'EOF'
      - type: bind
        source: ${PC_ROOT}/config/automation
        target: /config/automation
        read_only: true
EOF
    fi
  } >"$path"
}

write_stack_env() {
  cat >"$1" <<'EOF'
PC_POSTGRES_IMAGE=postgres@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
PC_N8N_IMAGE=n8n@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PC_CADDY_IMAGE=caddy@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
PC_CADDY_PROXY_IMAGE=project-control/caddy:test
PC_CONTROL_API_IMAGE=project-control/control-api:test
PC_WEB_IMAGE=project-control/web:test
PC_STACK_VERSION=test
EOF
}

setup_fixture() {
  local name="$1" repo_compose_broken="$2"
  local F="${SCRATCH}/${name}" SRC DEPLOY BIN
  SRC="${F}/source"; DEPLOY="${F}/deploy"; BIN="${F}/bin"
  mkdir -p \
    "$SRC/scripts/lib" "$SRC/infra/compose" "$SRC/infra/caddy" "$SRC/infra/n8n/workflows" \
    "$SRC/config" "$SRC/migrations" "$SRC/apps/runner/bin" \
    "$DEPLOY/compose" "$DEPLOY/config/caddy" "$DEPLOY/config/status/automation/workflows" \
    "$DEPLOY/runner/bin" "$DEPLOY/secrets" "$DEPLOY/backups/rollback" "$BIN"

  # --- Repository stand-in --------------------------------------------------
  cp "${REPO_ROOT}/scripts/update.sh" "$SRC/scripts/update.sh"
  cp "${REPO_ROOT}/scripts/lib/common.sh" "$SRC/scripts/lib/common.sh"
  cp "${REPO_ROOT}/scripts/lib/assert-config-mount.py" "$SRC/scripts/lib/assert-config-mount.py"
  # This test's own claim is about compose-file currency, not runner
  # liveness (already covered by tests/deployment-incident-behavior-
  # regression.sh) -- bypass both runner-liveness checks the same way that
  # test bypasses runner_binary_matches_live_process.
  printf '\nrunner_binary_matches_live_process() { return 0; }\n' >>"$SRC/scripts/lib/common.sh"
  printf '\nwait_for_runner_ready() { return 0; }\n' >>"$SRC/scripts/lib/common.sh"

  write_compose "$SRC/infra/compose/compose.yaml" "$repo_compose_broken"
  write_stack_env "$SRC/infra/versions.lock.env"
  printf 'PC_APP_UID=10001\nPC_APP_GID=10001\nPC_CONTROL_GID=10002\n' >>"$SRC/infra/versions.lock.env"
  : >"$SRC/infra/caddy/Caddyfile"
  printf '{"version":1,"workflows":[]}' >"$SRC/infra/n8n/workflows/manifest.json"
  printf '3\n' >"$SRC/config/checkpoint-reader-max-version"
  printf 'new runner\n' >"$SRC/apps/runner/bin/project-control-runner"
  chmod +x "$SRC/apps/runner/bin/project-control-runner"

  cat >"$SRC/scripts/build.sh" <<EOF
#!/usr/bin/env bash
printf 'build\n' >>"${F}/build.calls"
exit 0
EOF
  cat >"$SRC/scripts/rollback.sh" <<EOF
#!/usr/bin/env bash
printf 'rollback %s\n' "\$*" >>"${F}/rollback.calls"
exit 0
EOF
  chmod +x "$SRC/scripts/build.sh" "$SRC/scripts/rollback.sh"

  # --- Deployment root: the OLD, stale, pre-fix compose already in place ---
  write_compose "$DEPLOY/compose/compose.yaml" 1
  cp "$SRC/infra/versions.lock.env" "$DEPLOY/config/versions.lock.env"
  write_stack_env "$DEPLOY/config/stack.env"
  printf 'PC_APP_UID=10001\nPC_APP_GID=10001\nPC_CONTROL_GID=10002\n' >>"$DEPLOY/config/stack.env"
  printf '3\n' >"$DEPLOY/config/checkpoint-reader-max-version"
  printf 'old runner\n' >"$DEPLOY/runner/bin/project-control-runner"
  chmod +x "$DEPLOY/runner/bin/project-control-runner"
  printf 'x' >"$DEPLOY/secrets/pg_control_app_password"; chmod 0600 "$DEPLOY/secrets/pg_control_app_password"

  for script in backup restore-test verify verify-security telegram-notify; do
    cat >"$SRC/scripts/${script}.sh" <<EOF
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "$SRC/scripts/${script}.sh"
  done

  cat >"$BIN/id" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == -u ]] && { printf '0\n'; exit 0; }
exec /usr/bin/id "$@"
EOF
  cat >"$BIN/chown" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
  cat >"$BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
[[ "${1:-}" == is-active ]] && { printf 'active\n'; exit 0; }
exit 0
EOF
  cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
printf '401'
EOF
  cat >"$BIN/docker" <<EOF
#!/usr/bin/env bash
# Real \`docker compose ... config\` — the one call this test does not fake,
# because whether it sees the staged (new) or stale (old) compose file is
# exactly the claim under test. Real docker needs no daemon-side state to
# render a compose file: no image pull, no container, no network.
if [[ "\${1:-}" == compose ]]; then
  for arg in "\$@"; do
    if [[ "\$arg" == config ]]; then
      exec "$REAL_DOCKER" "\$@"
    fi
  done
  # \`compose run ... migrate.js --dry-run\`: the container-CREATION step
  # itself is not re-simulated here (that mechanic is separately,
  # exhaustively proven against the real image in
  # tests/control-api-config-mount-regression.sh) — but this fake still
  # reads the ACTUAL \`--file\` path this invocation was given, the same
  # path compose() (lib/common.sh) resolves, so a bad staging order (this
  # call reached before the new compose replaced the old one) is caught
  # here too, not only by the resolved-model check earlier in update.sh.
  compose_file=""
  take_next=0
  for arg in "\$@"; do
    if (( take_next )); then compose_file="\$arg"; take_next=0; continue; fi
    [[ "\$arg" == --file ]] && take_next=1
  done
  if [[ -n "\$compose_file" ]] && grep -q '/config/automation' "\$compose_file"; then
    printf 'Error: failed to create task: OCI runtime create failed: error mounting "/config/automation" to rootfs: create mountpoint for /config/automation mount: mkdirat: read-only file system\n' >&2
    exit 1
  fi
  printf '[info] DRY RUN — nothing was committed.\napplied=0 already-applied=0\n' >>"${F}/dry-run.output"
  cat "${F}/dry-run.output"
  exit 0
fi
image_for_service() {
  case "\$1" in
    postgres) printf 'sha256:%064d\n' 1 ;; n8n) printf 'sha256:%064d\n' 2 ;;
    control-api) printf 'sha256:%064d\n' 3 ;; web) printf 'sha256:%064d\n' 4 ;;
    caddy) printf 'sha256:%064d\n' 5 ;;
  esac
}
if [[ "\${1:-}" == ps ]]; then
  for arg in "\$@"; do [[ "\$arg" == label=com.docker.compose.service=* ]] && { printf 'cid-%s\n' "\${arg##*=}"; exit 0; }; done
fi
if [[ "\${1:-}" == inspect && "\${2:-}" == --format ]]; then
  [[ "\$3" == '{{.Image}}' ]] && { image_for_service "\${4#cid-}"; exit 0; }
  printf 'healthy\n'; exit 0
fi
if [[ "\${1:-}" == image && "\${2:-}" == inspect && "\${3:-}" == --format ]]; then
  case "\$5" in
    postgres@*) image_for_service postgres ;; n8n@*) image_for_service n8n ;;
    project-control/control-api:*) image_for_service control-api ;; project-control/web:*) image_for_service web ;;
    project-control/caddy:*) image_for_service caddy ;; *) exit 1 ;;
  esac
  exit 0
fi
if [[ "\${1:-}" == exec ]]; then exit 0; fi
exit 0
EOF
  chmod +x "$BIN"/*

  echo "$SRC:$DEPLOY:$BIN:$F"
}

run_update() {
  local src="$1" deploy="$2" bin="$3"
  ( export PATH="${bin}:${PATH}" PC_ROOT="$deploy" PC_ASSUME_YES=1
    bash "$src/scripts/update.sh" --skip-backup --force >"${SCRATCH}/stdout" 2>"${SCRATCH}/stderr"
  ) && echo 0 || echo $?
}

# -----------------------------------------------------------------------------
# POSITIVE: repository compose is the real, fixed single-mount version.
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture positive 0)
rc="$(run_update "$SRC" "$DEPLOY" "$BIN")"

[[ "$rc" == "0" ]] || { cat "${SCRATCH}/stderr" >&2; fail "positive scenario: update did not reach/pass the dry-run cleanly (exit ${rc})"; }
grep -q 'Staging updated deployment configuration' "${SCRATCH}/stderr" || fail "positive: staging step did not run"
grep -q 'staged compose/config verified' "${SCRATCH}/stderr" || fail "positive: resolved-model check did not run/pass"
grep -q '4/8  Migration dry-run' "${SCRATCH}/stderr" || fail "positive: migration dry-run step was never reached"
grep -qi 'migration dry-run passed' "${SCRATCH}/stderr" || fail "positive: migration dry-run did not report success"
grep -qi 'read-only file system\|mkdirat' "${SCRATCH}/stdout" "${SCRATCH}/stderr" && fail "positive: an OCI mount error appeared even though the staged compose is the fixed one"
cmp -s <(python3 -c "
import yaml
print(yaml.safe_dump(yaml.safe_load(open('${SRC}/infra/compose/compose.yaml'))))
") <(python3 -c "
import yaml
print(yaml.safe_dump(yaml.safe_load(open('${DEPLOY}/compose/compose.yaml'))))
") || fail "positive: the deployed compose.yaml does not match the repository's after staging"
pass "positive: staging replaces the stale deployed compose BEFORE the resolved-model check and the migration dry-run; dry-run reached, passed, no OCI mount error"

# -----------------------------------------------------------------------------
# NEGATIVE: repository compose is ALSO broken (a hypothetical future
# regression). The staged copy is therefore also broken; update.sh must
# abort before ever reaching "4/8 Migration dry-run".
# -----------------------------------------------------------------------------
IFS=: read -r SRC DEPLOY BIN F < <(setup_fixture negative 1)
rc="$(run_update "$SRC" "$DEPLOY" "$BIN")"

[[ "$rc" != "0" ]] || fail "negative scenario: update succeeded despite a nested-mount compose file being staged"
grep -q 'staged compose model has an unsafe control-api mount' "${SCRATCH}/stderr" \
  || { cat "${SCRATCH}/stderr" >&2; fail "negative: update did not fail with the expected resolved-model error"; }
grep -q '4/8  Migration dry-run' "${SCRATCH}/stderr" && fail "negative: migration dry-run step was reached despite the unsafe staged compose"
[[ ! -e "${F}/dry-run.output" ]] || fail "negative: the migration dry-run command was actually invoked"
pass "negative: an unsafe staged compose (nested /config/automation mount) is caught by the resolved-model check and aborts BEFORE the migration dry-run is ever attempted"

printf 'PASS: update.sh stages the new compose/config before the migration dry-run, verifies the resolved model, and only proceeds when it is safe\n'
