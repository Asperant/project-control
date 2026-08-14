# Project map

- `migrations/`: checksum-tracked PostgreSQL schema and explicit role grants.
- `packages/contracts/`: shared Zod request/response contracts.
- `apps/control-api/src/routes/`: authenticated Fastify route factories.
- `apps/control-api/src/projects/`: project registration/inspection domain.
- `apps/control-api/src/roadmap/`: manual roadmap transactions and mapping.
- `apps/web/src/components/projects/`: project registration/detail UI.
- `apps/web/src/components/roadmap/`: manual roadmap UI.
- `apps/runner/`: confined read-only inspection runner; never a roadmap path.
- `scripts/`: install/update/backup/restore/verify operations.

High-risk areas are migrations/role grants, auth/CSRF, append-only audit,
project archive guards, dependency cycles, update rollback, and runner
confinement. Do not casually change compose exposure, secrets, runner mounts,
or application database privileges.
