#!/usr/bin/env bash
# =============================================================================
# build.sh — build the container images and the runner binary.
#
# Every base image is passed in as a digest-pinned build argument from
# infra/versions.lock.env. The Dockerfiles declare the ARGs with no default, so
# a build started without them fails rather than silently resolving `latest`.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

load_versions
require_cmd docker

SKIP_RUNNER=0
SKIP_IMAGES=0
declare -a ONLY_SERVICES=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-runner) SKIP_RUNNER=1; shift ;;
    --skip-images) SKIP_IMAGES=1; shift ;;
    --only)
      [[ -n "${2:-}" ]] || die "--only needs a value (control-api, web, or caddy)"
      case "$2" in
        control-api|web|caddy) ;;
        *) die "--only must be control-api, web, or caddy (got: $2)" ;;
      esac
      ONLY_SERVICES+=("$2"); shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

# With no --only at all, every locally-built image is built — the default
# every existing caller (update.sh, a plain `pcctl build`) already relies on
# and must keep getting unchanged. `--only` (repeatable) narrows that to
# specific service(s) so a caller that is only ever going to redeploy a
# SUBSET of the three locally-built services (recover-deployment.sh,
# resume-update.sh) does not retag the other two away from whatever they are
# currently, correctly, running — this build's exporter embeds a fresh
# attestation/provenance manifest on every invocation, so even a 100%
# layer-cache-hit rebuild of an untouched service produces a new top-level
# image ID, which would otherwise silently orphan that service's tag from
# its still-running, still-correct container.
build_selected() {
  (( ${#ONLY_SERVICES[@]} == 0 )) && return 0
  local svc
  for svc in "${ONLY_SERVICES[@]}"; do [[ "$svc" == "$1" ]] && return 0; done
  return 1
}

cd "$PC_REPO_ROOT"

# The image label below is what a rebuild of byte-identical source is allowed
# to be described by while still resolving to the byte-identical image ID
# `--provenance=false --sbom=false` (below) already makes possible: `_pc_ts`
# (the current wall-clock time) would re-bust that on every single
# invocation, on purpose, exactly the way it did live on this host — one
# service's incidental rebuild moved its tag to a fresh, unreferenced image,
# permanently orphaning the tag from the sibling container that was never
# touched, still healthy, and still correct. The last commit's own timestamp
# changes only when the content actually does, which is the label's intent
# anyway ("when was this built") without the churn. Falls back to `_pc_ts`
# outside a git checkout (e.g. a tarball deploy with no `.git`).
IMAGE_CREATED_LABEL="$(git -C "$PC_REPO_ROOT" log -1 --format=%cI 2>/dev/null || true)"
[[ -n "$IMAGE_CREATED_LABEL" ]] || IMAGE_CREATED_LABEL="$(_pc_ts)"

# -----------------------------------------------------------------------------
# Runner binary — a static, stripped, reproducible Go build.
# -----------------------------------------------------------------------------
if (( ! SKIP_RUNNER )); then
  log_step "Building the runner binary"

  if ! have go; then
    log_error "Go toolchain not found; cannot build the runner."
    log_info  "Install Go ${PC_GO_VERSION}, or build elsewhere and place the binary at"
    log_info  "  apps/runner/bin/project-control-runner"
    log_info  "See docs/installation.md for the exact commands."
    exit 1
  fi

  go_version="$(go env GOVERSION 2>/dev/null || echo unknown)"
  log_info "using ${go_version} (lock expects go${PC_GO_VERSION})"

  mkdir -p apps/runner/bin

  (
    cd apps/runner
    # CGO_ENABLED=0 produces a genuinely static binary with no libc dependency,
    # so it cannot break when the host's glibc is upgraded.
    # -trimpath and the fixed buildid keep the output reproducible.
    CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
      go build \
        -trimpath \
        -buildvcs=false \
        -ldflags "-s -w -buildid= -X main.version=${PC_STACK_VERSION}" \
        -o bin/project-control-runner \
        ./cmd/runner
  )

  chmod 0750 apps/runner/bin/project-control-runner
  size="$(stat -c '%s' apps/runner/bin/project-control-runner)"
  sha="$(sha256sum apps/runner/bin/project-control-runner | cut -d' ' -f1)"
  log_ok "runner built: $((size / 1024)) KiB, sha256 ${sha:0:16}…"

  # A dynamically linked binary here would mean CGO leaked back in.
  if file apps/runner/bin/project-control-runner 2>/dev/null | grep -q 'dynamically linked'; then
    die "runner binary is dynamically linked; expected a static build"
  fi
fi

# -----------------------------------------------------------------------------
# Container images
# -----------------------------------------------------------------------------
if (( ! SKIP_IMAGES )); then
  if build_selected control-api; then
    log_step "Building the Control API image"
    docker build --provenance=false --sbom=false \
      --file apps/control-api/Dockerfile \
      --tag "${PC_CONTROL_API_IMAGE}" \
      --build-arg "NODE_BUILD_IMAGE=${PC_NODE_BUILD_IMAGE}" \
      --build-arg "NODE_RUNTIME_IMAGE=${PC_NODE_RUNTIME_IMAGE}" \
      --build-arg "PNPM_VERSION=${PC_PNPM_VERSION}" \
      --build-arg "APP_UID=${PC_APP_UID}" \
      --build-arg "APP_GID=${PC_APP_GID}" \
      --label "org.opencontainers.image.title=project-control-api" \
      --label "org.opencontainers.image.version=${PC_STACK_VERSION}" \
      --label "org.opencontainers.image.created=${IMAGE_CREATED_LABEL}" \
      .
    log_ok "built ${PC_CONTROL_API_IMAGE}"
  fi

  if build_selected web; then
    log_step "Building the web image"
    docker build --provenance=false --sbom=false \
      --file apps/web/Dockerfile \
      --tag "${PC_WEB_IMAGE}" \
      --build-arg "NODE_BUILD_IMAGE=${PC_NODE_BUILD_IMAGE}" \
      --build-arg "CADDY_IMAGE=${PC_CADDY_IMAGE}" \
      --build-arg "PNPM_VERSION=${PC_PNPM_VERSION}" \
      --build-arg "WEB_UID=${PC_WEB_UID}" \
      --label "org.opencontainers.image.title=project-control-web" \
      --label "org.opencontainers.image.version=${PC_STACK_VERSION}" \
      --label "org.opencontainers.image.created=${IMAGE_CREATED_LABEL}" \
      .
    log_ok "built ${PC_WEB_IMAGE}"
  fi

  if build_selected caddy; then
    log_step "Building the edge proxy image"
    # A thin layer over the pinned Caddy image; see infra/caddy/Dockerfile for why
    # it exists (cap_net_bind_service vs cap_drop: ALL).
    docker build --provenance=false --sbom=false \
      --file infra/caddy/Dockerfile \
      --tag "${PC_CADDY_PROXY_IMAGE}" \
      --build-arg "CADDY_IMAGE=${PC_CADDY_IMAGE}" \
      --build-arg "APP_UID=${PC_APP_UID}" \
      --build-arg "APP_GID=${PC_APP_GID}" \
      --label "org.opencontainers.image.title=project-control-caddy" \
      --label "org.opencontainers.image.version=${PC_STACK_VERSION}" \
      --label "org.opencontainers.image.created=${IMAGE_CREATED_LABEL}" \
      .
    log_ok "built ${PC_CADDY_PROXY_IMAGE}"
  fi

  log_step "Pulling pinned third-party images"
  for image in "${PC_POSTGRES_IMAGE}" "${PC_N8N_IMAGE}" "${PC_CADDY_IMAGE}"; do
    if docker image inspect "$image" >/dev/null 2>&1; then
      log_ok "already present: ${image%%@*}@${image##*@sha256:}"
    else
      log_info "pulling ${image}"
      docker pull --quiet "$image" >/dev/null
      log_ok "pulled ${image}"
    fi
  done
fi

log_ok "build complete"
