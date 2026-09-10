import { randomUUID } from 'node:crypto';
import type {
  CheckpointDetail, CheckpointGitState, CheckpointListQuery, CheckpointListResponse, CheckpointSnapshot, CheckpointSummary,
} from '@project-control/contracts';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { notFound } from '../errors.js';
import { getProjectGuard, assertProjectMutable as assertProjectMutableBase, type Executor } from '../projects/guard.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';
import { buildCheckpointSnapshot } from './snapshot.js';
import type { RunnerClient } from '../runner/client.js';
import { captureCheckpointGitState } from '../development/service.js';

function assertProjectMutable(project: { id: string; status: string }): void {
  assertProjectMutableBase(project, 'Checkpoint');
}

type CheckpointRow = {
  id: string; project_id: string; snapshot_version: number; snapshot_json: CheckpointSnapshot;
  session_note: string | null; created_by: string | null; created_at: Date; archived_at: Date | null;
};

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapSummary(row: CheckpointRow): CheckpointSummary {
  return {
    id: row.id, projectId: row.project_id, snapshotVersion: row.snapshot_version,
    sessionNote: row.session_note, createdBy: row.created_by,
    createdAt: row.created_at.toISOString(), archivedAt: iso(row.archived_at),
  };
}

function mapDetail(row: CheckpointRow): CheckpointDetail {
  return { ...mapSummary(row), snapshot: row.snapshot_json };
}

/**
 * Inserts a checkpoint using an existing transaction and already-locked
 * project. Work Session closure uses this so snapshot creation, linkage and
 * both audit records commit or roll back as one unit.
 */
export async function createCheckpointInTransaction(
  client: DbClient,
  project: { id: string; status: string; name: string },
  actorId: string,
  sessionNote: string | undefined,
  audit: MutationAudit,
  gitState: CheckpointGitState,
  timeline: MutationTimeline,
): Promise<CheckpointDetail> {
  assertProjectMutable(project);
  const snapshot = await buildCheckpointSnapshot(client, project.id, project, gitState);
  const id = randomUUID();
  await client.query(
    `INSERT INTO project_checkpoints (id, project_id, snapshot_version, snapshot_json, session_note, created_by)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
    [id, project.id, snapshot.version, JSON.stringify(snapshot), sessionNote ?? null, actorId],
  );
  await audit(client, 'checkpoint.created', {
    projectId: project.id,
    checkpointId: id,
    snapshotVersion: snapshot.version,
    sessionNotePresent: Boolean(sessionNote),
  });
  await timeline(client, {
    entityType: 'checkpoint', entityId: id, eventType: 'checkpoint.created', projectId: project.id,
    summary: `Checkpoint saved for "${project.name.slice(0, 90)}"`,
  });
  const { rows } = await client.query<CheckpointRow>('SELECT * FROM project_checkpoints WHERE id=$1', [id]);
  return mapDetail(rows[0]!);
}

export async function createCheckpoint(
  db: Db, projectId: string, actorId: string, sessionNote: string | undefined, audit: MutationAudit,
  runner: RunnerClient, timeline: MutationTimeline, requestId?: string,
): Promise<CheckpointDetail> {
  // Runner I/O deliberately happens before opening the PostgreSQL transaction.
  // Failure is represented in a compact unavailable snapshot and cannot block
  // checkpoint persistence or extend the project-row lock duration.
  const gitState = await captureCheckpointGitState(db, runner, projectId, requestId);
  return withTransaction(db, async (client) => {
    // Locking the project row serializes concurrent checkpoint creation for the
    // same project: each snapshot read happens with a stable view of the
    // roadmap/memory tables, and two concurrent "Save checkpoint" clicks
    // resolve into two distinct, correctly ordered rows rather than a race.
    const { rows } = await client.query<{ id: string; status: string; name: string }>(
      'SELECT id, status, name FROM projects WHERE id=$1 FOR UPDATE',
      [projectId],
    );
    const project = rows[0];
    if (!project) throw notFound('Project not found.');
    return createCheckpointInTransaction(client, project, actorId, sessionNote, audit, gitState, timeline);
  });
}

export async function listCheckpoints(db: Executor, projectId: string, query: CheckpointListQuery): Promise<CheckpointListResponse> {
  await getProjectGuard(db, projectId);
  // cursor_created_at: created_at at full microsecond precision, UTC — see
  // memory/store.ts's MemoryRow.cursor_created_at for why the cursor can't
  // be built from created_at.toISOString().
  const { rows } = await db.query<CheckpointRow & { cursor_created_at: string }>(
    `SELECT id, project_id, snapshot_version, session_note, created_by, created_at, archived_at,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM project_checkpoints
      WHERE project_id=$1 AND archived_at IS ${query.archived === 'true' ? 'NOT NULL' : 'NULL'}
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
      ORDER BY created_at DESC, id DESC
      LIMIT $4`,
    [projectId, query.beforeCreatedAt ?? null, query.beforeId ?? null, query.pageSize],
  );
  const checkpoints = rows.map(mapSummary);
  const last = rows.at(-1);
  return {
    checkpoints,
    pageSize: query.pageSize,
    nextCursor: rows.length === query.pageSize && last ? { createdAt: last.cursor_created_at, id: last.id } : null,
  };
}

export async function getCheckpoint(db: Executor, projectId: string, checkpointId: string): Promise<CheckpointDetail> {
  await getProjectGuard(db, projectId);
  const { rows } = await db.query<CheckpointRow>(
    'SELECT * FROM project_checkpoints WHERE id=$1 AND project_id=$2',
    [checkpointId, projectId],
  );
  if (!rows[0]) throw notFound('Checkpoint not found.');
  return mapDetail(rows[0]);
}

export async function archiveCheckpoint(db: Db, projectId: string, checkpointId: string, audit: MutationAudit): Promise<CheckpointSummary> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const { rows } = await client.query<CheckpointRow>(
      'SELECT * FROM project_checkpoints WHERE id=$1 AND project_id=$2 FOR UPDATE',
      [checkpointId, projectId],
    );
    if (!rows[0]) throw notFound('Checkpoint not found.');
    if (rows[0].archived_at) return mapSummary(rows[0]);
    await client.query('UPDATE project_checkpoints SET archived_at=now() WHERE id=$1', [checkpointId]);
    await audit(client, 'checkpoint.archived', { projectId, checkpointId });
    const { rows: updated } = await client.query<CheckpointRow>('SELECT * FROM project_checkpoints WHERE id=$1', [checkpointId]);
    return mapSummary(updated[0]!);
  });
}

/** The most recent non-archived checkpoint for a project, or null if none exists. */
export async function getLastActiveCheckpoint(db: Executor, projectId: string): Promise<CheckpointSummary | null> {
  const { rows } = await db.query<CheckpointRow>(
    `SELECT id, project_id, snapshot_version, session_note, created_by, created_at, archived_at
       FROM project_checkpoints WHERE project_id=$1 AND archived_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    [projectId],
  );
  return rows[0] ? mapSummary(rows[0]) : null;
}
