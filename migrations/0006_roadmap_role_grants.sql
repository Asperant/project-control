-- Runtime writes remain DML-only. Milestones and tasks deliberately have no DELETE grant.
GRANT SELECT, INSERT, UPDATE ON roadmap_milestones TO control_app;
GRANT SELECT, INSERT, UPDATE ON roadmap_tasks TO control_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON task_acceptance_criteria TO control_app;
GRANT SELECT, INSERT, DELETE ON task_dependencies TO control_app;
REVOKE UPDATE ON task_dependencies FROM control_app;
GRANT SELECT, INSERT, UPDATE ON task_notes TO control_app;

GRANT SELECT ON roadmap_milestones, roadmap_tasks, task_acceptance_criteria, task_dependencies, task_notes TO backup_reader;
