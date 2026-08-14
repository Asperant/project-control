-- =============================================================================
-- 0010_agent_runs_role_grants.sql — role grants for the Agent Run archive.
--
-- 0002's `ALTER DEFAULT PRIVILEGES FOR ROLE control_migrator` already handed
-- control_app SELECT/INSERT/UPDATE (and backup_reader SELECT) on these three
-- tables the moment 0009 created them, and that default set never includes
-- DELETE. The REVOKEs below are a belt-and-braces restatement of that fact —
-- not a behaviour change — so the "no physical delete, ever" invariant is
-- readable here rather than only implied by an absence in 0002.
--
-- Unlike project_checkpoints (0008), no column-scoped GRANT is used here:
-- agent_run_prompts and agent_reports need *conditional* immutability
-- ("mutable while draft, frozen once sent/final"), which a GRANT cannot
-- express. That's enforced instead by the BEFORE UPDATE triggers created in
-- 0009 (agent_run_prompts_guard_immutable / agent_reports_guard_immutable),
-- which apply regardless of what column-level privileges control_app holds.
-- =============================================================================

GRANT SELECT, INSERT, UPDATE ON agent_runs         TO control_app;
GRANT SELECT, INSERT, UPDATE ON agent_run_prompts  TO control_app;
GRANT SELECT, INSERT, UPDATE ON agent_reports      TO control_app;

REVOKE DELETE ON agent_runs        FROM control_app;
REVOKE DELETE ON agent_run_prompts FROM control_app;
REVOKE DELETE ON agent_reports     FROM control_app;

GRANT SELECT ON agent_runs         TO backup_reader;
GRANT SELECT ON agent_run_prompts  TO backup_reader;
GRANT SELECT ON agent_reports      TO backup_reader;
