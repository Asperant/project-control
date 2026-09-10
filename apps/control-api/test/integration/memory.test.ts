import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';
import { createMemoryEntry as createMemoryEntryInStore } from '../../src/memory/store.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
const email = 'memory@example.test';
const password = 'a-secure-memory-test-password';
let auth: { token: string; csrfToken: string };
let actorId: string;

const request = (method: string, url: string, payload?: unknown) =>
  harness.app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), cookies: { pc_session: auth.token }, headers: { 'x-csrf-token': auth.csrfToken } });

async function project(status = 'active'): Promise<string> {
  const id = randomUUID();
  await harness.ctx.db.query(
    `INSERT INTO projects(id,name,status,archived_at,location_input_path,location_canonical_path,location_allowed_root,created_by)
     VALUES ($1,$2,$3,CASE WHEN $3='archived' THEN now() END,$4,$4,'/tmp',$5)`,
    [id, `Memory ${id.slice(0, 6)}`, status, `/tmp/${id}`, null],
  );
  return id;
}
async function milestone(projectId: string, title = 'Milestone'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones`, { title });
  expect(response.statusCode).toBe(201);
  return response.json().milestones.at(-1).id as string;
}
async function task(projectId: string, milestoneId: string, title = 'Task'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones/${milestoneId}/tasks`, { title });
  expect(response.statusCode).toBe(201);
  return response.json().detail.task.id as string;
}
async function entry(projectId: string, body: Record<string, unknown> = {}): Promise<any> {
  const response = await request('POST', `/api/projects/${projectId}/memory`, { type: 'context', title: 'Entry', body: 'Body text', ...body });
  expect(response.statusCode).toBe(201);
  return response.json().entry;
}

