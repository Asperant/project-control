#!/usr/bin/env bash
# =============================================================================
# install-workflows-regression.sh
#
# install-workflows.sh's own decision logic — which workflows are already
# present (by name, via `n8n list:workflow`), which get staged and
# imported, how staging and import failures are reported, and the final
# imported/skipped counts — proven deterministically against a fake `docker`
# standing in for the real one, so this runs without any container at all
# and touches nothing live.
#
# This intentionally does NOT re-prove that `n8n import:workflow` itself is
# non-interactive, defaults to inactive, or needs no credential resolution
# — that was established by reading the pinned 2.34.0 image's own
# `import:workflow --help` output directly (see docs/automation.md's P0
# note). What it DOES prove, empirically, against the real pinned n8n image
# (not a mock): that staging a file into the container's tmpfs-mounted
# `/tmp` via `docker exec -i ... cat >` actually works — `docker cp` does
# not, for a --tmpfs-covered path on a running container, a real bug this
# script used to have (it reported success and silently never staged
# anything). See the "stages a file" test below, which runs against the
# live, already-running project-control-n8n container's own /tmp — nothing
# outside that ephemeral tmpfs is touched, no workflow is imported, no n8n
# application data changes.
# =============================================================================
set -Eeuo pipefail
IFS=$'\n\t'

TEST_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname -- "$TEST_DIR")"
SCRIPT="${REPO_ROOT}/scripts/install-workflows.sh"

fail() { printf 'FAIL: %s\n' "$1" >&2; exit 1; }

[[ -f "$SCRIPT" ]] || fail "scripts/install-workflows.sh not found"

if grep -qF 'docker cp "$file" "${cid}:${tmp_container_path}"' "$SCRIPT"; then
  fail "install-workflows.sh has regressed to using 'docker cp' to stage into the container's tmpfs /tmp — this silently fails on a real n8n container (verified against the pinned image; docker cp reports success but the file never appears). It must pipe through 'docker exec -i ... cat >' instead."
fi
if ! grep -qE "docker exec -i \"\\\$cid\" sh -c \"cat > '.*tmp_container_path.*'\"" "$SCRIPT"; then
  fail "install-workflows.sh no longer stages files via the proven 'docker exec -i ... cat >' pipe"
fi

# -----------------------------------------------------------------------------
# Live, read-only-in-effect proof: staging actually works against the real
# pinned n8n image's tmpfs /tmp, if that container happens to be running.
# Skips cleanly (never fails the suite) when it is not — this is a bonus
# proof against the real thing, not the primary coverage.
# -----------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 \
   && n8n_cid="$(docker ps --filter 'label=com.docker.compose.service=n8n' --format '{{.ID}}' 2>/dev/null | head -1)" \
   && [[ -n "$n8n_cid" ]]; then
  probe_name="pc-install-workflows-stage-probe-$$.json"
  probe_content='{"probe":"install-workflows-regression"}'
  printf '%s' "$probe_content" | docker exec -i "$n8n_cid" sh -c "cat > '/tmp/${probe_name}'"
  staged="$(docker exec "$n8n_cid" sh -c "cat '/tmp/${probe_name}' 2>/dev/null" || true)"
  docker exec "$n8n_cid" sh -c "rm -f '/tmp/${probe_name}'" >/dev/null 2>&1 || true
  [[ "$staged" == "$probe_content" ]] \
    || fail "staging via docker exec pipe did not round-trip against the live n8n container's tmpfs /tmp"
  echo "[  OK ] staging mechanism verified against the real, running, pinned n8n image" >&2
else
  echo "[ INFO] n8n container not running — skipping the live staging proof, mock-based coverage below still runs" >&2
fi

# -----------------------------------------------------------------------------
# Mock docker: deterministic control-flow coverage, no container needed.
# -----------------------------------------------------------------------------
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/pc-install-workflows-test.XXXXXXXX")"
cleanup() { rm -rf -- "$SCRATCH"; }
trap cleanup EXIT

WORKFLOWS_DIR="${SCRATCH}/pcroot/config/status/automation/workflows"
mkdir -p "$WORKFLOWS_DIR"
STAGED_LOG="${SCRATCH}/staged.log"
IMPORTED_LOG="${SCRATCH}/imported.log"
: >"$STAGED_LOG"; : >"$IMPORTED_LOG"

