import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
let auth: { token: string; csrfToken: string };

const request = (method: string, url: string, payload?: unknown) => harness.app.inject({
  method,
  url,
  ...(payload !== undefined ? { payload } : {}),
  cookies: { pc_session: auth.token },
  headers: { 'x-csrf-token': auth.csrfToken },
});

async function project(): Promise<string> {
  const id = randomUUID();
  await harness.ctx.db.query(
    `INSERT INTO projects(id,name,status,location_input_path,location_canonical_path,location_allowed_root)
     VALUES ($1,$2,'active',$3,$3,'/tmp')`,
    [id, `Resume ${id.slice(0, 6)}`, `/tmp/${id}`],
  );
  return id;
}

async function milestone(projectId: string, title = 'Milestone'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones`, { title });
  return response.json().milestones.at(-1).id as string;
}

async function task(projectId: string, milestoneId: string, title: string, priority = 'medium'): Promise<string> {
  const response = await request('POST', `/api/projects/${projectId}/roadmap/milestones/${milestoneId}/tasks`, { title, priority });
  return response.json().detail.task.id as string;
}

async function resume(projectId: string): Promise<any> {
  const response = await request('GET', `/api/projects/${projectId}/resume`);
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe.skipIf(!hasDocker)('deterministic Resume Project briefing', () => {
  beforeAll(async () => {
    harness = await createHarness();
    const email = 'resume@example.test';
    const password = 'a-secure-resume-test-password';
    await harness.ctx.db.query(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin')",
      [email, 'Resume Tester', await hashPassword(password)],
    );
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.8' });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);

  afterAll(async () => harness?.teardown());

  it('requires authentication and returns explicit empty states', async () => {
    const id = await project();
    expect((await harness.app.inject({ method: 'GET', url: `/api/projects/${id}/resume` })).statusCode).toBe(401);
    const briefing = await resume(id);
    expect(briefing.currentFocus).toMatchObject({ kind: 'none' });
    expect(briefing.recommendedNextAction).toEqual({ kind: 'none_pending', message: 'There is no pending roadmap action.' });
    expect(briefing.attentionRequired.items).toEqual([
      { key: 'git_inspection_unavailable', label: 'Git inspection is unavailable.', count: 1 },
    ]);
    expect(briefing.developmentState).toMatchObject({ status: 'unavailable', errorCode: 'runner_unavailable' });
    expect(briefing.workSessionHistory).toMatchObject({ workSessions: [], page: 1, pageSize: 20, total: 0 });
  });

  it('uses the open Work Session as focus while keeping the roadmap recommendation server-selected', async () => {
    const id = await project();
    const m = await milestone(id);
    const selected = await task(id, m, 'Critical planned', 'critical');
    await request('PATCH', `/api/projects/${id}/roadmap/tasks/${selected}`, { nextAction: 'Run the focused verification' });
    const started = (await request('POST', `/api/projects/${id}/work-sessions`, { goal: 'Finish the Resume flow' })).json().workSession;

    const first = await resume(id);
    const second = await resume(id);
    expect(first.currentFocus).toMatchObject({ kind: 'work_session', workSessionId: started.id, goal: 'Finish the Resume flow' });
    expect(first.recommendedNextAction).toMatchObject({ kind: 'roadmap_task', taskId: selected, action: 'Run the focused verification', actionSource: 'next_action' });
    expect(first.workSessionHistory).toMatchObject({ workSessions: [], total: 0 });
    expect(second.recommendedNextAction).toEqual(first.recommendedNextAction);

    await request('POST', `/api/projects/${id}/work-sessions/${started.id}/close`, { outcomeSummary: 'Resume flow completed.' });
    const closed = await resume(id);
    expect(closed.activeWorkSession).toBeNull();
    expect(closed.workSessionHistory.total).toBe(1);
    expect(closed.workSessionHistory.workSessions.map((item: any) => item.id)).toEqual([started.id]);
  });

  it('excludes unresolved work, honors priority, and falls back to the first incomplete criterion', async () => {
    const id = await project();
    const m = await milestone(id);
    const dependency = await task(id, m, 'Dependency');
    const unavailable = await task(id, m, 'Unavailable critical', 'critical');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${unavailable}/dependencies`, { dependsOnTaskId: dependency });
    const selected = await task(id, m, 'Ready high', 'high');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${selected}/criteria`, { text: 'First acceptance step' });
    await request('POST', `/api/projects/${id}/roadmap/tasks/${selected}/criteria`, { text: 'Second acceptance step' });

    const briefing = await resume(id);
    expect(briefing.currentFocus).toMatchObject({ kind: 'roadmap_task', taskId: selected });
    expect(briefing.recommendedNextAction).toMatchObject({
      kind: 'roadmap_task', taskId: selected, action: 'First acceptance step', actionSource: 'acceptance_criterion',
    });
    expect(briefing.attentionRequired.unresolvedDependencyCount).toBe(1);
    expect(briefing.attentionRequired.incompleteAcceptanceCount).toBe(2);
  });

  it('composes attention, existing Recent Agent Work, current memory and reachable session history', async () => {
    const id = await project();
    const m = await milestone(id);
    const blocked = await task(id, m, 'Blocked');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${blocked}/status`, { status: 'blocked', blockedReason: 'Waiting' });

    const run = (await request('POST', `/api/projects/${id}/agent-runs`, { title: 'Needs review', agentName: 'Codex' })).json().agentRun;
    await request('PATCH', `/api/projects/${id}/agent-runs/${run.id}/prompt`, { body: 'Do the work' });
    await request('POST', `/api/projects/${id}/agent-runs/${run.id}/prompt/send`);
    await request('POST', `/api/projects/${id}/agent-runs/${run.id}/status`, { status: 'completed' });
    const failedRun = (await request('POST', `/api/projects/${id}/agent-runs`, { title: 'Failed work', agentName: 'Claude' })).json().agentRun;
    await request('PATCH', `/api/projects/${id}/agent-runs/${failedRun.id}/prompt`, { body: 'Try the work' });
    await request('POST', `/api/projects/${id}/agent-runs/${failedRun.id}/prompt/send`);
    await request('POST', `/api/projects/${id}/agent-runs/${failedRun.id}/status`, { status: 'failed' });

    const old = (await request('POST', `/api/projects/${id}/memory`, { type: 'decision', title: 'Old', body: 'Old decision', importance: 'critical' })).json().entry;
    await request('POST', `/api/projects/${id}/memory/${old.id}/supersede`, { type: 'decision', title: 'Current', body: 'Current decision', importance: 'important' });
    const pinned = (await request('POST', `/api/projects/${id}/memory`, { type: 'constraint', title: 'Pinned constraint', body: 'Keep it', isPinned: true })).json().entry;
    const critical = (await request('POST', `/api/projects/${id}/memory`, { type: 'finding', title: 'Critical finding', body: 'Act on it', importance: 'critical' })).json().entry;

    for (let index = 0; index < 21; index += 1) {
      const session = (await request('POST', `/api/projects/${id}/work-sessions`, { goal: `Goal ${index}` })).json().workSession;
      await request('POST', `/api/projects/${id}/work-sessions/${session.id}/close`, { outcomeSummary: `Outcome ${index}` });
    }

    const briefing = await resume(id);
    expect(briefing.attentionRequired).toMatchObject({ blockedTaskCount: 1, agentRunsAwaitingValidationCount: 1, failedAgentRunCount: 1 });
    expect(briefing.recentAgentWork.map((item: any) => item.agentRunId)).toContain(run.id);
    expect(briefing.recentAgentWork.some((item: any) => 'body' in item)).toBe(false);
    expect(briefing.importantMemory[0].id).toBe(pinned.id);
    expect(briefing.importantMemory[1].id).toBe(critical.id);
    expect(briefing.importantMemory.map((item: any) => item.title)).toContain('Current');
    expect(briefing.importantMemory.map((item: any) => item.title)).not.toContain('Old');
    expect(briefing.workSessionHistory.workSessions).toHaveLength(20);
    expect(briefing.workSessionHistory.total).toBe(21);

    // Work Session history pagination is pure keyset — see work-sessions.test.ts.
    // Reaching the 21st (oldest) session goes through nextCursor, not `page`.
    const cursor = briefing.workSessionHistory.nextCursor as { startedAt: string; id: string };
    expect(cursor).not.toBeNull();
    const secondPage = (await request(
      'GET',
      `/api/projects/${id}/work-sessions?pageSize=20&status=closed&beforeStartedAt=${encodeURIComponent(cursor.startedAt)}&beforeId=${cursor.id}`,
    )).json();
    expect(secondPage.workSessions).toHaveLength(1);
  });

  it('does not surface tasks from archived milestones as current work or attention', async () => {
    const id = await project();
    const m = await milestone(id, 'Archived container');
    const active = await task(id, m, 'Stale active');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${active}/status`, { status: 'in_progress' });
    const blocked = await task(id, m, 'Stale blocked');
    await request('POST', `/api/projects/${id}/roadmap/tasks/${blocked}/status`, { status: 'blocked', blockedReason: 'Old blocker' });
    await request('POST', `/api/projects/${id}/roadmap/milestones/${m}/archive`);

    const briefing = await resume(id);
    expect(briefing.activeAndBlockedWork).toEqual({ active: [], blocked: [] });
    expect(briefing.attentionRequired.blockedTaskCount).toBe(0);
    expect(briefing.recommendedNextAction).toMatchObject({ kind: 'none_pending' });
  });
});
