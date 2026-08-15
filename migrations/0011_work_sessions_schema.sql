-- Persistent, project-scoped work periods. Sessions are never deleted; after
-- closure their historical fields are frozen and corrections are append-only.

-- Required by the composite FK below: a linked checkpoint must belong to the
-- same project as its Work Session.
ALTER TABLE project_checkpoints
    ADD CONSTRAINT project_checkpoints_project_id_id_key UNIQUE (project_id, id);

CREATE TABLE work_sessions (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID        NOT NULL REFERENCES projects (id),
    goal              TEXT        NOT NULL CHECK (length(goal) BETWEEN 1 AND 4000),
    status            TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at          TIMESTAMPTZ,
    outcome_summary   TEXT        CHECK (outcome_summary IS NULL OR length(outcome_summary) BETWEEN 1 AND 10000),
    blockers          TEXT        CHECK (blockers IS NULL OR length(blockers) BETWEEN 1 AND 4000),
    next_action       TEXT        CHECK (next_action IS NULL OR length(next_action) BETWEEN 1 AND 4000),
    checkpoint_id     UUID,
    created_by        UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT work_sessions_lifecycle_check CHECK (
        (status = 'open' AND ended_at IS NULL AND outcome_summary IS NULL
            AND blockers IS NULL AND next_action IS NULL AND checkpoint_id IS NULL)
        OR
        (status = 'closed' AND ended_at IS NOT NULL AND ended_at >= started_at
            AND outcome_summary IS NOT NULL)
    ),
    CONSTRAINT work_sessions_checkpoint_same_project_fk
        FOREIGN KEY (project_id, checkpoint_id)
        REFERENCES project_checkpoints (project_id, id)
);

CREATE UNIQUE INDEX work_sessions_one_open_per_project_idx
    ON work_sessions (project_id) WHERE status = 'open';
CREATE INDEX work_sessions_project_history_idx
    ON work_sessions (project_id, started_at DESC, id DESC);
CREATE INDEX work_sessions_checkpoint_idx
    ON work_sessions (checkpoint_id) WHERE checkpoint_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_work_session_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status = 'closed' THEN
        RAISE EXCEPTION 'closed Work Sessions are immutable' USING ERRCODE = '55000';
    END IF;

    -- Identity and start-history are immutable even while the session is open.
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.started_at IS DISTINCT FROM OLD.started_at
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Work Session identity and start history are immutable' USING ERRCODE = '55000';
    END IF;

    -- The only open-session edit is its goal. During the one permitted close
    -- transition the goal also stays fixed; close-only fields are populated.
    IF NEW.status = 'open' AND (
       NEW.ended_at IS DISTINCT FROM OLD.ended_at
       OR NEW.outcome_summary IS DISTINCT FROM OLD.outcome_summary
       OR NEW.blockers IS DISTINCT FROM OLD.blockers
       OR NEW.next_action IS DISTINCT FROM OLD.next_action
       OR NEW.checkpoint_id IS DISTINCT FROM OLD.checkpoint_id) THEN
        RAISE EXCEPTION 'only the goal may be edited while a Work Session is open' USING ERRCODE = '55000';
    END IF;
    IF NEW.status = 'closed' AND NEW.goal IS DISTINCT FROM OLD.goal THEN
        RAISE EXCEPTION 'Work Session goal cannot change during closure' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER work_sessions_guard_mutation
    BEFORE UPDATE ON work_sessions
    FOR EACH ROW EXECUTE FUNCTION guard_work_session_mutation();

CREATE TRIGGER work_sessions_set_updated_at
    BEFORE UPDATE ON work_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE work_session_amendments (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    work_session_id   UUID        NOT NULL REFERENCES work_sessions (id),
    body              TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
    created_by        UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX work_session_amendments_session_idx
    ON work_session_amendments (work_session_id, created_at, id);

CREATE OR REPLACE FUNCTION guard_work_session_amendment_parent_closed() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM work_sessions
        WHERE id = NEW.work_session_id AND status = 'closed'
    ) THEN
        RAISE EXCEPTION 'Work Session amendments require a closed parent session' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER work_session_amendments_require_closed_parent
    BEFORE INSERT ON work_session_amendments
    FOR EACH ROW EXECUTE FUNCTION guard_work_session_amendment_parent_closed();

COMMENT ON TABLE work_sessions IS 'Project work periods; closed rows are immutable and never physically deleted.';
COMMENT ON TABLE work_session_amendments IS 'Append-only corrections to closed Work Sessions.';
