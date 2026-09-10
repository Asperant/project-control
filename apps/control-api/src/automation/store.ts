import type {
  AutomationManifest, WorkflowDefinition, WorkflowRun, WorkflowRunResult,
  WorkflowRunStep, WorkflowRunStepStatus, WorkflowSeverity,
} from '@project-control/contracts';
import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';
import { findWorkflow } from './manifest.js';

type RunRow = {
  id: string;
  workflow_key: string;
  project_id: string | null;
  status: WorkflowRun['status'];
  trigger_kind: WorkflowRun['triggerKind'];
  triggered_by_user: string | null;
  service_token_id: string | null;
  idempotency_key: string | null;
  external_ref: string | null;
  lease_expires_at: Date | null;
  queued_at: Date;
  started_at: Date | null;
  settled_at: Date | null;
  result_json: WorkflowRunResult | null;
  created_at: Date;
  updated_at: Date;
};

type StepRow = {
  id: string;
  run_id: string;
  position: number;
  name: string;
  status: WorkflowRunStepStatus;
  detail_json: Record<string, unknown>;
  recorded_at: Date;
};

function toRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowKey: row.workflow_key,
    projectId: row.project_id,
    status: row.status,
    triggerKind: row.trigger_kind,
    triggeredByUserId: row.triggered_by_user,
    serviceTokenId: row.service_token_id,
    externalRef: row.external_ref,
    queuedAt: row.queued_at.toISOString(),
    startedAt: row.started_at ? row.started_at.toISOString() : null,
    settledAt: row.settled_at ? row.settled_at.toISOString() : null,
    result: row.result_json,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toStep(row: StepRow): WorkflowRunStep {
  return {
    id: row.id,
    position: row.position,
    name: row.name,
    status: row.status,
    detail: row.detail_json,
    recordedAt: row.recorded_at.toISOString(),
  };
}

/** Server-computed; never supplied by a caller — see migrations/0017. */
function computeIdempotencyKey(workflow: WorkflowDefinition, projectId: string | null): string | null {
  if (workflow.idempotencyWindow === 'none') return null;
  const scope = projectId ?? 'global';
  const iso = new Date().toISOString();
  const bucket = workflow.idempotencyWindow === 'hour' ? iso.slice(0, 13) : iso.slice(0, 10);
  return `${workflow.key}:${scope}:${bucket}`;
}

const RUN_COLUMNS = `id, workflow_key, project_id, status, trigger_kind, triggered_by_user,
  service_token_id, idempotency_key, external_ref, lease_expires_at, queued_at,
  started_at, settled_at, result_json, created_at, updated_at`;

/**
 * Workflow run lifecycle: open (manual → queued, scheduled → running
 * directly) → claim → step → settle, or cancel at any open point.
 *
 * Takes the manifest at construction because `claim` does not know in
 * advance which workflow's queued row it will dequeue — it needs the
 * manifest to look up that workflow's `timeoutSeconds` at the moment of
 * dequeue, to set the lease. Every other method receives an
 * already-resolved `WorkflowDefinition` from its caller (the route, which
 * looked the key up and 404s on an unknown one) rather than re-deriving it,
 * so the manifest lookup path stays in exactly one place.
 */
export class AutomationStore {
  constructor(
    private readonly db: Db,
    private readonly manifest: AutomationManifest,
  ) {}

  private assertScopeMatch(def: WorkflowDefinition, projectId: string | null): void {
    if (def.scope === 'global' && projectId !== null) {
      throw new AppError('bad_request', `Workflow '${def.key}' is global and does not accept a projectId.`);
    }
    if (def.scope === 'project' && projectId === null) {
      throw new AppError('bad_request', `Workflow '${def.key}' requires a projectId.`);
    }
  }

