import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
let actorId: string;
const email = 'timeline@example.test';
const password = 'a-secure-timeline-test-password';
let auth: { token: string; csrfToken: string };

const request = (method: string, url: string, payload?: unknown) =>
  harness.app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload } : {}),
    cookies: { pc_session: auth.token },
    headers: { 'x-csrf-token': auth.csrfToken },
  });

async function project(): Promise<string> {
  const id = randomUUID();
  await harness.ctx.db.query(
    `INSERT INTO projects(id,name,status,location_input_path,location_canonical_path,location_allowed_root,created_by)
     VALUES ($1,$2,'active',$3,$3,'/tmp',$4)`,
    [id, `Timeline ${id.slice(0, 6)}`, `/tmp/${id}`, actorId],
  );
  return id;
}

describe.skipIf(!hasDocker)('Timeline', () => {
  beforeAll(async () => {
    harness = await createHarness();
    actorId = (await harness.ctx.db.query<{ id: string }>(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id",
      [email, 'Timeline Tester', await hashPassword(password)],
    )).rows[0]!.id;
    const login = await harness.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.8',
    });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);

  afterAll(async () => harness?.teardown());

  it('requires authentication', async () => {
    const projectId = await project();
    const projectResponse = await harness.app.inject({ method: 'GET', url: `/api/projects/${projectId}/timeline` });
    expect(projectResponse.statusCode).toBe(401);
    const globalResponse = await harness.app.inject({ method: 'GET', url: '/api/timeline' });
    expect(globalResponse.statusCode).toBe(401);
  });

  it('records a curated entry when a memory entry is created, visible on both the project and global feed', async () => {
    const projectId = await project();
    const create = await request('POST', `/api/projects/${projectId}/memory`, {
      type: 'decision', title: 'Use write-time timeline', body: 'Body content that must never leak into the summary.',
      importance: 'normal', isPinned: false,
    });
    expect(create.statusCode).toBe(201);
    const memoryEntryId = create.json().entry.id;

    const projectFeed = await request('GET', `/api/projects/${projectId}/timeline`);
    expect(projectFeed.statusCode).toBe(200);
    const projectEntry = projectFeed.json().entries.find((e: any) => e.entityId === memoryEntryId);
    expect(projectEntry).toBeDefined();
    expect(projectEntry.entityType).toBe('memory');
    expect(projectEntry.eventType).toBe('memory.created');
    expect(projectEntry.summary).toContain('Use write-time timeline');
    expect(projectEntry.summary).not.toContain('must never leak');

    const globalFeed = await request('GET', '/api/timeline');
    expect(globalFeed.statusCode).toBe(200);
    expect(globalFeed.json().entries.some((e: any) => e.entityId === memoryEntryId)).toBe(true);
  });

  it('filters by entityType', async () => {
    const projectId = await project();
    await request('POST', `/api/projects/${projectId}/memory`, {
      type: 'finding', title: 'Filterable entry', body: 'x', importance: 'normal', isPinned: false,
    });
    const filtered = await request('GET', `/api/projects/${projectId}/timeline?entityType=roadmap_task`);
    expect(filtered.statusCode).toBe(200);
    expect(filtered.json().entries).toEqual([]);
  });

  it('paginates with a keyset cursor that never repeats or skips a row', async () => {
    const projectId = await project();
    for (let i = 0; i < 5; i += 1) {
      const response = await request('POST', `/api/projects/${projectId}/memory`, {
        type: 'context', title: `Entry ${i}`, body: 'x', importance: 'normal', isPinned: false,
      });
      expect(response.statusCode).toBe(201);
    }

    const seen = new Set<string>();
    let cursor: { occurredAt: string; id: string } | null = null;
    let pages = 0;
    do {
      const url = cursor
        ? `/api/projects/${projectId}/timeline?pageSize=2&beforeOccurredAt=${encodeURIComponent(cursor.occurredAt)}&beforeId=${cursor.id}`
        : `/api/projects/${projectId}/timeline?pageSize=2`;
      const response = await request('GET', url);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const entry of body.entries) {
        expect(seen.has(entry.id)).toBe(false);
        seen.add(entry.id);
      }
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen.size).toBe(5);
  });

  it('returns 404 for a nonexistent project', async () => {
    const response = await request('GET', `/api/projects/${randomUUID()}/timeline`);
    expect(response.statusCode).toBe(404);
  });
});
