-- =============================================================================
-- 0017_automation_schema.sql — workflow run lifecycle.
--
-- Applied by `control_migrator`. This is the authoritative record of every
-- automation run, whether triggered by an operator ("Run now" in the panel)
-- or by n8n's own schedule trigger. It exists as its own append-only history
-- rather than trusting n8n's execution log, which this deployment prunes
-- after 14 days (EXECUTIONS_DATA_MAX_AGE in compose.yaml) — see
-- docs/automation.md.
--
-- Workflow *definitions* are not a table here. They live in a repository-
-- owned manifest (infra/n8n/workflows/manifest.json), read-only-mounted into
-- the Control API and validated at boot — the same "code is the source of
-- truth, the database only records what happened" split
-- 0015/service-accounts.ts already uses for machine identity. workflow_key
-- below is therefore validated only by shape (CHECK), never by a foreign key
-- to a table that does not exist; an unknown key is rejected by application
-- code that already loaded and validated the manifest before any row here is
-- touched.
--
-- Lifecycle:
--
--   queued  -> running -> completed
--                       -> failed
--                       -> waiting_for_approval   (terminal — see below)
--                       -> expired                (lease lapsed, never retried)
--                       -> cancelled
--   queued  -> cancelled
--
-- `waiting_for_approval` is a terminal status in this version, not a paused
-- one: the automated part of a run ends the moment it proposes a mutation
-- (a Repository Action plan, `action:plan` scope), and confirming that
-- proposal is a separate, human-only action against `project_actions` — see
-- docs/service-accounts.md and docs/repository-actions.md. There is no
-- "resume this run" path, so a row in this status is exactly as immutable as
-- `completed`/`failed`.
--
-- A `running` row abandoned mid-flight (the API crashed, n8n never called
-- back) is never automatically retried or rewritten. It becomes `expired`
-- lazily, the next time anything reads or touches it and finds
-- `lease_expires_at` in the past — see
-- apps/control-api/src/automation/store.ts. There is no background sweeper.
-- =============================================================================

CREATE TABLE IF NOT EXISTS workflow_runs (
    id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_key       TEXT        NOT NULL CHECK (workflow_key ~ '^[a-z0-9-]{3,48}$'),
    project_id         UUID        REFERENCES projects (id),
    status             TEXT        NOT NULL DEFAULT 'queued'
                                    CHECK (status IN
                                      ('queued', 'running', 'completed', 'failed',
                                       'waiting_for_approval', 'cancelled', 'expired')),
    trigger_kind       TEXT        NOT NULL CHECK (trigger_kind IN ('manual', 'scheduled')),
    -- Exactly one of these two is set: a manual run was requested by an
    -- operator through the panel, a scheduled run was opened by a service
    -- token. Neither identifies the run's *executor* (that is always n8n) —
    -- only who or what caused it to exist.
    triggered_by_user  UUID        REFERENCES users (id) ON DELETE SET NULL,
    service_token_id   UUID        REFERENCES service_tokens (id) ON DELETE SET NULL,
    -- Server-computed from the manifest's idempotencyWindow policy, never
    -- supplied by the caller. NULL means the workflow declares no window.
    idempotency_key    TEXT,
    -- n8n's own execution id, if the caller supplied one. Opaque correlation
    -- only — never used in any authorization decision.
    external_ref       TEXT,
    -- Set only when status becomes 'running'; NULL for a queued row that has
    -- not been claimed yet.
    lease_expires_at   TIMESTAMPTZ,
    queued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at         TIMESTAMPTZ,
    settled_at         TIMESTAMPTZ,
    -- { summary, severity, linkedActionId?, artifactId?, reason? }. Never a
    -- diff, file content, token or secret — the same discipline
    -- project_actions.result_json already holds to.
    result_json        JSONB,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT workflow_runs_trigger_actor_check CHECK (
        (trigger_kind = 'manual'    AND triggered_by_user IS NOT NULL AND service_token_id IS NULL)
        OR (trigger_kind = 'scheduled' AND service_token_id IS NOT NULL AND triggered_by_user IS NULL)
    ),
    CONSTRAINT workflow_runs_lifecycle_check CHECK (
        (status = 'queued'  AND started_at IS NULL     AND settled_at IS NULL     AND result_json IS NULL)
        OR (status = 'running' AND started_at IS NOT NULL AND settled_at IS NULL     AND result_json IS NULL)
        OR (status IN ('completed', 'failed', 'waiting_for_approval', 'expired')
                                AND started_at IS NOT NULL AND settled_at IS NOT NULL
                                AND settled_at >= started_at AND result_json IS NOT NULL)
        OR (status = 'cancelled' AND settled_at IS NOT NULL)
    )
);

