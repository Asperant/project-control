-- =============================================================================
-- 0022_audit_events_detail_indexes_schema.sql — expression indexes for the
-- audit_events "recent activity" reads that filter on detail->>'x'.
--
-- Applied by `control_migrator`. Four read paths filter audit_events on a
-- JSONB key with LIMIT 100 and no supporting index, forcing a sequential
-- scan over the whole audit history on every call:
--   - listProjectActivity              (apps/control-api/src/projects/store.ts)  — detail->>'projectId'
--   - loadRoadmapActivity              (apps/control-api/src/roadmap/store.ts)   — detail->>'projectId'
--   - loadTaskDetail's activity query  (apps/control-api/src/roadmap/store.ts)   — detail->>'taskId'
--   - loadAgentRunTimeline             (apps/control-api/src/agent-runs/store.ts) — detail->>'agentRunId'
--
-- This migration is scan-cost only. The LIMIT 100 / no-further-pagination
-- behaviour of those four read paths is a deliberate "recent activity
-- glance" design, not an oversight left for later — the real paginated
-- history is timeline_events (0019/0020). Do not read this migration as an
-- invitation to add pagination to those four endpoints; that stays out of
-- scope here.
--
-- Each index is partial (`WHERE detail ? 'x'`) so it only carries rows that
-- actually set that key — audit_events holds every event type (auth,
-- service-token, system events included), and most of them never set
-- projectId/taskId/agentRunId at all, so an unfiltered index would carry a
-- lot of dead weight none of these four queries would ever match through.
-- occurred_at DESC rides along as a second column on each index: every one
-- of the four queries above pairs its detail-key equality filter with
-- `ORDER BY occurred_at DESC LIMIT 100`, so the index can satisfy both the
-- filter and the ordering directly instead of filtering then sorting.
--
-- No new grants are needed: control_app already has SELECT on audit_events
-- (0002), and indexes are read-time structures with no privilege of their
-- own to grant.
-- =============================================================================

CREATE INDEX IF NOT EXISTS audit_events_detail_project_id_idx
    ON audit_events ((detail->>'projectId'), occurred_at DESC)
    WHERE detail ? 'projectId';

CREATE INDEX IF NOT EXISTS audit_events_detail_task_id_idx
    ON audit_events ((detail->>'taskId'), occurred_at DESC)
    WHERE detail ? 'taskId';

CREATE INDEX IF NOT EXISTS audit_events_detail_agent_run_id_idx
    ON audit_events ((detail->>'agentRunId'), occurred_at DESC)
    WHERE detail ? 'agentRunId';
