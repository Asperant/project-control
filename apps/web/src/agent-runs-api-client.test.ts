import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setCsrfToken } from './api-client';

/**
 * Agent Run API client additions: URL/query construction, method/body shape,
 * CSRF propagation, and response parsing against the shared contract schemas.
 * Mirrors the stubbed-fetch approach in memory-api-client.test.ts — no
 * component rendering here, only request/response contract checks.
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
const RUN_ID = '00000000-0000-4000-8000-000000000002';
const PROMPT_ID = '00000000-0000-4000-8000-000000000003';
const REPORT_ID = '00000000-0000-4000-8000-000000000004';
const ENTRY_ID = '00000000-0000-4000-8000-000000000005';

const agentRun = {
  id: RUN_ID, projectId: PROJECT_ID, title: 'Investigate flaky test', agentName: 'Claude', status: 'draft',
  relatedMilestoneId: null, relatedMilestoneTitle: null, relatedTaskId: null, relatedTaskTitle: null,
  validationStatus: 'not_reviewed', validationNote: null, validatedBy: null, validatedAt: null,
  sentAt: null, startedAt: null, completedAt: null, failedAt: null, cancelledAt: null,
  createdBy: null, createdAt: '2026-08-04T10:00:00.000Z', updatedAt: '2026-08-04T10:00:00.000Z', archivedAt: null,
  hasPrompt: false, currentReportVersion: null,
};

const agentPrompt = {
  id: PROMPT_ID, agentRunId: RUN_ID, promptVersion: 1, body: 'Please investigate.', status: 'draft',
  sentAt: null, createdAt: '2026-08-04T10:00:00.000Z', updatedAt: '2026-08-04T10:00:00.000Z',
};

const agentReport = {
  id: REPORT_ID, agentRunId: RUN_ID, version: 1, body: 'Findings.', status: 'draft',
  supersedesReportId: null, supersededById: null, finalizedAt: null,
  createdBy: null, createdAt: '2026-08-04T10:00:00.000Z', updatedAt: '2026-08-04T10:00:00.000Z',
};

const memoryEntry = {
  id: ENTRY_ID, projectId: PROJECT_ID, type: 'finding', title: 'Root cause', body: 'It was X.',
  importance: 'normal', isPinned: false, status: 'active',
  relatedTaskId: null, relatedTaskTitle: null, relatedMilestoneId: null, relatedMilestoneTitle: null,
  supersededById: null, supersededByTitle: null, supersedesIds: [],
  sourceAgentRunId: RUN_ID, sourceAgentRunTitle: agentRun.title,
  archivedAt: null, createdBy: null, createdAt: '2026-08-04T10:00:00.000Z', updatedAt: '2026-08-04T10:00:00.000Z',
};

describe('agent runs', () => {
  it('builds the query string from list filters', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agentRuns: [agentRun] }));
    await api.listAgentRuns(PROJECT_ID, { search: 'flaky', status: 'draft', agentName: 'Claude', validationStatus: 'not_reviewed' });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/agent-runs?search=flaky&status=draft&agentName=Claude&validationStatus=not_reviewed`);
  });

  it('omits filters entirely when none are set', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agentRuns: [] }));
    await api.listAgentRuns(PROJECT_ID);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/agent-runs`);
  });

  it('posts a well-formed create request with the CSRF header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agentRun }, { status: 201 }));
    await api.createAgentRun(PROJECT_ID, { title: 'Investigate flaky test', agentName: 'Claude' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/agent-runs`);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('c'.repeat(43));
    expect(JSON.parse(init.body as string)).toMatchObject({ title: 'Investigate flaky test', agentName: 'Claude' });
  });

  it('sends a status transition with no query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agentRun: { ...agentRun, status: 'in_progress' } }));
    await api.setAgentRunStatus(PROJECT_ID, RUN_ID, { status: 'in_progress' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/status`);
    expect(JSON.parse(init.body as string)).toEqual({ status: 'in_progress' });
  });

  it('archives, reactivates and duplicates with no body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agentRun: { ...agentRun, archivedAt: '2026-08-05T00:00:00.000Z' } }));
    await api.archiveAgentRun(PROJECT_ID, RUN_ID);
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse({ agentRun }));
    await api.reactivateAgentRun(PROJECT_ID, RUN_ID);
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].body).toBeUndefined();

    fetchMock.mockResolvedValue(jsonResponse({ agentRun: { ...agentRun, id: '00000000-0000-4000-8000-000000000009' }, prompt: null }));
    const dup = await api.duplicateAgentRun(PROJECT_ID, RUN_ID);
    expect((fetchMock.mock.calls[2] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/duplicate`);
    expect(dup.prompt).toBeNull();
  });

  it('gets, edits and sends the prompt', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ prompt: agentPrompt }));
    await api.getAgentRunPrompt(PROJECT_ID, RUN_ID);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/prompt`);

    fetchMock.mockResolvedValue(jsonResponse({ prompt: { ...agentPrompt, body: 'Updated' } }));
    await api.updateAgentRunPrompt(PROJECT_ID, RUN_ID, { body: 'Updated' });
    const [, editInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(editInit.method).toBe('PATCH');

    fetchMock.mockResolvedValue(jsonResponse({ prompt: { ...agentPrompt, status: 'sent', sentAt: '2026-08-05T00:00:00.000Z' }, agentRun: { ...agentRun, status: 'sent' } }));
    const sent = await api.sendAgentRunPrompt(PROJECT_ID, RUN_ID);
    expect((fetchMock.mock.calls[2] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/prompt/send`);
    expect(sent.prompt.status).toBe('sent');
    expect(sent.agentRun.status).toBe('sent');
  });

  it('a nullable prompt response parses cleanly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ prompt: null }));
    const response = await api.getAgentRunPrompt(PROJECT_ID, RUN_ID);
    expect(response.prompt).toBeNull();
  });

  it('lists, creates, edits and finalizes reports', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ reports: [agentReport] }));
    await api.listAgentReports(PROJECT_ID, RUN_ID);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/reports`);

    fetchMock.mockResolvedValue(jsonResponse({ report: agentReport }, { status: 201 }));
    await api.createAgentReport(PROJECT_ID, RUN_ID, { body: 'Findings.' });
    expect((fetchMock.mock.calls[1] as [string, RequestInit])[1].method).toBe('POST');

    fetchMock.mockResolvedValue(jsonResponse({ report: { ...agentReport, body: 'Edited.' } }));
    await api.updateAgentReport(PROJECT_ID, RUN_ID, REPORT_ID, { body: 'Edited.' });
    expect((fetchMock.mock.calls[2] as [string])[0]).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/reports/${REPORT_ID}`);

    fetchMock.mockResolvedValue(jsonResponse({ report: { ...agentReport, status: 'final', finalizedAt: '2026-08-05T00:00:00.000Z' }, supersededReport: null }));
    const finalized = await api.finalizeAgentReport(PROJECT_ID, RUN_ID, REPORT_ID);
    expect(finalized.report.status).toBe('final');
    expect(finalized.supersededReport).toBeNull();
  });

  it('updates validation without leaking a note field when omitted', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ agentRun: { ...agentRun, validationStatus: 'accepted' } }));
    await api.updateAgentRunValidation(PROJECT_ID, RUN_ID, { status: 'accepted' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/validation`);
    expect(JSON.parse(init.body as string)).toEqual({ status: 'accepted' });
  });

  it('fetches the timeline and related memory', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ timeline: [{ id: '1', occurredAt: '2026-08-04T10:00:00.000Z', eventType: 'agentrun.created', label: 'Agent Run created', outcome: 'success', actorUserId: null }] }));
    const timeline = await api.getAgentRunTimeline(PROJECT_ID, RUN_ID);
    expect(timeline.timeline).toHaveLength(1);

    fetchMock.mockResolvedValue(jsonResponse({ entries: [memoryEntry] }));
    const related = await api.getRelatedMemory(PROJECT_ID, RUN_ID);
    expect(related.entries[0]?.sourceAgentRunId).toBe(RUN_ID);
  });

  it('promotes to memory with a normal memory-entry request body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ entry: memoryEntry }, { status: 201 }));
    await api.promoteAgentRunToMemory(PROJECT_ID, RUN_ID, { type: 'finding', title: 'Root cause', body: 'It was X.', importance: 'normal', isPinned: false });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/projects/${PROJECT_ID}/agent-runs/${RUN_ID}/promote-memory`);
    expect(JSON.parse(init.body as string)).toMatchObject({ type: 'finding', title: 'Root cause' });
  });
});
