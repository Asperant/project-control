import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkpointDetailResponseSchema, checkpointListResponseSchema } from '@project-control/contracts';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
const email = 'checkpoint@example.test';
const password = 'a-secure-checkpoint-test-password';
let auth: { token: string; csrfToken: string };

const request = (method: string, url: string, payload?: unknown) =>
  harness.app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), cookies: { pc_session: auth.token }, headers: { 'x-csrf-token': auth.csrfToken } });

async function project(status = 'active'): Promise<string> {
  const id = randomUUID();
  await harness.ctx.db.query(
    `INSERT INTO projects(id,name,status,archived_at,location_input_path,location_canonical_path,location_allowed_root,created_by)
     VALUES ($1,$2,$3,CASE WHEN $3='archived' THEN now() END,$4,$4,'/tmp',$5)`,
    [id, `Checkpoint ${id.slice(0, 6)}`, status, `/tmp/${id}`, null],
  );
  return id;
}
async function milestone(projectId: string, status = 'planned', title = 'Milestone'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones`, { title });
  const milestoneId = response.json().milestones.at(-1).id as string;
  if (status === 'blocked') await request('POST', `/api/projects/${projectId}/roadmap/milestones/${milestoneId}/status`, { status, blockedReason: 'waiting' });
  else if (status !== 'planned') await request('POST', `/api/projects/${projectId}/roadmap/milestones/${milestoneId}/status`, { status });
  return milestoneId;
}
async function task(projectId: string, milestoneId: string, title = 'Task'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones/${milestoneId}/tasks`, { title });
  return response.json().detail.task.id as string;
}
async function entry(projectId: string, body: Record<string, unknown> = {}): Promise<any> {
  const response = await request('POST', `/api/projects/${projectId}/memory`, { type: 'context', title: 'Entry', body: 'Body', ...body });
  return response.json().entry;
}

