#!/usr/bin/env bash
# =============================================================================
# install-workflows.sh — MANUAL CHECKPOINT (optional): imports the shipped
# n8n workflows once the "Project Control API" and Telegram credentials
# already exist in n8n's own credential store.
#
# Idempotent by inspection, not by n8n's own import semantics: this script
# lists what is already installed (by name) before importing, and only
# imports workflow files whose name is not already present, rather than
# assuming a re-import safely upserts. If n8n's import behavior for an
# already-present workflow name changes across versions, this script fails
# safe by skipping rather than risking a silent duplicate.
#
# Every workflow is imported deactivated (n8n's own default for
# import:workflow with no --activeState flag) — turning one on is a
# separate, deliberate action in the n8n UI, documented in
# docs/manual-checkpoints.md.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_stack_env

cid="$(container_id n8n)"
[[ -n "$cid" ]] || die "the n8n container is not running; run: sudo ./pcctl start"

state="$(docker inspect --format '{{.State.Status}}' "$cid")"
[[ "$state" == "running" ]] || die "the n8n container is ${state}, not running"

# Nested under config/status: see infra/compose/compose.yaml's comment on
# the control-api /config mount for why this lives here rather than in a
# sibling config/automation directory.
WORKFLOWS_DIR="${PC_ROOT}/config/status/automation/workflows"
[[ -d "$WORKFLOWS_DIR" ]] || die "no workflows found at ${WORKFLOWS_DIR}; run: sudo ./pcctl install"

shopt -s nullglob
files=("${WORKFLOWS_DIR}"/*.workflow.json)
shopt -u nullglob
(( ${#files[@]} > 0 )) || die "no *.workflow.json files in ${WORKFLOWS_DIR}"

log_step "checking which workflows are already installed"
existing="$(docker exec "$cid" n8n list:workflow 2>/dev/null | grep -v '^\[n8n\] Warning' || true)"

imported=0
skipped=0
for file in "${files[@]}"; do
  name="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["name"])' "$file")"
  if printf '%s\n' "$existing" | grep -qF -- "$name"; then
    log_info "already installed, skipping: ${name}"
    skipped=$((skipped+1))
    continue
  fi

  tmp_container_path="/tmp/$(basename "$file")"
  # `docker cp` does not reliably write into a path covered by a `--tmpfs`
  # mount for a running container — verified directly against this image
  # while building this script's test coverage: it reports success but the
  # file never appears. n8n's container is read_only everywhere except its
  # two writable mounts (the bind-mounted user folder and this tmpfs /tmp),
  # so there is no non-tmpfs path to fall back to either. Piping through a
  # live `docker exec` process works instead, because that process runs
  # inside the container's actual mount namespace rather than whatever
  # mechanism `docker cp` uses to reach the container's filesystem from the
  # host side. See tests/install-workflows-regression.sh.
  if ! docker exec -i "$cid" sh -c "cat > '${tmp_container_path}'" <"$file"; then
    log_error "failed to stage ${name} into the n8n container"
    continue
  fi
  if docker exec "$cid" n8n import:workflow --input="$tmp_container_path" >/dev/null 2>&1; then
    log_ok "imported: ${name}"
    imported=$((imported+1))
  else
    log_error "failed to import: ${name}"
  fi
  docker exec "$cid" rm -f "$tmp_container_path" >/dev/null 2>&1 || true
done

log_ok "workflows: ${imported} imported, ${skipped} already present"
log_info "every imported workflow is inactive by default — activate it in the n8n UI once you have verified it against a real run"
log_info "verify with: docker exec ${cid} n8n list:workflow"
