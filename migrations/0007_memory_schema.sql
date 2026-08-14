-- =============================================================================
-- 0007_memory_schema.sql — manual project memory and immutable checkpoints.
--
-- Applied by `control_migrator`. No AI, embedding, or automatic extraction is
-- involved anywhere in this migration or the code that reads/writes it — every
-- row is authored or triggered by a human action.
--
-- project_memory_entries: durable, manually authored project knowledge (a
-- decision, a constraint, a finding, ...) that outlives any single roadmap
-- task. Rows are archived or superseded, never deleted — see 0008 for the
-- grants that make that a database-level guarantee, not just an app
-- convention.
--
-- project_checkpoints: an immutable, server-generated snapshot of a project's
-- roadmap/memory state at a point in time, plus an optional user-authored
-- session note. Content is fixed at INSERT time; the only column that may ever
-- change afterwards is archived_at (see 0008's column-level GRANT).
-- =============================================================================

CREATE TABLE IF NOT EXISTS project_memory_entries (
    id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id             UUID        NOT NULL REFERENCES projects (id),
    type                   TEXT        NOT NULL CHECK (type IN (
                               'decision', 'constraint', 'context', 'finding', 'handoff', 'lesson'
                           )),
    title                  TEXT        NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    body                   TEXT        NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
    importance             TEXT        NOT NULL DEFAULT 'normal'
                                        CHECK (importance IN ('normal', 'important', 'critical')),
    is_pinned              BOOLEAN     NOT NULL DEFAULT FALSE,
    -- Both optional and independent: a project-level decision or constraint
    -- need not reference any roadmap item.
    related_task_id        UUID        REFERENCES roadmap_tasks (id),
    related_milestone_id   UUID        REFERENCES roadmap_milestones (id),
    -- Set once, by the supersede operation, to the entry that replaces this
    -- one. NULL means active (subject to archived_at) or never superseded.
    superseded_by_id       UUID        REFERENCES project_memory_entries (id),
    archived_at            TIMESTAMPTZ,
    created_by             UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT project_memory_entries_not_self_superseded CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)
);

CREATE INDEX IF NOT EXISTS project_memory_entries_project_idx ON project_memory_entries (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_memory_entries_type_idx ON project_memory_entries (project_id, type);
-- Supports "pinned, active" lookups — the set shown on the memory and
-- context/where-was-i screens.
CREATE INDEX IF NOT EXISTS project_memory_entries_pinned_active_idx ON project_memory_entries (project_id, created_at DESC)
    WHERE is_pinned AND archived_at IS NULL AND superseded_by_id IS NULL;
CREATE INDEX IF NOT EXISTS project_memory_entries_task_idx ON project_memory_entries (related_task_id) WHERE related_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_memory_entries_milestone_idx ON project_memory_entries (related_milestone_id) WHERE related_milestone_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_memory_entries_superseded_idx ON project_memory_entries (superseded_by_id) WHERE superseded_by_id IS NOT NULL;

DROP TRIGGER IF EXISTS project_memory_entries_set_updated_at ON project_memory_entries;
CREATE TRIGGER project_memory_entries_set_updated_at BEFORE UPDATE ON project_memory_entries
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS project_checkpoints (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id        UUID        NOT NULL REFERENCES projects (id),
    -- Format version of snapshot_json. Lets the API read older checkpoints
    -- after the shape changes without a data migration.
    snapshot_version  INTEGER     NOT NULL DEFAULT 1 CHECK (snapshot_version >= 1),
    -- Server-generated only; see src/checkpoints/store.ts. The client supplies
    -- nothing here beyond session_note.
    snapshot_json     JSONB       NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
    session_note      TEXT        CHECK (session_note IS NULL OR length(session_note) <= 4000),
    created_by        UUID        REFERENCES users (id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- The only column an application role may ever update — see 0008.
    archived_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS project_checkpoints_project_idx ON project_checkpoints (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_checkpoints_active_idx ON project_checkpoints (project_id, created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS project_checkpoints_archived_idx ON project_checkpoints (project_id, archived_at) WHERE archived_at IS NOT NULL;

COMMENT ON TABLE project_memory_entries IS 'Manual project memory; rows are archived or superseded, never deleted.';
COMMENT ON TABLE project_checkpoints IS 'Immutable, server-generated checkpoint snapshots. See 0008 for the column-level grant that enforces this.';
COMMENT ON COLUMN project_checkpoints.snapshot_json IS 'Server-generated structured snapshot; the client cannot supply this content.';
