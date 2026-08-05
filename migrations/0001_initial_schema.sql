-- =============================================================================
-- 0001_initial_schema.sql — Stage 1 tables for the `project_control` database.
--
-- Applied by the `control_migrator` role. Every statement is written so that a
-- re-run is a no-op; the migration runner also records applied versions in
-- `schema_migrations` and skips them, so this is belt and braces.
--
-- Stage 1 scope only: users, sessions, audit_events, schema_migrations,
-- system_settings, artifact_objects. No project/task tables yet.
-- =============================================================================

-- gen_random_uuid() lives in pgcrypto on PostgreSQL < 13 and in core from 13
-- onwards. On 17 it is built in, so no extension is required and none is
-- created — installing extensions would need superuser, which the migrator
-- deliberately does not have.

-- -----------------------------------------------------------------------------
-- schema_migrations — the runner's own ledger.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
    version         TEXT        PRIMARY KEY,
    name            TEXT        NOT NULL,
    -- SHA-256 of the file contents at apply time. If a migration file is edited
    -- after being applied, the runner detects the mismatch and refuses to start
    -- rather than silently running against a schema it cannot reason about.
    checksum        TEXT        NOT NULL,
    applied_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    execution_ms    INTEGER     NOT NULL DEFAULT 0
);

COMMENT ON TABLE schema_migrations IS
    'Ledger of applied migrations. checksum guards against post-hoc edits.';

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- CITEXT would be tidier but requires an extension (superuser). Emails are
    -- normalised to lowercase by the API contract before they ever reach here,
    -- and the unique index below is on the raw column to match that invariant.
    email            TEXT        NOT NULL,
    display_name     TEXT        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    -- Argon2id PHC string ($argon2id$v=19$m=...,t=...,p=...$salt$hash).
    -- Never selected by any read path that feeds an HTTP response.
    password_hash    TEXT        NOT NULL,
    role             TEXT        NOT NULL DEFAULT 'viewer'
                                 CHECK (role IN ('admin', 'operator', 'viewer')),
    is_active        BOOLEAN     NOT NULL DEFAULT TRUE,
    failed_login_count INTEGER   NOT NULL DEFAULT 0,
    -- Set when failed_login_count crosses the configured threshold.
    locked_until     TIMESTAMPTZ,
    last_login_at    TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT users_email_format CHECK (email = lower(email) AND position('@' in email) > 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);
CREATE INDEX IF NOT EXISTS users_active_idx ON users (is_active) WHERE is_active;

COMMENT ON COLUMN users.password_hash IS 'Argon2id PHC string. Never leaves the database layer.';

-- -----------------------------------------------------------------------------
-- sessions
--
-- The cookie carries a high-entropy opaque token; only its SHA-256 is stored.
-- A database read therefore cannot be replayed as a session, which matters
-- because `backup_reader` can dump this table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash       TEXT        NOT NULL,
    -- Double-submit CSRF token. Bound to the session, rotated with it.
    csrf_token_hash  TEXT        NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Absolute expiry. Idle expiry is derived from last_seen_at at read time.
    expires_at       TIMESTAMPTZ NOT NULL,
    revoked_at       TIMESTAMPTZ,
    -- Coarse client fingerprint for the audit trail. No full user-agent string
    -- and no raw IP beyond what the loopback proxy provides.
    user_agent_hash  TEXT,
    CONSTRAINT sessions_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_token_hash_key ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
-- Supports the periodic sweep of dead sessions.
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions (expires_at)
    WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- audit_events — append-only trail.
--
-- No UPDATE or DELETE grant is issued for this table (see 0002), so the runtime
-- role can add rows but cannot rewrite history.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Dotted machine key, e.g. `auth.login.succeeded`.
    event_type    TEXT        NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
    outcome       TEXT        NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'error')),
    actor_user_id UUID        REFERENCES users (id) ON DELETE SET NULL,
    -- Present even for anonymous events (failed logins), so an operator can
    -- correlate a request across the API log and the audit trail.
    request_id    TEXT,
    subject       TEXT,
    -- Structured, already-redacted context. The writer is responsible for never
    -- placing secret material here; see src/audit.ts.
    detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT audit_detail_is_object CHECK (jsonb_typeof(detail) = 'object')
);

CREATE INDEX IF NOT EXISTS audit_events_occurred_at_idx ON audit_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_type_idx ON audit_events (event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx ON audit_events (actor_user_id, occurred_at DESC);

-- -----------------------------------------------------------------------------
-- system_settings — small key/value store for operational state.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS system_settings (
    key          TEXT        PRIMARY KEY CHECK (key ~ '^[a-z0-9_.]{1,120}$'),
    value        JSONB       NOT NULL,
    description  TEXT        NOT NULL DEFAULT '',
    -- Marks settings that must never be rendered in the UI or included in a
    -- support bundle. Stage 1 stores no secret here, but the flag exists so a
    -- later stage cannot add one without opting into the handling.
    is_sensitive BOOLEAN     NOT NULL DEFAULT FALSE,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   UUID        REFERENCES users (id) ON DELETE SET NULL
);

-- -----------------------------------------------------------------------------
-- artifact_objects — metadata for content-addressed files on the host FS.
--
-- The bytes live at data/artifacts/objects/<aa>/<sha256>. This table is the
-- index; it never holds the content itself (no BYTEA, no large object).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artifact_objects (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    sha256        TEXT        NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    filename      TEXT        NOT NULL CHECK (length(filename) BETWEEN 1 AND 255),
    content_type  TEXT        NOT NULL DEFAULT 'application/octet-stream',
    size_bytes    BIGINT      NOT NULL CHECK (size_bytes >= 0),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID        REFERENCES users (id) ON DELETE SET NULL,
    -- Soft archive only. The referenced file on disk is never unlinked by the
    -- application, so a metadata mistake can always be undone.
    archived_at   TIMESTAMPTZ,
    archived_by   UUID        REFERENCES users (id) ON DELETE SET NULL
);

-- Many metadata rows may point at one blob (same content, different filenames),
-- so the digest is indexed but NOT unique.
CREATE INDEX IF NOT EXISTS artifact_objects_sha256_idx ON artifact_objects (sha256);
CREATE INDEX IF NOT EXISTS artifact_objects_created_at_idx ON artifact_objects (created_at DESC);
CREATE INDEX IF NOT EXISTS artifact_objects_live_idx ON artifact_objects (created_at DESC)
    WHERE archived_at IS NULL;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS system_settings_set_updated_at ON system_settings;
CREATE TRIGGER system_settings_set_updated_at
    BEFORE UPDATE ON system_settings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
