-- Memory entries follow the same DML-only pattern as the roadmap tables: the
-- runtime role can add and update rows but never physically delete one.
GRANT SELECT, INSERT, UPDATE ON project_memory_entries TO control_app;
GRANT SELECT ON project_memory_entries TO backup_reader;

-- Checkpoints are immutable by design. control_app may INSERT a new row and
-- read existing ones, and may UPDATE only the archived_at column — never the
-- snapshot content, the session note, or the row's identity. This is enforced
-- here, at the privilege level, not merely by application convention: even a
-- bug in the Control API cannot issue a statement that rewrites a checkpoint.
--
-- 0002's `ALTER DEFAULT PRIVILEGES FOR ROLE control_migrator` already handed
-- control_app a blanket table-level UPDATE the moment 0007 created this
-- table — the same mechanism 0006 already works around for task_dependencies.
-- That table-wide grant is revoked here before the narrower, column-scoped
-- one is issued, so only archived_at ends up updatable.
GRANT SELECT, INSERT ON project_checkpoints TO control_app;
REVOKE UPDATE ON project_checkpoints FROM control_app;
GRANT UPDATE (archived_at) ON project_checkpoints TO control_app;
GRANT SELECT ON project_checkpoints TO backup_reader;