describe.skipIf(!hasDocker)('immutable checkpoints', () => {
  beforeAll(async () => {
    harness = await createHarness();
    await harness.ctx.db.query(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin')",
      [email, 'Checkpoint Tester', await hashPassword(password)],
    );
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.3' });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);
  afterAll(async () => harness?.teardown());

  it('requires authentication for checkpoint reads', async () => {
    const id = await project();
    expect((await harness.app.inject({ method: 'GET', url: `/api/projects/${id}/checkpoints` })).statusCode).toBe(401);
  });

  it('keeps Development reads authenticated, audit-quiet, archived-readable, and safely unavailable', async () => {
    const id = await project();
    expect((await harness.app.inject({ method: 'GET', url: `/api/projects/${id}/development` })).statusCode).toBe(401);
    const before = await harness.ctx.db.query<{ count: number }>(
      'SELECT count(*)::int count FROM audit_events WHERE subject=$1', [`project:${id}`],
    );
    const active = await request('GET', `/api/projects/${id}/development`);
    expect(active.statusCode).toBe(200);
    expect(active.json()).toMatchObject({
      projectId: id, status: 'unavailable', errorCode: 'runner_unavailable',
      files: [], recentCommits: [], checkpointComparison: { status: 'no_git_checkpoint' },
    });
    const after = await harness.ctx.db.query<{ count: number }>(
      'SELECT count(*)::int count FROM audit_events WHERE subject=$1', [`project:${id}`],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);

    await request('POST', `/api/projects/${id}/archive`);
    const archived = await request('GET', `/api/projects/${id}/development`);
    expect(archived.statusCode).toBe(200);
    expect(archived.json().status).toBe('unavailable');
  });

  it('creates a server-generated snapshot, ignores any client-supplied snapshot content, and sets the version', async () => {
    const id = await project();
    const response = await request('POST', `/api/projects/${id}/checkpoints`, {
      sessionNote: 'Roadmap side finished.',
      // Not a real field on the request schema — a strict-mode client that
      // tried to inject snapshot content would be rejected outright.
      snapshotJson: { forged: true },
    });
    expect(response.statusCode).toBe(422); // strict schema rejects the unknown field entirely

    const clean = await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: 'Roadmap side finished.' });
    expect(clean.statusCode).toBe(201);
    const { checkpoint } = clean.json();
    expect(checkpoint.sessionNote).toBe('Roadmap side finished.');
    // New checkpoints are v3; runner failure is captured compactly and never
    // blocks the otherwise valid checkpoint transaction.
    expect(checkpoint.snapshotVersion).toBe(3);
    expect(checkpoint.snapshot.version).toBe(3);
    expect(checkpoint.snapshot.projectId).toBe(id);
    expect(checkpoint.snapshot).not.toHaveProperty('forged');
    expect(checkpoint.snapshot.recentAgentActivity).toEqual([]);
    expect(checkpoint.snapshot.gitState).toMatchObject({
      status: 'unavailable', branch: null, headSha: null, dirty: false,
    });
    expect(checkpoint.snapshot.gitState).not.toHaveProperty('files');
    expect(checkpoint.snapshot.gitState).not.toHaveProperty('diff');
  });

  it('still reads a v1-shaped checkpoint row (no recentAgentActivity key) written before this feature existed', async () => {
    const id = await project();
    const v1Snapshot = {
      version: 1, projectId: id, projectName: 'V1 project', projectStatus: 'active', generatedAt: new Date().toISOString(),
      currentFocus: [], inProgressTasks: [], blockedMilestones: [], blockedTasks: [], nextActions: [],
      pendingAcceptance: [], unresolvedDependencies: [], recentlyCompletedTasks: [], pinnedMemory: [], importantMemory: [],
    };
    const checkpointId = randomUUID();
    await harness.ctx.db.query(
      `INSERT INTO project_checkpoints (id, project_id, snapshot_version, snapshot_json, session_note) VALUES ($1,$2,1,$3::jsonb,'legacy')`,
      [checkpointId, id, JSON.stringify(v1Snapshot)],
    );

    const list = (await request('GET', `/api/projects/${id}/checkpoints`)).json().checkpoints;
    expect(list.map((c: any) => c.id)).toContain(checkpointId);

    const detail = (await request('GET', `/api/projects/${id}/checkpoints/${checkpointId}`)).json().checkpoint;
    expect(detail.snapshotVersion).toBe(1);
    expect(detail.snapshot.version).toBe(1);
    expect(detail.snapshot).not.toHaveProperty('recentAgentActivity');
  });

  it('still reads a v2 checkpoint without Git state', async () => {
    const id = await project();
    const snapshot = {
      version: 2, projectId: id, projectName: 'V2 project', projectStatus: 'active', generatedAt: new Date().toISOString(),
      currentFocus: [], inProgressTasks: [], blockedMilestones: [], blockedTasks: [], nextActions: [],
      pendingAcceptance: [], unresolvedDependencies: [], recentlyCompletedTasks: [], pinnedMemory: [], importantMemory: [],
      recentAgentActivity: [],
    };
    const checkpointId = randomUUID();
    await harness.ctx.db.query(
      'INSERT INTO project_checkpoints (id,project_id,snapshot_version,snapshot_json) VALUES ($1,$2,2,$3::jsonb)',
      [checkpointId, id, JSON.stringify(snapshot)],
    );
    const detail = (await request('GET', `/api/projects/${id}/checkpoints/${checkpointId}`)).json().checkpoint;
    expect(detail.snapshotVersion).toBe(2);
    expect(detail.snapshot.version).toBe(2);
    expect(detail.snapshot).not.toHaveProperty('gitState');
  });

  it('parses real stored v1, v2 and v3 rows through the actual checkpointSnapshotSchema discriminated union the web client relies on (not just its own unit tests)', async () => {
    // The two tests above prove the API returns v1/v2 rows without erroring, by
    // asserting on the raw JSON. Neither the checkpoint routes nor the store
    // ever run `checkpointSnapshotSchema` at read time (see checkpoints/store.ts's
    // mapDetail: `snapshot: row.snapshot_json` is passed through untyped) — the
    // only place that schema is actually invoked against a live response is the
    // web panel's api-client, via `checkpointDetailResponseSchema.parse(...)`.
    // This test calls the same schema, against the same kind of real,
    // directly-inserted historical rows, to prove the discriminated union
    // genuinely reads old real rows end to end — the gap the contracts
    // package's own isolated schema unit tests cannot close.
    const id = await project();

    // v1 — shipped before Agent Run awareness or Git state existed.
    const v1Snapshot = {
      version: 1, projectId: id, projectName: 'V1 project', projectStatus: 'active', generatedAt: new Date().toISOString(),
      currentFocus: [], inProgressTasks: [], blockedMilestones: [], blockedTasks: [], nextActions: [],
      pendingAcceptance: [], unresolvedDependencies: [], recentlyCompletedTasks: [], pinnedMemory: [], importantMemory: [],
    };
    const v1Id = randomUUID();
    await harness.ctx.db.query(
      `INSERT INTO project_checkpoints (id, project_id, snapshot_version, snapshot_json, session_note) VALUES ($1,$2,1,$3::jsonb,'legacy')`,
      [v1Id, id, JSON.stringify(v1Snapshot)],
    );

    // v2 — adds the body-free recentAgentActivity list, still no gitState.
    const v2Snapshot = { ...v1Snapshot, projectName: 'V2 project', version: 2, recentAgentActivity: [] };
    const v2Id = randomUUID();
    await harness.ctx.db.query(
      'INSERT INTO project_checkpoints (id,project_id,snapshot_version,snapshot_json) VALUES ($1,$2,2,$3::jsonb)',
      [v2Id, id, JSON.stringify(v2Snapshot)],
    );

    // v3 — the current version. Produced through the real create-checkpoint
    // path (never inserted directly): the application itself only ever writes
    // the current shape, exactly as the task at hand describes.
    const v3 = (await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: 'current' })).json().checkpoint;

    const listBody = (await request('GET', `/api/projects/${id}/checkpoints`)).json();
    const parsedList = checkpointListResponseSchema.parse(listBody);
    expect(parsedList.checkpoints.map((c) => c.id).sort()).toEqual([v1Id, v2Id, v3.id].sort());

    for (const [checkpointId, expectedVersion] of [[v1Id, 1], [v2Id, 2], [v3.id, 3]] as const) {
      const raw = (await request('GET', `/api/projects/${id}/checkpoints/${checkpointId}`)).json();
      // Throws on any schema mismatch — this is the assertion that matters.
      const parsed = checkpointDetailResponseSchema.parse(raw);
      expect(parsed.checkpoint.snapshot.version).toBe(expectedVersion);
      expect(parsed.checkpoint.id).toBe(checkpointId);
    }
  });

  it('includes recent, non-draft, non-archived Agent Run activity in the snapshot, newest first, capped at 5, with no prompt/report body', async () => {
    const id = await project();

    async function sentRun(title: string): Promise<string> {
      const run = (await request('POST', `/api/projects/${id}/agent-runs`, { title, agentName: 'Claude' })).json().agentRun;
      await request('PATCH', `/api/projects/${id}/agent-runs/${run.id}/prompt`, { body: 'Do the thing.' });
      await request('POST', `/api/projects/${id}/agent-runs/${run.id}/prompt/send`);
      return run.id;
    }

    const draftRun = (await request('POST', `/api/projects/${id}/agent-runs`, { title: 'Never sent', agentName: 'Claude' })).json().agentRun;
    void draftRun;
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) ids.push(await sentRun(`Run ${i}`));
    // Archive the very last one — it must not appear even though it's recent.
    await request('POST', `/api/projects/${id}/agent-runs/${ids[5]}/archive`);

    const checkpoint = (await request('POST', `/api/projects/${id}/checkpoints`, {})).json().checkpoint;
    const activity = checkpoint.snapshot.recentAgentActivity;
    expect(activity).toHaveLength(5);
    expect(activity.map((a: any) => a.agentRunId)).not.toContain(draftRun.id);
    expect(activity.map((a: any) => a.agentRunId)).not.toContain(ids[5]);
    expect(activity.every((a: any) => !('body' in a))).toBe(true);
    for (const a of activity) {
      expect(a).toHaveProperty('agentRunId');
      expect(a).toHaveProperty('title');
      expect(a).toHaveProperty('agentName', 'Claude');
      expect(a).toHaveProperty('status', 'sent');
      expect(a).toHaveProperty('validationStatus', 'not_reviewed');
    }
  });

  it('rejects checkpoint creation on an archived project', async () => {
    const id = await project();
    await request('POST', `/api/projects/${id}/archive`);
    expect((await request('POST', `/api/projects/${id}/checkpoints`, {})).statusCode).toBe(409);
  });

  it('lists checkpoints in reverse chronological order and separates archived from active', async () => {
    const id = await project();
    const first = (await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: 'first' })).json().checkpoint;
    const second = (await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: 'second' })).json().checkpoint;
    let list = (await request('GET', `/api/projects/${id}/checkpoints`)).json().checkpoints;
    expect(list.map((c: any) => c.id)).toEqual([second.id, first.id]);

    const archived = (await request('POST', `/api/projects/${id}/checkpoints/${first.id}/archive`)).json().checkpoint;
    expect(archived.archivedAt).toBeTruthy();
    list = (await request('GET', `/api/projects/${id}/checkpoints`)).json().checkpoints;
    expect(list.map((c: any) => c.id)).toEqual([second.id]);
    list = (await request('GET', `/api/projects/${id}/checkpoints?archived=true`)).json().checkpoints;
    expect(list.map((c: any) => c.id)).toEqual([first.id]);
  });

  it('paginates with a keyset cursor that never repeats or skips a checkpoint', async () => {
    const id = await project();
    for (let i = 0; i < 5; i += 1) await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: `Checkpoint ${i}` });

    const seen = new Set<string>();
    let cursor: { createdAt: string; id: string } | null = null;
    let pages = 0;
    do {
      const url = cursor
        ? `/api/projects/${id}/checkpoints?pageSize=2&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}`
        : `/api/projects/${id}/checkpoints?pageSize=2`;
      const response = await request('GET', url);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      for (const c of body.checkpoints) {
        expect(seen.has(c.id)).toBe(false);
        seen.add(c.id);
      }
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);

    expect(seen.size).toBe(5);
  });

  it('is immutable at the database privilege level: control_app cannot rewrite a checkpoint and cannot delete one', async () => {
    const id = await project();
    const checkpoint = (await request('POST', `/api/projects/${id}/checkpoints`, { sessionNote: 'original' })).json().checkpoint;

    await expect(
      harness.ctx.db.query("UPDATE project_checkpoints SET snapshot_json='{}'::jsonb WHERE id=$1", [checkpoint.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      harness.ctx.db.query("UPDATE project_checkpoints SET session_note='tampered' WHERE id=$1", [checkpoint.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      harness.ctx.db.query('DELETE FROM project_checkpoints WHERE id=$1', [checkpoint.id]),
    ).rejects.toMatchObject({ code: '42501' });

    // The one column control_app IS allowed to touch: archived_at, and only
    // through the application's own archive path (already proven above).
    const reread = (await request('GET', `/api/projects/${id}/checkpoints/${checkpoint.id}`)).json().checkpoint;
    expect(reread.sessionNote).toBe('original');
  });

  it('builds a snapshot that reflects in-progress/blocked roadmap state, next actions, pending acceptance, dependencies and recently completed tasks', async () => {
    const id = await project();
    const active = await milestone(id, 'in_progress', 'Production Readiness');
    const blockedMilestone = await milestone(id, 'blocked', 'Deployment docs');
    const t1 = await task(id, active, 'OpenObserve upgrade');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t1}/status`, { status: 'in_progress' });
    await request('PATCH', `/api/projects/${id}/roadmap/tasks/${t1}`, { nextAction: 'Run verify-security' });
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t1}/criteria`, { text: 'Passes verify' });

    const t2 = await task(id, active, 'Blocked task');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t2}/status`, { status: 'blocked', blockedReason: 'Waiting on creds' });

    const depBase = await task(id, active, 'Base dependency');
    const t3 = await task(id, active, 'Depends on base');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t3}/dependencies`, { dependsOnTaskId: depBase });

    const t4 = await task(id, active, 'Already done');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t4}/status`, { status: 'in_progress' });
    await request('POST', `/api/projects/${id}/roadmap/tasks/${t4}/status`, { status: 'done' });

    const pinned = await entry(id, { type: 'decision', title: 'Pinned decision' });
    await request('POST', `/api/projects/${id}/memory/${pinned.id}/pin`);
    const important = await entry(id, { type: 'constraint', title: 'Important constraint', importance: 'important' });
    const archivedMemory = await entry(id, { type: 'finding', title: 'Archived finding' });
    await request('POST', `/api/projects/${id}/memory/${archivedMemory.id}/archive`);
    const old = await entry(id, { type: 'decision', title: 'Old decision' });
    await request('POST', `/api/projects/${id}/memory/${old.id}/supersede`, { type: 'decision', title: 'New decision', body: 'Replaces old' });

    const checkpoint = (await request('POST', `/api/projects/${id}/checkpoints`, {})).json().checkpoint;
    const s = checkpoint.snapshot;

    expect(s.currentFocus.map((m: any) => m.title)).toContain('Production Readiness');
    expect(s.blockedMilestones.map((m: any) => m.title)).toContain('Deployment docs');
    expect(s.blockedMilestones.find((m: any) => m.title === 'Deployment docs').blockedReason).toBe('waiting');
    expect(s.inProgressTasks.map((t: any) => t.title)).toContain('OpenObserve upgrade');
    expect(s.blockedTasks.find((t: any) => t.title === 'Blocked task').blockedReason).toBe('Waiting on creds');
    expect(s.nextActions.find((t: any) => t.title === 'OpenObserve upgrade').nextAction).toBe('Run verify-security');
    expect(s.pendingAcceptance.find((t: any) => t.title === 'OpenObserve upgrade').pendingCount).toBe(1);
    expect(s.unresolvedDependencies.find((d: any) => d.title === 'Depends on base').dependsOnTitle).toBe('Base dependency');
    expect(s.recentlyCompletedTasks.map((t: any) => t.title)).toContain('Already done');

    const pinnedTitles = s.pinnedMemory.map((m: any) => m.title);
    expect(pinnedTitles).toContain('Pinned decision');
    const importantTitles = s.importantMemory.map((m: any) => m.title);
    expect(importantTitles).toContain('Important constraint');
    expect([...pinnedTitles, ...importantTitles]).not.toContain('Archived finding');
    expect([...pinnedTitles, ...importantTitles]).not.toContain('Old decision');
  });
});
