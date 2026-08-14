import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, setCsrfToken } from './api-client';

/**
 * The project-registration additions to the API client: URL/query
 * construction, method/body shape, and CSRF header propagation on the new
 * write endpoints. Mirrors the stubbed-fetch approach in api-client.test.ts.
 */

const jsonResponse = (body: unknown, init: { status?: number } = {}): Response =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json' },
  });

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

const inspectionBody = {
  inspectionId: '00000000-0000-4000-8000-000000000001',
  expiresAt: '2026-08-04T22:00:00.000Z',
  scanVersion: '1',
  location: {
    inputPath: '/home/asrin/Desktop/demo',
    canonicalPath: '/home/asrin/Desktop/demo',
    allowedRoot: '/home/asrin/Desktop',
    accessible: true,
    checkedAt: '2026-08-04T10:00:00.000Z',
  },
  repository: {
    present: false,
    topLevelPath: null,
    remotes: [],
    normalizedIdentity: null,
    activeBranch: null,
    defaultBranch: null,
    defaultBranchConfidence: null,
    lastCommitHash: null,
    lastCommitShortHash: null,
    lastCommitAt: null,
    lastCommitSubject: null,
    isDirty: null,
    modifiedCount: null,
    untrackedCount: null,
    scannedAt: null,
  },
  technologies: [],
  commands: [],
  manifests: [],
  warnings: [],
  limitsHit: [],
};

describe('project inspection', () => {
  it('posts the typed path to /api/projects/inspections', async () => {
    fetchMock.mockResolvedValue(jsonResponse(inspectionBody, { status: 201 }));
    await api.inspectProject({ path: '/home/asrin/Desktop/demo' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/inspections');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ path: '/home/asrin/Desktop/demo' });
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('c'.repeat(43));
  });

  it('surfaces a rejected path as a bad_request ApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        { error: { code: 'bad_request', message: 'The path is not inside any allowed project root.' }, requestId: 'r'.repeat(8) },
        { status: 400 },
      ),
    );
    await expect(api.inspectProject({ path: '/etc' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('listProjects query construction', () => {
  it('omits undefined and empty-string filters from the query string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [], page: 1, pageSize: 20, total: 0 }));
    await api.listProjects({ search: '', status: undefined, page: 1, pageSize: 20, sort: 'updatedAt', order: 'desc' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).not.toContain('search=');
    expect(url).not.toContain('status=');
    expect(url).toContain('page=1');
    expect(url).toContain('sort=updatedAt');
  });

  it('serialises a boolean filter as a plain string', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [], page: 1, pageSize: 20, total: 0 }));
    await api.listProjects({ includeArchived: true });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('includeArchived=true');
  });

  it('URL-encodes a search term', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ projects: [], page: 1, pageSize: 20, total: 0 }));
    await api.listProjects({ search: 'my project & co' });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toContain('search=my+project+%26+co');
  });
});

describe('write endpoints send the correct method and CSRF header', () => {
  it('updateProject sends PATCH', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {} }));
    await api.updateProject('id-1', { name: 'New name' }).catch(() => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/id-1');
    expect(init.method).toBe('PATCH');
  });

  it('deleteProjectRule sends DELETE with the CSRF header', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ deleted: true }));
    await api.deleteProjectRule('id-1', 'rule-1');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/projects/id-1/rules/rule-1');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('c'.repeat(43));
  });

  it('archiveProject and reactivateProject hit dedicated endpoints, not a generic PATCH', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {} }));
    await api.archiveProject('id-1').catch(() => {});
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('/api/projects/id-1/archive');

    fetchMock.mockResolvedValue(jsonResponse({ project: {} }));
    await api.reactivateProject('id-1').catch(() => {});
    expect((fetchMock.mock.calls[1] as [string])[0]).toBe('/api/projects/id-1/reactivate');
  });

  it('applyRescan carries confirmRepositoryIdentityChange through to the request body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ project: {}, applied: [] }));
    await api
      .applyRescan('id-1', { inspectionId: 'insp-1', confirmRepositoryIdentityChange: true })
      .catch(() => {});
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({ confirmRepositoryIdentityChange: true });
  });
});

describe('response validation', () => {
  it('rejects with malformed_response when the server response does not match the schema', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ nonsense: true }, { status: 201 }));
    let error: ApiError | undefined;
    try {
      await api.inspectProject({ path: '/home/asrin/Desktop/demo' });
    } catch (caught) {
      error = caught as ApiError;
    }
    expect(error?.code).toBe('malformed_response');
  });
});

describe('roadmap client', () => {
  it('uses the project-scoped milestone endpoint with CSRF', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      projectId: '00000000-0000-4000-8000-000000000001', readOnly: false,
      progress: { completed: 0, total: 0, percentage: 0 }, milestones: [],
    }, { status: 201 }));
    await api.createMilestone('00000000-0000-4000-8000-000000000001', {
      title: 'Production readiness', description: '', status: 'planned', priority: 'high',
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/roadmap/milestones');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['x-csrf-token']).toBe('c'.repeat(43));
  });

  it('preserves structured confirmation-required detail', async () => {
    fetchMock.mockResolvedValue(jsonResponse({
      error: { code: 'confirmation_required', message: '2 criteria incomplete.', confirmation: { kind: 'incomplete_acceptance', count: 2 } },
      requestId: 'r'.repeat(8),
    }, { status: 409 }));
    await expect(api.changeRoadmapTaskStatus('p', 't', { status: 'done' })).rejects.toMatchObject({
      code: 'confirmation_required', confirmation: { kind: 'incomplete_acceptance', count: 2 },
    });
  });
});
