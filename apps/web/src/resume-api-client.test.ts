import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from './api-client';

const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } });

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const SESSION_ID = '00000000-0000-4000-8000-000000000002';
const AMENDMENT_ID = '00000000-0000-4000-8000-000000000003';

const workSession = {
  id: SESSION_ID,
  projectId: PROJECT_ID,
  goal: 'Ship the Resume UI',
  status: 'open',
  startedAt: '2026-08-15T08:00:00.000Z',
  endedAt: null,
  outcomeSummary: null,
  blockers: null,
  nextAction: null,
  checkpointId: null,
  createdBy: null,
  createdAt: '2026-08-15T08:00:00.000Z',
  updatedAt: '2026-08-15T08:00:00.000Z',
  amendments: [],
};

const resumeResponse = {
  projectId: PROJECT_ID,
  readOnly: false,
  currentFocus: { kind: 'work_session', workSessionId: SESSION_ID, goal: workSession.goal, startedAt: workSession.startedAt },
  recommendedNextAction: { kind: 'none_pending', message: 'No pending roadmap action.' },
  attentionRequired: {
    blockedTaskCount: 0,
    unresolvedDependencyCount: 0,
    incompleteAcceptanceCount: 0,
    agentRunsAwaitingValidationCount: 0,
    failedAgentRunCount: 0,
    openSessionHasBlockers: false,
    items: [],
  },
  activeWorkSession: workSession,
  lastSession: null,
  lastCheckpoint: null,
  changesSinceCheckpoint: { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] },
  activeAndBlockedWork: { active: [], blocked: [] },
  developmentState: {
    status: 'not_repository', errorCode: null, repository: { available: true, isRepository: false },
    head: { sha: null, shortSha: null, branch: null, detached: false, unborn: false },
    workingTree: { clean: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 0 },
    remote: null, github: { detected: false, configured: false, status: 'unsupported' },
    checkpointComparison: { status: 'no_git_checkpoint' }, attention: [],
  },
  recentAgentWork: [],
  importantMemory: [],
  workSessionHistory: { workSessions: [], page: 1, pageSize: 20, total: 0 },
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  setCsrfToken('c'.repeat(43));
});

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken(null);
});

describe('project resume', () => {
  it('loads the purpose-built response without making a frontend task selection', async () => {
    fetchMock.mockResolvedValue(jsonResponse(resumeResponse));
    const response = await api.getProjectResume(PROJECT_ID);

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/resume`);
    expect(response.currentFocus.kind).toBe('work_session');
    expect(response.recommendedNextAction.kind).toBe('none_pending');
  });
});

describe('project development', () => {
  it('parses the coherent read-only Development response', async () => {
    const responseBody = {
      projectId: PROJECT_ID, status: 'not_repository', errorCode: null,
      repository: { available: true, isRepository: false },
      head: { sha: null, shortSha: null, branch: null, detached: false, unborn: false },
      workingTree: { clean: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 0 },
      files: [], filesTruncated: false, recentCommits: [], remote: null,
      github: { detected: false, configured: false, status: 'unsupported' },
      checkpointComparison: { status: 'no_git_checkpoint' },
      attention: [{ key: 'repository_not_detected', label: 'The registered folder is not a Git repository', count: 1 }],
    };
    fetchMock.mockResolvedValue(jsonResponse(responseBody));
    const response = await api.getProjectDevelopment(PROJECT_ID);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/development`);
    expect(response.status).toBe('not_repository');
  });
});

describe('work sessions', () => {
  it('uses page and pageSize for bounded history loading', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workSessions: [workSession], page: 2, pageSize: 20, total: 21 }));
    const response = await api.listWorkSessions(PROJECT_ID, { page: 2, pageSize: 20 });

    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/work-sessions?page=2&pageSize=20`);
    expect(response.page).toBe(2);
  });

  it('gets and starts a session through explicit project-scoped routes', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ workSession }));
    await api.getWorkSession(PROJECT_ID, SESSION_ID);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/work-sessions/${SESSION_ID}`);

    fetchMock.mockResolvedValueOnce(jsonResponse({ workSession }, { status: 201 }));
    await api.startWorkSession(PROJECT_ID, { goal: workSession.goal });
    const [url, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/work-sessions`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ goal: workSession.goal });
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('c'.repeat(43));
  });

  it('updates only the open-session goal', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ workSession: { ...workSession, goal: 'Updated goal' } }));
    await api.updateWorkSession(PROJECT_ID, SESSION_ID, { goal: 'Updated goal' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/work-sessions/${SESSION_ID}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ goal: 'Updated goal' });
  });

  it('closes with outcome, optional continuity fields and checkpoint confirmation', async () => {
    const closed = { ...workSession, status: 'closed', endedAt: '2026-08-15T10:00:00.000Z', outcomeSummary: 'Resume UI shipped.' };
    fetchMock.mockResolvedValue(jsonResponse({ workSession: closed }));
    await api.closeWorkSession(PROJECT_ID, SESSION_ID, {
      outcomeSummary: 'Resume UI shipped.',
      blockers: 'Visual smoke test remains.',
      nextAction: 'Run the browser checks.',
      createCheckpoint: true,
      checkpointSessionNote: 'Frontend slice complete.',
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/work-sessions/${SESSION_ID}/close`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toMatchObject({ outcomeSummary: 'Resume UI shipped.', createCheckpoint: true });
  });

  it('adds an append-only correction through the amendments endpoint', async () => {
    const amendment = { id: AMENDMENT_ID, workSessionId: SESSION_ID, body: 'Corrected outcome detail.', createdBy: null, createdAt: '2026-08-15T11:00:00.000Z' };
    fetchMock.mockResolvedValue(jsonResponse({ amendment }, { status: 201 }));
    const response = await api.addWorkSessionAmendment(PROJECT_ID, SESSION_ID, { body: amendment.body });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/work-sessions/${SESSION_ID}/amendments`);
    expect(init.method).toBe('POST');
    expect(response.amendment.id).toBe(AMENDMENT_ID);
  });
});
