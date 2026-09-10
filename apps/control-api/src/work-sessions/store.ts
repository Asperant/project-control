import { randomUUID } from 'node:crypto';
import type {
  AddWorkSessionAmendmentRequest, CloseWorkSessionRequest, StartWorkSessionRequest,
  UpdateWorkSessionRequest, WorkSession, WorkSessionAmendment, WorkSessionListQuery, CheckpointGitState,
} from '@project-control/contracts';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';
import { getProjectGuard, assertProjectMutable, type Executor } from '../projects/guard.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';
import { createCheckpointInTransaction } from '../checkpoints/store.js';
import type { RunnerClient } from '../runner/client.js';
import { captureCheckpointGitState } from '../development/service.js';

type WorkSessionRow = {
  id: string; project_id: string; goal: string; status: 'open' | 'closed';
  started_at: Date; ended_at: Date | null; outcome_summary: string | null;
  blockers: string | null; next_action: string | null; checkpoint_id: string | null;
  created_by: string | null; created_at: Date; updated_at: Date;
};

type AmendmentRow = {
  id: string; work_session_id: string; body: string; created_by: string | null; created_at: Date;
};

function mapAmendment(row: AmendmentRow): WorkSessionAmendment {
  return {
    id: row.id,
    workSessionId: row.work_session_id,
    body: row.body,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
  };
}

function mapSession(row: WorkSessionRow, amendments: WorkSessionAmendment[] = []): WorkSession {
  return {
    id: row.id,
    projectId: row.project_id,
    goal: row.goal,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    outcomeSummary: row.outcome_summary,
    blockers: row.blockers,
    nextAction: row.next_action,
    checkpointId: row.checkpoint_id,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    amendments,
  };
}

async function loadAmendments(db: Executor, sessionIds: string[]): Promise<Map<string, WorkSessionAmendment[]>> {
  const result = new Map<string, WorkSessionAmendment[]>();
  if (sessionIds.length === 0) return result;
  const { rows } = await db.query<AmendmentRow>(
    `SELECT * FROM work_session_amendments
      WHERE work_session_id = ANY($1::uuid[])
      ORDER BY created_at, id`,
    [sessionIds],
  );
  for (const row of rows) {
    const amendments = result.get(row.work_session_id) ?? [];
    amendments.push(mapAmendment(row));
    result.set(row.work_session_id, amendments);
  }
  return result;
}

