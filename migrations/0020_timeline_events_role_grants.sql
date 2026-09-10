-- timeline_events is an append-only outbox, same discipline as audit_events
-- (0002): the runtime can add and read rows, never rewrite or remove them.
GRANT SELECT, INSERT ON timeline_events TO control_app;
REVOKE UPDATE, DELETE, TRUNCATE ON timeline_events FROM control_app;

GRANT SELECT ON timeline_events TO backup_reader;
