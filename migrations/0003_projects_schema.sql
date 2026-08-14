-- =============================================================================
-- 0003_projects_schema.sql — project registration and identity tables.
--
-- Applied by `control_migrator`. Adds the ability to register a project by
-- pointing at a folder that already exists on the host, record what the
-- runner safely observed about it (git state, manifest-detected technology),
-- and let an operator layer rules and command metadata on top.
--
-- Location and repository facts are columns on `projects` itself rather than
-- separate 1:1 tables — both are intrinsic, always-present-or-null attributes
-- of exactly one project, so a join would buy nothing. `project_technologies`,
-- `project_rules` and `project_commands` are genuine one-to-many collections
-- and get their own tables. `project_inspections` is the short-lived,
-- server-held result of a folder scan: it is never itself "the project", and
-- doubles as the rescan-diff staging area via its nullable `project_id`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- projects
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS projects (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    name                  TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    short_code            TEXT        CHECK (short_code IS NULL OR short_code ~ '^[a-z0-9][a-z0-9-]{0,31}$'),
    description           TEXT        NOT NULL DEFAULT '',
    purpose               TEXT        NOT NULL DEFAULT '',
    product_goal          TEXT        NOT NULL DEFAULT '',
    status                TEXT        NOT NULL DEFAULT 'active'
                                       CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    priority              TEXT        NOT NULL DEFAULT 'medium'
                                       CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    tags                  TEXT[]      NOT NULL DEFAULT '{}',
    created_by            UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at           TIMESTAMPTZ,
    last_inspected_at     TIMESTAMPTZ,

    -- --- Location -------------------------------------------------------------
    -- What the operator typed, and what the runner resolved it to. Both are
    -- kept: the input is what a rescan re-validates against, the canonical path
    -- is the join key used for the duplicate-project check.
    location_input_path      TEXT        NOT NULL,
    location_canonical_path  TEXT        NOT NULL CHECK (location_canonical_path ~ '^/'),
    location_allowed_root    TEXT        NOT NULL,
    location_accessible      BOOLEAN     NOT NULL DEFAULT TRUE,
    location_checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- --- Repository (all NULL when the folder is not a git repository) -------
    repo_present                    BOOLEAN     NOT NULL DEFAULT FALSE,
    repo_top_level_path             TEXT,
    -- Sanitised [{ "name": "origin", "url": "https://host/org/repo.git" }, ...].
    -- Credentials are stripped by the runner before this ever leaves it.
    repo_remotes                    JSONB       NOT NULL DEFAULT '[]'::jsonb,
    -- Normalised host+path identity used for cross-project duplicate detection.
    -- NULL when there is no remote to normalise.
    repo_normalized_identity        TEXT,
    repo_active_branch              TEXT,
    repo_default_branch             TEXT,
    repo_default_branch_confidence  TEXT CHECK (repo_default_branch_confidence IS NULL
                                       OR repo_default_branch_confidence IN ('known', 'inferred', 'unknown')),
    repo_last_commit_hash           TEXT CHECK (repo_last_commit_hash IS NULL OR repo_last_commit_hash ~ '^[0-9a-f]{40}$'),
    repo_last_commit_short_hash     TEXT,
    repo_last_commit_at             TIMESTAMPTZ,
    repo_last_commit_subject        TEXT,
    repo_is_dirty                   BOOLEAN,
    repo_modified_count             INTEGER CHECK (repo_modified_count IS NULL OR repo_modified_count >= 0),
    repo_untracked_count            INTEGER CHECK (repo_untracked_count IS NULL OR repo_untracked_count >= 0),
    repo_scanned_at                 TIMESTAMPTZ,

    CONSTRAINT projects_archived_consistency
        CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
    CONSTRAINT projects_remotes_is_array
        CHECK (jsonb_typeof(repo_remotes) = 'array')
);

COMMENT ON TABLE projects IS
    'A registered project folder. Physically never deleted — see status=archived.';
COMMENT ON COLUMN projects.repo_remotes IS
    'Credential-free remote list. Never store a URL containing a userinfo component here.';

-- Exactly one active (non-archived) project per canonical filesystem path.
CREATE UNIQUE INDEX IF NOT EXISTS projects_canonical_path_active_key
    ON projects (location_canonical_path) WHERE status <> 'archived';

-- Exactly one active project per normalised repository identity. Git-less
-- projects (identity NULL) never collide with each other here.
CREATE UNIQUE INDEX IF NOT EXISTS projects_repo_identity_active_key
    ON projects (repo_normalized_identity) WHERE status <> 'archived' AND repo_normalized_identity IS NOT NULL;

CREATE INDEX IF NOT EXISTS projects_status_idx   ON projects (status);
CREATE INDEX IF NOT EXISTS projects_priority_idx ON projects (priority);
CREATE INDEX IF NOT EXISTS projects_tags_idx      ON projects USING gin (tags);
CREATE INDEX IF NOT EXISTS projects_name_trgm_idx ON projects (lower(name));
CREATE INDEX IF NOT EXISTS projects_created_at_idx ON projects (created_at DESC);

