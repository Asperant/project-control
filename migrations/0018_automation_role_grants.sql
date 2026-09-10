-- Runtime may open, claim, and settle workflow runs, but never delete
-- history. workflow_run_steps is stricter than workflow_runs itself: no
-- UPDATE grant at all, so a recorded step cannot be rewritten even while its
-- parent run is still open.
GRANT SELECT, INSERT, UPDATE ON workflow_runs TO control_app;
REVOKE DELETE, TRUNCATE ON workflow_runs FROM control_app;

GRANT SELECT, INSERT ON workflow_run_steps TO control_app;
REVOKE UPDATE, DELETE, TRUNCATE ON workflow_run_steps FROM control_app;

GRANT SELECT ON workflow_runs TO backup_reader;
GRANT SELECT ON workflow_run_steps TO backup_reader;