describe.skipIf(!hasDocker)('manual project memory', () => {
  beforeAll(async () => {
    harness = await createHarness();
    actorId = (await harness.ctx.db.query<{ id: string }>(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id",
      [email, 'Memory Tester', await hashPassword(password)],
    )).rows[0]!.id;
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.2' });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);
  afterAll(async () => harness?.teardown());

  it('requires authentication for memory reads', async () => {
    const id = await project();
    const response = await harness.app.inject({ method: 'GET', url: `/api/projects/${id}/memory` });
    expect(response.statusCode).toBe(401);
  });

  it('creates every supported memory type with sane defaults', async () => {
    const id = await project();
    for (const type of ['decision', 'constraint', 'context', 'finding', 'handoff', 'lesson']) {
      const e = await entry(id, { type, title: `A ${type}`, body: 'Body' });
      expect(e.type).toBe(type);
      expect(e.importance).toBe('normal');
      expect(e.isPinned).toBe(false);
      expect(e.status).toBe('active');
    }
  });

  it('rejects an invalid type and an invalid importance', async () => {
    const id = await project();
    expect((await request('POST', `/api/projects/${id}/memory`, { type: 'not-a-type', title: 'X', body: 'Y' })).statusCode).toBe(422);
    expect((await request('POST', `/api/projects/${id}/memory`, { type: 'decision', title: 'X', body: 'Y', importance: 'urgent' })).statusCode).toBe(422);
  });

  it('updates title, body and importance without touching type', async () => {
    const id = await project();
    const e = await entry(id, { type: 'decision' });
    const updated = (await request('PATCH', `/api/projects/${id}/memory/${e.id}`, { title: 'New title', importance: 'critical' })).json().entry;
    expect(updated.title).toBe('New title');
    expect(updated.importance).toBe('critical');
    expect(updated.type).toBe('decision');
  });

  it('pins, unpins, archives and reactivates', async () => {
    const id = await project();
    const e = await entry(id);
    let current = (await request('POST', `/api/projects/${id}/memory/${e.id}/pin`)).json().entry;
    expect(current.isPinned).toBe(true);
    current = (await request('POST', `/api/projects/${id}/memory/${e.id}/unpin`)).json().entry;
    expect(current.isPinned).toBe(false);
    current = (await request('POST', `/api/projects/${id}/memory/${e.id}/archive`)).json().entry;
    expect(current.status).toBe('archived');
    expect(current.archivedAt).toBeTruthy();
    current = (await request('POST', `/api/projects/${id}/memory/${e.id}/reactivate`)).json().entry;
    expect(current.status).toBe('active');
    expect(current.archivedAt).toBeNull();
  });

  it('never physically deletes a memory entry', async () => {
    const id = await project();
    const e = await entry(id);
    await expect(harness.ctx.db.query('DELETE FROM project_memory_entries WHERE id=$1', [e.id])).rejects.toMatchObject({ code: '42501' });
  });

  it('accepts a same-project related task/milestone and rejects a cross-project one', async () => {
    const id = await project();
    const m = await milestone(id);
    const t = await task(id, m);
    const ok = await entry(id, { relatedTaskId: t, relatedMilestoneId: m });
    expect(ok.relatedTaskId).toBe(t);
    expect(ok.relatedMilestoneId).toBe(m);

    const other = await project();
    const om = await milestone(other);
    const ot = await task(other, om);
    expect((await request('POST', `/api/projects/${id}/memory`, { type: 'context', title: 'X', body: 'Y', relatedTaskId: ot })).statusCode).toBe(404);
    expect((await request('POST', `/api/projects/${id}/memory`, { type: 'context', title: 'X', body: 'Y', relatedMilestoneId: om })).statusCode).toBe(404);
  });

  it('rejects memory mutation on an archived project and allows it again after reactivation', async () => {
    const id = await project();
    const e = await entry(id);
    await request('POST', `/api/projects/${id}/archive`);
    expect((await request('POST', `/api/projects/${id}/memory`, { type: 'context', title: 'X', body: 'Y' })).statusCode).toBe(409);
    expect((await request('PATCH', `/api/projects/${id}/memory/${e.id}`, { title: 'Denied' })).statusCode).toBe(409);
    expect((await request('GET', `/api/projects/${id}/memory`)).statusCode).toBe(200);
    await request('POST', `/api/projects/${id}/reactivate`);
    expect((await request('PATCH', `/api/projects/${id}/memory/${e.id}`, { title: 'Allowed' })).statusCode).toBe(200);
  });

  it('searches title and body case-insensitively', async () => {
    const id = await project();
    await entry(id, { title: 'Use MinIO for artifacts', body: 'Because it is S3 compatible.' });
    await entry(id, { title: 'Unrelated', body: 'Nothing to see' });
    let found = (await request('GET', `/api/projects/${id}/memory?search=minio`)).json().entries;
    expect(found).toHaveLength(1);
    found = (await request('GET', `/api/projects/${id}/memory?search=S3%20compatible`)).json().entries;
    expect(found).toHaveLength(1);
    found = (await request('GET', `/api/projects/${id}/memory?search=nowhere`)).json().entries;
    expect(found).toHaveLength(0);
  });

  it('filters by type, pinned, archived and superseded, hiding archived/superseded by default', async () => {
    const id = await project();
    const decision = await entry(id, { type: 'decision', title: 'D1' });
    await entry(id, { type: 'lesson', title: 'L1' });
    await request('POST', `/api/projects/${id}/memory/${decision.id}/pin`);
    const archivedOne = await entry(id, { type: 'finding', title: 'F1' });
    await request('POST', `/api/projects/${id}/memory/${archivedOne.id}/archive`);

    expect((await request('GET', `/api/projects/${id}/memory`)).json().entries).toHaveLength(2); // archived one hidden by default
    expect((await request('GET', `/api/projects/${id}/memory?type=lesson`)).json().entries).toHaveLength(1);
    expect((await request('GET', `/api/projects/${id}/memory?pinned=true`)).json().entries).toHaveLength(1);
    expect((await request('GET', `/api/projects/${id}/memory?archived=true`)).json().entries).toHaveLength(1);
    expect((await request('GET', `/api/projects/${id}/memory?superseded=true`)).json().entries).toHaveLength(0);
  });

  it('paginates with a compound keyset cursor over (is_pinned, created_at, id) that never repeats or skips a row', async () => {
    const id = await project();
    const pinnedIds: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const e = await entry(id, { title: `Pinned ${i}` });
      await request('POST', `/api/projects/${id}/memory/${e.id}/pin`);
      pinnedIds.push(e.id);
    }
    for (let i = 0; i < 5; i += 1) await entry(id, { title: `Unpinned ${i}` });

    const seen = new Set<string>();
    let cursor: { isPinned: boolean; createdAt: string; id: string } | null = null;
    let pages = 0;
    do {
      const url = cursor
        ? `/api/projects/${id}/memory?pageSize=3&beforeIsPinned=${cursor.isPinned}&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`
        : `/api/projects/${id}/memory?pageSize=3`;
      const response = await request('GET', url);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      // is_pinned is the primary sort key: the very first page must exhaust
      // both pinned rows before any unpinned one appears.
      if (pages === 0) {
        expect(body.entries[0].isPinned).toBe(true);
        expect(body.entries[1].isPinned).toBe(true);
        expect(body.entries[2].isPinned).toBe(false);
      }
      for (const e of body.entries) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen.size).toBe(7);
    expect([...seen].filter((entryId) => pinnedIds.includes(entryId))).toHaveLength(2);
  });

  it('does not drop rows that share a created_at down to the microsecond (a real bug: JS Date/toISOString() truncates to milliseconds, so a cursor built that way can equal — not exceed — an unreturned row with the same timestamp)', async () => {
    const id = await project();
    // Five rows sharing one literal timestamptz with non-zero microsecond
    // digits beyond millisecond precision — exactly what a burst of writes
    // inside one transaction produces in production (transaction-time `now()`
    // is constant for the whole transaction), just forced deterministically
    // here instead of relying on timing.
    const sharedTimestamp = '2026-01-01T00:00:00.123456+00';
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const entryId = randomUUID();
      await harness.ctx.db.query(
        `INSERT INTO project_memory_entries(id,project_id,type,title,body,importance,is_pinned,created_at)
         VALUES ($1,$2,'context',$3,'Body','normal',false,$4::timestamptz)`,
        [entryId, id, `Tied ${i}`, sharedTimestamp],
      );
      ids.push(entryId);
    }

    const seen = new Set<string>();
    let cursor: { isPinned: boolean; createdAt: string; id: string } | null = null;
    let pages = 0;
    do {
      const url = cursor
        ? `/api/projects/${id}/memory?pageSize=2&beforeIsPinned=${cursor.isPinned}&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`
        : `/api/projects/${id}/memory?pageSize=2`;
      const response = await request('GET', url);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const e of body.entries) {
        expect(seen.has(e.id)).toBe(false);
        seen.add(e.id);
      }
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen.size).toBe(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('importantOnly restricts to pinned or important/critical entries — the predicate getProjectResume relies on to stay bounded', async () => {
    const id = await project();
    const normal = await entry(id, { title: 'Normal', importance: 'normal' });
    const important = await entry(id, { title: 'Important', importance: 'important' });
    const critical = await entry(id, { title: 'Critical', importance: 'critical' });
    const pinnedNormal = await entry(id, { title: 'Pinned normal', importance: 'normal' });
    await request('POST', `/api/projects/${id}/memory/${pinnedNormal.id}/pin`);
    void normal;

    const found = (await request('GET', `/api/projects/${id}/memory?importantOnly=true`)).json().entries;
    const foundIds = found.map((e: any) => e.id).sort();
    expect(foundIds).toEqual([important.id, critical.id, pinnedNormal.id].sort());
  });

  describe('supersede', () => {
    it('creates a new entry and preserves the old one as superseded, with a visible link both ways', async () => {
      const id = await project();
      const old = await entry(id, { type: 'decision', title: 'Use MinIO for artifacts' });
      const response = await request('POST', `/api/projects/${id}/memory/${old.id}/supersede`, {
        type: 'decision', title: 'Use local content-addressed artifact storage', body: 'Simpler, no extra service.',
      });
      expect(response.statusCode).toBe(201);
      const { oldEntry, newEntry } = response.json();
      expect(oldEntry.status).toBe('superseded');
      expect(oldEntry.supersededById).toBe(newEntry.id);
      expect(newEntry.status).toBe('active');
      expect(newEntry.supersedesIds).toEqual([old.id]);

      const reloadedOld = (await request('GET', `/api/projects/${id}/memory/${old.id}`)).json().entry;
      expect(reloadedOld.status).toBe('superseded');
      expect(reloadedOld.supersededByTitle).toBe('Use local content-addressed artifact storage');
    });

    it('rejects self-supersede', async () => {
      const id = await project();
      const e = await entry(id);
      expect((await request('POST', `/api/projects/${id}/memory/${e.id}/supersede`, { newEntryId: e.id })).statusCode).toBe(409);
    });

    it('rejects superseding with an entry from another project', async () => {
      const id = await project();
      const e = await entry(id);
      const other = await project();
      const foreign = await entry(other);
      expect((await request('POST', `/api/projects/${id}/memory/${e.id}/supersede`, { newEntryId: foreign.id })).statusCode).toBe(404);
    });

    it('rejects superseding an entry that has already been superseded', async () => {
      const id = await project();
      const a = await entry(id, { title: 'A' });
      const b = await entry(id, { title: 'B' });
      expect((await request('POST', `/api/projects/${id}/memory/${a.id}/supersede`, { newEntryId: b.id })).statusCode).toBe(201);
      const c = await entry(id, { title: 'C' });
      expect((await request('POST', `/api/projects/${id}/memory/${a.id}/supersede`, { newEntryId: c.id })).statusCode).toBe(409);
    });

    it('rejects a supersede chain that would become circular', async () => {
      const id = await project();
      const a = await entry(id, { title: 'A' });
      const b = await entry(id, { title: 'B' });
      const c = await entry(id, { title: 'C' });
      expect((await request('POST', `/api/projects/${id}/memory/${a.id}/supersede`, { newEntryId: b.id })).statusCode).toBe(201);
      expect((await request('POST', `/api/projects/${id}/memory/${b.id}/supersede`, { newEntryId: c.id })).statusCode).toBe(201);
      expect((await request('POST', `/api/projects/${id}/memory/${c.id}/supersede`, { newEntryId: a.id })).statusCode).toBe(409);
    });

    it('rolls the mutation back when required audit fails', async () => {
      const id = await project();
      await expect(
        createMemoryEntryInStore(
          harness.ctx.db, id, actorId,
          { type: 'decision', title: 'Must rollback', body: 'Body', importance: 'normal', isPinned: false },
          async () => { throw new Error('audit unavailable'); },
        ),
      ).rejects.toThrow('audit unavailable');
      const rows = await harness.ctx.db.query('SELECT 1 FROM project_memory_entries WHERE project_id=$1', [id]);
      expect(rows.rowCount).toBe(0);
    });
  });

  it('grants backup_reader read-only access and no DELETE to control_app', async () => {
    for (const table of ['project_memory_entries', 'project_checkpoints']) {
      const result = await harness.ctx.db.query<{ can_read: boolean; can_write: boolean }>(
        `SELECT has_table_privilege('backup_reader',$1,'SELECT') can_read, has_table_privilege('backup_reader',$1,'INSERT,UPDATE,DELETE') can_write`,
        [table],
      );
      expect(result.rows[0]).toEqual({ can_read: true, can_write: false });
    }
  });
});
