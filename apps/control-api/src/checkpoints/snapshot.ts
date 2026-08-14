import type { CheckpointSnapshot, RoadmapPriority, RoadmapStatus } from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';
import { loadRecentAgentActivity } from '../agent-runs/snapshot.js';

/** How many recent Agent Run entries a checkpoint snapshot / live context carries. */
export const RECENT_AGENT_ACTIVITY_LIMIT = 5;

/**
 * The single, shared read of "what does this project's roadmap look like
 * right now" that both the checkpoint snapshot builder and the live
 * current-context/"Where was I?" endpoint draw from. Keeping this in one
 * place is what stops the two from drifting apart with slightly different
 * status/ordering rules over time.
 *
 * Ordering policy (deterministic, no AI involved anywhere):
 *  - milestones: roadmap sort_order
 *  - tasks within a milestone: roadmap sort_order
 *  - "next actions": in_progress tasks first, then blocked, then the rest,
 *    each group in milestone/task sort_order — see docs/project-memory.md.
 */

export type SnapshotMilestone = { milestoneId: string; title: string; priority: RoadmapPriority; blockedReason: string | null };
export type SnapshotTask = {
  taskId: string; title: string; milestoneId: string; milestoneTitle: string; status: RoadmapStatus;
  blockedReason: string | null; nextAction: string;
};
export type SnapshotAcceptance = { taskId: string; title: string; milestoneId: string; milestoneTitle: string; pendingCount: number };
export type SnapshotDependency = { taskId: string; title: string; milestoneId: string; dependsOnTaskId: string; dependsOnTitle: string; dependsOnStatus: RoadmapStatus };
export type SnapshotCompletedTask = { taskId: string; title: string; milestoneId: string; milestoneTitle: string; completedAt: string };
export type SnapshotMemory = { id: string; type: string; title: string; importance: string };

export type RawProjectData = {
  currentFocus: SnapshotMilestone[];
  inProgressTasks: SnapshotTask[];
  blockedMilestones: SnapshotMilestone[];
  blockedTasks: SnapshotTask[];
  nextActions: SnapshotTask[];
  pendingAcceptance: SnapshotAcceptance[];
  unresolvedDependencies: SnapshotDependency[];
  recentlyCompletedTasks: SnapshotCompletedTask[];
};

type MilestoneRow = { id: string; title: string; priority: RoadmapPriority; blocked_reason: string | null };
type TaskRow = {
  id: string; title: string; status: RoadmapStatus; blocked_reason: string | null; next_action: string;
  completed_at: Date | null; milestone_id: string; milestone_title: string;
  milestone_sort_order: number; task_sort_order: number; incomplete_acceptance_count: number;
};
type DependencyRow = { task_id: string; title: string; milestone_id: string; depends_on_task_id: string; depends_on_title: string; depends_on_status: RoadmapStatus };

function mapMilestone(row: MilestoneRow): SnapshotMilestone {
  return { milestoneId: row.id, title: row.title, priority: row.priority, blockedReason: row.blocked_reason };
}

const RECENTLY_COMPLETED_LIMIT = 10;

