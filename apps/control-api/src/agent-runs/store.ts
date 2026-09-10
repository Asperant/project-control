import { randomUUID } from 'node:crypto';
import type {
  AgentRun, AgentRunListQuery, AgentRunListResponse, AgentRunStatus, AgentRunTimelineEntry, AgentRunPrompt,
  AgentReport, AgentValidationStatus, CreateAgentRunRequest, CreateMemoryEntryRequest, MemoryEntry,
  UpdateAgentRunRequest, UpdateAgentRunValidationRequest,
} from '@project-control/contracts';
import type { AuditEventType } from '../audit.js';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';
import { getMemoryEntry, insertEntry } from '../memory/store.js';
import { getProjectGuard, assertProjectMutable as assertProjectMutableBase, type Executor } from '../projects/guard.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';

const SUBJECT = 'Agent Run';
function assertProjectMutable(project: { id: string; status: string }): void {
  assertProjectMutableBase(project, SUBJECT);
}

/** Archived runs are read-only, independent of the project's own archived state. */
function assertRunMutable(run: { archived_at: Date | null }): void {
  if (run.archived_at) throw new AppError('conflict', 'This Agent Run is archived. Changes are disabled.');
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

type AgentRunRow = {
  id: string; project_id: string; title: string; agent_name: string; status: AgentRunStatus;
  related_milestone_id: string | null; related_milestone_title: string | null;
  related_task_id: string | null; related_task_title: string | null;
  validation_status: AgentValidationStatus; validation_note: string | null;
  validated_by: string | null; validated_at: Date | null;
  sent_at: Date | null; started_at: Date | null; completed_at: Date | null;
  failed_at: Date | null; cancelled_at: Date | null;
  created_by: string | null; created_at: Date; updated_at: Date; archived_at: Date | null;
  has_prompt: boolean; current_report_version: number | null;
};

const SELECT_RUN = `
  SELECT ar.*, rt.title related_task_title, rm.title related_milestone_title,
    EXISTS(SELECT 1 FROM agent_run_prompts p WHERE p.agent_run_id = ar.id) has_prompt,
    (SELECT r.version FROM agent_reports r WHERE r.agent_run_id = ar.id AND r.status = 'final') current_report_version
  FROM agent_runs ar
  LEFT JOIN roadmap_tasks rt ON rt.id = ar.related_task_id
  LEFT JOIN roadmap_milestones rm ON rm.id = ar.related_milestone_id
`;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id, projectId: row.project_id, title: row.title, agentName: row.agent_name, status: row.status,
    relatedMilestoneId: row.related_milestone_id, relatedMilestoneTitle: row.related_milestone_title,
    relatedTaskId: row.related_task_id, relatedTaskTitle: row.related_task_title,
    validationStatus: row.validation_status, validationNote: row.validation_note,
    validatedBy: row.validated_by, validatedAt: iso(row.validated_at),
    sentAt: iso(row.sent_at), startedAt: iso(row.started_at), completedAt: iso(row.completed_at),
    failedAt: iso(row.failed_at), cancelledAt: iso(row.cancelled_at),
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    archivedAt: iso(row.archived_at), hasPrompt: row.has_prompt, currentReportVersion: row.current_report_version,
  };
}

async function loadRun(db: Executor, projectId: string, runId: string, lock = false): Promise<AgentRunRow> {
  const { rows } = await db.query<AgentRunRow>(
    `${SELECT_RUN} WHERE ar.id=$1 AND ar.project_id=$2${lock ? ' FOR UPDATE OF ar' : ''}`,
    [runId, projectId],
  );
  if (!rows[0]) throw notFound('Agent Run not found.');
  return rows[0];
}

