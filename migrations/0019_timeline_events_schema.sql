-- =============================================================================
-- 0019_timeline_events_schema.sql — a curated, append-only activity feed.
--
-- Applied by `control_migrator`. Populated by application code at each
-- existing mutation call site (apps/control-api/src/timeline.ts), the same
-- way audit_events already is (apps/control-api/src/audit.ts) — not by a
-- database trigger. That choice was made deliberately rather than by
-- default: this schema's only other write-time, cross-cutting event log
-- (audit_events, 0001) is application-code populated too, with the
-- append-only guarantee coming from privilege (0020's REVOKE), not from
-- trigger enforcement. A trigger-based design would have been a genuinely
-- new pattern for this schema; this one is not.
--
-- What belongs here is a short, human-readable, already-redacted summary of
-- something that happened — "Memory created: 'Deployment restriction'" —
-- never the entity's own body/prompt/report/snapshot content. A timeline
-- reader must never become a second way to read data a feature's own
-- endpoint would gate. See apps/control-api/src/timeline.ts's own module
-- comment for the redaction discipline this relies on.
--
-- project_id is nullable: some events (a global, non-project-scoped
-- automation run) have none, matching workflow_runs.project_id itself
-- (0017) being nullable for the same reason.
-- =============================================================================

CREATE TABLE IF NOT EXISTS timeline_events (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    UUID        REFERENCES projects (id) ON DELETE CASCADE,
    -- Short, closed-ish vocabulary naming the entity kind — "memory",
    -- "agent_run", "checkpoint", "work_session", "workflow_run", "action",
    -- "roadmap_task", "roadmap_milestone", "project". Not a foreign key:
    -- the entity itself may later be deleted (memory/checkpoints are
    -- soft-archived, not hard-deleted, but this stays robust either way),
    -- and the timeline is a record of what happened, not a live join.
    entity_type   TEXT        NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 40),
    entity_id     UUID,
    -- Dotted machine key, deliberately the same shape as audit_events'
    -- event_type (e.g. "memory.created", "agent_run.completed") so the two
    -- logs read consistently side by side.
    event_type    TEXT        NOT NULL CHECK (length(event_type) BETWEEN 1 AND 120),
    summary       TEXT        NOT NULL CHECK (length(summary) BETWEEN 1 AND 300),
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_user_id UUID        REFERENCES users (id) ON DELETE SET NULL,
    -- 'system' covers events with no human or service actor at all (a
    -- lease-expiry sweep settling a stuck run, for example).
    actor_kind    TEXT        NOT NULL CHECK (actor_kind IN ('user', 'service', 'system'))
);

-- Per-project timeline: keyset-paginable on (occurred_at, id) within a project.
CREATE INDEX IF NOT EXISTS timeline_events_project_idx
    ON timeline_events (project_id, occurred_at DESC, id DESC);

-- Global cross-project activity feed: the same keyset shape, unfiltered.
CREATE INDEX IF NOT EXISTS timeline_events_occurred_idx
    ON timeline_events (occurred_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS timeline_events_entity_idx
    ON timeline_events (entity_type, entity_id);