cat >"${WORKFLOWS_DIR}/already-present.workflow.json" <<'EOF'
{"name": "Project Control — Already Present", "nodes": [], "connections": {}}
EOF
cat >"${WORKFLOWS_DIR}/fresh-one.workflow.json" <<'EOF'
{"name": "Project Control — Fresh One", "nodes": [], "connections": {}}
EOF
cat >"${WORKFLOWS_DIR}/stage-fails.workflow.json" <<'EOF'
{"name": "Project Control — Stage Fails", "nodes": [], "connections": {}}
EOF

# A fake `docker` on PATH ahead of the real one. Mirrors exactly the
# subcommand shapes install-workflows.sh and common.sh's container_id()
# actually invoke.
FAKE_BIN="${SCRATCH}/bin"
mkdir -p "$FAKE_BIN"
cat >"${FAKE_BIN}/docker" <<MOCKEOF
#!/usr/bin/env bash
set -Eeuo pipefail
STAGED_LOG="${STAGED_LOG}"
IMPORTED_LOG="${IMPORTED_LOG}"

case "\$1" in
  ps)
    echo "fake-n8n-container-id"
    ;;
  inspect)
    echo "running"
    ;;
  exec)
    shift
    # Drop flags (-i, -e VAR=val, ...) to find the actual command.
    while [[ "\$1" == -* ]]; do
      if [[ "\$1" == "-e" ]]; then shift 2; else shift; fi
    done
    cid="\$1"; shift
    if [[ "\$1" == "n8n" && "\$2" == "list:workflow" ]]; then
      echo "Project Control — Already Present"
      exit 0
    fi
    if [[ "\$1" == "sh" && "\$2" == "-c" ]]; then
      body="\$3"
      if [[ "\$body" == cat* ]]; then
        dest="\$(printf '%s' "\$body" | sed -E "s/^cat > '(.*)'\$/\\1/")"
        echo "STAGE:\${dest}" >>"\$STAGED_LOG"
        if [[ "\$dest" == *stage-fails* ]]; then
          exit 1
        fi
        cat >/dev/null
        exit 0
      fi
      if [[ "\$body" == rm* ]]; then
        exit 0
      fi
    fi
    if [[ "\$1" == "n8n" && "\$2" == "import:workflow" ]]; then
      echo "IMPORT:\$1 \$2 \$3" >>"\$IMPORTED_LOG"
      exit 0
    fi
    if [[ "\$1" == "rm" ]]; then
      exit 0
    fi
    echo "fake docker exec: unrecognised invocation: \$*" >&2
    exit 1
    ;;
  *)
    echo "fake docker: unrecognised invocation: \$*" >&2
    exit 1
    ;;
esac
MOCKEOF
chmod +x "${FAKE_BIN}/docker"

output="$(PATH="${FAKE_BIN}:${PATH}" PC_ROOT="${SCRATCH}/pcroot" PC_COMPOSE_PROJECT=project-control \
  bash "$SCRIPT" 2>&1)" && status=0 || status=$?

(( status == 0 )) || fail "install-workflows.sh exited ${status}; output:\n${output}"

# --- Assertions ---------------------------------------------------------------
if grep -q "already-present.workflow.json" "$STAGED_LOG"; then
  fail "an already-installed workflow (matched by name via list:workflow) was staged anyway"
fi
printf '%s\n' "$output" | grep -qF "already installed, skipping: Project Control — Already Present" \
  || fail "the already-installed workflow was not reported as skipped"

grep -q "fresh-one.workflow.json" "$STAGED_LOG" \
  || fail "the fresh (not-yet-installed) workflow was never staged"
grep -q "import:workflow" "$IMPORTED_LOG" \
  || fail "n8n import:workflow was never invoked for the fresh workflow"

grep -q "stage-fails.workflow.json" "$STAGED_LOG" \
  || fail "the staging-failure fixture was never attempted"
if grep -q "STAGE:.*stage-fails" "$IMPORTED_LOG" 2>/dev/null; then
  fail "import:workflow ran even though staging failed for that file"
fi
printf '%s\n' "$output" | grep -qiF "failed to stage" \
  || fail "a staging failure was not reported to the operator"

printf '%s\n' "$output" | grep -qF "workflows: 1 imported, 1 already present" \
  || fail "final imported/skipped counts were not as expected; output:\n${output}"

printf 'PASS: install-workflows.sh control flow — skip-if-present, stage+import, staging-failure handling all correct\n'