export async function loadRawProjectData(db: Executor, projectId: string): Promise<RawProjectData> {
  // Sequential, not Promise.all: `db` may be a single transaction client (the
  // checkpoint-creation path), and a pg client can only run one query at a
  // time — issuing several without awaiting between them is deprecated and,
  // on a future driver version, an outright error.
  const { rows: inProgressMilestones } = await db.query<MilestoneRow>(
    `SELECT id, title, priority, blocked_reason FROM roadmap_milestones WHERE project_id=$1 AND status='in_progress' AND archived_at IS NULL ORDER BY sort_order`,
    [projectId],
  );
  const { rows: blockedMilestoneRows } = await db.query<MilestoneRow>(
    `SELECT id, title, priority, blocked_reason FROM roadmap_milestones WHERE project_id=$1 AND status='blocked' AND archived_at IS NULL ORDER BY sort_order`,
    [projectId],
  );
  const { rows: taskRows } = await db.query<TaskRow>(
    `SELECT t.id, t.title, t.status, t.blocked_reason, t.next_action, t.completed_at,
            t.milestone_id, m.title AS milestone_title, m.sort_order AS milestone_sort_order, t.sort_order AS task_sort_order,
            (SELECT count(*) FROM task_acceptance_criteria c WHERE c.task_id=t.id AND NOT c.is_completed) AS incomplete_acceptance_count
       FROM roadmap_tasks t JOIN roadmap_milestones m ON m.id=t.milestone_id
      WHERE m.project_id=$1
      ORDER BY m.sort_order, t.sort_order`,
    [projectId],
  );
  const { rows: dependencyRows } = await db.query<DependencyRow>(
    `SELECT d.task_id, t.title, t.milestone_id, d.depends_on_task_id, dep.title AS depends_on_title, dep.status AS depends_on_status
       FROM task_dependencies d
       JOIN roadmap_tasks t ON t.id=d.task_id
       JOIN roadmap_tasks dep ON dep.id=d.depends_on_task_id
       JOIN roadmap_milestones m ON m.id=t.milestone_id
      WHERE m.project_id=$1 AND dep.status <> 'done'
      ORDER BY m.sort_order, t.sort_order`,
    [projectId],
  );

  const mapTask = (row: TaskRow): SnapshotTask => ({
    taskId: row.id, title: row.title, milestoneId: row.milestone_id, milestoneTitle: row.milestone_title,
    status: row.status, blockedReason: row.blocked_reason, nextAction: row.next_action,
  });

  const inProgressTasks = taskRows.filter((r) => r.status === 'in_progress').map(mapTask);
  const blockedTasks = taskRows.filter((r) => r.status === 'blocked').map(mapTask);

  const nextActionOrder = (status: string): number => (status === 'in_progress' ? 0 : status === 'blocked' ? 1 : 2);
  const nextActions = taskRows
    .filter((r) => r.next_action.trim() !== '' && r.status !== 'done' && r.status !== 'cancelled')
    .sort((a, b) => nextActionOrder(a.status) - nextActionOrder(b.status) || a.milestone_sort_order - b.milestone_sort_order || a.task_sort_order - b.task_sort_order)
    .map(mapTask);

  const pendingAcceptance: SnapshotAcceptance[] = taskRows
    .filter((r) => r.status !== 'cancelled' && Number(r.incomplete_acceptance_count) > 0)
    .map((r) => ({ taskId: r.id, title: r.title, milestoneId: r.milestone_id, milestoneTitle: r.milestone_title, pendingCount: Number(r.incomplete_acceptance_count) }));

  const recentlyCompletedTasks: SnapshotCompletedTask[] = taskRows
    .filter((r) => r.status === 'done' && r.completed_at)
    .sort((a, b) => (b.completed_at as Date).getTime() - (a.completed_at as Date).getTime())
    .slice(0, RECENTLY_COMPLETED_LIMIT)
    .map((r) => ({ taskId: r.id, title: r.title, milestoneId: r.milestone_id, milestoneTitle: r.milestone_title, completedAt: (r.completed_at as Date).toISOString() }));

  const unresolvedDependencies: SnapshotDependency[] = dependencyRows.map((r) => ({
    taskId: r.task_id, title: r.title, milestoneId: r.milestone_id, dependsOnTaskId: r.depends_on_task_id,
    dependsOnTitle: r.depends_on_title, dependsOnStatus: r.depends_on_status,
  }));

  return {
    currentFocus: inProgressMilestones.map(mapMilestone),
    inProgressTasks,
    blockedMilestones: blockedMilestoneRows.map(mapMilestone),
    blockedTasks,
    nextActions,
    pendingAcceptance,
    unresolvedDependencies,
    recentlyCompletedTasks,
  };
}

type MemoryRowForSnapshot = { id: string; type: string; title: string; importance: string };

export async function loadPinnedMemorySnapshot(db: Executor, projectId: string): Promise<SnapshotMemory[]> {
  const { rows } = await db.query<MemoryRowForSnapshot>(
    `SELECT id, type, title, importance FROM project_memory_entries
      WHERE project_id=$1 AND is_pinned AND archived_at IS NULL AND superseded_by_id IS NULL
      ORDER BY created_at DESC`,
    [projectId],
  );
  return rows;
}

export async function loadImportantMemorySnapshot(db: Executor, projectId: string): Promise<SnapshotMemory[]> {
  const { rows } = await db.query<MemoryRowForSnapshot>(
    `SELECT id, type, title, importance FROM project_memory_entries
      WHERE project_id=$1 AND archived_at IS NULL AND superseded_by_id IS NULL
        AND importance IN ('important','critical') AND type IN ('decision','constraint')
      ORDER BY (importance = 'critical') DESC, created_at DESC`,
    [projectId],
  );
  return rows;
}

export async function buildCheckpointSnapshot(
  db: Executor, projectId: string, project: { name: string; status: string },
): Promise<CheckpointSnapshot> {
  // Sequential for the same reason as loadRawProjectData: a transaction
  // client cannot run overlapping queries.
  const raw = await loadRawProjectData(db, projectId);
  const pinnedMemory = await loadPinnedMemorySnapshot(db, projectId);
  const importantMemoryRaw = await loadImportantMemorySnapshot(db, projectId);
  const pinnedIds = new Set(pinnedMemory.map((m) => m.id));
  const importantMemory = importantMemoryRaw.filter((m) => !pinnedIds.has(m.id));
  const recentAgentActivity = await loadRecentAgentActivity(db, projectId, RECENT_AGENT_ACTIVITY_LIMIT);

  return {
    version: 2,
    recentAgentActivity,
    projectId,
    projectName: project.name,
    projectStatus: project.status,
    generatedAt: new Date().toISOString(),
    currentFocus: raw.currentFocus,
    inProgressTasks: raw.inProgressTasks,
    blockedMilestones: raw.blockedMilestones,
    blockedTasks: raw.blockedTasks,
    nextActions: raw.nextActions,
    pendingAcceptance: raw.pendingAcceptance,
    unresolvedDependencies: raw.unresolvedDependencies,
    recentlyCompletedTasks: raw.recentlyCompletedTasks,
    pinnedMemory: pinnedMemory as CheckpointSnapshot['pinnedMemory'],
    importantMemory: importantMemory as CheckpointSnapshot['importantMemory'],
  };
}
