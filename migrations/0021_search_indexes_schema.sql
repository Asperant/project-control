-- =============================================================================
-- 0021_search_indexes_schema.sql — full-text search over existing content.
--
-- Applied by `control_migrator`. Adds one generated, stored tsvector column
-- per searchable table plus a GIN index on it — the documented Postgres
-- pattern for full-text search (see "Creating an Index" in the tsvector
-- docs). This is deliberately separate from 0019/0020's timeline_events: the
-- timeline is a curated, write-time feed of short summaries; this is
-- read-time full-text search directly over each table's own content. A
-- search result and a timeline entry answer different questions and are
-- computed differently — do not merge them.
--
-- Multi-field columns use setweight() so a title/name match ranks above a
-- body/description match of the same word (ts_rank respects A > B > C > D).
-- agent_run_prompts and agent_reports have no project_id of their own; the
-- search route joins through agent_run_id to scope by project, the same way
-- every other read of those tables already does.
--
-- No new grants are needed: control_app already has SELECT on every table
-- here (0002/0006/0008/0010/0012), and a generated column is populated by
-- control_migrator's own INSERT/UPDATE, not a separate write path.
-- =============================================================================

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(purpose, '') || ' ' || coalesce(product_goal, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS projects_search_idx ON projects USING gin (search_vector);

ALTER TABLE roadmap_milestones
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS roadmap_milestones_search_idx ON roadmap_milestones USING gin (search_vector);

ALTER TABLE roadmap_tasks
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(description, '') || ' ' || coalesce(next_action, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS roadmap_tasks_search_idx ON roadmap_tasks USING gin (search_vector);

ALTER TABLE project_memory_entries
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS project_memory_entries_search_idx ON project_memory_entries USING gin (search_vector);

-- session_note is the only free-text field on a checkpoint (snapshot_json is
-- structured data, not prose) and is optional — coalesce keeps the column
-- valid, and an empty tsvector simply never matches a search.
ALTER TABLE project_checkpoints
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        to_tsvector('english', coalesce(session_note, ''))
    ) STORED;
CREATE INDEX IF NOT EXISTS project_checkpoints_search_idx ON project_checkpoints USING gin (search_vector);

ALTER TABLE agent_runs
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(title, '')), 'A')
    ) STORED;
CREATE INDEX IF NOT EXISTS agent_runs_search_idx ON agent_runs USING gin (search_vector);

ALTER TABLE agent_run_prompts
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS agent_run_prompts_search_idx ON agent_run_prompts USING gin (search_vector);

ALTER TABLE agent_reports
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(body, '')), 'B')
    ) STORED;
CREATE INDEX IF NOT EXISTS agent_reports_search_idx ON agent_reports USING gin (search_vector);

ALTER TABLE work_sessions
    ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(goal, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(outcome_summary, '')), 'B') ||
        setweight(to_tsvector('english', coalesce(blockers, '') || ' ' || coalesce(next_action, '')), 'C')
    ) STORED;
CREATE INDEX IF NOT EXISTS work_sessions_search_idx ON work_sessions USING gin (search_vector);