-- At most one queued-or-running run per (workflow, project-or-global) — the
-- database-level answer to a double "Run now" click or an overlapping
-- schedule fire, the same pattern project_actions_one_open_per_project_idx
-- (0013) uses.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_one_open_idx
    ON workflow_runs (workflow_key, coalesce(project_id::text, 'global'))
    WHERE status IN ('queued', 'running');

-- Prevents a second run inside the same idempotency window — the database-
-- level answer to a misfiring cron or a retried n8n execution.
--
-- The predicate excludes 'cancelled' and 'expired' rather than naming the
-- terminal-success statuses it protects: a partial index only constrains
-- rows that satisfy its own predicate, and a freshly INSERTed row is always
-- 'queued' or 'running' — never yet 'completed'/'failed'/
-- 'waiting_for_approval' — so a predicate that named only those statuses
-- could never actually fire at INSERT time (the new row itself would never
-- match it) and this constraint would silently protect nothing. Excluding
-- only 'cancelled'/'expired' means every other status, including the
-- brand-new row's own starting 'queued'/'running', participates in the
-- uniqueness check — which is what makes a second open collide immediately
-- against a first that is still in flight *or* has already settled, while
-- still letting a retry through once the first attempt is cancelled or its
-- lease has lapsed, because that row then drops out of the predicate.
CREATE UNIQUE INDEX IF NOT EXISTS workflow_runs_idempotency_idx
    ON workflow_runs (workflow_key, coalesce(project_id::text, 'global'), idempotency_key)
    WHERE idempotency_key IS NOT NULL AND status NOT IN ('cancelled', 'expired');

CREATE INDEX IF NOT EXISTS workflow_runs_history_idx ON workflow_runs (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS workflow_runs_claimable_idx ON workflow_runs (queued_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS workflow_runs_lease_idx ON workflow_runs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS workflow_runs_project_idx ON workflow_runs (project_id, created_at DESC)
    WHERE project_id IS NOT NULL;

DROP TRIGGER IF EXISTS workflow_runs_set_updated_at ON workflow_runs;
CREATE TRIGGER workflow_runs_set_updated_at BEFORE UPDATE ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION guard_workflow_run_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.status IN ('completed', 'failed', 'waiting_for_approval', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'a settled workflow run is immutable' USING ERRCODE = '55000';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.workflow_key IS DISTINCT FROM OLD.workflow_key
       OR NEW.project_id IS DISTINCT FROM OLD.project_id
       OR NEW.trigger_kind IS DISTINCT FROM OLD.trigger_kind
       OR NEW.triggered_by_user IS DISTINCT FROM OLD.triggered_by_user
       OR NEW.service_token_id IS DISTINCT FROM OLD.service_token_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'workflow run identity is immutable' USING ERRCODE = '55000';
    END IF;

    -- Only a genuine status change is checked against the transition graph.
    -- An update that leaves status alone (touching only, say,
    -- lease_expires_at) is not a transition at all and must not be rejected
    -- as an invalid one — NEW.status carries OLD.status forward unchanged
    -- for any column not named in the UPDATE's SET list, so without this
    -- guard a same-status update would be misread as "running -> running"
    -- and rejected.
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
        (OLD.status = 'queued'  AND NEW.status IN ('running', 'cancelled'))
        OR (OLD.status = 'running' AND NEW.status IN ('completed', 'failed', 'waiting_for_approval', 'expired', 'cancelled'))
    ) THEN
        RAISE EXCEPTION 'invalid workflow run status transition: % -> %', OLD.status, NEW.status
            USING ERRCODE = '55000';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER workflow_runs_guard_mutation
    BEFORE UPDATE ON workflow_runs
    FOR EACH ROW EXECUTE FUNCTION guard_workflow_run_mutation();

-- -----------------------------------------------------------------------------
-- workflow_run_steps — append-only. No UPDATE grant is issued at all (0018),
-- stricter than workflow_runs itself: a step, once recorded, never changes.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS workflow_run_steps (
    id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id       UUID        NOT NULL REFERENCES workflow_runs (id),
    position     INT         NOT NULL CHECK (position >= 0),
    name         TEXT        NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    status       TEXT        NOT NULL CHECK (status IN ('passed', 'failed', 'skipped', 'warning')),
    detail_json  JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail_json) = 'object'),
    recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, position)
);

CREATE INDEX IF NOT EXISTS workflow_run_steps_run_idx ON workflow_run_steps (run_id, position);

COMMENT ON TABLE workflow_runs IS 'Authoritative automation run history. workflow_key is validated by the repository-owned manifest at the application layer, not a foreign key. Settled rows are immutable and never physically deleted.';
COMMENT ON TABLE workflow_run_steps IS 'Append-only step log for a workflow run. No UPDATE grant exists for any role.';
COMMENT ON COLUMN workflow_runs.result_json IS 'Server-generated: summary, severity, optional linked Repository Action or artifact id. Never a diff, file content, or secret.';
