-- Runtime may propose, run, and settle Repository Actions, but never delete
-- history. The settled-row trigger in 0013 conditionally freezes UPDATE
-- after a row reaches a terminal status.
GRANT SELECT, INSERT, UPDATE ON project_actions TO control_app;
REVOKE DELETE, TRUNCATE ON project_actions FROM control_app;

GRANT SELECT ON project_actions TO backup_reader;