/** Returns the task's milestone_id; 404s on cross-project or missing (mirrors memory/store.ts). */
async function assertTaskInProject(db: Executor, projectId: string, taskId: string): Promise<string> {
  const { rows } = await db.query<{ milestone_id: string }>(
    `SELECT t.milestone_id FROM roadmap_tasks t JOIN roadmap_milestones m ON m.id=t.milestone_id WHERE t.id=$1 AND m.project_id=$2`,
    [taskId, projectId],
  );
  if (!rows[0]) throw notFound('Related task not found in this project.');
  return rows[0].milestone_id;
}

async function assertMilestoneInProject(db: Executor, projectId: string, milestoneId: string): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM roadmap_milestones WHERE id=$1 AND project_id=$2', [milestoneId, projectId]);
  if (!rows[0]) throw notFound('Related milestone not found in this project.');
}

/** A related task and a related milestone supplied together must agree — the task's own milestone wins. */
async function assertConsistentRelations(
  db: Executor, projectId: string, taskId: string | null | undefined, milestoneId: string | null | undefined,
): Promise<void> {
  if (!taskId || !milestoneId) return;
  const taskMilestoneId = await assertTaskInProject(db, projectId, taskId);
  if (taskMilestoneId !== milestoneId) {
    throw new AppError('validation_failed', 'relatedMilestoneId does not match the related task\'s milestone.', {
      fields: [{ path: 'relatedMilestoneId', message: 'Does not match relatedTaskId\'s milestone.' }],
    });
  }
}

// ---------------------------------------------------------------------------
// Agent Run CRUD / lifecycle
// ---------------------------------------------------------------------------

export async function listAgentRuns(db: Executor, projectId: string, query: AgentRunListQuery): Promise<AgentRunListResponse> {
  await getProjectGuard(db, projectId);
  const conditions = ['ar.project_id = $1'];
  const params: unknown[] = [projectId];

  conditions.push(query.archived === 'true' ? 'ar.archived_at IS NOT NULL' : 'ar.archived_at IS NULL');
  if (query.status) {
    params.push(query.status);
    conditions.push(`ar.status = $${params.length}`);
  }
  if (query.agentName) {
    params.push(query.agentName);
    conditions.push(`lower(ar.agent_name) = lower($${params.length})`);
  }
  if (query.validationStatus) {
    params.push(query.validationStatus);
    conditions.push(`ar.validation_status = $${params.length}`);
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    const p = `$${params.length}`;
    conditions.push(`(
      ar.title ILIKE ${p} OR ar.validation_note ILIKE ${p}
      OR EXISTS (SELECT 1 FROM agent_run_prompts pr WHERE pr.agent_run_id = ar.id AND pr.body ILIKE ${p})
      OR EXISTS (SELECT 1 FROM agent_reports rp WHERE rp.agent_run_id = ar.id AND rp.body ILIKE ${p})
    )`);
  }
  // Keyset cursor, appended after every filter above (including the search
  // EXISTS subqueries) — it is just one more WHERE predicate, so it composes
  // with any combination of filters without special-casing.
  if (query.beforeCreatedAt !== undefined) {
    params.push(query.beforeCreatedAt, query.beforeId);
    conditions.push(`(ar.created_at, ar.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(query.pageSize);
  const { rows } = await db.query<AgentRunRow>(
    `${SELECT_RUN} WHERE ${conditions.join(' AND ')} ORDER BY ar.created_at DESC, ar.id DESC LIMIT $${params.length}`,
    params,
  );
  const agentRuns = rows.map(mapRun);
  const last = rows.at(-1);
  return {
    agentRuns,
    pageSize: query.pageSize,
    nextCursor: rows.length === query.pageSize && last ? { createdAt: last.created_at.toISOString(), id: last.id } : null,
  };
}

export async function getAgentRun(db: Executor, projectId: string, runId: string): Promise<AgentRun> {
  return mapRun(await loadRun(db, projectId, runId));
}

export async function createAgentRun(
  db: Db, projectId: string, actorId: string, input: CreateAgentRunRequest, audit: MutationAudit, timeline: MutationTimeline,
): Promise<AgentRun> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    await assertConsistentRelations(client, projectId, input.relatedTaskId, input.relatedMilestoneId);
    if (input.relatedTaskId) await assertTaskInProject(client, projectId, input.relatedTaskId);
    if (input.relatedMilestoneId) await assertMilestoneInProject(client, projectId, input.relatedMilestoneId);

    const id = randomUUID();
    await client.query(
      `INSERT INTO agent_runs (id, project_id, title, agent_name, related_milestone_id, related_task_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, projectId, input.title, input.agentName, input.relatedMilestoneId ?? null, input.relatedTaskId ?? null, actorId],
    );
    await audit(client, 'agentrun.created', { projectId, agentRunId: id, agentName: input.agentName, relatedTaskId: input.relatedTaskId ?? null, relatedMilestoneId: input.relatedMilestoneId ?? null });
    await timeline(client, {
      entityType: 'agent_run', entityId: id, eventType: 'agent_run.created', projectId,
      summary: `Agent Run created: "${input.title.slice(0, 100)}"`,
    });
    return mapRun(await loadRun(client, projectId, id));
  });
}

