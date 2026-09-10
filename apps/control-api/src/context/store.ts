import type { ProjectContextResponse } from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';
import { getProjectGuard } from '../projects/guard.js';
import { listMemory } from '../memory/store.js';
import { getLastActiveCheckpoint } from '../checkpoints/store.js';
import { loadRawProjectData, RECENT_AGENT_ACTIVITY_LIMIT } from '../checkpoints/snapshot.js';
import { loadRecentAgentActivity } from '../agent-runs/snapshot.js';

/**
 * Deterministic "Current context / Where was I?" composition.
 *
 * No AI, no summarisation, no free-text generation: every field below is a
 * direct, documented read of the roadmap, memory and audit tables. See
 * docs/project-memory.md for the ordering policy this relies on.
 */

// Pinning is a deliberate, curated act, so this is generous relative to
// listMemory's own default page size — a project would need an unusually
// large amount of pinned material to ever hit it.
const PINNED_CONTEXT_LIMIT = 200;

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
  'work_session.started': { prefix: '+', label: (n) => `${n} work session${n === 1 ? '' : 's'} started` },
  'work_session.goal_updated': { prefix: '~', label: (n) => `${n} work-session goal${n === 1 ? '' : 's'} updated` },
  'work_session.closed': { prefix: '✓', label: (n) => `${n} work session${n === 1 ? '' : 's'} closed` },
  'work_session.amendment_added': { prefix: '+', label: (n) => `${n} work-session correction${n === 1 ? '' : 's'} added` },
  'agentrun.sent': { prefix: '+', label: (n) => `${n} agent run${n === 1 ? '' : 's'} sent` },
  'agentrun.completed': { prefix: '✓', label: (n) => `${n} agent run${n === 1 ? '' : 's'} completed` },
  'agentrun.failed': { prefix: '!', label: (n) => `${n} agent run${n === 1 ? '' : 's'} failed` },
  'agentrun.cancelled': { prefix: '✕', label: (n) => `${n} agent run${n === 1 ? '' : 's'} cancelled` },
  'agentreport.finalized': { prefix: '+', label: (n) => `${n} agent report${n === 1 ? '' : 's'} finalized` },
  'agentrun.memory_promoted': { prefix: '+', label: (n) => `${n} finding${n === 1 ? '' : 's'} promoted to memory` },
  // agentvalidation.updated is one event type covering five possible target
  // statuses; the query below buckets it by detail->>'newStatus' so "accepted"
  // and "rejected" are counted (and labelled) separately rather than merged.
  'agentvalidation.updated:accepted': { prefix: '✓', label: (n) => `${n} validation${n === 1 ? '' : 's'} accepted` },
  'agentvalidation.updated:accepted_with_changes': { prefix: '✓', label: (n) => `${n} validation${n === 1 ? '' : 's'} accepted with changes` },
  'agentvalidation.updated:rejected': { prefix: '✕', label: (n) => `${n} validation${n === 1 ? '' : 's'} rejected` },
};

async function computeChangesSinceCheckpoint(
  db: Executor, projectId: string, since: { id: string; createdAt: string } | null,
): Promise<ProjectContextResponse['changesSinceCheckpoint']> {
  if (!since) {
    return { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] };
  }

  const { rows } = await db.query<{ bucket_key: string; count: string }>(
    `SELECT
        CASE WHEN event_type = 'agentvalidation.updated'
             THEN 'agentvalidation.updated:' || COALESCE(detail->>'newStatus', 'other')
             ELSE event_type
        END AS bucket_key,
        count(*) AS count
       FROM audit_events
      WHERE occurred_at > $1
        AND event_type <> 'checkpoint.created'
        AND (
          event_type LIKE 'roadmap.%' OR event_type LIKE 'memory.%' OR event_type LIKE 'work_session.%' OR event_type = 'checkpoint.archived'
          OR event_type IN ('agentrun.sent','agentrun.completed','agentrun.failed','agentrun.cancelled',
                             'agentreport.finalized','agentrun.memory_promoted','agentvalidation.updated')
        )
        AND detail->>'projectId' = $2
      GROUP BY bucket_key`,
    [since.createdAt, projectId],
  );

  const items: Array<{ key: string; label: string; count: number }> = [];
  let otherCount = 0;
  for (const row of rows) {
    const count = Number(row.count);
    if (count <= 0) continue;
    const category = CHANGE_CATEGORIES[row.bucket_key];
    if (category) {
      items.push({ key: row.bucket_key, label: `${category.prefix} ${category.label(count)}`, count });
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
  const [raw, pinnedMemory, lastCheckpoint, recentAgentWork] = await Promise.all([
    loadRawProjectData(db, projectId),
    listMemory(db, projectId, { pinned: 'true', pageSize: PINNED_CONTEXT_LIMIT }),
    getLastActiveCheckpoint(db, projectId),
    loadRecentAgentActivity(db, projectId, RECENT_AGENT_ACTIVITY_LIMIT),
  ]);
  const pinnedContext = pinnedMemory.entries;
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
    recentAgentWork,
    lastCheckpoint,
    changesSinceCheckpoint,
  };
}
