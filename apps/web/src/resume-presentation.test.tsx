import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ResumeProjectResponse, WorkSession } from '@project-control/contracts';
import { ResumeView } from './components/resume/ResumeView';

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const CHECKPOINT_ID = '00000000-0000-4000-8000-000000000003';
const NOW = '2026-08-15T10:00:00.000Z';

function session(status: 'open' | 'closed'): WorkSession {
  return {
    id: SESSION_ID,
    projectId: PROJECT_ID,
    goal: status === 'open' ? 'Finish the active flow' : 'Finish the historical flow',
    status,
    startedAt: NOW,
    endedAt: status === 'closed' ? '2026-08-15T11:00:00.000Z' : null,
    outcomeSummary: status === 'closed' ? 'The flow was completed.' : null,
    blockers: null,
    nextAction: status === 'closed' ? 'Run acceptance.' : null,
    checkpointId: status === 'closed' ? CHECKPOINT_ID : null,
    createdBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    amendments: status === 'closed' ? [{ id: '00000000-0000-4000-8000-000000000004', workSessionId: SESSION_ID, body: 'Correction text', createdBy: null, createdAt: NOW }] : [],
  };
}

function viewModel(overrides: Partial<ResumeProjectResponse> = {}): ResumeProjectResponse {
  return {
    projectId: PROJECT_ID,
    readOnly: false,
    currentFocus: { kind: 'none', message: 'No active project focus exists.' },
    recommendedNextAction: { kind: 'none_pending', message: 'There is no pending roadmap action.' },
    attentionRequired: { blockedTaskCount: 0, unresolvedDependencyCount: 0, incompleteAcceptanceCount: 0, agentRunsAwaitingValidationCount: 0, failedAgentRunCount: 0, openSessionHasBlockers: false, items: [] },
    activeWorkSession: null,
    lastSession: null,
    lastCheckpoint: null,
    changesSinceCheckpoint: { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] },
    activeAndBlockedWork: { active: [], blocked: [] },
    recentAgentWork: [],
    importantMemory: [],
    workSessionHistory: { workSessions: [], page: 1, pageSize: 20, total: 0, nextCursor: null },
    ...overrides,
  };
}

function render(data: ResumeProjectResponse): string {
  return renderToStaticMarkup(<ResumeView projectId={PROJECT_ID} canWrite archived={false} onSessionExpired={() => undefined} onOpenMemory={() => undefined} initialData={data} />);
}

describe('Resume presentation', () => {
  it('renders all eleven sections and explicit empty states in order', () => {
    const html = render(viewModel());
    const headings = Array.from(html.matchAll(/<h3[^>]*>(\d+)\./g), (match) => Number(match[1]));
    expect(headings).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(html).toContain('No active project focus exists.');
    expect(html).toContain('No completed work session yet.');
    expect(html).toContain('No checkpoint has been created.');
  });

  it('renders active and closed session state, linked checkpoint and amendments', () => {
    const open = session('open');
    const closed = session('closed');
    const html = render(viewModel({
      currentFocus: { kind: 'work_session', workSessionId: open.id, goal: open.goal, startedAt: open.startedAt },
      activeWorkSession: open,
      lastSession: closed,
      workSessionHistory: { workSessions: [closed], page: 1, pageSize: 20, total: 1, nextCursor: null },
    }));
    expect(html).toContain('Finish the active flow');
    expect(html).toContain('The flow was completed.');
    expect(html).toContain('View linked checkpoint');
    expect(html).toContain('Correction text');
  });

  it('renders the action supplied by the API without deriving another one', () => {
    const html = render(viewModel({
      recommendedNextAction: {
        kind: 'roadmap_task', taskId: SESSION_ID, milestoneId: CHECKPOINT_ID, milestoneTitle: 'Milestone',
        taskTitle: 'Task title fallback', taskStatus: 'planned', priority: 'high', action: 'API-selected acceptance step', actionSource: 'acceptance_criterion',
      },
    }));
    expect(html).toContain('API-selected acceptance step');
    expect(html).toContain('Based on: acceptance criterion');
  });
});