export async function updateAgentRun(
  db: Db, projectId: string, runId: string, input: UpdateAgentRunRequest, audit: MutationAudit,
): Promise<AgentRun> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await loadRun(client, projectId, runId, true);
    assertRunMutable(row);

    const hasTask = Object.prototype.hasOwnProperty.call(input, 'relatedTaskId');
    const hasMilestone = Object.prototype.hasOwnProperty.call(input, 'relatedMilestoneId');
    const nextTaskId = hasTask ? input.relatedTaskId ?? null : row.related_task_id;
    const nextMilestoneId = hasMilestone ? input.relatedMilestoneId ?? null : row.related_milestone_id;
    await assertConsistentRelations(client, projectId, nextTaskId, nextMilestoneId);
    if (hasTask && input.relatedTaskId) await assertTaskInProject(client, projectId, input.relatedTaskId);
    if (hasMilestone && input.relatedMilestoneId) await assertMilestoneInProject(client, projectId, input.relatedMilestoneId);

    await client.query(
      `UPDATE agent_runs SET
         title = COALESCE($3, title),
         agent_name = COALESCE($4, agent_name),
         related_task_id = CASE WHEN $5 THEN $6 ELSE related_task_id END,
         related_milestone_id = CASE WHEN $7 THEN $8 ELSE related_milestone_id END
       WHERE id=$1 AND project_id=$2`,
      [runId, projectId, input.title ?? null, input.agentName ?? null, hasTask, input.relatedTaskId ?? null, hasMilestone, input.relatedMilestoneId ?? null],
    );
    await audit(client, 'agentrun.updated', { projectId, agentRunId: runId, changedFields: Object.keys(input) });
    return mapRun(await loadRun(client, projectId, runId));
  });
}

const STATUS_TRANSITIONS: Record<AgentRunStatus, AgentRunStatus[]> = {
  draft: ['cancelled'],
  sent: ['in_progress', 'completed', 'failed', 'cancelled'],
  in_progress: ['completed', 'failed', 'cancelled'],
  failed: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

const STATUS_EVENT: Record<'in_progress' | 'completed' | 'failed' | 'cancelled', AuditEventType> = {
  in_progress: 'agentrun.started', completed: 'agentrun.completed', failed: 'agentrun.failed', cancelled: 'agentrun.cancelled',
};

export async function setAgentRunStatus(
  db: Db, projectId: string, runId: string, target: 'in_progress' | 'completed' | 'failed' | 'cancelled', audit: MutationAudit, timeline: MutationTimeline,
): Promise<AgentRun> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await loadRun(client, projectId, runId, true);
    assertRunMutable(row);
    if (!STATUS_TRANSITIONS[row.status].includes(target)) {
      throw new AppError('conflict', `Agent Run status cannot change from ${row.status} to ${target}.`);
    }
    await client.query(
      `UPDATE agent_runs SET
         status = $2,
         started_at = CASE WHEN $2='in_progress' THEN COALESCE(started_at, now()) ELSE started_at END,
         completed_at = CASE WHEN $2='completed' THEN now() ELSE completed_at END,
         failed_at = CASE WHEN $2='failed' THEN now() WHEN $2='in_progress' THEN NULL ELSE failed_at END,
         cancelled_at = CASE WHEN $2='cancelled' THEN now() ELSE cancelled_at END
       WHERE id=$1`,
      [runId, target],
    );
    await audit(client, STATUS_EVENT[target], { projectId, agentRunId: runId, from: row.status, to: target });
    if (target === 'completed' || target === 'failed') {
      await timeline(client, {
        entityType: 'agent_run', entityId: runId, eventType: target === 'completed' ? 'agent_run.completed' : 'agent_run.failed', projectId,
        summary: `Agent Run ${target}: "${row.title.slice(0, 100)}"`,
      });
    }
    return mapRun(await loadRun(client, projectId, runId));
  });
}

