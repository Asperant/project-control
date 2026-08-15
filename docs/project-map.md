# Project map

- `migrations/`: checksum-tracked PostgreSQL schema and explicit role grants.
- `packages/contracts/`: shared Zod request/response contracts.
- `apps/control-api/src/routes/`: authenticated Fastify route factories.
- `apps/control-api/src/projects/`: project registration/inspection domain.
- `apps/control-api/src/roadmap/`: manual roadmap transactions and mapping.
- `apps/control-api/src/memory/`: manual project memory (decisions, constraints, ...).
- `apps/control-api/src/checkpoints/`: immutable checkpoint snapshots and the
  raw-data builder shared with `context/`.
- `apps/control-api/src/context/`: deterministic current-context / "Where was
  I?" composition — no AI, reads only.
- `apps/control-api/src/resume/`: purpose-built deterministic Resume briefing;
  roadmap selection policy stays server-side.
- `apps/control-api/src/work-sessions/`: Work Session lifecycle, append-only
  corrections, and atomic checkpoint-on-close transactions.
- `apps/control-api/src/projects/guard.ts`: shared project-guard/archive-lock
  helper reused by roadmap, memory, checkpoints and Work Sessions.
- `apps/web/src/components/projects/`: project registration/detail UI.
- `apps/web/src/components/roadmap/`: manual roadmap UI.
- `apps/web/src/components/memory/`: manual project memory and checkpoint UI.
- `apps/runner/`: confined read-only inspection runner; never a roadmap or
  memory path.
- `scripts/`: install/update/backup/restore/verify operations.

High-risk areas are migrations/role grants, auth/CSRF, append-only audit,
project archive guards, dependency cycles, checkpoint and closed-session
immutability, one-open-session concurrency, checkpoint/session same-project
ownership, update rollback, and runner confinement. Do not casually change
compose exposure, secrets, runner mounts, or application database privileges.
