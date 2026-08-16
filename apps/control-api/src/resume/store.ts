import type {
  MemoryEntry, ResumeProjectResponse, RoadmapPriority, RoadmapStatus,
} from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';
import { getProjectGuard } from '../projects/guard.js';
import { getProjectContext } from '../context/store.js';
import { listMemory } from '../memory/store.js';
import { getLastClosedWorkSession, getOpenWorkSession, listWorkSessions } from '../work-sessions/store.js';
import {
  selectCurrentFocusTask, selectRecommendedRoadmapAction, type ResumeTaskCandidate,
  isVisibleResumeWork,
} from './selector.js';
import type { RunnerClient } from '../runner/client.js';
import { getProjectDevelopment } from '../development/service.js';

type CandidateRow = {
  id: string;
  milestone_id: string;
  milestone_title: string;
  title: string;
  status: RoadmapStatus;
  priority: RoadmapPriority;
  milestone_status: RoadmapStatus;
  milestone_archived: boolean;
  milestone_position: number;
  task_position: number;
  next_action: string;
  first_incomplete_criterion: string | null;
  unresolved_dependency_count: number;
};

async function loadResumeCandidates(db: Executor, projectId: string): Promise<ResumeTaskCandidate[]> {
  const { rows } = await db.query<CandidateRow>(
    `SELECT t.id, t.milestone_id, m.title AS milestone_title, t.title, t.status, t.priority,
            m.status AS milestone_status, (m.archived_at IS NOT NULL) AS milestone_archived,
            m.sort_order AS milestone_position, t.sort_order AS task_position, t.next_action,
            (SELECT c.text FROM task_acceptance_criteria c
              WHERE c.task_id=t.id AND NOT c.is_completed
              ORDER BY c.sort_order, c.created_at, c.id LIMIT 1) AS first_incomplete_criterion,
            (SELECT count(*)::int FROM task_dependencies d
              JOIN roadmap_tasks dependency ON dependency.id=d.depends_on_task_id
              WHERE d.task_id=t.id AND dependency.status <> 'done') AS unresolved_dependency_count
       FROM roadmap_tasks t
       JOIN roadmap_milestones m ON m.id=t.milestone_id
      WHERE m.project_id=$1`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    milestoneId: row.milestone_id,
    milestoneTitle: row.milestone_title,
    title: row.title,
    status: row.status,
    priority: row.priority,
    milestoneStatus: row.milestone_status,
    milestoneArchived: row.milestone_archived,
    milestonePosition: row.milestone_position,
    position: row.task_position,
    nextAction: row.next_action,
    firstIncompleteCriterion: row.first_incomplete_criterion,
    unresolvedDependencyCount: Number(row.unresolved_dependency_count),
  }));
}

async function loadAgentAttention(
  db: Executor, projectId: string,
): Promise<{ awaiting_validation: number; failed: number }> {
  const { rows } = await db.query<{ awaiting_validation: number; failed: number }>(
    `SELECT
       count(*) FILTER (WHERE status='completed' AND validation_status IN ('not_reviewed','under_review'))::int AS awaiting_validation,
       count(*) FILTER (WHERE status='failed')::int AS failed
       FROM agent_runs WHERE project_id=$1 AND archived_at IS NULL`,
    [projectId],
  );
  return rows[0] ?? { awaiting_validation: 0, failed: 0 };
}

function compareImportantMemory(a: MemoryEntry, b: MemoryEntry): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  const rank = { critical: 0, important: 1, normal: 2 } as const;
  const importance = rank[a.importance] - rank[b.importance];
  if (importance) return importance;
  const aDecision = a.type === 'decision' || a.type === 'constraint';
  const bDecision = b.type === 'decision' || b.type === 'constraint';
  if (aDecision !== bDecision) return aDecision ? -1 : 1;
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

function workItem(task: {
  taskId: string; milestoneId: string; milestoneTitle: string; title: string;
  status: RoadmapStatus; blockedReason: string | null; nextAction: string;
}): ResumeProjectResponse['activeAndBlockedWork']['active'][number] {
  return {
    taskId: task.taskId,
    milestoneId: task.milestoneId,
    milestoneTitle: task.milestoneTitle,
    title: task.title,
    status: task.status as 'in_progress' | 'blocked',
    blockedReason: task.blockedReason,
    nextAction: task.nextAction,
  };
}

