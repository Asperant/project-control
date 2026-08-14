# Manual roadmap

Each registered project has a manual roadmap in its detail screen. The feature
does not call AI, run commands, mutate Git, or write into the registered project
folder. Data is stored only in the `project_control` PostgreSQL database.

## Using the roadmap

Open **Projects → project detail → Roadmap**. Add a milestone, then add tasks
inside it. Milestones and tasks support `planned`, `in_progress`, `blocked`,
`done`, and `cancelled`; priorities are `low`, `medium`, `high`, and `critical`.
A blocked item requires a block reason.

Task detail contains:

- an ordered acceptance checklist;
- dependencies on tasks in the same project;
- a separate, manually written next action;
- chronological notes;
- readable activity history from the existing audit trail.

Milestones and tasks are never physically deleted. Cancel an obsolete item,
or archive/reactivate a milestone. Notes use soft deletion; acceptance criteria
and dependency links can be removed.

## Confirmations

Completing a task with unfinished acceptance criteria is allowed only after an
explicit confirmation. Starting a task with unresolved dependencies follows the
same pattern. The server recalculates the real count; it never trusts a count
from the browser. Overrides are written to the audit trail.

A cancelled dependency remains unresolved. Circular, duplicate, self, and
cross-project dependencies are rejected.

## Progress

Progress is derived, never entered manually:

```text
done non-cancelled tasks / all non-cancelled tasks
```

Cancelled tasks are excluded. An empty milestone or project is `0 / 0` and
`0%`. Completing every task does not automatically change milestone status.

## Archive behavior

An archived project remains readable, including its roadmap, but every roadmap
mutation is rejected. Reactivating the project restores editing without changing
roadmap data. Archived or cancelled milestones make their child tasks read-only
until the milestone is reactivated or reopened.

## API overview

Authenticated reads and admin/operator writes are project-scoped below:

```text
GET/POST/PATCH /api/projects/:projectId/roadmap/...
```

The API covers roadmap summary/activity, milestone lifecycle/reorder, task
detail/lifecycle/reorder, acceptance criteria, dependencies, and notes. Browser
writes use the existing session, Origin, CSRF, and role checks.

## Deployment and backup

Migrations `0005` and `0006` add the schema and explicit role grants. They are
additive and preserve existing projects. `control_app` receives DML only and no
DELETE privilege on milestone/task rows; `backup_reader` receives SELECT.

The existing full `project_control` dump automatically includes roadmap data,
and Restic already includes installed migration files. After an update run:

```bash
./pcctl verify
./pcctl verify-security
sudo ./pcctl backup
sudo ./pcctl restore-test
```

See [update-rollback.md](update-rollback.md) before a migration-bearing update.

## Troubleshooting

- **Changes are disabled:** reactivate the project or milestone; cancelled
  milestones must be reopened to `planned`.
- **Confirmation appears:** review the shown incomplete count, then explicitly
  continue or cancel.
- **Dependency rejected:** remove the duplicate/cycle or select a task in the
  same project.
- **Roadmap endpoint returns 401/403:** sign in; viewers can read but only admins
  and operators can mutate.
- **Migration/constraint verify fails:** inspect Control API migration logs and
  do not reset the database. Use the documented backup/restore flow.
