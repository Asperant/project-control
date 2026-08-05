#!/usr/bin/env bash
# =============================================================================
# reconcile-roles-and-databases.sh
#
# The single source of truth for PostgreSQL role and database provisioning.
# Idempotent: safe against an empty cluster, a half-provisioned cluster (e.g.
# one where a prior run died partway through), or an already fully-
# provisioned cluster. Never drops a role or database, never re-runs initdb,
# never touches existing table data.
#
# This one file is bind-mounted, unmodified, into two different places —
# never copied, so there is exactly one copy of this logic to audit:
#
#   1. /docker-entrypoint-initdb.d/10-roles-and-databases.sh (postgres service)
#      Run once by the official postgres entrypoint the first time PGDATA is
#      empty. PGHOST is unset, so psql connects over the local Unix socket;
#      the entrypoint has already exported PGPASSWORD (from
#      POSTGRES_PASSWORD_FILE) for that connection before any init script
#      runs.
#
#   2. the `db-bootstrap` Compose service
#      Run once per `docker compose up`, after postgres reports healthy,
#      against a cluster that may already be fully or partially provisioned
#      (this is what repairs a cluster whose first init died partway
#      through). PGHOST/PGPORT point at the `postgres` service over the
#      `data` network; PGPASSWORD is not preinjected there, so this script
#      builds a short-lived, mode-0600 PGPASSFILE from the mounted superuser
#      secret and deletes it unconditionally on exit.
#
# In both contexts the four application role passwords are read fresh from
# /run/secrets/pg_*_password and applied with ALTER ROLE ... PASSWORD, so a
# rotated secret converges the next time this runs, in either context.
#
# Creates/repairs two databases and four roles with no overlapping access:
#
#   Database `project_control`      Database `n8n`
#   ─────────────────────────      ──────────────
#   control_app       CONNECT      n8n_app       CONNECT (owner)
#   control_migrator  CONNECT      —
#   backup_reader     CONNECT      backup_reader CONNECT
#   n8n_app           DENIED       control_app   DENIED
#                                  control_migrator DENIED
#
# Isolation is enforced by revoking CONNECT from PUBLIC on each database and
# granting it only to the roles that belong there.
# =============================================================================
set -Eeuo pipefail

log() { printf '[pg-reconcile] %s\n' "$*" >&2; }

read_secret() {
  local path="$1" label="$2"
  if [[ ! -r "$path" ]]; then
    log "FATAL: cannot read ${label} at ${path}"
    exit 1
  fi
  local value
  value="$(<"$path")"
  value="${value%$'\n'}"
  if [[ -z "$value" ]]; then
    log "FATAL: ${label} is empty"
    exit 1
  fi
  printf '%s' "$value"
}

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"

# --- Superuser authentication -------------------------------------------------
# If PGPASSWORD is already set, the postgres entrypoint put it there for the
# local-socket init connection — use it as-is and touch nothing else. Otherwise
# (the standalone db-bootstrap service) build a short-lived PGPASSFILE from the
# mounted superuser secret and remove it unconditionally on exit: success,
# failure, or signal. The password itself is never placed in an argument, an
# environment variable we set, a log line, or left on disk after this script
# exits.
PGPASSFILE_CREATED=""
cleanup() {
  if [[ -n "$PGPASSFILE_CREATED" && -f "$PGPASSFILE_CREATED" ]]; then
    rm -f -- "$PGPASSFILE_CREATED"
  fi
}
trap cleanup EXIT

if [[ -z "${PGPASSWORD:-}" ]]; then
  SUPERUSER_PASSWORD="$(read_secret /run/secrets/pg_superuser_password 'postgres superuser password')"
  PGPASSFILE_CREATED="$(mktemp /tmp/.pgpass.XXXXXXXX)"
  chmod 0600 "$PGPASSFILE_CREATED"
  printf '*:*:*:%s:%s\n' "$POSTGRES_USER" "$SUPERUSER_PASSWORD" >"$PGPASSFILE_CREATED"
  chmod 0600 "$PGPASSFILE_CREATED"
  unset SUPERUSER_PASSWORD
  export PGPASSFILE="$PGPASSFILE_CREATED"
  log "built an ephemeral PGPASSFILE for superuser authentication (removed on exit)"
fi

CONTROL_APP_PASSWORD="$(read_secret /run/secrets/pg_control_app_password 'control_app password')"
CONTROL_MIGRATOR_PASSWORD="$(read_secret /run/secrets/pg_control_migrator_password 'control_migrator password')"
N8N_APP_PASSWORD="$(read_secret /run/secrets/pg_n8n_app_password 'n8n_app password')"
BACKUP_READER_PASSWORD="$(read_secret /run/secrets/pg_backup_reader_password 'backup_reader password')"

log "reconciling roles and databases"

