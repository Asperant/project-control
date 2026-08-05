#!/usr/bin/env bash
# =============================================================================
# configure-google-drive.sh — MANUAL CHECKPOINT 2
#
# Sets up the encrypted off-site backup target:
#
#   restic repository  →  rclone:gdrive:Project-Control-Backups/restic
#
# Two operator-supplied pieces of material are involved and neither can be
# generated automatically:
#
#   1. Google Drive OAuth token — requires a browser consent flow.
#   2. Restic repository password — chosen by the operator. This is the ONLY
#      thing standing between a Google Drive compromise and the plaintext of
#      every backup, and losing it makes every existing snapshot permanently
#      unrecoverable. It is therefore never generated, never displayed and
#      never transmitted.
# =============================================================================
# shellcheck source=lib/common.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lib/common.sh"

require_root
load_versions

RCLONE_CONFIG="${PC_ROOT}/config/rclone.conf"
RESTIC_REPO="rclone:gdrive:Project-Control-Backups/restic"

log_step "MANUAL CHECKPOINT 2 — Google Drive backup target"

# -----------------------------------------------------------------------------
# Dependencies
# -----------------------------------------------------------------------------
missing=()
have restic || missing+=(restic)
have rclone || missing+=(rclone)

if (( ${#missing[@]} > 0 )); then
  cat >&2 <<INSTALL

  Missing: ${missing[*]}

  Install them (Ubuntu 22.04):

      # Both from pinned upstream releases with checksum verification.
      # Ubuntu 22.04 ships restic 0.12.1 (2021), which is far too old for the
      # component guarding your last-resort copy of the data.
      # Exact commands: docs/installation.md "Backup tooling".

  Then re-run:

      sudo ./pcctl configure-google-drive

INSTALL
  log_warn "MANUAL_CONFIGURATION_REQUIRED: install ${missing[*]}"
  exit 0
fi

log_ok "restic $(restic version 2>/dev/null | head -1)"
log_ok "rclone $(rclone version 2>/dev/null | head -1)"

if [[ ! -t 0 ]]; then
  log_warn "MANUAL_CONFIGURATION_REQUIRED: Google Drive OAuth needs an interactive terminal"
  log_info "run: sudo ./pcctl configure-google-drive"
  exit 0
fi

# -----------------------------------------------------------------------------
# 1. rclone remote
# -----------------------------------------------------------------------------
ensure_dir "$(dirname "$RCLONE_CONFIG")" 0755 root root

if [[ -f "$RCLONE_CONFIG" ]] && RCLONE_CONFIG="$RCLONE_CONFIG" rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
  log_ok "rclone remote 'gdrive' already configured"
else
  cat >&2 <<'OAUTH'

  ── Google Drive authorisation ────────────────────────────────────────────

  rclone's interactive configuration will now start. Answer as follows:

      name>                gdrive
      Storage>             drive          (Google Drive)
      client_id>           (blank — press Enter)
      client_secret>       (blank — press Enter)
      scope>               1              (full access)  or  3 (drive.file)
      service_account_file>(blank — press Enter)
      Edit advanced config>n
      Use web browser to automatically authenticate?

        * On a machine WITH a browser:  y
        * On a headless server:         n  — rclone then prints a command to
          run on a machine that has a browser, and you paste the resulting
          token back here.

      Configure this as a Shared Drive?>  n

  Choose  q) Quit config  when you are done.

  ──────────────────────────────────────────────────────────────────────────

OAUTH

  read -r -p "Press Enter to start rclone config… " _

  RCLONE_CONFIG="$RCLONE_CONFIG" rclone config

  if ! RCLONE_CONFIG="$RCLONE_CONFIG" rclone listremotes 2>/dev/null | grep -q '^gdrive:'; then
    die "no remote named 'gdrive' was created; re-run and name the remote exactly 'gdrive'"
  fi
fi

# The rclone config file holds a refresh token: it is a credential.
chmod 0600 "$RCLONE_CONFIG"
chown root:root "$RCLONE_CONFIG"
log_ok "rclone.conf secured (0600 root)"

log_step "Testing Google Drive access"
if ! RCLONE_CONFIG="$RCLONE_CONFIG" rclone lsd gdrive: --max-depth 1 >/dev/null 2>&1; then
  die "cannot list Google Drive; re-run the OAuth flow"
fi
log_ok "Google Drive is reachable"

RCLONE_CONFIG="$RCLONE_CONFIG" rclone mkdir "gdrive:Project-Control-Backups/restic" 2>/dev/null || true
log_ok "backup folder present: Project-Control-Backups/restic"

# -----------------------------------------------------------------------------
# 2. Restic repository password
# -----------------------------------------------------------------------------
if secret_exists restic_password; then
  log_ok "restic password already stored"
else
  cat >&2 <<'PASSWORD'

  ── Restic repository password ────────────────────────────────────────────

  Choose a strong passphrase. Understand what it protects and what it costs:

    * Every backup is encrypted with it before it leaves this machine, so
      Google Drive only ever holds ciphertext.
    * If you lose it, EVERY EXISTING SNAPSHOT IS PERMANENTLY UNRECOVERABLE.
      There is no reset, no recovery code, and no support path.

  Store it somewhere outside this machine — a password manager, or paper in a
  safe. A copy that only exists on the host being backed up is not a copy.

  It is not echoed as you type and is never displayed again.

PASSWORD

  read -r -s -p "Restic repository password: " RESTIC_PW; printf '\n' >&2
  read -r -s -p "Confirm password: "            RESTIC_PW2; printf '\n' >&2

  [[ "$RESTIC_PW" == "$RESTIC_PW2" ]] || die "passwords do not match; nothing was stored"
  (( ${#RESTIC_PW} >= 16 )) || die "password must be at least 16 characters"

  write_secret restic_password "$RESTIC_PW"
  RESTIC_PW=""; RESTIC_PW2=""
  unset RESTIC_PW RESTIC_PW2
fi

# -----------------------------------------------------------------------------
# 3. Initialise the repository (idempotent)
# -----------------------------------------------------------------------------
log_step "Preparing the restic repository"

export RESTIC_REPOSITORY="$RESTIC_REPO"
# The password reaches restic through a file descriptor, never through argv or
# an environment variable that would be visible in /proc.
export RESTIC_PASSWORD_FILE="${PC_SECRETS_DIR}/restic_password"
export RCLONE_CONFIG="$RCLONE_CONFIG"

if restic cat config >/dev/null 2>&1; then
  log_ok "repository already initialised"
else
  log_info "initialising the repository (first run)"
  if restic init 2>&1 | redact_stream; then
    log_ok "repository initialised"
  else
    die "restic init failed"
  fi
fi

# -----------------------------------------------------------------------------
# 4. Prove it round-trips before declaring success
# -----------------------------------------------------------------------------
log_step "Verifying the repository"
if restic check --read-data-subset=1% 2>&1 | redact_stream; then
  log_ok "repository check passed"
else
  log_warn "restic check reported problems; review the output above"
fi

snapshots="$(restic snapshots --json 2>/dev/null | python3 -c 'import sys,json;print(len(json.load(sys.stdin)))' 2>/dev/null || echo 0)"

# -----------------------------------------------------------------------------
STATUS_FILE="${PC_ROOT}/config/status/backup-status.json"
tmp="$(mktemp)"
cat >"$tmp" <<EOF
{
  "configured": true,
  "repository": "${RESTIC_REPO}",
  "snapshotCount": ${snapshots},
  "lastResult": "not_run_yet",
  "updatedAt": "$(_pc_ts)"
}
EOF
install_file "$tmp" "$STATUS_FILE" 0644
rm -f "$tmp"

cat >&2 <<BANNER

$(printf '═%.0s' {1..70})
  Google Drive backup configured
$(printf '═%.0s' {1..70})

  Repository : ${RESTIC_REPO}
  Snapshots  : ${snapshots}
  Encryption : restic (AES-256), keyed by your passphrase, applied before upload
  Schedule   : nightly 02:30 (+ up to 30 min jitter), Persistent=true

  Run the first backup now:

      sudo ./pcctl backup

  Then prove it can actually be restored:

      sudo ./pcctl restore-test

$(printf '═%.0s' {1..70})

BANNER
