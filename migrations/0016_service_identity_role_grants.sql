-- Runtime may mint (INSERT), read and revoke (UPDATE) service identity rows,
-- but never delete history. `ALTER DEFAULT PRIVILEGES` in 0002 already grants
-- control_app SELECT/INSERT/UPDATE and backup_reader SELECT on any new table;
-- the REVOKEs below are the explicit, auditable statement of what that
-- default deliberately excludes — the same belt-and-braces pattern 0014 uses
-- for project_actions.
GRANT SELECT, INSERT, UPDATE ON service_accounts TO control_app;
REVOKE DELETE, TRUNCATE ON service_accounts FROM control_app;

GRANT SELECT, INSERT, UPDATE ON service_tokens TO control_app;
REVOKE DELETE, TRUNCATE ON service_tokens FROM control_app;

GRANT SELECT ON service_accounts TO backup_reader;
GRANT SELECT ON service_tokens TO backup_reader;
