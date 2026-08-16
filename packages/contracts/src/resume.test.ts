import { describe, expect, it } from 'vitest';
import {
  closeWorkSessionRequestSchema, resumeProjectResponseSchema, startWorkSessionRequestSchema,
  updateWorkSessionRequestSchema, workSessionSchema,
} from './resume.js';

describe('Work Session and Resume contracts', () => {
  it('requires trimmed non-empty goals and rejects unknown mutation fields', () => {
    expect(startWorkSessionRequestSchema.safeParse({ goal: '  Focus  ' }).data).toEqual({ goal: 'Focus' });
    expect(startWorkSessionRequestSchema.safeParse({ goal: '   ' }).success).toBe(false);
    expect(updateWorkSessionRequestSchema.safeParse({ goal: 'Focus', outcomeSummary: 'not editable here' }).success).toBe(false);
  });

  it('requires an outcome and only accepts a checkpoint note when checkpoint creation is selected', () => {
    expect(closeWorkSessionRequestSchema.safeParse({}).success).toBe(false);
    expect(closeWorkSessionRequestSchema.safeParse({ outcomeSummary: 'Done', checkpointSessionNote: 'note' }).success).toBe(false);
    expect(closeWorkSessionRequestSchema.safeParse({ outcomeSummary: 'Done', createCheckpoint: true, checkpointSessionNote: 'note' }).success).toBe(true);
  });

  it('preserves the server-selected recommended action discriminant', () => {
    const parsed = resumeProjectResponseSchema.safeParse({
      projectId: '00000000-0000-4000-8000-000000000001',
      readOnly: false,
      developmentState: resumeDevelopmentState(),
      currentFocus: { kind: 'none', message: 'No focus' },
      recommendedNextAction: { kind: 'none_pending', message: 'No action' },
      attentionRequired: {
        blockedTaskCount: 0, unresolvedDependencyCount: 0, incompleteAcceptanceCount: 0,
        agentRunsAwaitingValidationCount: 0, failedAgentRunCount: 0, openSessionHasBlockers: false, items: [],
      },
      activeWorkSession: null,
      lastSession: null,
      lastCheckpoint: null,
      changesSinceCheckpoint: { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] },
      activeAndBlockedWork: { active: [], blocked: [] },
      recentAgentWork: [],
      importantMemory: [],
      workSessionHistory: { workSessions: [], page: 1, pageSize: 20, total: 0 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.recommendedNextAction).toEqual({ kind: 'none_pending', message: 'No action' });
  });

  it('rejects lifecycle-invalid and open-history Work Session payloads', () => {
    const invalidOpen = workSessionForContract({ status: 'open', endedAt: '2026-08-15T10:00:00.000Z', outcomeSummary: 'Impossible' });
    expect(workSessionSchema.safeParse(invalidOpen).success).toBe(false);

    const response = baseResumeResponse();
    response.workSessionHistory.workSessions = [workSessionForContract({ status: 'open' })];
    response.workSessionHistory.total = 1;
    expect(resumeProjectResponseSchema.safeParse(response).success).toBe(false);
  });
});

function workSessionForContract(overrides: Record<string, unknown> = {}): any {
  return {
    id: '00000000-0000-4000-8000-000000000002', projectId: '00000000-0000-4000-8000-000000000001',
    goal: 'Goal', status: 'open', startedAt: '2026-08-15T09:00:00.000Z', endedAt: null,
    outcomeSummary: null, blockers: null, nextAction: null, checkpointId: null, createdBy: null,
    createdAt: '2026-08-15T09:00:00.000Z', updatedAt: '2026-08-15T09:00:00.000Z', amendments: [], ...overrides,
  };
}

function baseResumeResponse(): any {
  return {
    projectId: '00000000-0000-4000-8000-000000000001', readOnly: false,
    developmentState: resumeDevelopmentState(),
    currentFocus: { kind: 'none', message: 'No focus' }, recommendedNextAction: { kind: 'none_pending', message: 'No action' },
    attentionRequired: { blockedTaskCount: 0, unresolvedDependencyCount: 0, incompleteAcceptanceCount: 0, agentRunsAwaitingValidationCount: 0, failedAgentRunCount: 0, openSessionHasBlockers: false, items: [] },
    activeWorkSession: null, lastSession: null, lastCheckpoint: null,
    changesSinceCheckpoint: { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] },
    activeAndBlockedWork: { active: [], blocked: [] }, recentAgentWork: [], importantMemory: [],
    workSessionHistory: { workSessions: [], page: 1, pageSize: 20, total: 0, nextCursor: null },
  };
}

function resumeDevelopmentState(): any {
  return {
    status: 'not_repository', errorCode: null,
    repository: { available: true, isRepository: false },
    head: { sha: null, shortSha: null, branch: null, detached: false, unborn: false },
    workingTree: { clean: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 0 },
    remote: null,
    github: { detected: false, configured: false, status: 'unsupported' },
    checkpointComparison: { status: 'no_git_checkpoint' },
    attention: [{ key: 'repository_not_detected', label: 'Not a Git repository', count: 1 }],
  };
}