export async function setAgentRunArchived(db: Db, projectId: string, runId: string, archived: boolean, audit: MutationAudit): Promise<AgentRun> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await loadRun(client, projectId, runId, true);
    if (archived && row.archived_at) return mapRun(row);
    if (!archived && !row.archived_at) return mapRun(row);
    await client.query('UPDATE agent_runs SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1', [runId, archived]);
    await audit(client, archived ? 'agentrun.archived' : 'agentrun.reactivated', { projectId, agentRunId: runId });
    return mapRun(await loadRun(client, projectId, runId));
  });
}

export async function duplicateAgentRun(
  db: Db, projectId: string, runId: string, actorId: string, audit: MutationAudit,
): Promise<{ agentRun: AgentRun; prompt: AgentRunPrompt | null }> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const source = await loadRun(client, projectId, runId);
    const { rows: promptRows } = await client.query<{ body: string }>('SELECT body FROM agent_run_prompts WHERE agent_run_id=$1', [runId]);

    const newId = randomUUID();
    await client.query(
      `INSERT INTO agent_runs (id, project_id, title, agent_name, related_milestone_id, related_task_id, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [newId, projectId, source.title, source.agent_name, source.related_milestone_id, source.related_task_id, actorId],
    );

    let newPrompt: AgentRunPrompt | null = null;
    if (promptRows[0]) {
      const promptId = randomUUID();
      await client.query(
        `INSERT INTO agent_run_prompts (id, agent_run_id, body) VALUES ($1,$2,$3)`,
        [promptId, newId, promptRows[0].body],
      );
      const { rows } = await client.query<PromptRow>('SELECT * FROM agent_run_prompts WHERE id=$1', [promptId]);
      newPrompt = mapPrompt(rows[0]!);
    }

    await audit(client, 'agentrun.duplicated', { projectId, agentRunId: newId, sourceAgentRunId: runId });
    return { agentRun: mapRun(await loadRun(client, projectId, newId)), prompt: newPrompt };
  });
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

type PromptRow = {
  id: string; agent_run_id: string; prompt_version: number; body: string; status: 'draft' | 'sent';
  sent_at: Date | null; created_at: Date; updated_at: Date;
};

function mapPrompt(row: PromptRow): AgentRunPrompt {
  return {
    id: row.id, agentRunId: row.agent_run_id, promptVersion: row.prompt_version, body: row.body, status: row.status,
    sentAt: iso(row.sent_at), createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export async function getAgentRunPrompt(db: Executor, projectId: string, runId: string): Promise<AgentRunPrompt | null> {
  await getProjectGuard(db, projectId);
  await loadRun(db, projectId, runId);
  const { rows } = await db.query<PromptRow>('SELECT * FROM agent_run_prompts WHERE agent_run_id=$1', [runId]);
  return rows[0] ? mapPrompt(rows[0]) : null;
}

export async function upsertAgentRunPrompt(db: Db, projectId: string, runId: string, body: string, audit: MutationAudit): Promise<AgentRunPrompt> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const run = await loadRun(client, projectId, runId, true);
    assertRunMutable(run);

    const { rows: existingRows } = await client.query<PromptRow>('SELECT * FROM agent_run_prompts WHERE agent_run_id=$1 FOR UPDATE', [runId]);
    const existing = existingRows[0];
    if (existing) {
      if (existing.status === 'sent') throw new AppError('conflict', 'This prompt has been sent and is read-only.');
      await client.query('UPDATE agent_run_prompts SET body=$1 WHERE id=$2', [body, existing.id]);
    } else {
      await client.query('INSERT INTO agent_run_prompts (id, agent_run_id, body) VALUES ($1,$2,$3)', [randomUUID(), runId, body]);
    }
    await audit(client, 'agentprompt.updated', { projectId, agentRunId: runId });
    const { rows } = await client.query<PromptRow>('SELECT * FROM agent_run_prompts WHERE agent_run_id=$1', [runId]);
    return mapPrompt(rows[0]!);
  });
}

export async function sendAgentRunPrompt(db: Db, projectId: string, runId: string, audit: MutationAudit): Promise<{ prompt: AgentRunPrompt; agentRun: AgentRun }> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const run = await loadRun(client, projectId, runId, true);
    assertRunMutable(run);

    const { rows } = await client.query<PromptRow>('SELECT * FROM agent_run_prompts WHERE agent_run_id=$1 FOR UPDATE', [runId]);
    const prompt = rows[0];
    if (!prompt) throw new AppError('conflict', 'This Agent Run has no prompt to send yet.');

    if (prompt.status === 'sent') {
      // Idempotent: a duplicate "Mark as sent" click is a no-op, not an error.
      return { prompt: mapPrompt(prompt), agentRun: mapRun(await loadRun(client, projectId, runId)) };
    }
    if (!prompt.body.trim()) throw new AppError('validation_failed', 'The prompt is empty and cannot be sent.');
    if (run.status !== 'draft') throw new AppError('conflict', `Agent Run must be in draft to send its prompt (currently ${run.status}).`);

    await client.query(`UPDATE agent_run_prompts SET status='sent', sent_at=now() WHERE id=$1`, [prompt.id]);
    await client.query(`UPDATE agent_runs SET status='sent', sent_at=now() WHERE id=$1`, [runId]);
    await audit(client, 'agentrun.sent', { projectId, agentRunId: runId });

    const { rows: sentPromptRows } = await client.query<PromptRow>('SELECT * FROM agent_run_prompts WHERE id=$1', [prompt.id]);
    return { prompt: mapPrompt(sentPromptRows[0]!), agentRun: mapRun(await loadRun(client, projectId, runId)) };
  });
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

type ReportRow = {
  id: string; agent_run_id: string; version: number; body: string; status: 'draft' | 'final' | 'superseded';
  supersedes_report_id: string | null; superseded_by_id: string | null; finalized_at: Date | null;
  created_by: string | null; created_at: Date; updated_at: Date;
};

function mapReport(row: ReportRow): AgentReport {
  return {
    id: row.id, agentRunId: row.agent_run_id, version: row.version, body: row.body, status: row.status,
    supersedesReportId: row.supersedes_report_id, supersededById: row.superseded_by_id, finalizedAt: iso(row.finalized_at),
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

export async function listAgentReports(db: Executor, projectId: string, runId: string): Promise<AgentReport[]> {
  await getProjectGuard(db, projectId);
  await loadRun(db, projectId, runId);
  const { rows } = await db.query<ReportRow>('SELECT * FROM agent_reports WHERE agent_run_id=$1 ORDER BY version DESC', [runId]);
  return rows.map(mapReport);
}

export async function createAgentReport(
  db: Db, projectId: string, runId: string, actorId: string, body: string, audit: MutationAudit,
): Promise<AgentReport> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    // Lock the run row to serialize concurrent "create draft report" attempts
    // (version allocation + the one-draft-per-run invariant both depend on it).
    const run = await loadRun(client, projectId, runId, true);
    assertRunMutable(run);

    const { rows: currentFinalRows } = await client.query<{ id: string }>(
      `SELECT id FROM agent_reports WHERE agent_run_id=$1 AND status='final'`, [runId],
    );
    const supersedesReportId = currentFinalRows[0]?.id ?? null;
    const { rows: versionRows } = await client.query<{ next_version: number }>(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next_version FROM agent_reports WHERE agent_run_id=$1`, [runId],
    );
    const nextVersion = versionRows[0]!.next_version;

    const id = randomUUID();
    try {
      await client.query(
        `INSERT INTO agent_reports (id, agent_run_id, version, body, supersedes_report_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, runId, nextVersion, body, supersedesReportId, actorId],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('conflict', 'A draft report already exists for this Agent Run.');
      throw error;
    }

    await audit(client, supersedesReportId ? 'agentreport.revision_started' : 'agentreport.created', { projectId, agentRunId: runId, reportId: id, reportVersion: nextVersion, supersedesReportId });
    const { rows } = await client.query<ReportRow>('SELECT * FROM agent_reports WHERE id=$1', [id]);
    return mapReport(rows[0]!);
  });
}

async function loadReport(client: DbClient, runId: string, reportId: string, lock = false): Promise<ReportRow> {
  const { rows } = await client.query<ReportRow>(
    `SELECT * FROM agent_reports WHERE id=$1 AND agent_run_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [reportId, runId],
  );
  if (!rows[0]) throw notFound('Agent Report not found.');
  return rows[0];
}

