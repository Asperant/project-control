import { randomUUID } from 'node:crypto';
import type { CheckpointDetail, CheckpointSnapshot, CheckpointSummary } from '@project-control/contracts';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { notFound } from '../errors.js';
import { getProjectGuard, assertProjectMutable as assertProjectMutableBase, type Executor } from '../projects/guard.js';
import type { MutationAudit } from '../roadmap/store.js';
import { buildCheckpointSnapshot } from './snapshot.js';

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
): Promise<CheckpointDetail> {
  assertProjectMutable(project);
  const snapshot = await buildCheckpointSnapshot(client, project.id, project);
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
  const { rows } = await client.query<CheckpointRow>('SELECT * FROM project_checkpoints WHERE id=$1', [id]);
  return mapDetail(rows[0]!);
}

export async function createCheckpoint(
  db: Db, projectId: string, actorId: string, sessionNote: string | undefined, audit: MutationAudit,
): Promise<CheckpointDetail> {
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
    return createCheckpointInTransaction(client, project, actorId, sessionNote, audit);
  });
}

export async function listCheckpoints(db: Executor, projectId: string, includeArchived: boolean): Promise<CheckpointSummary[]> {
  await getProjectGuard(db, projectId);
  const { rows } = await db.query<CheckpointRow>(
    `SELECT id, project_id, snapshot_version, session_note, created_by, created_at, archived_at
       FROM project_checkpoints WHERE project_id=$1 AND archived_at IS ${includeArchived ? 'NOT NULL' : 'NULL'}
       ORDER BY created_at DESC`,
    [projectId],
  );
  return rows.map(mapSummary);
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
