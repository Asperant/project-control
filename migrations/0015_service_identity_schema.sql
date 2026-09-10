-- =============================================================================
-- 0015_service_identity_schema.sql — machine (non-human) principals.
--
-- Applied by `control_migrator`. This is the platform's first non-human
-- principal: a scoped Bearer token a machine (n8n, in the first consumer) can
-- present instead of the session cookie every human route already requires.
-- See docs/service-accounts.md and apps/control-api/src/auth/middleware.ts.
--
-- Two tables, both append-only in spirit:
--
--   service_accounts  one row per known machine identity ('n8n-automation').
--                     Created only by the compiled-in registry in
--                     apps/control-api/src/auth/service-accounts.ts — there is
--                     no route that creates one, mirroring the runner's own
--                     compiled-in operation table.
--   service_tokens    one row per minted credential. Only a SHA-256 of the
--                     token is ever stored — the same design as `sessions`,
--                     for the same reason: a `backup_reader` dump that reaches
--                     Google Drive must contain nothing replayable.
--
-- A token's scopes must be a subset of its account's scopes, enforced by
-- trigger because a CHECK constraint cannot see another table's row. Identity
-- fields on a token are immutable from creation; only `revoked_at` and
-- `last_used_at` may change after the row exists. Neither table is ever
-- physically deleted from; revocation is `revoked_at`, disabling an account is
-- `status = 'disabled'`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- service_accounts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_accounts (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Stable machine key, e.g. 'n8n-automation'. Matched against the
    -- compiled-in registry at mint time — an unknown key cannot be minted a
    -- token even by an operator holding the migrator credential directly,
    -- because the CLI that mints tokens only knows about registry entries.
    key           TEXT        NOT NULL CHECK (key ~ '^[a-z0-9-]{3,64}$'),
    display_name  TEXT        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    -- Ceiling scopes: no token minted for this account may carry a scope
    -- outside this set. See service_tokens.scopes and
    -- guard_service_token_scopes() below.
    scopes        TEXT[]      NOT NULL CHECK (cardinality(scopes) > 0),
    status        TEXT        NOT NULL DEFAULT 'active'
                               CHECK (status IN ('active', 'disabled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The fixed scope vocabulary. Kept in sync by hand with
    -- packages/contracts/src/service-accounts.ts serviceScopeSchema — the same
    -- dual-declaration this repository already accepts for
    -- project_actions.kind / repositoryActionKindSchema.
    CONSTRAINT service_accounts_scopes_known CHECK (
        scopes <@ ARRAY[
            'automation:run', 'project:read', 'project:rescan',
            'action:plan', 'system:read', 'report:write'
        ]::text[]
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS service_accounts_key_key ON service_accounts (key);

DROP TRIGGER IF EXISTS service_accounts_set_updated_at ON service_accounts;
CREATE TRIGGER service_accounts_set_updated_at BEFORE UPDATE ON service_accounts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- service_tokens
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS service_tokens (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id     UUID        NOT NULL REFERENCES service_accounts (id),
    -- SHA-256 of the token's secret half. Never the token itself — see the
    -- header comment and apps/control-api/src/auth/service-tokens.ts.
    token_hash     TEXT        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    -- 'pcs_' plus the token's public id-part. Diagnostic only: lets an
    -- operator (and an audit row) name a token without ever storing enough to
    -- reconstruct it. Not sensitive on its own — the id-part carries no
    -- entropy that authenticates anything.
    prefix         TEXT        NOT NULL CHECK (prefix ~ '^pcs_[A-Za-z0-9_-]{6,32}$'),
    scopes         TEXT[]      NOT NULL CHECK (cardinality(scopes) > 0),
    -- No unexpiring machine credential. A caller must pass --ttl-days; there
    -- is no default that means "forever".
    expires_at     TIMESTAMPTZ NOT NULL,
    last_used_at   TIMESTAMPTZ,
    revoked_at     TIMESTAMPTZ,
    created_by     UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT service_tokens_scopes_known CHECK (
        scopes <@ ARRAY[
            'automation:run', 'project:read', 'project:rescan',
            'action:plan', 'system:read', 'report:write'
        ]::text[]
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS service_tokens_token_hash_key ON service_tokens (token_hash);
CREATE INDEX IF NOT EXISTS service_tokens_account_history_idx
    ON service_tokens (account_id, created_at DESC);
-- Supports the hot lookup path (resolve-by-hash already uses the unique index
-- above; this supports "does this account have any live token" listings).
CREATE INDEX IF NOT EXISTS service_tokens_live_idx
    ON service_tokens (account_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION guard_service_token_scopes() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    account_scopes TEXT[];
BEGIN
    SELECT scopes INTO account_scopes FROM service_accounts WHERE id = NEW.account_id;
    IF account_scopes IS NULL THEN
        RAISE EXCEPTION 'service account % does not exist', NEW.account_id USING ERRCODE = '23503';
    END IF;
    IF NOT (NEW.scopes <@ account_scopes) THEN
        RAISE EXCEPTION 'token scopes must be a subset of the account''s scopes' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER service_tokens_guard_scopes
    BEFORE INSERT ON service_tokens
    FOR EACH ROW EXECUTE FUNCTION guard_service_token_scopes();

CREATE OR REPLACE FUNCTION guard_service_token_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.account_id IS DISTINCT FROM OLD.account_id
       OR NEW.token_hash IS DISTINCT FROM OLD.token_hash
       OR NEW.prefix IS DISTINCT FROM OLD.prefix
       OR NEW.scopes IS DISTINCT FROM OLD.scopes
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'a service token''s identity is immutable; only last_used_at and revoked_at may change'
            USING ERRCODE = '55000';
    END IF;
    -- Revocation is one-way.
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
        RAISE EXCEPTION 'a revoked service token cannot be un-revoked' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER service_tokens_guard_mutation
    BEFORE UPDATE ON service_tokens
    FOR EACH ROW EXECUTE FUNCTION guard_service_token_mutation();

COMMENT ON TABLE service_accounts IS 'Known machine identities. Rows are created only by the compiled-in registry, never by a route.';
COMMENT ON TABLE service_tokens IS 'Minted Bearer credentials for a service account. Only a SHA-256 of the token is stored; the plaintext exists only in the CLI output at mint time.';
COMMENT ON COLUMN service_tokens.token_hash IS 'SHA-256 of the token secret-half. Never the token itself.';
COMMENT ON COLUMN service_tokens.prefix IS 'pcs_<id-part> only, for diagnostics. Carries no authenticating entropy.';
