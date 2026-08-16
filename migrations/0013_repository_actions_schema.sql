-- =============================================================================
-- 0013_repository_actions_schema.sql — controlled repository mutations.
--
-- Applied by `control_migrator`. This is the platform's first write path
-- into a registered project's own repository (as opposed to this platform's
-- own PostgreSQL data). Every row here is an append-only record of one
-- proposed-then-optionally-executed action; a row is never physically
-- deleted, and once it reaches a terminal status it is immutable — the same
-- convention 0011's work_sessions established for a different kind of
-- lifecycle record.
--
-- project_actions is deliberately narrow in scope for its first version: the
-- only `kind` accepted today is 'git.commit'. Nothing here executes a
-- command; the Control API composes a plan by reading runner state
-- (project.git.write.status / project.git.development) and, on confirmation,
-- asks the runner's project.git.commit operation to carry it out. See
-- docs/repository-actions.md for the full design and
-- apps/runner/internal/gitwrite for what actually makes that one call safe.
--
-- Lifecycle:
--
--   planned -> running -> succeeded
--                       -> failed
--   planned -> cancelled
--   planned -> expired
--
-- 'running' rows abandoned mid-flight by an API crash are never rewritten to
-- an "unknown" status in the database — that would just be a second kind of
-- lie about what actually happened. Instead the API treats a 'running' row
-- older than a generous staleness threshold as needing reconciliation: a
-- fresh read of live repository state (never a retry of the write) resolves
-- it to 'succeeded' or 'failed', through the same transition the normal path
-- uses. See apps/control-api/src/repository-actions/store.ts.
-- =============================================================================

CREATE TABLE IF NOT EXISTS project_actions (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID        NOT NULL REFERENCES projects (id),
    kind            TEXT        NOT NULL CHECK (kind IN ('git.commit')),
    status          TEXT        NOT NULL DEFAULT 'planned'
                                 CHECK (status IN ('planned', 'running', 'succeeded', 'failed', 'cancelled', 'expired')),
    risk            TEXT        NOT NULL CHECK (risk IN ('low', 'medium', 'high', 'critical')),
    -- Server-generated only: branch, expected HEAD, the caller-selected path
    -- list, any protected paths excluded from that selection, and the commit
    -- message. Never a command, argv, or shell fragment — see
    -- apps/control-api/src/repository-actions/plan.ts.
    plan_json       JSONB       NOT NULL CHECK (jsonb_typeof(plan_json) = 'object'),
    -- SHA-256 over the observed repository state the plan was built from
    -- (HEAD, branch, per-path working-tree status). Recomputed and compared
    -- at execute time; a mismatch means the repository changed since the
    -- plan was shown to the operator, and the action is rejected rather than
    -- silently re-planned.
    fingerprint     TEXT        NOT NULL CHECK (length(fingerprint) = 64),
    expires_at      TIMESTAMPTZ NOT NULL,
    requested_by    UUID        REFERENCES users (id) ON DELETE SET NULL,
    started_at      TIMESTAMPTZ,
    settled_at      TIMESTAMPTZ,
    -- Server-generated only: resulting commit SHA, previous HEAD, verified
    -- post-execution repository state, or a stable failure reason code.
    -- Never a diff, file content, or anything that could carry a secret.
    result_json     JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT project_actions_lifecycle_check CHECK (
        (status = 'planned'   AND started_at IS NULL     AND settled_at IS NULL                            AND result_json IS NULL)
        OR (status = 'running'    AND started_at IS NOT NULL AND settled_at IS NULL                            AND result_json IS NULL)
        OR (status IN ('succeeded', 'failed')
                                   AND started_at IS NOT NULL AND settled_at IS NOT NULL AND settled_at >= started_at AND result_json IS NOT NULL)
        OR (status = 'cancelled'  AND started_at IS NULL     AND settled_at IS NOT NULL                        AND result_json IS NULL)
        OR (status = 'expired'    AND started_at IS NULL     AND settled_at IS NOT NULL                        AND result_json IS NULL)
    )
);

-- At most one action may be pending (planned or running) per project at a
-- time. This is the database-level answer to "two concurrent 'Commit' clicks
-- race": the second INSERT simply fails the unique index rather than the
-- application needing a check-then-insert that could itself race.
CREATE UNIQUE INDEX IF NOT EXISTS project_actions_one_open_per_project_idx
    ON project_actions (project_id) WHERE status IN ('planned', 'running');

CREATE INDEX IF NOT EXISTS project_actions_project_history_idx
    ON project_actions (project_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS project_actions_pending_idx
    ON project_actions (project_id, created_at) WHERE status IN ('planned', 'running');
-- Supports the reconciliation sweep: "running rows older than N".
CREATE INDEX IF NOT EXISTS project_actions_running_started_idx
    ON project_actions (started_at) WHERE status = 'running';

DROP TRIGGER IF EXISTS project_actions_set_updated_at ON project_actions;
CREATE TRIGGER project_actions_set_updated_at BEFORE UPDATE ON project_actions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION guard_project_action_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('succeeded', 'failed', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'a settled Repository Action is immutable' USING ERRCODE = '55000';
    END IF;

    -- Identity and the confirmed plan are immutable from the moment the row
    -- is created, including while it is still 'planned' — a plan the
    -- operator has not yet seen change would defeat the entire point of
    -- showing a preview before asking for confirmation.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.risk IS DISTINCT FROM OLD.risk
       OR NEW.plan_json IS DISTINCT FROM OLD.plan_json
       OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
       OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
       OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Repository Action identity and plan are immutable' USING ERRCODE = '55000';
    END IF;

    IF NOT (
        (OLD.status = 'planned' AND NEW.status IN ('running', 'cancelled', 'expired'))
        OR (OLD.status = 'running' AND NEW.status IN ('succeeded', 'failed'))
    ) THEN
        RAISE EXCEPTION 'invalid Repository Action status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER project_actions_guard_mutation
    BEFORE UPDATE ON project_actions
    FOR EACH ROW EXECUTE FUNCTION guard_project_action_mutation();

COMMENT ON TABLE project_actions IS 'Controlled repository mutations (plan -> confirm -> execute -> verify -> audit). Settled rows are immutable and never physically deleted.';
COMMENT ON COLUMN project_actions.plan_json IS 'Server-generated plan preview; the client cannot supply this content directly.';
COMMENT ON COLUMN project_actions.result_json IS 'Server-generated execution result; never contains a diff, file content, or secret material.';
