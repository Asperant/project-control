import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
const email = 'context@example.test';
const password = 'a-secure-context-test-password';
let auth: { token: string; csrfToken: string };

const request = (method: string, url: string, payload?: unknown) =>
  harness.app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), cookies: { pc_session: auth.token }, headers: { 'x-csrf-token': auth.csrfToken } });

async function project(): Promise<string> {
  const id = randomUUID();
  await harness.ctx.db.query(
    `INSERT INTO projects(id,name,status,location_input_path,location_canonical_path,location_allowed_root,created_by)
     VALUES ($1,$2,'active',$3,$3,'/tmp',$4)`,
    [id, `Context ${id.slice(0, 6)}`, `/tmp/${id}`, null],
  );
  return id;
}
async function milestone(projectId: string, title = 'Milestone'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones`, { title });
  return response.json().milestones.at(-1).id as string;
}
async function task(projectId: string, milestoneId: string, title = 'Task'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones/${milestoneId}/tasks`, { title });
  return response.json().detail.task.id as string;
}
async function context(projectId: string): Promise<any> {
  const response = await request('GET', `/api/projects/${projectId}/context`);
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe.skipIf(!hasDocker)('current context / "Where was I?"', () => {
  beforeAll(async () => {
    harness = await createHarness();
    await harness.ctx.db.query(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin')",
      [email, 'Context Tester', await hashPassword(password)],
    );
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.4' });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);
  afterAll(async () => harness?.teardown());

  it('requires authentication', async () => {
    const id = await project();
    expect((await harness.app.inject({ method: 'GET', url: `/api/projects/${id}/context` })).statusCode).toBe(401);
  });

  it('reports a clean empty state for a project with no roadmap or memory activity', async () => {
    const id = await project();
    const c = await context(id);
    expect(c.currentFocus).toEqual([]);
    expect(c.inProgressTasks).toEqual([]);
    expect(c.blocked).toEqual({ milestones: [], tasks: [] });
    expect(c.nextActions).toEqual([]);
    expect(c.pendingAcceptance).toEqual([]);
    expect(c.unresolvedDependencies).toEqual([]);
    expect(c.pinnedContext).toEqual([]);
    expect(c.lastCheckpoint).toBeNull();
    expect(c.changesSinceCheckpoint).toEqual({ hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] });
  });

  it('derives current focus, in-progress work, blocked work, next actions, pending acceptance and dependencies deterministically', async () => {
    const id = await project();
    const m1 = await milestone(id, 'Alpha');
    const m2 = await milestone(id, 'Beta');
    await request('POST', `/api/projects/${id}/roadmap/milestones/${m1}/status`, { status: 'in_progress' });
    await request('POST', `/api/projects/${id}/roadmap/milestones/${m2}/status`, { status: 'blocked', blockedReason: 'Needs sign-off' });

    const t1 = await task(id, m1, 'Ship feature');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t1}/status`, { status: 'in_progress' });
    await request('PATCH', `/api/projects/${id}/roadmap/tasks/${t1}`, { nextAction: 'Open PR' });
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t1}/criteria`, { text: 'Reviewed' });

    const t2 = await task(id, m2, 'Write docs');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t2}/status`, { status: 'blocked', blockedReason: 'Waiting on legal' });

    const base = await task(id, m1, 'Base');
    const dependent = await task(id, m1, 'Dependent');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${dependent}/dependencies`, { dependsOnTaskId: base });

    const c = await context(id);
    expect(c.currentFocus.map((m: any) => m.title)).toEqual(['Alpha']);
    expect(c.inProgressTasks.map((t: any) => t.title)).toEqual(['Ship feature']);
    expect(c.blocked.milestones.map((m: any) => m.title)).toEqual(['Beta']);
    expect(c.blocked.tasks.map((t: any) => t.title)).toEqual(['Write docs']);
    // Deterministic ordering: in_progress next actions before blocked ones.
    expect(c.nextActions.map((t: any) => t.title)).toEqual(['Ship feature']);
    expect(c.pendingAcceptance.map((t: any) => t.title)).toEqual(['Ship feature']);
    expect(c.unresolvedDependencies.map((d: any) => d.title)).toEqual(['Dependent']);
  });

  it('shows pinned memory as pinned context and the last active (non-archived) checkpoint', async () => {
    const id = await project();
    const entryResponse = await request('POST', `/api/projects/${id}/memory`, { type: 'constraint', title: 'Safari is out of scope', body: 'Explicit decision.' });
    const entryId = entryResponse.json().entry.id;
    await request('POST', `/api/projects/${id}/memory/${entryId}/pin`);

    let c = await context(id);
    expect(c.pinnedContext.map((e: any) => e.title)).toEqual(['Safari is out of scope']);
    expect(c.lastCheckpoint).toBeNull();

    const first = (await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: 'first' })).json().checkpoint;
    const second = (await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: 'second' })).json().checkpoint;
    c = await context(id);
    expect(c.lastCheckpoint.id).toBe(second.id);

    await request('POST', `/api/projects/${id}/checkpoints/${second.id}/archive`);
    c = await context(id);
    expect(c.lastCheckpoint.id).toBe(first.id);
  });

  describe('changes since last checkpoint', () => {
    it('summarises roadmap and memory activity after the checkpoint, excludes the checkpoint-creation event itself, and excludes events before the checkpoint', async () => {
      const id = await project();
      const m = await milestone(id, 'Before');
      const t0 = await task(id, m, 'Started before checkpoint');
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t0}/status`, { status: 'in_progress' });
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t0}/status`, { status: 'done' });

      const checkpoint = (await request('POST', `/api/projects/${id}/checkpoints`, {})).json().checkpoint;

      const t1 = await task(id, m, 'Started after');
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t1}/status`, { status: 'in_progress' });
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t1}/status`, { status: 'done' });
      const t2 = await task(id, m, 'Blocked after');
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t2}/status`, { status: 'blocked', blockedReason: 'x' });
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t1}/criteria`, { text: 'crit' });
      // Criterion completion happened before status=done above on t1, but add
      // one more explicitly to exercise the acceptance-completed counter.
      const t3 = await task(id, m, 'Acceptance task');
      const criterionResponse = await request('POST', `/api/projects/${id}/roadmap/tasks/${t3}/criteria`, { text: 'must pass' });
      const criterionId = criterionResponse.json().detail.criteria[0].id;
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t3}/criteria/${criterionId}/completion`, { isCompleted: true });

      const memoryResponse = await request('POST', `/api/projects/${id}/memory`, { type: 'decision', title: 'New decision', body: 'x' });
      const memoryId = memoryResponse.json().entry.id;
      await request('POST', `/api/projects/${id}/memory/${memoryId}/supersede`, { type: 'decision', title: 'Replacement decision', body: 'y' });

      const c = await context(id);
      expect(c.changesSinceCheckpoint.hasCheckpoint).toBe(true);
      expect(c.changesSinceCheckpoint.sinceCheckpointId).toBe(checkpoint.id);

      const byKey = Object.fromEntries(c.changesSinceCheckpoint.items.map((i: any) => [i.key, i.count]));
      expect(byKey['roadmap.task.started']).toBe(1); // t1 only — t2 goes straight to blocked, t3 is never started
      expect(byKey['roadmap.task.completed']).toBe(1); // t1 only; t0 completed before the checkpoint, so excluded
      expect(byKey['roadmap.task.blocked']).toBe(1);
      expect(byKey['roadmap.acceptance.completed']).toBe(1);
      expect(byKey['memory.created']).toBe(1);
      expect(byKey['memory.superseded']).toBe(1);
      expect(byKey['checkpoint.created']).toBeUndefined();
    });

    it('does not select an archived checkpoint as the baseline', async () => {
      const id = await project();
      const only = (await request('POST', `/api/projects/${id}/checkpoints`, {})).json().checkpoint;
      await request('POST', `/api/projects/${id}/checkpoints/${only.id}/archive`);
      const c = await context(id);
      expect(c.lastCheckpoint).toBeNull();
      expect(c.changesSinceCheckpoint).toEqual({ hasCheckpoint: false, sinceCheckpointId: null, sinceCreatedAt: null, items: [] });
    });

    it('does not double-count a single mutation as two events', async () => {
      const id = await project();
      const checkpoint = (await request('POST', `/api/projects/${id}/checkpoints`, {})).json().checkpoint;
      const m = await milestone(id);
      const t = await task(id, m, 'Solo');
      await request('POST', `/api/projects/${id}/roadmap/tasks/${t}/status`, { status: 'in_progress' });

      const c = await context(id);
      expect(c.changesSinceCheckpoint.sinceCheckpointId).toBe(checkpoint.id);
      const started = c.changesSinceCheckpoint.items.find((i: any) => i.key === 'roadmap.task.started');
      expect(started.count).toBe(1);
    });
  });
});
