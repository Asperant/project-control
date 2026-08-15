-- Runtime may manage open sessions and close them, but never delete history.
-- The closed-row trigger in 0011 conditionally freezes UPDATE after closure.
GRANT SELECT, INSERT, UPDATE ON work_sessions TO control_app;
REVOKE DELETE, TRUNCATE ON work_sessions FROM control_app;

-- Corrections are append-only at the privilege level.
GRANT SELECT, INSERT ON work_session_amendments TO control_app;
REVOKE UPDATE, DELETE, TRUNCATE ON work_session_amendments FROM control_app;

GRANT SELECT ON work_sessions, work_session_amendments TO backup_reader;
