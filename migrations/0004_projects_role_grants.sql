-- =============================================================================
-- 0004_projects_role_grants.sql — grants for the tables added in 0003.
--
-- The default privileges installed in 0002_role_grants.sql already apply here:
-- every table 0003 created was created by `control_migrator`, so `control_app`
-- already holds SELECT/INSERT/UPDATE and `backup_reader` already holds SELECT
-- on all five of them, with no action required. The grants below are stated
-- explicitly anyway for the same reason 0002 states them for the Stage 1
-- tables — so the privilege model is legible from the migration history
-- without having to reconstruct it from `pg_default_acl` — plus the grants
-- default privileges do NOT provide: DELETE, needed on
--
--   * project_inspections — the periodic sweep of expired rows (mirrors the
--     DELETE grant 0002 gives `sessions` for the same reason);
--   * project_rules — an operator can remove a rule they added;
--   * project_technologies / project_commands — an operator can remove a
--     technology or command they added, and a rescan apply removes a
--     manifest-detected row that is no longer found (user-defined rows are
--     never targeted by that delete; see projects/store.ts).
--
-- `projects` itself deliberately has no DELETE grant anywhere: a project is
-- archived, never physically deleted, so `control_app` structurally cannot
-- remove a row from that table even if application code tried to.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON projects              TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_technologies  TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_rules         TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_commands      TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON project_inspections   TO control_app;

GRANT SELECT ON projects              TO backup_reader;
GRANT SELECT ON project_technologies  TO backup_reader;
GRANT SELECT ON project_rules         TO backup_reader;
GRANT SELECT ON project_commands      TO backup_reader;
GRANT SELECT ON project_inspections   TO backup_reader;