  /**
   * Lazily resolves a lapsed lease. There is no background sweeper — a
   * `running` row past its `lease_expires_at` becomes `expired` the next
   * time anything reads or touches it, here.
   */
  private async sweepIfExpired(row: RunRow): Promise<RunRow> {
    if (row.status !== 'running' || !row.lease_expires_at || row.lease_expires_at.getTime() > Date.now()) {
      return row;
    }
    await this.db.query(
      `UPDATE workflow_runs
          SET status = 'expired', settled_at = now(),
              result_json = jsonb_build_object(
                'summary', 'The run''s lease expired before it settled.',
                'severity', 'warning', 'linkedActionId', null, 'artifactId', null,
                'reason', 'lease_expired')
        WHERE id = $1 AND status = 'running'`,
      [row.id],
    );
    const { rows } = await this.db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = $1`, [row.id]);
    return rows[0] ?? row;
  }

  /** Manual trigger — the panel's "Run now". Always opens `queued`. */
  async requestRun(params: {
    workflowKey: string;
    projectId: string | null;
    triggeredByUserId: string;
  }): Promise<WorkflowRun> {
    const def = findWorkflow(this.manifest, params.workflowKey);
    if (!def) throw notFound(`Unknown workflow: ${params.workflowKey}`);
    this.assertScopeMatch(def, params.projectId);

    const idempotencyKey = computeIdempotencyKey(def, params.projectId);
    try {
      const { rows } = await this.db.query<RunRow>(
        `INSERT INTO workflow_runs (workflow_key, project_id, trigger_kind, triggered_by_user, idempotency_key)
         VALUES ($1, $2, 'manual', $3, $4)
         RETURNING ${RUN_COLUMNS}`,
        [def.key, params.projectId, params.triggeredByUserId, idempotencyKey],
      );
      return toRun(rows[0]!);
    } catch (error) {
      throw this.translateConstraintError(error);
    }
  }

  /** Scheduled trigger — n8n's own cron already fired, so this opens directly into `running`. */
  async openRun(params: {
    workflowKey: string;
    projectId: string | null;
    serviceTokenId: string;
    externalRef: string | null;
  }): Promise<WorkflowRun> {
    const def = findWorkflow(this.manifest, params.workflowKey);
    if (!def) throw notFound(`Unknown workflow: ${params.workflowKey}`);
    this.assertScopeMatch(def, params.projectId);

    const idempotencyKey = computeIdempotencyKey(def, params.projectId);
    const leaseExpiresAt = new Date(Date.now() + def.timeoutSeconds * 1000);

    try {
      const { rows } = await this.db.query<RunRow>(
        `INSERT INTO workflow_runs
           (workflow_key, project_id, status, trigger_kind, service_token_id,
            idempotency_key, external_ref, lease_expires_at, started_at)
         VALUES ($1, $2, 'running', 'scheduled', $3, $4, $5, $6, now())
         RETURNING ${RUN_COLUMNS}`,
        [def.key, params.projectId, params.serviceTokenId, idempotencyKey, params.externalRef, leaseExpiresAt],
      );
      return toRun(rows[0]!);
    } catch (error) {
      throw this.translateConstraintError(error);
    }
  }

  /**
   * Claims the oldest queued run, across every workflow. `FOR UPDATE SKIP
   * LOCKED` inside a transaction is what makes two concurrent claims never
   * pick the same row: the second claim's SELECT skips a row the first has
   * already locked, rather than blocking on it.
   */
  /** Which token claimed a run is recorded only in the audit trail (by the
   * caller), never on the row itself — see the comment inside this method. */
  async claim(): Promise<WorkflowRun | null> {
    return withTransaction(this.db, async (client) => {
      const picked = await client.query<{ id: string; workflow_key: string }>(
        `SELECT id, workflow_key FROM workflow_runs
          WHERE status = 'queued'
          ORDER BY queued_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
      );
      const candidate = picked.rows[0];
      if (!candidate) return null;

      const def = findWorkflow(this.manifest, candidate.workflow_key);
      if (!def) {
        // The manifest no longer knows this key (removed in a redeploy since
        // the run was queued). There is no sane timeout to apply, so the row
        // is expired rather than claimed — never silently dropped.
        await client.query(
          `UPDATE workflow_runs
              SET status = 'expired', settled_at = now(),
                  result_json = jsonb_build_object(
                    'summary', 'Workflow was removed from the manifest before this run could be claimed.',
                    'severity', 'warning', 'linkedActionId', null, 'artifactId', null,
                    'reason', 'workflow_unknown')
            WHERE id = $1`,
          [candidate.id],
        );
        return null;
      }

