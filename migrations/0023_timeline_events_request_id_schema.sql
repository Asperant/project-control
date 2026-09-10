-- =============================================================================
-- 0023_timeline_events_request_id_schema.sql — correlation parity with
-- audit_events.
--
-- Applied by `control_migrator`. audit_events has carried request_id since
-- 0001 specifically so an operator can correlate a request across the API
-- log and the audit trail; timeline_events never got the same column, so a
-- row there (e.g. workflow_run.settled) could only be correlated indirectly,
-- via the paired audit_events row written for the same request. Most call
-- sites already write both an audit row and a timeline row for the same
-- mutation (see apps/control-api/src/timeline.ts's TimelineLog, deliberately
-- shaped like audit.ts's AuditLog), so this closes a real, if minor, gap
-- rather than adding new plumbing.
--
-- Nullable, like audit_events.request_id: not every timeline entry has one
-- (a lease-expiry sweep settling a stuck run is 'system'-actored with no
-- inbound HTTP request to carry an id from).
-- =============================================================================

ALTER TABLE timeline_events ADD COLUMN IF NOT EXISTS request_id TEXT;
