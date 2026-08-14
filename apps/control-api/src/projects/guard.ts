import type { Db, DbClient } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';

export type Executor = Db | DbClient;
export type ProjectGuard = { id: string; status: string };

/**
 * Shared by every feature area that hangs data off a project (roadmap,
 * memory, checkpoints): loads the project row, optionally locking it, and
 * throws a uniform 404 when it does not exist.
 */
export async function getProjectGuard(db: Executor, projectId: string, lock = false): Promise<ProjectGuard> {
  const { rows } = await db.query<ProjectGuard>(
    `SELECT id, status FROM projects WHERE id=$1${lock ? ' FOR UPDATE' : ''}`,
    [projectId],
  );
  if (!rows[0]) throw notFound('Project not found.');
  return rows[0];
}

/** A single project-wide mutation gate: archived projects are read-only everywhere. */
export function assertProjectMutable(project: ProjectGuard, subject = 'Roadmap'): void {
  if (project.status === 'archived') {
    throw new AppError('conflict', `This project is archived. ${subject} changes are disabled.`);
  }
}
