import { describe, expect, it } from 'vitest';
import { selectCurrentFocusTask, selectRecommendedRoadmapAction, type ResumeTaskCandidate } from './selector.js';

function task(overrides: Partial<ResumeTaskCandidate> = {}): ResumeTaskCandidate {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    milestoneId: '00000000-0000-4000-8000-000000000010',
    milestoneTitle: 'M1',
    title: 'Task',
    status: 'planned',
    priority: 'medium',
    milestoneStatus: 'in_progress',
    milestoneArchived: false,
    milestonePosition: 0,
    position: 0,
    nextAction: '',
    firstIncompleteCriterion: null,
    unresolvedDependencyCount: 0,
    ...overrides,
  };
}

describe('Resume roadmap selection', () => {
  it('prefers in-progress, then existing priority order, then roadmap order and stable id', () => {
    const result = selectRecommendedRoadmapAction([
      task({ id: '00000000-0000-4000-8000-000000000004', status: 'planned', priority: 'critical' }),
      task({ id: '00000000-0000-4000-8000-000000000003', status: 'in_progress', priority: 'high', position: 2 }),
      task({ id: '00000000-0000-4000-8000-000000000002', status: 'in_progress', priority: 'critical', milestonePosition: 1 }),
      task({ id: '00000000-0000-4000-8000-000000000001', status: 'in_progress', priority: 'critical', milestonePosition: 0, position: 1 }),
    ]);
    expect(result).toMatchObject({ kind: 'roadmap_task', taskId: '00000000-0000-4000-8000-000000000001' });
  });

  it.each([
    { status: 'done' as const },
    { status: 'cancelled' as const },
    { status: 'blocked' as const },
    { unresolvedDependencyCount: 1 },
    { milestoneStatus: 'blocked' as const },
    { milestoneArchived: true },
  ])('excludes unavailable work: %o', (overrides) => {
    const result = selectRecommendedRoadmapAction([task({ ...overrides, title: 'Unavailable' }), task({ id: '00000000-0000-4000-8000-000000000099', title: 'Eligible' })]);
    expect(result).toMatchObject({ kind: 'roadmap_task', taskTitle: 'Eligible' });
  });

  it('derives action from next_action, then first incomplete criterion, then title', () => {
    expect(selectRecommendedRoadmapAction([task({ nextAction: '  Ship it  ', firstIncompleteCriterion: 'Criterion' })])).toMatchObject({ action: 'Ship it', actionSource: 'next_action' });
    expect(selectRecommendedRoadmapAction([task({ firstIncompleteCriterion: '  Verify it  ' })])).toMatchObject({ action: 'Verify it', actionSource: 'acceptance_criterion' });
    expect(selectRecommendedRoadmapAction([task({ title: 'Fallback title' })])).toMatchObject({ action: 'Fallback title', actionSource: 'task_title' });
  });

  it('returns blocker-oriented and genuinely-empty states explicitly', () => {
    expect(selectRecommendedRoadmapAction([task({ status: 'blocked' }), task({ id: '00000000-0000-4000-8000-000000000002', unresolvedDependencyCount: 1 })])).toMatchObject({ kind: 'blocked', blockedTaskCount: 1, dependencyBlockedTaskCount: 1 });
    expect(selectRecommendedRoadmapAction([task({ status: 'done' })])).toEqual({ kind: 'none_pending', message: 'There is no pending roadmap action.' });
  });

  it('does not invent blockers from archived or completed containers', () => {
    expect(selectRecommendedRoadmapAction([task({ status: 'blocked', milestoneArchived: true })])).toMatchObject({ kind: 'none_pending' });
    expect(selectRecommendedRoadmapAction([task({ status: 'blocked', milestoneStatus: 'done' })])).toMatchObject({ kind: 'none_pending' });
    expect(selectRecommendedRoadmapAction([task({ status: 'done', milestoneStatus: 'blocked' })])).toMatchObject({ kind: 'none_pending' });
  });

  it('uses an in-progress task for focus even when its dependency is unresolved, then eligible planned work', () => {
    expect(selectCurrentFocusTask([task({ status: 'in_progress', unresolvedDependencyCount: 1 })])).toMatchObject({ taskStatus: 'in_progress' });
    expect(selectCurrentFocusTask([task({ status: 'planned', unresolvedDependencyCount: 1 }), task({ id: '00000000-0000-4000-8000-000000000002', title: 'Ready' })])).toMatchObject({ taskTitle: 'Ready' });
  });

  it('is stable across repeated calls', () => {
    const tasks = [task({ id: '00000000-0000-4000-8000-000000000002' }), task({ id: '00000000-0000-4000-8000-000000000001' })];
    expect(selectRecommendedRoadmapAction(tasks)).toEqual(selectRecommendedRoadmapAction([...tasks].reverse()));
  });
});