      // service_token_id is deliberately NOT set here: migrations/0017 treats
      // it as part of a run's trigger *identity* (immutable once the row
      // exists — see guard_workflow_run_mutation), meaning "the token that
      // caused a scheduled run to exist", not "the token currently executing
      // it". A claimed manual run's triggering identity stays
      // triggered_by_user; which token claimed it is recorded only in the
      // audit trail (workflow.run_claimed), the same way project_actions
      // never adds an "executed by" column either.
      const leaseExpiresAt = new Date(Date.now() + def.timeoutSeconds * 1000);
      const updated = await client.query<RunRow>(
        `UPDATE workflow_runs
            SET status = 'running', started_at = now(), lease_expires_at = $2
          WHERE id = $1
          RETURNING ${RUN_COLUMNS}`,
        [candidate.id, leaseExpiresAt],
      );
      return toRun(updated.rows[0]!);
    });
  }

  async get(runId: string): Promise<WorkflowRun | null> {
    const { rows } = await this.db.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM workflow_runs WHERE id = $1`, [runId]);
    const row = rows[0];
    if (!row) return null;
    return toRun(await this.sweepIfExpired(row));
  }

  async listSteps(runId: string): Promise<WorkflowRunStep[]> {
    const { rows } = await this.db.query<StepRow>(
      `SELECT id, run_id, position, name, status, detail_json, recorded_at
         FROM workflow_run_steps WHERE run_id = $1 ORDER BY position`,
      [runId],
    );
    return rows.map(toStep);
  }

  async list(query: {
    page: number;
    pageSize: number;
    workflowKey?: string;
    projectId?: string;
    status?: WorkflowRun['status'];
  }): Promise<{ runs: WorkflowRun[]; total: number }> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    if (query.workflowKey) { values.push(query.workflowKey); conditions.push(`workflow_key = $${values.length}`); }
    if (query.projectId) { values.push(query.projectId); conditions.push(`project_id = $${values.length}`); }
    if (query.status) { values.push(query.status); conditions.push(`status = $${values.length}`); }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await this.db.query<{ count: string }>(
      `SELECT count(*) FROM workflow_runs ${where}`,
      values,
    );
    const total = Number(countResult.rows[0]?.count ?? '0');

    const offset = (query.page - 1) * query.pageSize;
    const { rows } = await this.db.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, query.pageSize, offset],
    );

    const runs = await Promise.all(rows.map((row) => this.sweepIfExpired(row).then(toRun)));
    return { runs, total };
  }

  /** The manifest entry's most recent run, or null if it has never run. */
  async lastRunFor(workflowKey: string): Promise<WorkflowRun | null> {
    const { rows } = await this.db.query<RunRow>(
      `SELECT ${RUN_COLUMNS} FROM workflow_runs
        WHERE workflow_key = $1
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [workflowKey],
    );
    const row = rows[0];
    if (!row) return null;
    return toRun(await this.sweepIfExpired(row));
  }

  async addStep(runId: string, step: {
    position: number;
    name: string;
    status: WorkflowRunStepStatus;
    detail: Record<string, unknown>;
  }): Promise<WorkflowRunStep> {
    const run = await this.get(runId);
    if (!run) throw notFound('No such workflow run.');
    if (run.status !== 'running') {
      throw new AppError('conflict', `Cannot record a step on a run with status '${run.status}'.`);
    }

    try {
      const { rows } = await this.db.query<StepRow>(
        `INSERT INTO workflow_run_steps (run_id, position, name, status, detail_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)
         RETURNING id, run_id, position, name, status, detail_json, recorded_at`,
        [runId, step.position, step.name, step.status, JSON.stringify(step.detail)],
      );
      return toStep(rows[0]!);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new AppError('conflict', `Step position ${step.position} was already recorded for this run.`);
      }
      throw error;
    }
  }

  async settle(runId: string, params: {
    status: 'completed' | 'failed' | 'waiting_for_approval';
    summary: string;
    severity: WorkflowSeverity;
    linkedActionId: string | null;
    artifactId: string | null;
  }): Promise<{ run: WorkflowRun; notify: boolean }> {
    const run = await this.get(runId);
    if (!run) throw notFound('No such workflow run.');
    if (run.status !== 'running') {
      throw new AppError('conflict', `Cannot settle a run with status '${run.status}'.`);
    }

    const def = findWorkflow(this.manifest, run.workflowKey);
    // Fails open: if the workflow was removed from the manifest mid-run, a
    // missed notification is worse than a spurious one.
    const notify = def ? def.notify[params.severity] : true;

    const resultJson: WorkflowRunResult = {
      summary: params.summary,
      severity: params.severity,
      linkedActionId: params.linkedActionId,
      artifactId: params.artifactId,
      reason: null,
    };

    const { rows } = await this.db.query<RunRow>(
      `UPDATE workflow_runs
          SET status = $2, settled_at = now(), result_json = $3::jsonb
        WHERE id = $1 AND status = 'running'
        RETURNING ${RUN_COLUMNS}`,
      [runId, params.status, JSON.stringify(resultJson)],
    );
    const updated = rows[0];
    if (!updated) throw new AppError('conflict', 'Run changed state concurrently.');
    return { run: toRun(updated), notify };
  }

  async cancel(runId: string): Promise<WorkflowRun> {
    const run = await this.get(runId);
    if (!run) throw notFound('No such workflow run.');
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new AppError('conflict', `Cannot cancel a run with status '${run.status}'.`);
    }

    const { rows } = await this.db.query<RunRow>(
      `UPDATE workflow_runs
          SET status = 'cancelled', settled_at = now()
        WHERE id = $1 AND status IN ('queued', 'running')
        RETURNING ${RUN_COLUMNS}`,
      [runId],
    );
    const updated = rows[0];
    if (!updated) throw new AppError('conflict', 'Run changed state concurrently.');
    return toRun(updated);
  }

  private translateConstraintError(error: unknown): unknown {
    if (isUniqueViolation(error)) {
      return new AppError(
        'conflict',
        'Another run for this workflow is already open, or one already ran in the current idempotency window.',
      );
    }
    return error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}