DROP TRIGGER IF EXISTS projects_set_updated_at ON projects;
CREATE TRIGGER projects_set_updated_at
    BEFORE UPDATE ON projects
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- project_technologies — one row per detected or user-added technology.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_technologies (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    name              TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    category          TEXT        NOT NULL CHECK (category IN (
                          'language', 'framework', 'package_manager', 'build_tool',
                          'test_tool', 'container', 'database', 'monorepo', 'other'
                      )),
    version           TEXT        CHECK (version IS NULL OR length(version) <= 60),
    -- 'manifest': found by the runner from a known project-definition file.
    -- 'user': added by an operator in the inspection preview or project detail.
    detection_source  TEXT        NOT NULL CHECK (detection_source IN ('manifest', 'user')),
    evidence_path     TEXT        CHECK (evidence_path IS NULL OR length(evidence_path) <= 500),
    is_user_defined   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name, category)
);

CREATE INDEX IF NOT EXISTS project_technologies_project_idx ON project_technologies (project_id);

DROP TRIGGER IF EXISTS project_technologies_set_updated_at ON project_technologies;
CREATE TRIGGER project_technologies_set_updated_at
    BEFORE UPDATE ON project_technologies
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- project_rules — operator-authored guidance, grouped by category.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_rules (
    id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    category    TEXT        NOT NULL CHECK (category IN (
                    'architecture', 'technology', 'security', 'testing',
                    'workflow', 'scope', 'out_of_scope', 'approval_required'
                )),
    text        TEXT        NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
    enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
    sort_order  INTEGER     NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_rules_project_idx ON project_rules (project_id, category, sort_order);

DROP TRIGGER IF EXISTS project_rules_set_updated_at ON project_rules;
CREATE TRIGGER project_rules_set_updated_at
    BEFORE UPDATE ON project_rules
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- project_commands — test/lint/build/... command metadata. Never executed by
-- this platform; see docs/architecture.md ("Command metadata is inert").
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_commands (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id         UUID        NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    type               TEXT        NOT NULL CHECK (type IN ('test', 'lint', 'build', 'typecheck', 'validate', 'custom')),
    display_name       TEXT        NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
    -- Free-text description of the command, e.g. "pnpm test". Metadata only —
    -- never parsed as argv and never passed to a shell or the runner.
    command_text       TEXT        NOT NULL CHECK (length(command_text) BETWEEN 1 AND 500),
    working_directory  TEXT        NOT NULL DEFAULT '.',
    detection_source   TEXT        NOT NULL CHECK (detection_source IN ('manifest', 'user')),
    is_user_defined    BOOLEAN     NOT NULL DEFAULT FALSE,
    enabled            BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Lets a rescan upsert manifest-detected commands with ON CONFLICT rather
    -- than a separate existence check.
    UNIQUE (project_id, type, command_text, working_directory)
);

CREATE INDEX IF NOT EXISTS project_commands_project_idx ON project_commands (project_id);

DROP TRIGGER IF EXISTS project_commands_set_updated_at ON project_commands;
CREATE TRIGGER project_commands_set_updated_at
    BEFORE UPDATE ON project_commands
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- project_inspections — a folder scan awaiting operator confirmation.
--
-- `project_id NULL`   → a scan for a brand-new project, awaiting POST /projects.
-- `project_id NOT NULL` → a rescan of an existing project, awaiting a
--                          diff-preview approval that updates it in place.
--
-- Rows are never rewritten after creation except to mark them consumed; a
-- sweep (mirroring SessionStore.purgeExpired) deletes old rows, which is why
-- `control_app` needs an explicit DELETE grant here in 0004 that default
-- privileges do not provide.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS project_inspections (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by            UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    project_id            UUID        REFERENCES projects (id) ON DELETE CASCADE,
    input_path            TEXT        NOT NULL,
    canonical_path        TEXT        NOT NULL,
    allowed_root          TEXT        NOT NULL,
    -- SHA-256 over the facts a save/apply re-checks for drift (canonical path,
    -- repo identity, last commit hash). Recomputed at consume time; a mismatch
    -- means the folder changed between inspection and confirmation.
    fingerprint           TEXT        NOT NULL,
    result                JSONB       NOT NULL,
    warnings              JSONB       NOT NULL DEFAULT '[]'::jsonb,
    scan_version          TEXT        NOT NULL,
    status                TEXT        NOT NULL DEFAULT 'pending'
                                       CHECK (status IN ('pending', 'consumed', 'expired', 'rejected')),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at            TIMESTAMPTZ NOT NULL,
    consumed_at           TIMESTAMPTZ,

    CONSTRAINT project_inspections_result_is_object CHECK (jsonb_typeof(result) = 'object'),
    CONSTRAINT project_inspections_warnings_is_array CHECK (jsonb_typeof(warnings) = 'array'),
    CONSTRAINT project_inspections_expiry_after_creation CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS project_inspections_created_by_idx ON project_inspections (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS project_inspections_project_idx ON project_inspections (project_id) WHERE project_id IS NOT NULL;
-- Supports the periodic sweep of dead inspections.
CREATE INDEX IF NOT EXISTS project_inspections_expires_at_idx ON project_inspections (expires_at)
    WHERE status = 'pending';

COMMENT ON TABLE project_inspections IS
    'Short-lived, server-held scan result. Never trusted blindly at save time — re-validated against the live filesystem and re-fingerprinted.';
