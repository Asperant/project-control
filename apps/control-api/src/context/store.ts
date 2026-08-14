import type { ProjectContextResponse } from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';
import { getProjectGuard } from '../projects/guard.js';
import { listMemory } from '../memory/store.js';
import { getLastActiveCheckpoint } from '../checkpoints/store.js';
import { loadRawProjectData } from '../checkpoints/snapshot.js';

/**
 * Deterministic "Current context / Where was I?" composition.
 *
 * No AI, no summarisation, no free-text generation: every field below is a
 * direct, documented read of the roadmap, memory and audit tables. See
 * docs/project-memory.md for the ordering policy this relies on.
 */

type ChangeCategory = { prefix: string; label: (count: number) => string };

const CHANGE_CATEGORIES: Record<string, ChangeCategory> = {
  'roadmap.milestone.completed': { prefix: '✓', label: (n) => `${n} milestone${n === 1 ? '' : 's'} completed` },
  'roadmap.milestone.blocked': { prefix: '!', label: (n) => `${n} milestone${n === 1 ? '' : 's'} became blocked` },
  'roadmap.milestone.created': { prefix: '+', label: (n) => `${n} milestone${n === 1 ? '' : 's'} added` },
  'roadmap.task.started': { prefix: '→', label: (n) => `${n} task${n === 1 ? '' : 's'} started` },
  'roadmap.task.completed': { prefix: '✓', label: (n) => `${n} task${n === 1 ? '' : 's'} completed` },
  'roadmap.task.blocked': { prefix: '!', label: (n) => `${n} task${n === 1 ? '' : 's'} became blocked` },
  'roadmap.task.cancelled': { prefix: '✕', label: (n) => `${n} task${n === 1 ? '' : 's'} cancelled` },
  'roadmap.task.created': { prefix: '+', label: (n) => `${n} task${n === 1 ? '' : 's'} added` },
  'roadmap.acceptance.completed': { prefix: '+', label: (n) => `${n} acceptance criteri${n === 1 ? 'on' : 'a'} completed` },
  'memory.created': { prefix: '+', label: (n) => `${n} memory entr${n === 1 ? 'y' : 'ies'} added` },
  'memory.superseded': { prefix: '~', label: (n) => `${n} memory entr${n === 1 ? 'y' : 'ies'} superseded` },
  'memory.archived': { prefix: '-', label: (n) => `${n} memory entr${n === 1 ? 'y' : 'ies'} archived` },
  'checkpoint.archived': { prefix: '-', label: (n) => `${n} checkpoint${n === 1 ? '' : 's'} archived` },
};

async function computeChangesSinceCheckpoint(
  db: Executor, projectId: string, since: { id: string; createdAt: string } | null,
): Promise<ProjectContextResponse['changesSinceCheckpoint']> {
  if (!since) {
    return { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] };
  }

  const { rows } = await db.query<{ event_type: string; count: string }>(
    `SELECT event_type, count(*) AS count
       FROM audit_events
      WHERE occurred_at > $1
        AND event_type <> 'checkpoint.created'
        AND (event_type LIKE 'roadmap.%' OR event_type LIKE 'memory.%' OR event_type = 'checkpoint.archived')
        AND detail->>'projectId' = $2
      GROUP BY event_type`,
    [since.createdAt, projectId],
  );

  const items: Array<{ key: string; label: string; count: number }> = [];
  let otherCount = 0;
  for (const row of rows) {
    const count = Number(row.count);
    if (count <= 0) continue;
    const category = CHANGE_CATEGORIES[row.event_type];
    if (category) {
      items.push({ key: row.event_type, label: `${category.prefix} ${category.label(count)}`, count });
    } else {
      otherCount += count;
    }
  }
  if (otherCount > 0) {
    items.push({ key: 'other', label: `• ${otherCount} other change${otherCount === 1 ? '' : 's'}`, count: otherCount });
  }
  // Deterministic, stable order: most-specific categories first, in the order
  // declared above, generic "other" bucket last.
  const order = [...Object.keys(CHANGE_CATEGORIES), 'other'];
  items.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));

  return { hasCheckpoint: true, sinceCheckpointId: since.id, sinceCreatedAt: since.createdAt, items };
}

export async function getProjectContext(db: Executor, projectId: string): Promise<ProjectContextResponse> {
  await getProjectGuard(db, projectId);
  const [raw, pinnedContext, lastCheckpoint] = await Promise.all([
    loadRawProjectData(db, projectId),
    listMemory(db, projectId, { pinned: 'true' }),
    getLastActiveCheckpoint(db, projectId),
  ]);
  const changesSinceCheckpoint = await computeChangesSinceCheckpoint(db, projectId, lastCheckpoint);

  return {
    projectId,
    currentFocus: raw.currentFocus,
    inProgressTasks: raw.inProgressTasks,
    blocked: { milestones: raw.blockedMilestones, tasks: raw.blockedTasks },
    nextActions: raw.nextActions,
    pendingAcceptance: raw.pendingAcceptance,
    unresolvedDependencies: raw.unresolvedDependencies,
    pinnedContext,
    lastCheckpoint,
    changesSinceCheckpoint,
  };
}