export async function updateAgentReport(
  db: Db, projectId: string, runId: string, reportId: string, body: string, audit: MutationAudit,
): Promise<AgentReport> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    assertRunMutable(await loadRun(client, projectId, runId, true));
    const report = await loadReport(client, runId, reportId, true);
    if (report.status !== 'draft') throw new AppError('conflict', 'Only a draft report can be edited.');
    await client.query('UPDATE agent_reports SET body=$1 WHERE id=$2', [body, reportId]);
    await audit(client, 'agentreport.updated', { projectId, agentRunId: runId, reportId, reportVersion: report.version });
    return mapReport(await loadReport(client, runId, reportId));
  });
}

export async function finalizeAgentReport(
  db: Db, projectId: string, runId: string, reportId: string, audit: MutationAudit,
): Promise<{ report: AgentReport; supersededReport: AgentReport | null }> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    assertRunMutable(await loadRun(client, projectId, runId, true));
    const draft = await loadReport(client, runId, reportId, true);
    if (draft.status !== 'draft') throw new AppError('conflict', 'Only a draft report can be finalized.');

    let supersededOld: ReportRow | null = null;
    if (draft.supersedes_report_id) {
      const old = await loadReport(client, runId, draft.supersedes_report_id, true);
      if (old.status !== 'final') throw new AppError('conflict', 'The report this revision supersedes is no longer the current final report.');
      await client.query(`UPDATE agent_reports SET status='superseded', superseded_by_id=$1 WHERE id=$2`, [reportId, old.id]);
      await audit(client, 'agentreport.superseded', { projectId, agentRunId: runId, reportId: old.id, reportVersion: old.version, supersededById: reportId });
      supersededOld = { ...old, status: 'superseded', superseded_by_id: reportId };
    }

    await client.query(`UPDATE agent_reports SET status='final', finalized_at=now() WHERE id=$1`, [reportId]);
    await audit(client, 'agentreport.finalized', { projectId, agentRunId: runId, reportId, reportVersion: draft.version });

    return { report: mapReport(await loadReport(client, runId, reportId)), supersededReport: supersededOld ? mapReport(supersededOld) : null };
  });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export async function updateAgentRunValidation(
  db: Db, projectId: string, runId: string, actorId: string, input: UpdateAgentRunValidationRequest, audit: MutationAudit,
): Promise<AgentRun> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    assertRunMutable(await loadRun(client, projectId, runId, true));
    await client.query(
      `UPDATE agent_runs SET validation_status=$2, validation_note=$3, validated_by=$4, validated_at=now() WHERE id=$1`,
      [runId, input.status, input.note ?? null, actorId],
    );
    // Never carry the free-text note into audit detail — only the status transition.
    await audit(client, 'agentvalidation.updated', { projectId, agentRunId: runId, newStatus: input.status, notePresent: Boolean(input.note) });
    return mapRun(await loadRun(client, projectId, runId));
  });
}

