import type { RoadmapPriority, RoadmapStatus } from '@project-control/contracts';

/**
 * The compact roadmap facts needed to choose a Resume focus/action. Keeping
 * the selector pure makes the product policy independently testable and keeps
 * ordering logic out of both SQL and the React client.
 */
export type ResumeTaskCandidate = {
  id: string;
  milestoneId: string;
  milestoneTitle: string;
  title: string;
  status: RoadmapStatus;
  priority: RoadmapPriority;
  milestoneStatus: RoadmapStatus;
  milestoneArchived: boolean;
  milestonePosition: number;
  position: number;
  nextAction: string;
  firstIncompleteCriterion: string | null;
  unresolvedDependencyCount: number;
};

export type SelectedRoadmapTask = {
  taskId: string;
  milestoneId: string;
  milestoneTitle: string;
  taskTitle: string;
  taskStatus: 'planned' | 'in_progress';
  priority: RoadmapPriority;
};

export type RecommendedRoadmapAction =
  | ({ kind: 'roadmap_task'; action: string; actionSource: 'next_action' | 'acceptance_criterion' | 'task_title' } & SelectedRoadmapTask)
  | { kind: 'blocked'; message: string; blockedTaskCount: number; dependencyBlockedTaskCount: number }
  | { kind: 'none_pending'; message: string };

const PRIORITY_RANK: Record<RoadmapPriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export function hasActionableResumeContainer(task: ResumeTaskCandidate): boolean {
  return !task.milestoneArchived && task.milestoneStatus !== 'blocked'
    && task.milestoneStatus !== 'done' && task.milestoneStatus !== 'cancelled';
}

export function isVisibleResumeWork(task: ResumeTaskCandidate): boolean {
  return !task.milestoneArchived && task.milestoneStatus !== 'done' && task.milestoneStatus !== 'cancelled'
    && task.status !== 'done' && task.status !== 'cancelled';
}

function compareWithinLifecycle(a: ResumeTaskCandidate, b: ResumeTaskCandidate): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || a.milestonePosition - b.milestonePosition
    || a.position - b.position
    || a.id.localeCompare(b.id);
}

function selectedTask(task: ResumeTaskCandidate): SelectedRoadmapTask {
  return {
    taskId: task.id,
    milestoneId: task.milestoneId,
    milestoneTitle: task.milestoneTitle,
    taskTitle: task.title,
    taskStatus: task.status as 'planned' | 'in_progress',
    priority: task.priority,
  };
}

export function selectCurrentFocusTask(tasks: ResumeTaskCandidate[]): SelectedRoadmapTask | null {
  const available = tasks.filter(hasActionableResumeContainer);
  const inProgress = available.filter((task) => task.status === 'in_progress').sort(compareWithinLifecycle);
  if (inProgress[0]) return selectedTask(inProgress[0]);

  const plannedEligible = available
    .filter((task) => task.status === 'planned' && task.unresolvedDependencyCount === 0)
    .sort(compareWithinLifecycle);
  return plannedEligible[0] ? selectedTask(plannedEligible[0]) : null;
}

export function selectRecommendedRoadmapAction(tasks: ResumeTaskCandidate[]): RecommendedRoadmapAction {
  const eligible = tasks
    .filter((task) => hasActionableResumeContainer(task))
    .filter((task) => (task.status === 'in_progress' || task.status === 'planned') && task.unresolvedDependencyCount === 0)
    .sort((a, b) => {
      const lifecycle = (a.status === 'in_progress' ? 0 : 1) - (b.status === 'in_progress' ? 0 : 1);
      return lifecycle || compareWithinLifecycle(a, b);
    });

  const task = eligible[0];
  if (task) {
    const nextAction = task.nextAction.trim();
    const criterion = task.firstIncompleteCriterion?.trim() ?? '';
    const actionSource = nextAction ? 'next_action' : criterion ? 'acceptance_criterion' : 'task_title';
    return {
      kind: 'roadmap_task',
      ...selectedTask(task),
      action: nextAction || criterion || task.title,
      actionSource,
    };
  }

  const blockedTaskCount = tasks.filter((task) =>
    isVisibleResumeWork(task) && (task.status === 'blocked' || task.milestoneStatus === 'blocked'),
  ).length;
  const dependencyBlockedTaskCount = tasks.filter((task) =>
    hasActionableResumeContainer(task)
      && (task.status === 'planned' || task.status === 'in_progress')
      && task.unresolvedDependencyCount > 0,
  ).length;
  if (blockedTaskCount > 0 || dependencyBlockedTaskCount > 0) {
    const total = blockedTaskCount + dependencyBlockedTaskCount;
    return {
      kind: 'blocked',
      message: `${total} roadmap task${total === 1 ? ' is' : 's are'} blocked or waiting on dependencies.`,
      blockedTaskCount,
      dependencyBlockedTaskCount,
    };
  }

  return { kind: 'none_pending', message: 'There is no pending roadmap action.' };
}
