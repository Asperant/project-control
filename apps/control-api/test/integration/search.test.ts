import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
let actorId: string;
const email = 'search@example.test';
const password = 'a-secure-search-test-password';
let auth: { token: string; csrfToken: string };

const request = (method: string, url: string, payload?: unknown) =>
  harness.app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
    cookies: { pc_session: auth.token },
    headers: { 'x-csrf-token': auth.csrfToken },
  });

async function project(name: string): Promise<string> {
  const id = randomUUID();
  await harness.ctx.db.query(
    `INSERT INTO projects(id,name,status,location_input_path,location_canonical_path,location_allowed_root,created_by)
     VALUES ($1,$2,'active',$3,$3,'/tmp',$4)`,
    [id, name, `/tmp/${id}`, actorId],
  );
  return id;
}

describe.skipIf(!hasDocker)('Search', () => {
  beforeAll(async () => {
    harness = await createHarness();
    actorId = (await harness.ctx.db.query<{ id: string }>(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id",
      [email, 'Search Tester', await hashPassword(password)],
    )).rows[0]!.id;
    const login = await harness.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.9',
    });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);

  afterAll(async () => harness?.teardown());

  it('requires authentication', async () => {
    const response = await harness.app.inject({ method: 'GET', url: '/api/search?q=deployment' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects an empty query', async () => {
    const response = await request('GET', '/api/search?q=');
    expect(response.statusCode).toBe(422);
  });

  it('finds a memory entry by a word in its body, with a bounded, highlighted snippet', async () => {
    const projectId = await project('Search Subject Alpha');
    const create = await request('POST', `/api/projects/${projectId}/memory`, {
      type: 'decision', title: 'Deployment restriction', body: 'No deploys after five in the afternoon on Fridays without sign-off.',
      importance: 'normal', isPinned: false,
    });
    expect(create.statusCode).toBe(201);
    const memoryEntryId = create.json().entry.id;

    const response = await request('GET', '/api/search?q=fridays');
    expect(response.statusCode).toBe(200);
    const body = response.json();
    const hit = body.results.find((r: any) => r.entityId === memoryEntryId);
    expect(hit).toBeDefined();
    expect(hit.entityType).toBe('memory');
    expect(hit.projectId).toBe(projectId);
    expect(hit.projectName).toBe('Search Subject Alpha');
    expect(hit.snippet.length).toBeLessThanOrEqual(40);
    expect(hit.snippet.some((segment: { text: string; matched: boolean }) => segment.matched && /fridays/i.test(segment.text))).toBe(true);
    const controlChars = [String.fromCharCode(1), String.fromCharCode(2)];
    expect(hit.snippet.every((segment: { text: string }) => controlChars.every((marker) => !segment.text.includes(marker)))).toBe(true);
  });

  it('filters by entity type and by project', async () => {
    const projectA = await project('Search Subject Beta');
    const projectB = await project('Search Subject Gamma');
    await request('POST', `/api/projects/${projectA}/memory`, {
      type: 'finding', title: 'Widget calibration finding', body: 'Widget calibration drifted overnight.', importance: 'normal', isPinned: false,
    });
    await request('POST', `/api/projects/${projectB}/roadmap/milestones`, {
      title: 'Widget calibration milestone', description: 'Track the widget calibration effort.', status: 'planned', priority: 'medium',
    });

    const typeFiltered = await request('GET', '/api/search?q=calibration&type=roadmap_milestone');
    expect(typeFiltered.statusCode).toBe(200);
    expect(typeFiltered.json().results.every((r: any) => r.entityType === 'roadmap_milestone')).toBe(true);

    const projectFiltered = await request('GET', `/api/search?q=calibration&projectId=${projectA}`);
    expect(projectFiltered.statusCode).toBe(200);
    expect(projectFiltered.json().results.every((r: any) => r.projectId === projectA)).toBe(true);
  });

  it('returns no results for a query that matches nothing', async () => {
    const response = await request('GET', '/api/search?q=zzznomatchzzz');
    expect(response.statusCode).toBe(200);
    expect(response.json().results).toEqual([]);
  });
});