async function loadSessionRow(
  db: Executor, projectId: string, sessionId: string, lock = false,
): Promise<WorkSessionRow> {
  const { rows } = await db.query<WorkSessionRow>(
    `SELECT * FROM work_sessions WHERE id=$1 AND project_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [sessionId, projectId],
  );
  if (!rows[0]) throw notFound('Work Session not found.');
  return rows[0];
}

async function hydrateSession(db: Executor, row: WorkSessionRow): Promise<WorkSession> {
  const amendments = await loadAmendments(db, [row.id]);
  return mapSession(row, amendments.get(row.id) ?? []);
}

export async function listWorkSessions(
  db: Executor, projectId: string, query: WorkSessionListQuery,
): Promise<{ workSessions: WorkSession[]; total: number; nextCursor: { startedAt: string; id: string } | null }> {
  await getProjectGuard(db, projectId);
  const offset = query.beforeStartedAt ? 0 : (query.page - 1) * query.pageSize;
  const [sessionsResult, countResult] = await Promise.all([
    db.query<WorkSessionRow>(
      `SELECT * FROM work_sessions
        WHERE project_id=$1
          AND ($2::text IS NULL OR status=$2)
          AND ($3::timestamptz IS NULL OR (started_at,id) < ($3::timestamptz,$4::uuid))
        ORDER BY started_at DESC, id DESC LIMIT $5 OFFSET $6`,
      [projectId, query.status ?? null, query.beforeStartedAt ?? null, query.beforeId ?? null, query.pageSize, offset],
    ),
    db.query<{ total: number }>(
      'SELECT count(*)::int total FROM work_sessions WHERE project_id=$1 AND ($2::text IS NULL OR status=$2)',
      [projectId, query.status ?? null],
    ),
  ]);
  const amendments = await loadAmendments(db, sessionsResult.rows.map((row) => row.id));
  const last = sessionsResult.rows.at(-1);
  return {
    workSessions: sessionsResult.rows.map((row) => mapSession(row, amendments.get(row.id) ?? [])),
    total: countResult.rows[0]?.total ?? 0,
    nextCursor: sessionsResult.rows.length === query.pageSize && last
      ? { startedAt: last.started_at.toISOString(), id: last.id }
      : null,
  };
}

export async function getWorkSession(db: Executor, projectId: string, sessionId: string): Promise<WorkSession> {
  await getProjectGuard(db, projectId);
  return hydrateSession(db, await loadSessionRow(db, projectId, sessionId));
}

export async function getOpenWorkSession(db: Executor, projectId: string): Promise<WorkSession | null> {
  const { rows } = await db.query<WorkSessionRow>(
    `SELECT * FROM work_sessions WHERE project_id=$1 AND status='open'
      ORDER BY started_at DESC, id DESC LIMIT 1`,
    [projectId],
  );
  return rows[0] ? hydrateSession(db, rows[0]) : null;
}

export async function getLastClosedWorkSession(db: Executor, projectId: string): Promise<WorkSession | null> {
  const { rows } = await db.query<WorkSessionRow>(
    `SELECT * FROM work_sessions WHERE project_id=$1 AND status='closed'
      ORDER BY ended_at DESC, id DESC LIMIT 1`,
    [projectId],
  );
  return rows[0] ? hydrateSession(db, rows[0]) : null;
}

export async function startWorkSession(
  db: Db, projectId: string, actorId: string, body: StartWorkSessionRequest, audit: MutationAudit, timeline: MutationTimeline,
): Promise<WorkSession> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true), 'Work Session');
    const id = randomUUID();
    try {
      await client.query(
        'INSERT INTO work_sessions (id, project_id, goal, created_by) VALUES ($1,$2,$3,$4)',
        [id, projectId, body.goal, actorId],
      );
    } catch (error) {
      if (typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505') {
        throw new AppError('conflict', 'This project already has an open Work Session.');
      }
      throw error;
    }
    await audit(client, 'work_session.started', { projectId, workSessionId: id });
    await timeline(client, {
      entityType: 'work_session', entityId: id, eventType: 'work_session.started', projectId,
      summary: `Work Session started: "${body.goal.slice(0, 100)}"`,
    });
    return mapSession(await loadSessionRow(client, projectId, id));
  });
}

export async function updateWorkSession(
  db: Db, projectId: string, sessionId: string, body: UpdateWorkSessionRequest, audit: MutationAudit,
): Promise<WorkSession> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true), 'Work Session');
    const current = await loadSessionRow(client, projectId, sessionId, true);
    if (current.status !== 'open') throw new AppError('conflict', 'Closed Work Sessions are read-only. Add an amendment instead.');
    await client.query('UPDATE work_sessions SET goal=$1 WHERE id=$2', [body.goal, sessionId]);
    await audit(client, 'work_session.goal_updated', { projectId, workSessionId: sessionId });
    return mapSession(await loadSessionRow(client, projectId, sessionId));
  });
}

export async function closeWorkSession(
  db: Db, projectId: string, sessionId: string, actorId: string,
  body: CloseWorkSessionRequest, audit: MutationAudit, runner: RunnerClient, timeline: MutationTimeline, requestId?: string,
): Promise<WorkSession> {
  // Capture before opening the transaction; a runner failure becomes an
  // unavailable v3 Git state and never blocks an otherwise valid close.
  const gitState: CheckpointGitState | null = body.createCheckpoint
    ? await captureCheckpointGitState(db, runner, projectId, requestId)
    : null;
  return withTransaction(db, async (client) => {
    const { rows: projects } = await client.query<{ id: string; status: string; name: string }>(
      'SELECT id, status, name FROM projects WHERE id=$1 FOR UPDATE',
      [projectId],
    );
    const project = projects[0];
    if (!project) throw notFound('Project not found.');
    assertProjectMutable(project, 'Work Session');

    const current = await loadSessionRow(client, projectId, sessionId, true);
    if (current.status !== 'open') throw new AppError('conflict', 'This Work Session is already closed.');

    let checkpointId: string | null = null;
    if (body.createCheckpoint) {
      const checkpoint = await createCheckpointInTransaction(
        client, project, actorId, body.checkpointSessionNote, audit, gitState!, timeline,
      );
      checkpointId = checkpoint.id;
      await audit(client, 'work_session.checkpoint_created', {
        projectId, workSessionId: sessionId, checkpointId,
      });
    }

    await client.query(
      `UPDATE work_sessions SET status='closed', ended_at=now(), outcome_summary=$1,
        blockers=$2, next_action=$3, checkpoint_id=$4 WHERE id=$5`,
      [body.outcomeSummary, body.blockers ?? null, body.nextAction ?? null, checkpointId, sessionId],
    );
    await audit(client, 'work_session.closed', {
      projectId,
      workSessionId: sessionId,
      checkpointCreated: checkpointId !== null,
      blockersPresent: Boolean(body.blockers),
      nextActionPresent: Boolean(body.nextAction),
    });
    await timeline(client, {
      entityType: 'work_session', entityId: sessionId, eventType: 'work_session.closed', projectId,
      summary: `Work Session closed: "${current.goal.slice(0, 100)}"`,
    });
    return mapSession(await loadSessionRow(client, projectId, sessionId));
  });
}

export async function addWorkSessionAmendment(
  db: Db, projectId: string, sessionId: string, actorId: string,
  body: AddWorkSessionAmendmentRequest, audit: MutationAudit,
): Promise<WorkSessionAmendment> {
  return withTransaction(db, async (client: DbClient) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true), 'Work Session');
    const session = await loadSessionRow(client, projectId, sessionId, true);
    if (session.status !== 'closed') throw new AppError('conflict', 'Amendments can only be added to a closed Work Session.');
    const id = randomUUID();
    const { rows } = await client.query<AmendmentRow>(
      `INSERT INTO work_session_amendments (id, work_session_id, body, created_by)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, sessionId, body.body, actorId],
    );
    await audit(client, 'work_session.amendment_added', {
      projectId, workSessionId: sessionId, amendmentId: id,
    });
    return mapAmendment(rows[0]!);
  });
}