// ---------------------------------------------------------------------------
// Promote to memory
//
// Not AI extraction: the user writes the memory entry's content themselves.
// This only wires the resulting row's provenance back to the run it came
// from, reusing memory/store.ts's own insert logic rather than duplicating
// it — see insertEntry's doc comment for why a client can never spoof this
// through the general memory-create endpoint.
// ---------------------------------------------------------------------------

export async function promoteAgentRunToMemory(
  db: Db, projectId: string, runId: string, actorId: string, input: CreateMemoryEntryRequest, audit: MutationAudit,
): Promise<MemoryEntry> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    await loadRun(client, projectId, runId); // 404s on cross-project or missing

    const id = await insertEntry(client, projectId, actorId, { ...input, sourceAgentRunId: runId });
    await audit(client, 'memory.created', { projectId, entryId: id, type: input.type, importance: input.importance, isPinned: input.isPinned, sourceAgentRunId: runId });
    await audit(client, 'agentrun.memory_promoted', { projectId, agentRunId: runId, entryId: id });

    return getMemoryEntry(client, projectId, id);
  });
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function activityLabel(eventType: string, detail: Record<string, unknown>): string {
  const labels: Record<string, string> = {
    'agentrun.created': 'Agent Run created',
    'agentrun.updated': 'Agent Run updated',
    'agentrun.sent': 'Prompt marked as sent',
    'agentrun.started': 'Run started',
    'agentrun.completed': 'Run completed',
    'agentrun.failed': 'Run failed',
    'agentrun.cancelled': 'Run cancelled',
    'agentrun.archived': 'Agent Run archived',
    'agentrun.reactivated': 'Agent Run reactivated',
    'agentrun.duplicated': 'Duplicated as a new run',
    'agentrun.memory_promoted': 'Finding promoted to Project Memory',
    'agentprompt.updated': 'Prompt edited',
    'agentreport.created': 'Report draft added',
    'agentreport.updated': 'Report draft edited',
    'agentreport.finalized': 'Report finalized',
    'agentreport.revision_started': 'Report revision started',
    'agentreport.superseded': 'Report superseded',
  };
  if (eventType === 'agentvalidation.updated' && typeof detail['newStatus'] === 'string') {
    return `Validation set to ${String(detail['newStatus']).replace(/_/g, ' ')}`;
  }
  return labels[eventType] ?? 'Agent Run updated';
}

export async function loadAgentRunTimeline(db: Executor, projectId: string, runId: string): Promise<AgentRunTimelineEntry[]> {
  await getProjectGuard(db, projectId);
  await loadRun(db, projectId, runId);
  const { rows } = await db.query<{ id: string; occurred_at: Date; event_type: string; outcome: string; actor_user_id: string | null; detail: Record<string, unknown> }>(
    `SELECT id, occurred_at, event_type, outcome, actor_user_id, detail FROM audit_events
      WHERE (event_type LIKE 'agentrun.%' OR event_type LIKE 'agentprompt.%' OR event_type LIKE 'agentreport.%' OR event_type LIKE 'agentvalidation.%')
        AND detail->>'agentRunId' = $1
      ORDER BY occurred_at DESC LIMIT 100`,
    [runId],
  );
  return rows.map((r) => ({
    id: String(r.id), occurredAt: r.occurred_at.toISOString(), eventType: r.event_type,
    label: activityLabel(r.event_type, r.detail), outcome: r.outcome, actorUserId: r.actor_user_id,
  }));
}
