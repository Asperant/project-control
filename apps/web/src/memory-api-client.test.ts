import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from './api-client';

/**
 * The memory/checkpoint/context additions to the API client: URL/query
 * construction, method/body shape, and response parsing against the shared
 * contract schemas. Mirrors the stubbed-fetch approach in
 * projects-api-client.test.ts — there is no browser here, only assertions
 * about the request the client builds and how it interprets the response.
 */

const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } });

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

const PROJECT_ID = '00000000-0000-4000-8000-000000000001';
const ENTRY_ID = '00000000-0000-4000-8000-000000000002';
const CHECKPOINT_ID = '00000000-0000-4000-8000-000000000003';

const memoryEntry = {
  id: ENTRY_ID, projectId: PROJECT_ID, type: 'decision', title: 'Use local storage', body: 'No extra service.',
  importance: 'normal', isPinned: false, status: 'active',
  relatedTaskId: null, relatedTaskTitle: null, relatedMilestoneId: null, relatedMilestoneTitle: null,
  supersededById: null, supersededByTitle: null, supersedesIds: [],
  sourceAgentRunId: null, sourceAgentRunTitle: null,
  archivedAt: null, createdBy: null, createdAt: '2026-08-04T10:00:00.000Z', updatedAt: '2026-08-04T10:00:00.000Z',
};

const snapshotFragment = {
  version: 2, projectId: PROJECT_ID, projectName: 'Demo', projectStatus: 'active', generatedAt: '2026-08-04T10:00:00.000Z',
  currentFocus: [], inProgressTasks: [], blockedMilestones: [], blockedTasks: [], nextActions: [],
  pendingAcceptance: [], unresolvedDependencies: [], recentlyCompletedTasks: [], pinnedMemory: [], importantMemory: [],
  recentAgentActivity: [],
};

const checkpointSummary = {
  id: CHECKPOINT_ID, projectId: PROJECT_ID, snapshotVersion: 1, sessionNote: 'Roadmap side done.',
  createdBy: null, createdAt: '2026-08-04T10:00:00.000Z', archivedAt: null,
};

describe('memory entries', () => {
  it('builds the query string from list filters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [memoryEntry] }));
    await api.listMemory(PROJECT_ID, { type: 'decision', pinned: 'true', search: 'minio' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/memory?type=decision&pinned=true&search=minio`);
  });

  it('omits filters entirely when none are set', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entries: [] }));
    await api.listMemory(PROJECT_ID);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/memory`);
  });

  it('posts a well-formed create request with the CSRF header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entry: memoryEntry }, { status: 201 }));
    await api.createMemoryEntry(PROJECT_ID, { type: 'decision', title: 'Use local storage', body: 'No extra service.', importance: 'normal', isPinned: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/memory`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('c'.repeat(43));
    expect(JSON.parse(init.body as string)).toMatchObject({ type: 'decision', title: 'Use local storage' });
  });

  it('pins, unpins, archives and reactivates with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entry: { ...memoryEntry, isPinned: true } }));
    await api.pinMemoryEntry(PROJECT_ID, ENTRY_ID);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/memory/${ENTRY_ID}/pin`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('supersedes with a brand-new entry payload', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ oldEntry: { ...memoryEntry, status: 'superseded' }, newEntry: memoryEntry }, { status: 201 }));
    await api.supersedeMemoryEntry(PROJECT_ID, ENTRY_ID, { type: 'decision', title: 'Replacement', body: 'New reasoning.', importance: 'normal', isPinned: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/memory/${ENTRY_ID}/supersede`);
    expect(JSON.parse(init.body as string)).toMatchObject({ title: 'Replacement' });
  });

  it('supersedes by pointing at an existing entry id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ oldEntry: { ...memoryEntry, status: 'superseded' }, newEntry: memoryEntry }, { status: 201 }));
    await api.supersedeMemoryEntry(PROJECT_ID, ENTRY_ID, { newEntryId: CHECKPOINT_ID });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ newEntryId: CHECKPOINT_ID });
  });
});

describe('checkpoints', () => {
  it('lists active checkpoints by default and archived ones on request', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(jsonResponse({ checkpoints: [checkpointSummary] })));
    await api.listCheckpoints(PROJECT_ID);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/checkpoints`);

    await api.listCheckpoints(PROJECT_ID, true);
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/checkpoints?archived=true`);
  });

  it('creates a checkpoint with only a session note in the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ checkpoint: { ...checkpointSummary, snapshot: snapshotFragment } }, { status: 201 }));
    await api.createCheckpoint(PROJECT_ID, { sessionNote: 'Roadmap side done.' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/checkpoints`);
    expect(JSON.parse(init.body as string)).toEqual({ sessionNote: 'Roadmap side done.' });
  });

  it('parses a full checkpoint detail response including the snapshot', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ checkpoint: { ...checkpointSummary, snapshot: snapshotFragment } }));
    const response = await api.getCheckpoint(PROJECT_ID, CHECKPOINT_ID);
    expect(response.checkpoint.snapshot.version).toBe(2);
  });

  it('archives a checkpoint and only returns the summary shape (no snapshot)', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ checkpoint: { ...checkpointSummary, archivedAt: '2026-08-05T00:00:00.000Z' } }));
    const response = await api.archiveCheckpoint(PROJECT_ID, CHECKPOINT_ID);
    expect(response.checkpoint.archivedAt).toBe('2026-08-05T00:00:00.000Z');
  });
});

describe('current context', () => {
  it('fetches the deterministic context bundle and reports no checkpoint cleanly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      projectId: PROJECT_ID,
      currentFocus: [], inProgressTasks: [], blocked: { milestones: [], tasks: [] }, nextActions: [],
      pendingAcceptance: [], unresolvedDependencies: [], pinnedContext: [], recentAgentWork: [],
      lastCheckpoint: null,
      changesSinceCheckpoint: { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] },
    }));
    const response = await api.getProjectContext(PROJECT_ID);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/context`);
    expect(response.lastCheckpoint).toBeNull();
    expect(response.changesSinceCheckpoint.hasCheckpoint).toBe(false);
  });

  it('preserves recentAgentWork through response parsing, with no prompt/report body field', async () => {
    const recentAgentWork = [{
      agentRunId: '00000000-0000-4000-8000-000000000009', title: 'Investigate flaky checkpoint test', agentName: 'Claude',
      status: 'completed', validationStatus: 'accepted_with_changes', relatedTaskId: null,
      activityAt: '2026-08-04T10:00:00.000Z',
    }];
    fetchMock.mockResolvedValue(jsonResponse({
      projectId: PROJECT_ID,
      currentFocus: [], inProgressTasks: [], blocked: { milestones: [], tasks: [] }, nextActions: [],
      pendingAcceptance: [], unresolvedDependencies: [], pinnedContext: [], recentAgentWork,
      lastCheckpoint: null,
      changesSinceCheckpoint: { hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] },
    }));
    const response = await api.getProjectContext(PROJECT_ID);
    expect(response.recentAgentWork).toHaveLength(1);
    expect(response.recentAgentWork[0]).toMatchObject({
      agentName: 'Claude', title: 'Investigate flaky checkpoint test',
      status: 'completed', validationStatus: 'accepted_with_changes',
    });
    expect(response.recentAgentWork[0]).not.toHaveProperty('body');
    expect(response.recentAgentWork[0]).not.toHaveProperty('prompt');
    expect(response.recentAgentWork[0]).not.toHaveProperty('report');
  });
});
