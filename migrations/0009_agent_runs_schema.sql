-- =============================================================================
-- 0009_agent_runs_schema.sql — manual Agent Run provenance archive.
--
-- Applied by `control_migrator`. This is a pure archive: nothing here calls an
-- LLM, executes an agent, or automates prompt/report handling. A user pastes a
-- prompt in manually, sends it to Claude/Codex/whatever by hand, and pastes the
-- report back in manually. See docs/agent-runs.md.
--
-- Three tables, following the roadmap/memory precedent of "never physically
-- delete, archive or supersede instead":
--
--   agent_runs         the aggregate root. Freely mutable (title, agent name,
--                       related roadmap links, lifecycle status, validation)
--                       until archived — nothing here needs a trigger, the
--                       existing "no DELETE grant" convention is enough.
--
--   agent_run_prompts  one row per run. Editable while draft; once marked sent
--                       it must never change again, including by a bug in the
--                       Control API itself. Unlike project_checkpoints (0007),
--                       "editable, then frozen" is a *state-dependent* rule, so
--                       a column-scoped GRANT (0007/0008's approach) cannot
--                       express it — a BEFORE UPDATE trigger is used instead.
--                       This is the first conditional-immutability trigger in
--                       this schema; see agent_run_prompts_guard_immutable().
--
--   agent_reports       versioned Markdown/text report bodies. Draft is
--                       editable; final is frozen except for the one legal
--                       transition (final -> superseded) that the atomic
--                       "finalize a revision" operation performs; superseded is
--                       frozen forever. Same trigger approach, one more legal
--                       transition to allow for.
--
-- project_memory_entries.source_agent_run_id links a manually promoted memory
-- entry back to the run it came from (nullable; general memory creation can
-- never set it — see apps/control-api/src/memory/store.ts).
-- =============================================================================

CREATE TABLE IF NOT EXISTS agent_runs (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id             UUID        NOT NULL REFERENCES projects (id),
    title                  TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    agent_name             TEXT        NOT NULL CHECK (length(agent_name) BETWEEN 1 AND 80),
    status                 TEXT        NOT NULL DEFAULT 'draft'
                                        CHECK (status IN ('draft','sent','in_progress','completed','failed','cancelled')),
    related_milestone_id   UUID        REFERENCES roadmap_milestones (id),
    related_task_id        UUID        REFERENCES roadmap_tasks (id),
    validation_status      TEXT        NOT NULL DEFAULT 'not_reviewed'
                                        CHECK (validation_status IN ('not_reviewed','under_review','accepted','accepted_with_changes','rejected')),
    validation_note        TEXT        CHECK (validation_note IS NULL OR length(validation_note) <= 10000),
    validated_by           UUID        REFERENCES users (id) ON DELETE SET NULL,
    validated_at           TIMESTAMPTZ,
    sent_at                TIMESTAMPTZ,
    started_at             TIMESTAMPTZ,
    completed_at           TIMESTAMPTZ,
    failed_at              TIMESTAMPTZ,
    cancelled_at           TIMESTAMPTZ,
    created_by             UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at            TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS agent_runs_project_idx ON agent_runs (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_status_idx ON agent_runs (project_id, status);
CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs (project_id, agent_name);
CREATE INDEX IF NOT EXISTS agent_runs_validation_idx ON agent_runs (project_id, validation_status);
CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs (related_task_id) WHERE related_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_runs_milestone_idx ON agent_runs (related_milestone_id) WHERE related_milestone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_runs_archived_idx ON agent_runs (project_id, archived_at) WHERE archived_at IS NOT NULL;
-- Supports the "recent, non-draft, non-archived" reads shared by the
-- checkpoint snapshot builder and the live "Where was I?" context.
CREATE INDEX IF NOT EXISTS agent_runs_recent_active_idx ON agent_runs (project_id, status)
    WHERE archived_at IS NULL AND status <> 'draft';

DROP TRIGGER IF EXISTS agent_runs_set_updated_at ON agent_runs;
CREATE TRIGGER agent_runs_set_updated_at BEFORE UPDATE ON agent_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- agent_run_prompts
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_run_prompts (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id    UUID        NOT NULL REFERENCES agent_runs (id),
    prompt_version  INTEGER     NOT NULL DEFAULT 1 CHECK (prompt_version >= 1),
    body            TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
    status          TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent')),
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- No prompt-revision system: at most one prompt row per run.
    CONSTRAINT agent_run_prompts_one_per_run UNIQUE (agent_run_id)
);

CREATE INDEX IF NOT EXISTS agent_run_prompts_run_idx ON agent_run_prompts (agent_run_id);

DROP TRIGGER IF EXISTS agent_run_prompts_set_updated_at ON agent_run_prompts;
CREATE TRIGGER agent_run_prompts_set_updated_at BEFORE UPDATE ON agent_run_prompts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION agent_run_prompts_guard_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'sent' THEN
        RAISE EXCEPTION 'agent_run_prompts: prompt % is sent and immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_run_prompts_guard_immutable ON agent_run_prompts;
CREATE TRIGGER agent_run_prompts_guard_immutable BEFORE UPDATE ON agent_run_prompts
    FOR EACH ROW EXECUTE FUNCTION agent_run_prompts_guard_immutable();

-- -----------------------------------------------------------------------------
-- agent_reports
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agent_reports (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_run_id           UUID        NOT NULL REFERENCES agent_runs (id),
    version                INTEGER     NOT NULL CHECK (version >= 1),
    body                   TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 100000),
    status                 TEXT        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final','superseded')),
    supersedes_report_id   UUID        REFERENCES agent_reports (id),
    superseded_by_id       UUID        REFERENCES agent_reports (id),
    finalized_at           TIMESTAMPTZ,
    created_by             UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT agent_reports_run_version_key UNIQUE (agent_run_id, version),
    CONSTRAINT agent_reports_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
    CONSTRAINT agent_reports_not_self_supersedes CHECK (supersedes_report_id IS NULL OR supersedes_report_id <> id)
);

CREATE INDEX IF NOT EXISTS agent_reports_run_idx ON agent_reports (agent_run_id, version);
CREATE INDEX IF NOT EXISTS agent_reports_supersedes_idx ON agent_reports (supersedes_report_id) WHERE supersedes_report_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_reports_superseded_by_idx ON agent_reports (superseded_by_id) WHERE superseded_by_id IS NOT NULL;
-- At most one draft per run — a concurrent second "start revision" 409s on
-- this constraint rather than racing.
CREATE UNIQUE INDEX IF NOT EXISTS agent_reports_one_draft_per_run ON agent_reports (agent_run_id) WHERE status = 'draft';

DROP TRIGGER IF EXISTS agent_reports_set_updated_at ON agent_reports;
CREATE TRIGGER agent_reports_set_updated_at BEFORE UPDATE ON agent_reports
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION agent_reports_guard_immutable() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'superseded' THEN
        RAISE EXCEPTION 'agent_reports: report % is superseded and immutable', OLD.id
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;

    IF OLD.status = 'final' THEN
        -- The only legal change to a final report is the atomic supersede
        -- transition performed when a revision is finalized: status flips to
        -- 'superseded' and superseded_by_id is set, nothing else moves.
        IF NEW.status IS DISTINCT FROM 'superseded'
            OR NEW.body IS DISTINCT FROM OLD.body
            OR NEW.version IS DISTINCT FROM OLD.version
            OR NEW.agent_run_id IS DISTINCT FROM OLD.agent_run_id
            OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
            OR NEW.created_at IS DISTINCT FROM OLD.created_at
            OR NEW.supersedes_report_id IS DISTINCT FROM OLD.supersedes_report_id
        THEN
            RAISE EXCEPTION 'agent_reports: final report % is immutable except for the supersede transition', OLD.id
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS agent_reports_guard_immutable ON agent_reports;
CREATE TRIGGER agent_reports_guard_immutable BEFORE UPDATE ON agent_reports
    FOR EACH ROW EXECUTE FUNCTION agent_reports_guard_immutable();

-- -----------------------------------------------------------------------------
-- Memory provenance
-- -----------------------------------------------------------------------------

ALTER TABLE project_memory_entries ADD COLUMN IF NOT EXISTS source_agent_run_id UUID REFERENCES agent_runs (id);
CREATE INDEX IF NOT EXISTS project_memory_entries_source_run_idx ON project_memory_entries (source_agent_run_id) WHERE source_agent_run_id IS NOT NULL;

COMMENT ON TABLE agent_runs IS 'Manual Agent Run provenance archive: title/agent/lifecycle/validation. Never physically deleted.';
COMMENT ON TABLE agent_run_prompts IS 'Exactly what was sent to the agent. Frozen at the DB level once status=sent — see agent_run_prompts_guard_immutable().';
COMMENT ON TABLE agent_reports IS 'What the agent reported back, versioned. Frozen at the DB level once final/superseded — see agent_reports_guard_immutable().';
COMMENT ON COLUMN project_memory_entries.source_agent_run_id IS 'Set only by the promote-to-memory code path; the general memory create endpoint cannot set this.';
