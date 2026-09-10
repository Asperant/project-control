import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { closeWorkSession as closeWorkSessionInStore } from '../../src/work-sessions/store.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
let actorId: string;
const email = 'work-sessions@example.test';
const password = 'a-secure-work-sessions-test-password';
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
    [id, `Sessions ${id.slice(0, 6)}`, `/tmp/${id}`, actorId],
  );
  return id;
}

async function start(projectId: string, goal = 'Ship the next safe increment'): Promise<any> {
  const response = await request('POST', `/api/projects/${projectId}/work-sessions`, { goal });
  expect(response.statusCode).toBe(201);
  return response.json().workSession;
}

describe.skipIf(!hasDocker)('Work Sessions', () => {
  beforeAll(async () => {
    harness = await createHarness();
    actorId = (await harness.ctx.db.query<{ id: string }>(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin') RETURNING id",
      [email, 'Work Session Tester', await hashPassword(password)],
    )).rows[0]!.id;
    const login = await harness.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.7',
    });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);

  afterAll(async () => harness?.teardown());

  it('requires authentication for reads', async () => {
    const projectId = await project();
    const response = await harness.app.inject({ method: 'GET', url: `/api/projects/${projectId}/work-sessions` });
    expect(response.statusCode).toBe(401);
  });

  it('requires CSRF and rejects viewer mutations', async () => {
    const projectId = await project();
    const noCsrf = await harness.app.inject({
      method: 'POST', url: `/api/projects/${projectId}/work-sessions`, payload: { goal: 'Denied' }, cookies: { pc_session: auth.token },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().error.code).toBe('csrf_failed');

    const viewerEmail = `viewer-${randomUUID()}@example.test`;
    const viewerPassword = 'a-secure-viewer-password';
    await harness.ctx.db.query(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'viewer')",
      [viewerEmail, 'Viewer', await hashPassword(viewerPassword)],
    );
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: viewerEmail, password: viewerPassword }, remoteAddress: '10.88.0.9' });
    const viewerAuth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
    const denied = await harness.app.inject({
      method: 'POST', url: `/api/projects/${projectId}/work-sessions`, payload: { goal: 'Denied' },
      cookies: { pc_session: viewerAuth.token }, headers: { 'x-csrf-token': viewerAuth.csrfToken },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('forbidden');
  });

  it('starts one open session, edits its goal, and rejects a second open session with 409', async () => {
    const projectId = await project();
    const session = await start(projectId);
    expect(session.status).toBe('open');
    expect(session.endedAt).toBeNull();

    const duplicate = await request('POST', `/api/projects/${projectId}/work-sessions`, { goal: 'Competing focus' });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('conflict');

    const updated = await request('PATCH', `/api/projects/${projectId}/work-sessions/${session.id}`, { goal: 'Verify the increment' });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().workSession.goal).toBe('Verify the increment');
  });

  it('also enforces one open session at the database level', async () => {
    const projectId = await project();
    await start(projectId);
    await expect(
      harness.ctx.db.query('INSERT INTO work_sessions(project_id,goal,created_by) VALUES($1,$2,$3)', [projectId, 'Second', actorId]),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('serializes simultaneous starts so exactly one session opens', async () => {
    const projectId = await project();
    const responses = await Promise.all([
      request('POST', `/api/projects/${projectId}/work-sessions`, { goal: 'Concurrent A' }),
      request('POST', `/api/projects/${projectId}/work-sessions`, { goal: 'Concurrent B' }),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    const rows = await harness.ctx.db.query("SELECT id FROM work_sessions WHERE project_id=$1 AND status='open'", [projectId]);
    expect(rows.rowCount).toBe(1);
  });

  it('protects open-session identity/start history and requires amendments to have a closed parent', async () => {
    const projectId = await project();
    const session = await start(projectId);
    await expect(
      harness.ctx.db.query('UPDATE work_sessions SET started_at=started_at - interval \'1 day\' WHERE id=$1', [session.id]),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      harness.ctx.db.query(
        'INSERT INTO work_session_amendments(work_session_id,body,created_by) VALUES($1,$2,$3)',
        [session.id, 'Too early', actorId],
      ),
    ).rejects.toMatchObject({ code: '55000' });
    await expect(
      harness.ctx.db.query(
        `INSERT INTO work_sessions(project_id,goal,status,started_at,ended_at,outcome_summary,created_by)
         VALUES($1,'Invalid chronology','closed',now(),now() - interval '1 hour','Done',$2)`,
        [projectId, actorId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('requires an outcome, closes with ended_at, and freezes historical fields', async () => {
    const projectId = await project();
    const session = await start(projectId);
    expect((await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, {})).statusCode).toBe(422);

    const response = await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, {
      outcomeSummary: 'Implemented and verified the core.',
      blockers: 'Awaiting final review.',
      nextAction: 'Run the full quality gates.',
    });
    expect(response.statusCode).toBe(200);
    const closed = response.json().workSession;
    expect(closed.status).toBe('closed');
    expect(closed.endedAt).toBeTruthy();
    expect(closed.outcomeSummary).toBe('Implemented and verified the core.');
    expect((await request('PATCH', `/api/projects/${projectId}/work-sessions/${session.id}`, { goal: 'Rewrite history' })).statusCode).toBe(409);

    await expect(
      harness.ctx.db.query('UPDATE work_sessions SET goal=$1 WHERE id=$2', ['Tampered', session.id]),
    ).rejects.toMatchObject({ code: '55000' });
    for (const sql of [
      "UPDATE work_sessions SET outcome_summary='Tampered' WHERE id=$1",
      "UPDATE work_sessions SET status='open',ended_at=NULL,outcome_summary=NULL,blockers=NULL,next_action=NULL,checkpoint_id=NULL WHERE id=$1",
      "UPDATE work_sessions SET ended_at=ended_at + interval '1 hour' WHERE id=$1",
      "UPDATE work_sessions SET created_at=created_at - interval '1 day' WHERE id=$1",
    ]) {
      await expect(harness.ctx.db.query(sql, [session.id])).rejects.toMatchObject({ code: '55000' });
    }
  });

  it('appends corrections to closed sessions and database privileges prevent amendment mutation', async () => {
    const projectId = await project();
    const session = await start(projectId);
    await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, { outcomeSummary: 'Initial summary' });
    const response = await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/amendments`, { body: 'Correction: tests were also run.' });
    expect(response.statusCode).toBe(201);
    const amendment = response.json().amendment;

    const detail = (await request('GET', `/api/projects/${projectId}/work-sessions/${session.id}`)).json().workSession;
    expect(detail.amendments.map((item: any) => item.body)).toEqual(['Correction: tests were also run.']);
    await expect(
      harness.ctx.db.query('UPDATE work_session_amendments SET body=$1 WHERE id=$2', ['Tampered', amendment.id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      harness.ctx.db.query('DELETE FROM work_session_amendments WHERE id=$1', [amendment.id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects session mutations while archived and preserves history after reactivation', async () => {
    const projectId = await project();
    const session = await start(projectId);
    const closed = await start(await project(), 'Closed elsewhere');
    const closedProjectId = (await harness.ctx.db.query<{ project_id: string }>('SELECT project_id FROM work_sessions WHERE id=$1', [closed.id])).rows[0]!.project_id;
    await request('POST', `/api/projects/${closedProjectId}/work-sessions/${closed.id}/close`, { outcomeSummary: 'Closed' });
    await request('POST', `/api/projects/${closedProjectId}/archive`);
    expect((await request('POST', `/api/projects/${closedProjectId}/work-sessions/${closed.id}/amendments`, { body: 'Denied' })).statusCode).toBe(409);

    await request('POST', `/api/projects/${projectId}/archive`);
    expect((await request('POST', `/api/projects/${projectId}/work-sessions`, { goal: 'Denied' })).statusCode).toBe(409);
    expect((await request('PATCH', `/api/projects/${projectId}/work-sessions/${session.id}`, { goal: 'Denied' })).statusCode).toBe(409);
    expect((await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, { outcomeSummary: 'Denied' })).statusCode).toBe(409);
    expect((await request('GET', `/api/projects/${projectId}/work-sessions`)).json().workSessions).toHaveLength(1);

    await request('POST', `/api/projects/${projectId}/reactivate`);
    const visible = (await request('GET', `/api/projects/${projectId}/work-sessions/${session.id}`)).json().workSession;
    expect(visible.goal).toBe('Ship the next safe increment');
  });

  it('creates and links a v3 checkpoint atomically when closing', async () => {
    const projectId = await project();
    const session = await start(projectId);
    const response = await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, {
      outcomeSummary: 'Checkpoint-ready outcome.',
      createCheckpoint: true,
      checkpointSessionNote: 'Session close checkpoint',
    });
    expect(response.statusCode).toBe(200);
    const closed = response.json().workSession;
    expect(closed.checkpointId).toBeTruthy();
    const checkpoint = (await request('GET', `/api/projects/${projectId}/checkpoints/${closed.checkpointId}`)).json().checkpoint;
    expect(checkpoint.snapshotVersion).toBe(3);
    expect(checkpoint.snapshot.gitState.status).toBe('unavailable');
    expect(checkpoint.sessionNote).toBe('Session close checkpoint');
  });

  it('handles repeated close-with-checkpoint submission without duplicate history', async () => {
    const projectId = await project();
    const session = await start(projectId);
    const payload = { outcomeSummary: 'One close only.', createCheckpoint: true };
    const responses = await Promise.all([
      request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, payload),
      request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, payload),
    ]);
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const checkpoints = await harness.ctx.db.query('SELECT id FROM project_checkpoints WHERE project_id=$1', [projectId]);
    expect(checkpoints.rowCount).toBe(1);
  });

  it('rolls checkpoint creation and session closure back when required audit fails', async () => {
    const projectId = await project();
    const session = await start(projectId);
    await expect(
      closeWorkSessionInStore(
        harness.ctx.db,
        projectId,
        session.id,
        actorId,
        { outcomeSummary: 'Must roll back', createCheckpoint: true },
        async (_client, eventType) => {
          if (eventType === 'work_session.closed') throw new Error('audit unavailable');
        },
        harness.ctx.runner,
        async () => {},
      ),
    ).rejects.toThrow('audit unavailable');
    const stored = await harness.ctx.db.query<{ status: string; checkpoint_id: string | null }>(
      'SELECT status, checkpoint_id FROM work_sessions WHERE id=$1', [session.id],
    );
    expect(stored.rows[0]).toEqual({ status: 'open', checkpoint_id: null });
    const checkpoints = await harness.ctx.db.query('SELECT 1 FROM project_checkpoints WHERE project_id=$1', [projectId]);
    expect(checkpoints.rowCount).toBe(0);
  });

  it('rejects cross-project checkpoint linkage through the composite foreign key', async () => {
    const firstProject = await project();
    const secondProject = await project();
    const checkpoint = (await request('POST', `/api/projects/${secondProject}/checkpoints`, {})).json().checkpoint;
    await expect(
      harness.ctx.db.query(
        `INSERT INTO work_sessions(project_id,goal,status,ended_at,outcome_summary,checkpoint_id,created_by)
         VALUES($1,'Closed','closed',now(),'Done',$2,$3)`,
        [firstProject, checkpoint.id, actorId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('paginates newest-first history without silently losing older sessions', async () => {
    const projectId = await project();
    for (let index = 0; index < 3; index += 1) {
      const session = await start(projectId, `Goal ${index}`);
      await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, { outcomeSummary: `Outcome ${index}` });
    }
    const firstPage = (await request('GET', `/api/projects/${projectId}/work-sessions?page=1&pageSize=2`)).json();
    const secondPage = (await request('GET', `/api/projects/${projectId}/work-sessions?page=2&pageSize=2`)).json();
    expect(firstPage.total).toBe(3);
    expect(firstPage.workSessions).toHaveLength(2);
    expect(secondPage.workSessions).toHaveLength(1);
    expect(firstPage.workSessions[0].goal).toBe('Goal 2');
  });

  it('keeps cursor pagination stable when a newer session is inserted between reads', async () => {
    const projectId = await project();
    for (let index = 0; index < 3; index += 1) {
      const session = await start(projectId, `Cursor goal ${index}`);
      await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, { outcomeSummary: `Cursor outcome ${index}` });
    }

    const firstPage = (await request('GET', `/api/projects/${projectId}/work-sessions?pageSize=2&status=closed`)).json();
    expect(firstPage.nextCursor).not.toBeNull();
    const newer = await start(projectId, 'Inserted after first page');
    await request('POST', `/api/projects/${projectId}/work-sessions/${newer.id}/close`, { outcomeSummary: 'Newer outcome' });

    const cursor = firstPage.nextCursor as { startedAt: string; id: string };
    const secondPage = (await request(
      'GET',
      `/api/projects/${projectId}/work-sessions?pageSize=2&status=closed&beforeStartedAt=${encodeURIComponent(cursor.startedAt)}&beforeId=${cursor.id}`,
    )).json();
    const firstIds = new Set(firstPage.workSessions.map((session: { id: string }) => session.id));
    expect(secondPage.workSessions).toHaveLength(1);
    expect(secondPage.workSessions[0].goal).toBe('Cursor goal 0');
    expect(secondPage.workSessions.every((session: { id: string }) => !firstIds.has(session.id))).toBe(true);
    expect(secondPage.workSessions.some((session: { id: string }) => session.id === newer.id)).toBe(false);
  });

  it('keeps free-text bodies out of Work Session audit details', async () => {
    const projectId = await project();
    const goal = 'PRIVATE_GOAL_BODY';
    const outcome = 'PRIVATE_OUTCOME_BODY';
    const session = await start(projectId, goal);
    await request('PATCH', `/api/projects/${projectId}/work-sessions/${session.id}`, { goal: 'PRIVATE_UPDATED_GOAL_BODY' });
    await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/close`, {
      outcomeSummary: outcome, blockers: 'PRIVATE_BLOCKER_BODY', nextAction: 'PRIVATE_NEXT_BODY', createCheckpoint: true,
    });
    await request('POST', `/api/projects/${projectId}/work-sessions/${session.id}/amendments`, { body: 'PRIVATE_AMENDMENT_BODY' });
    const { rows } = await harness.ctx.db.query<{ event_type: string; detail: Record<string, unknown> }>(
      "SELECT event_type,detail FROM audit_events WHERE event_type LIKE 'work_session.%' AND detail->>'workSessionId'=$1 ORDER BY event_type",
      [session.id],
    );
    expect(rows.map((row) => row.event_type)).toEqual([
      'work_session.amendment_added', 'work_session.checkpoint_created', 'work_session.closed',
      'work_session.goal_updated', 'work_session.started',
    ]);
    const serialized = JSON.stringify(rows.map((row) => row.detail));
    expect(serialized).not.toContain(goal);
    expect(serialized).not.toContain(outcome);
    expect(serialized).not.toContain('PRIVATE_BLOCKER_BODY');
    expect(serialized).not.toContain('PRIVATE_NEXT_BODY');
    expect(serialized).not.toContain('PRIVATE_AMENDMENT_BODY');
    expect(serialized).not.toContain('PRIVATE_UPDATED_GOAL_BODY');
  });

  it('grants backup_reader read-only access and denies physical deletion to control_app', async () => {
    for (const table of ['work_sessions', 'work_session_amendments']) {
      const result = await harness.ctx.db.query<{ can_read: boolean; can_delete: boolean }>(
        `SELECT has_table_privilege('backup_reader',$1,'SELECT') can_read,
                has_table_privilege('control_app',$1,'DELETE') can_delete`,
        [table],
      );
      expect(result.rows[0]).toEqual({ can_read: true, can_delete: false });
    }
  });
});
