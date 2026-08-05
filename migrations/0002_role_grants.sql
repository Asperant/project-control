-- =============================================================================
-- 0002_role_grants.sql — least-privilege grants inside `project_control`.
--
-- Roles themselves (and the per-database CONNECT privileges that isolate them)
-- are created by infra/postgres/init/10-roles-and-databases.sh, which runs once
-- as the superuser at cluster initialisation. This migration only grants object
-- privileges, because objects do not exist until 0001 has run.
--
-- Privilege model:
--   control_app       runtime.  SELECT/INSERT/UPDATE on data tables.
--                               INSERT-only on audit_events (append-only).
--                               No DDL, no DELETE on audit history.
--   control_migrator  owner of every object. Runs DDL. Not used at runtime.
--   backup_reader     SELECT only, for consistent logical dumps.
--   n8n_app           has no privileges here at all; it cannot even CONNECT to
--                     this database (enforced in the init script).
-- =============================================================================

-- The migrator owns everything it creates, which is what lets it ALTER later.
-- Nothing below grants the runtime role any DDL capability.

-- -----------------------------------------------------------------------------
-- Schema usage
-- -----------------------------------------------------------------------------
GRANT USAGE ON SCHEMA public TO control_app;
GRANT USAGE ON SCHEMA public TO backup_reader;

-- Explicitly *not* granted: CREATE on schema public for control_app.
-- The init script already revoked CREATE from PUBLIC; this is the positive
-- statement of the same intent.
REVOKE CREATE ON SCHEMA public FROM control_app;

-- -----------------------------------------------------------------------------
-- control_app — runtime data access
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE ON users            TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO control_app;
GRANT SELECT, INSERT, UPDATE ON system_settings  TO control_app;
GRANT SELECT, INSERT, UPDATE ON artifact_objects TO control_app;

-- Append-only: rows can be added and read, never modified or removed.
GRANT SELECT, INSERT ON audit_events TO control_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM control_app;

-- Read-only view of the migration ledger, for /api/system/status.
GRANT SELECT ON schema_migrations TO control_app;

-- Identity column sequence for audit_events.
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO control_app;

-- -----------------------------------------------------------------------------
-- backup_reader — logical dump only
-- -----------------------------------------------------------------------------
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_reader;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO backup_reader;

-- -----------------------------------------------------------------------------
-- Default privileges for objects created by future migrations
--
-- Without these, every new table would silently be inaccessible to the runtime
-- role until someone remembered to add a GRANT.
-- -----------------------------------------------------------------------------
ALTER DEFAULT PRIVILEGES FOR ROLE control_migrator IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE ON TABLES TO control_app;
ALTER DEFAULT PRIVILEGES FOR ROLE control_migrator IN SCHEMA public
    GRANT USAGE ON SEQUENCES TO control_app;
ALTER DEFAULT PRIVILEGES FOR ROLE control_migrator IN SCHEMA public
    GRANT SELECT ON TABLES TO backup_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE control_migrator IN SCHEMA public
    GRANT SELECT ON SEQUENCES TO backup_reader;

-- -----------------------------------------------------------------------------
-- Baseline settings
-- -----------------------------------------------------------------------------
INSERT INTO system_settings (key, value, description) VALUES
    ('stage', '"1"'::jsonb, 'Deployed platform stage.'),
    ('bootstrap.admin_created', 'false'::jsonb,
     'Set to true by the create-admin CLI. No default account is ever created.')
ON CONFLICT (key) DO NOTHING;