# `psql -v ON_ERROR_STOP=1` makes any failure abort — far better than a
# silently half-provisioned cluster.
#
# Passwords are passed as psql variables and quoted with :'name', so they are
# escaped by psql rather than interpolated into SQL text by the shell, and
# never appear in this script's own argv.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v control_app_pw="$CONTROL_APP_PASSWORD" \
  -v control_migrator_pw="$CONTROL_MIGRATOR_PASSWORD" \
  -v n8n_app_pw="$N8N_APP_PASSWORD" \
  -v backup_reader_pw="$BACKUP_READER_PASSWORD" <<'SQL'

-- ---------------------------------------------------------------------------
-- Roles
--
-- A bare role is created only if missing; every run then reapplies the full
-- attribute set and current password with ALTER ROLE, so an interrupted first
-- run, a repeat run, or a rotated secret all converge to the same state
-- without ever dropping a role. NOINHERIT matters: it stops a role from
-- silently picking up privileges of a role it is granted. All four are
-- NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_app') THEN
    CREATE ROLE control_app NOLOGIN;
  END IF;
END $$;
ALTER ROLE control_app WITH LOGIN PASSWORD :'control_app_pw'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 20;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'control_migrator') THEN
    CREATE ROLE control_migrator NOLOGIN;
  END IF;
END $$;
ALTER ROLE control_migrator WITH LOGIN PASSWORD :'control_migrator_pw'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 5;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'n8n_app') THEN
    CREATE ROLE n8n_app NOLOGIN;
  END IF;
END $$;
ALTER ROLE n8n_app WITH LOGIN PASSWORD :'n8n_app_pw'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 20;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_reader') THEN
    CREATE ROLE backup_reader NOLOGIN;
  END IF;
END $$;
ALTER ROLE backup_reader WITH LOGIN PASSWORD :'backup_reader_pw'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS
    CONNECTION LIMIT 5;

-- ---------------------------------------------------------------------------
-- Databases
--
-- CREATE DATABASE cannot be wrapped in a plain conditional, so \gexec is
-- used: the SELECT produces a CREATE DATABASE statement as a text row only
-- when the database is missing, and \gexec executes whatever rows come back
-- — zero rows means nothing executes. control_migrator owns project_control
-- so it can run DDL without any cluster-wide privilege; n8n_app owns n8n
-- because n8n manages its own schema.
-- ---------------------------------------------------------------------------
SELECT 'CREATE DATABASE project_control OWNER control_migrator ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'project_control')
\gexec

SELECT 'CREATE DATABASE n8n OWNER n8n_app ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'n8n')
\gexec

-- If a database already existed under a different owner (e.g. left over from
-- a partial run), converge ownership without touching its data.
ALTER DATABASE project_control OWNER TO control_migrator;
ALTER DATABASE n8n             OWNER TO n8n_app;

-- ---------------------------------------------------------------------------
-- Cross-database isolation
--
-- Revoking CONNECT from PUBLIC is the step that actually isolates the two
-- databases; without it every role could connect to both, and object-level
-- grants would be the only barrier. REVOKE/GRANT are no-ops when the
-- privilege state already matches, so this is safe to repeat.
-- ---------------------------------------------------------------------------
REVOKE ALL ON DATABASE project_control FROM PUBLIC;
REVOKE ALL ON DATABASE n8n             FROM PUBLIC;
REVOKE ALL ON DATABASE postgres        FROM PUBLIC;
REVOKE ALL ON DATABASE template1       FROM PUBLIC;

GRANT CONNECT ON DATABASE project_control TO control_app, control_migrator, backup_reader;
GRANT CONNECT ON DATABASE n8n             TO n8n_app, backup_reader;

-- Explicit denial, stated for the benefit of the reader and of `pcctl
-- verify-security`, which asserts exactly these cannot connect.
REVOKE CONNECT ON DATABASE n8n             FROM control_app, control_migrator;
REVOKE CONNECT ON DATABASE project_control FROM n8n_app;

SQL

# ---------------------------------------------------------------------------
# Per-database schema hardening.
#
# Since PostgreSQL 15, PUBLIC no longer has CREATE on `public` by default, but
# the revoke is issued explicitly so the posture does not depend on a default
# that could change or on which major version this cluster was created under.
# Every statement here is idempotent: REVOKE/GRANT/ALTER ... OWNER TO are
# no-ops once the target state already holds.
# ---------------------------------------------------------------------------
log "hardening project_control schema"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname project_control <<'SQL'
REVOKE ALL   ON SCHEMA public FROM PUBLIC;
GRANT  USAGE ON SCHEMA public TO   control_app, backup_reader;
ALTER  SCHEMA public OWNER TO control_migrator;
-- Only the migrator may create objects.
GRANT  CREATE ON SCHEMA public TO control_migrator;
SQL

log "hardening n8n schema"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname n8n <<'SQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER  SCHEMA public OWNER TO n8n_app;
GRANT  ALL   ON SCHEMA public TO n8n_app;
-- backup_reader needs to read whatever n8n creates later.
GRANT  USAGE ON SCHEMA public TO backup_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE n8n_app IN SCHEMA public
    GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE n8n_app IN SCHEMA public
    GRANT SELECT ON SEQUENCES TO backup_reader;
SQL

log "reconciliation complete: databases project_control, n8n; roles control_app, control_migrator, n8n_app, backup_reader"