export async function getProjectResume(
  db: Executor, runner: RunnerClient, projectId: string, requestId?: string,
): Promise<ResumeProjectResponse> {
  const [project, context, candidates, activeWorkSession, lastSession, history, allMemory, agentAttention, development] = await Promise.all([
    getProjectGuard(db, projectId),
    getProjectContext(db, projectId),
    loadResumeCandidates(db, projectId),
    getOpenWorkSession(db, projectId),
    getLastClosedWorkSession(db, projectId),
    listWorkSessions(db, projectId, { page: 1, pageSize: 20, status: 'closed' }),
    listMemory(db, projectId, {}),
    loadAgentAttention(db, projectId),
    getProjectDevelopment(db, runner, projectId, requestId),
  ]);

  const roadmapFocus = selectCurrentFocusTask(candidates);
  const visibleTaskIds = new Set(candidates.filter(isVisibleResumeWork).map((task) => task.id));
  const currentFocus: ResumeProjectResponse['currentFocus'] = activeWorkSession
    ? { kind: 'work_session', workSessionId: activeWorkSession.id, goal: activeWorkSession.goal, startedAt: activeWorkSession.startedAt }
    : roadmapFocus
      ? { kind: 'roadmap_task', ...roadmapFocus }
      : { kind: 'none', message: 'No active project focus exists.' };

  const visibleBlockedTasks = context.blocked.tasks.filter((task) => visibleTaskIds.has(task.taskId));
  const visibleDependencies = context.unresolvedDependencies.filter((item) => visibleTaskIds.has(item.taskId));
  const visibleAcceptance = context.pendingAcceptance.filter((item) => visibleTaskIds.has(item.taskId));
  const blockedTaskCount = visibleBlockedTasks.length;
  const unresolvedDependencyCount = visibleDependencies.length;
  const incompleteAcceptanceCount = visibleAcceptance.reduce((total, item) => total + item.pendingCount, 0);
  const openSessionHasBlockers = Boolean(activeWorkSession?.blockers?.trim());
  const items: ResumeProjectResponse['attentionRequired']['items'] = [];
  if (blockedTaskCount) items.push({ key: 'blocked_tasks', count: blockedTaskCount, label: `${blockedTaskCount} blocked roadmap task${blockedTaskCount === 1 ? '' : 's'}` });
  if (unresolvedDependencyCount) items.push({ key: 'unresolved_dependencies', count: unresolvedDependencyCount, label: `${unresolvedDependencyCount} unresolved dependenc${unresolvedDependencyCount === 1 ? 'y' : 'ies'}` });
  if (incompleteAcceptanceCount) items.push({ key: 'incomplete_acceptance', count: incompleteAcceptanceCount, label: `${incompleteAcceptanceCount} incomplete acceptance criteri${incompleteAcceptanceCount === 1 ? 'on' : 'a'}` });
  if (agentAttention.awaiting_validation) items.push({ key: 'agent_runs_awaiting_validation', count: agentAttention.awaiting_validation, label: `${agentAttention.awaiting_validation} Agent Run${agentAttention.awaiting_validation === 1 ? '' : 's'} awaiting validation` });
  if (agentAttention.failed) items.push({ key: 'failed_agent_runs', count: agentAttention.failed, label: `${agentAttention.failed} failed Agent Run${agentAttention.failed === 1 ? '' : 's'}` });
  if (openSessionHasBlockers) items.push({ key: 'open_session_blockers', count: 1, label: 'The open Work Session has recorded blockers' });
  items.push(...development.attention);

  const { projectId: _developmentProjectId, files: _files, filesTruncated: _filesTruncated, recentCommits: _recentCommits, ...developmentState } = development;

  return {
    projectId,
    readOnly: project.status === 'archived',
    developmentState,
    currentFocus,
    recommendedNextAction: selectRecommendedRoadmapAction(candidates),
    attentionRequired: {
      blockedTaskCount,
      unresolvedDependencyCount,
      incompleteAcceptanceCount,
      agentRunsAwaitingValidationCount: agentAttention.awaiting_validation,
      failedAgentRunCount: agentAttention.failed,
      openSessionHasBlockers,
      items,
    },
    activeWorkSession,
    lastSession,
    lastCheckpoint: context.lastCheckpoint,
    changesSinceCheckpoint: context.changesSinceCheckpoint,
    activeAndBlockedWork: {
      active: context.inProgressTasks.filter((task) => visibleTaskIds.has(task.taskId)).map(workItem),
      blocked: visibleBlockedTasks.map(workItem),
    },
    recentAgentWork: context.recentAgentWork,
    importantMemory: allMemory
      .filter((entry) => entry.isPinned || entry.importance === 'critical' || entry.importance === 'important')
      .sort(compareImportantMemory),
    workSessionHistory: {
      workSessions: history.workSessions,
      page: 1,
      pageSize: 20,
      total: history.total,
      nextCursor: history.nextCursor,
    },
  };
}
