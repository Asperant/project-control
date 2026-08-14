import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

const hasDocker = await dockerAvailable();
let harness: TestHarness;
const email = 'agent-runs@example.test';
const password = 'a-secure-agent-runs-test-password';
let auth: { token: string; csrfToken: string };

const request = (method: string, url: string, payload?: unknown) =>
  harness.app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), cookies: { pc_session: auth.token }, headers: { 'x-csrf-token': auth.csrfToken } });

async function project(status = 'active'): Promise<string> {
  const id = randomUUID();
  await harness.ctx.db.query(
    `INSERT INTO projects(id,name,status,archived_at,location_input_path,location_canonical_path,location_allowed_root,created_by)
     VALUES ($1,$2,$3,CASE WHEN $3='archived' THEN now() END,$4,$4,'/tmp',$5)`,
    [id, `Agent Runs ${id.slice(0, 6)}`, status, `/tmp/${id}`, null],
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
async function run(projectId: string, body: Record<string, unknown> = {}): Promise<any> {
  const response = await request('POST', `/api/projects/${projectId}/agent-runs`, { title: 'A run', agentName: 'Claude', ...body });
  expect(response.statusCode).toBe(201);
  return response.json().agentRun;
}
async function sentRun(projectId: string, body: Record<string, unknown> = {}): Promise<any> {
  const r = await run(projectId, body);
  await request('PATCH', `/api/projects/${projectId}/agent-runs/${r.id}/prompt`, { body: 'Please do the thing.' });
  const sent = await request('POST', `/api/projects/${projectId}/agent-runs/${r.id}/prompt/send`);
  expect(sent.statusCode).toBe(200);
  return sent.json().agentRun;
}

describe.skipIf(!hasDocker)('Agent Run provenance archive', () => {
  beforeAll(async () => {
    harness = await createHarness();
    await harness.ctx.db.query(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin')",
      [email, 'Agent Run Tester', await hashPassword(password)],
    );
    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password }, remoteAddress: '10.88.0.5' });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
  }, 120_000);
  afterAll(async () => harness?.teardown());

  it('requires authentication for reads', async () => {
    const id = await project();
    expect((await harness.app.inject({ method: 'GET', url: `/api/projects/${id}/agent-runs` })).statusCode).toBe(401);
  });

  it('creates a draft run with not_reviewed validation and no prompt', async () => {
    const id = await project();
    const r = await run(id, { title: 'First run' });
    expect(r.status).toBe('draft');
    expect(r.validationStatus).toBe('not_reviewed');
    expect(r.hasPrompt).toBe(false);
    expect(r.currentReportVersion).toBeNull();
  });

  it('updates draft metadata', async () => {
    const id = await project();
    const r = await run(id);
    const updated = (await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}`, { title: 'Renamed', agentName: 'Codex' })).json().agentRun;
    expect(updated.title).toBe('Renamed');
    expect(updated.agentName).toBe('Codex');
  });

  describe('roadmap relations', () => {
    it('accepts a same-project related task/milestone', async () => {
      const id = await project();
      const m = await milestone(id);
      const t = await task(id, m);
      const r = await run(id, { relatedTaskId: t, relatedMilestoneId: m });
      expect(r.relatedTaskId).toBe(t);
      expect(r.relatedMilestoneId).toBe(m);
      expect(r.relatedTaskTitle).toBe('Task');
    });

    it('rejects a cross-project task and a cross-project milestone', async () => {
      const id = await project();
      const other = await project();
      const om = await milestone(other);
      const ot = await task(other, om);
      expect((await request('POST', `/api/projects/${id}/agent-runs`, { title: 'X', agentName: 'Claude', relatedTaskId: ot })).statusCode).toBe(404);
      expect((await request('POST', `/api/projects/${id}/agent-runs`, { title: 'X', agentName: 'Claude', relatedMilestoneId: om })).statusCode).toBe(404);
    });

    it('rejects a related task/milestone pair that disagree', async () => {
      const id = await project();
      const m1 = await milestone(id, 'M1');
      const m2 = await milestone(id, 'M2');
      const t = await task(id, m1);
      const response = await request('POST', `/api/projects/${id}/agent-runs`, { title: 'X', agentName: 'Claude', relatedTaskId: t, relatedMilestoneId: m2 });
      expect(response.statusCode).toBe(422);
    });
  });

  describe('status lifecycle', () => {
    it('rejects an invalid status value', async () => {
      const id = await project();
      const r = await sentRun(id);
      expect((await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'bogus' })).statusCode).toBe(422);
    });

    it('walks sent -> in_progress -> completed, setting timestamps', async () => {
      const id = await project();
      const r = await sentRun(id);
      expect(r.status).toBe('sent');
      expect(r.sentAt).toBeTruthy();

      const started = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'in_progress' })).json().agentRun;
      expect(started.status).toBe('in_progress');
      expect(started.startedAt).toBeTruthy();

      const completed = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'completed' })).json().agentRun;
      expect(completed.status).toBe('completed');
      expect(completed.completedAt).toBeTruthy();
    });

    it('rejects an out-of-order transition, e.g. completed straight from draft', async () => {
      const id = await project();
      const r = await run(id);
      expect((await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'completed' })).statusCode).toBe(409);
    });

    it('allows retrying a failed run back to in_progress, then cancelling', async () => {
      const id = await project();
      const r = await sentRun(id);
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'failed' });
      const retried = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'in_progress' })).json().agentRun;
      expect(retried.status).toBe('in_progress');
      expect(retried.failedAt).toBeNull();
      const cancelled = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'cancelled' })).json().agentRun;
      expect(cancelled.status).toBe('cancelled');
    });

    it('rejects any further transition once completed or cancelled', async () => {
      const id = await project();
      const r = await sentRun(id);
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'completed' });
      expect((await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'in_progress' })).statusCode).toBe(409);
    });
  });

  describe('archive / reactivate', () => {
    it('archives and reactivates, and rejects mutation on an archived run', async () => {
      const id = await project();
      const r = await run(id);
      const archived = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/archive`)).json().agentRun;
      expect(archived.archivedAt).toBeTruthy();
      expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}`, { title: 'Denied' })).statusCode).toBe(409);
      expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'x' })).statusCode).toBe(409);

      const reactivated = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reactivate`)).json().agentRun;
      expect(reactivated.archivedAt).toBeNull();
      expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}`, { title: 'Allowed' })).statusCode).toBe(200);
    });

    it('never physically deletes an Agent Run', async () => {
      const id = await project();
      const r = await run(id);
      await expect(harness.ctx.db.query('DELETE FROM agent_runs WHERE id=$1', [r.id])).rejects.toMatchObject({ code: '42501' });
    });
  });

  it('rejects Agent Run mutation on an archived project and allows it again after reactivation', async () => {
    const id = await project();
    const r = await run(id);
    await request('POST', `/api/projects/${id}/archive`);
    expect((await request('POST', `/api/projects/${id}/agent-runs`, { title: 'X', agentName: 'Claude' })).statusCode).toBe(409);
    expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}`, { title: 'Denied' })).statusCode).toBe(409);
    expect((await request('GET', `/api/projects/${id}/agent-runs`)).statusCode).toBe(200);
    await request('POST', `/api/projects/${id}/reactivate`);
    expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}`, { title: 'Allowed' })).statusCode).toBe(200);
  });

  describe('prompt', () => {
    it('creates and edits a draft prompt', async () => {
      const id = await project();
      const r = await run(id);
      const created = (await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'v1' })).json().prompt;
      expect(created.status).toBe('draft');
      expect(created.body).toBe('v1');
      const edited = (await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'v2' })).json().prompt;
      expect(edited.id).toBe(created.id);
      expect(edited.body).toBe('v2');
    });

    it('rejects an empty prompt body', async () => {
      const id = await project();
      const r = await run(id);
      expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: '' })).statusCode).toBe(422);
    });

    it('cannot send a run with no prompt at all', async () => {
      const id = await project();
      const r = await run(id);
      expect((await request('POST', `/api/projects/${id}/agent-runs/${r.id}/prompt/send`)).statusCode).toBe(409);
    });

    it('marks a prompt sent: sets sent_at on both prompt and run, and status becomes sent', async () => {
      const id = await project();
      const r = await run(id);
      await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'Ship it' });
      const response = await request('POST', `/api/projects/${id}/agent-runs/${r.id}/prompt/send`);
      expect(response.statusCode).toBe(200);
      const { prompt, agentRun } = response.json();
      expect(prompt.status).toBe('sent');
      expect(prompt.sentAt).toBeTruthy();
      expect(agentRun.status).toBe('sent');
      expect(agentRun.sentAt).toBeTruthy();
    });

    it('is immutable once sent: body/version frozen at the DB level, control_app cannot rewrite it', async () => {
      const id = await project();
      const sent = await sentRun(id);
      const promptRow = (await harness.ctx.db.query('SELECT id FROM agent_run_prompts WHERE agent_run_id=$1', [sent.id])).rows[0];
      await expect(
        harness.ctx.db.query("UPDATE agent_run_prompts SET body='tampered' WHERE id=$1", [promptRow.id]),
      ).rejects.toMatchObject({ code: '23000' });

      // The API path agrees: editing a sent prompt is rejected as a conflict, not silently accepted.
      expect((await request('PATCH', `/api/projects/${id}/agent-runs/${sent.id}/prompt`, { body: 'tampered' })).statusCode).toBe(409);
    });

    it('double-send is idempotent, not corrupting', async () => {
      const id = await project();
      const r = await run(id);
      await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'Once' });
      const first = await request('POST', `/api/projects/${id}/agent-runs/${r.id}/prompt/send`);
      const second = await request('POST', `/api/projects/${id}/agent-runs/${r.id}/prompt/send`);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().prompt.sentAt).toBe(first.json().prompt.sentAt);
    });

    it('never physically deletes a prompt', async () => {
      const id = await project();
      const r = await run(id);
      await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'x' });
      const promptRow = (await harness.ctx.db.query('SELECT id FROM agent_run_prompts WHERE agent_run_id=$1', [r.id])).rows[0];
      await expect(harness.ctx.db.query('DELETE FROM agent_run_prompts WHERE id=$1', [promptRow.id])).rejects.toMatchObject({ code: '42501' });
    });
  });

  describe('reports', () => {
    it('creates a draft report and edits it', async () => {
      const id = await project();
      const r = await sentRun(id);
      const created = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'Draft body' })).json().report;
      expect(created.status).toBe('draft');
      expect(created.version).toBe(1);
      const edited = (await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/reports/${created.id}`, { body: 'Edited body' })).json().report;
      expect(edited.body).toBe('Edited body');
    });

    it('rejects a second concurrent draft for the same run', async () => {
      const id = await project();
      const r = await sentRun(id);
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'First draft' });
      expect((await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'Second draft' })).statusCode).toBe(409);
    });

    it('finalizes a draft; the final body/version become immutable at the DB level', async () => {
      const id = await project();
      const r = await sentRun(id);
      const draft = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'Final body' })).json().report;
      const response = await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports/${draft.id}/finalize`);
      expect(response.statusCode).toBe(200);
      const { report, supersededReport } = response.json();
      expect(report.status).toBe('final');
      expect(report.finalizedAt).toBeTruthy();
      expect(supersededReport).toBeNull();

      await expect(
        harness.ctx.db.query("UPDATE agent_reports SET body='tampered' WHERE id=$1", [report.id]),
      ).rejects.toMatchObject({ code: '23000' });
      expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/reports/${report.id}`, { body: 'tampered' })).statusCode).toBe(409);
      expect((await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports/${report.id}/finalize`)).statusCode).toBe(409);
    });

    it('never physically deletes a report', async () => {
      const id = await project();
      const r = await sentRun(id);
      const draft = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'x' })).json().report;
      await expect(harness.ctx.db.query('DELETE FROM agent_reports WHERE id=$1', [draft.id])).rejects.toMatchObject({ code: '42501' });
    });

    describe('revision / supersede', () => {
      it('starts a revision, allocates the next version, and atomically supersedes the old final only once the revision is itself finalized', async () => {
        const id = await project();
        const r = await sentRun(id);
        const v1Draft = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'v1' })).json().report;
        const v1 = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports/${v1Draft.id}/finalize`)).json().report;
        expect(v1.version).toBe(1);

        const v2Draft = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'v2' })).json().report;
        expect(v2Draft.version).toBe(2);
        expect(v2Draft.supersedesReportId).toBe(v1.id);

        // The old final stays current until the revision is actually finalized.
        let stillV1 = (await request('GET', `/api/projects/${id}/agent-runs/${r.id}/reports`)).json().reports;
        expect(stillV1.find((x: any) => x.id === v1.id).status).toBe('final');

        const finalizeResponse = await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports/${v2Draft.id}/finalize`);
        const { report: v2, supersededReport } = finalizeResponse.json();
        expect(v2.status).toBe('final');
        expect(supersededReport.id).toBe(v1.id);
        expect(supersededReport.status).toBe('superseded');
        expect(supersededReport.supersededById).toBe(v2.id);

        const all = (await request('GET', `/api/projects/${id}/agent-runs/${r.id}/reports`)).json().reports;
        expect(all.find((x: any) => x.id === v1.id).status).toBe('superseded');
        expect(all.find((x: any) => x.id === v2.id).status).toBe('final');
      });

      it('rejects self-supersede at the schema level (cannot construct one) and enforces unique version per run', async () => {
        const id = await project();
        const r = await sentRun(id);
        const draft = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'v1' })).json().report;
        await expect(
          harness.ctx.db.query('INSERT INTO agent_reports (agent_run_id, version, body) VALUES ($1,1,$2)', [r.id, 'dup']),
        ).rejects.toMatchObject({ code: '23505' });
        await expect(
          harness.ctx.db.query('UPDATE agent_reports SET superseded_by_id=id WHERE id=$1', [draft.id]),
        ).rejects.toThrow();
      });

      it('a superseded revision report is fully frozen: no further edits, no re-finalize', async () => {
        const id = await project();
        const r = await sentRun(id);
        const v1Draft = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'v1' })).json().report;
        const v1 = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports/${v1Draft.id}/finalize`)).json().report;
        const v2Draft = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'v2' })).json().report;
        await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports/${v2Draft.id}/finalize`);

        await expect(
          harness.ctx.db.query("UPDATE agent_reports SET body='tampered' WHERE id=$1", [v1.id]),
        ).rejects.toMatchObject({ code: '23000' });
      });
    });
  });

  describe('validation', () => {
    it('defaults to not_reviewed and is independent from run status', async () => {
      const id = await project();
      const r = await sentRun(id);
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'in_progress' });
      const completed = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/status`, { status: 'completed' })).json().agentRun;
      expect(completed.validationStatus).toBe('not_reviewed');

      const rejected = (await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/validation`, { status: 'rejected', note: 'verify failed' })).json().agentRun;
      expect(rejected.status).toBe('completed'); // run status untouched
      expect(rejected.validationStatus).toBe('rejected');
      expect(rejected.validationNote).toBe('verify failed');
    });

    it('accepts all five validation statuses and allows changing after accepted', async () => {
      const id = await project();
      const r = await run(id);
      for (const status of ['not_reviewed', 'under_review', 'accepted', 'accepted_with_changes', 'rejected']) {
        const updated = (await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/validation`, { status })).json().agentRun;
        expect(updated.validationStatus).toBe(status);
      }
      // accepted -> rejected must still be allowed (a later problem can be found).
      await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/validation`, { status: 'accepted' });
      const changed = (await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/validation`, { status: 'rejected', note: 'found a bug later' })).json().agentRun;
      expect(changed.validationStatus).toBe('rejected');
    });

    it('rejects an archived run\'s validation mutation', async () => {
      const id = await project();
      const r = await run(id);
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/archive`);
      expect((await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/validation`, { status: 'accepted' })).statusCode).toBe(409);
    });
  });

  describe('duplicate', () => {
    it('creates a new draft run copying title/agent/related links/prompt, without report/validation/timestamps', async () => {
      const id = await project();
      const m = await milestone(id);
      const t = await task(id, m);
      const original = await sentRun(id, { title: 'Original', relatedTaskId: t, relatedMilestoneId: m });
      await request('POST', `/api/projects/${id}/agent-runs/${original.id}/status`, { status: 'in_progress' });
      await request('POST', `/api/projects/${id}/agent-runs/${original.id}/status`, { status: 'completed' });
      const report = (await request('POST', `/api/projects/${id}/agent-runs/${original.id}/reports`, { body: 'Report' })).json().report;
      await request('POST', `/api/projects/${id}/agent-runs/${original.id}/reports/${report.id}/finalize`);
      await request('PATCH', `/api/projects/${id}/agent-runs/${original.id}/validation`, { status: 'accepted', note: 'ok' });

      const response = await request('POST', `/api/projects/${id}/agent-runs/${original.id}/duplicate`);
      expect(response.statusCode).toBe(201);
      const { agentRun: dup, prompt: dupPrompt } = response.json();
      expect(dup.id).not.toBe(original.id);
      expect(dup.title).toBe('Original');
      expect(dup.relatedTaskId).toBe(t);
      expect(dup.relatedMilestoneId).toBe(m);
      expect(dup.status).toBe('draft');
      expect(dup.validationStatus).toBe('not_reviewed');
      expect(dup.sentAt).toBeNull();
      expect(dup.completedAt).toBeNull();
      expect(dupPrompt.status).toBe('draft');
      expect(dupPrompt.body).toBe('Please do the thing.');

      const dupReports = (await request('GET', `/api/projects/${id}/agent-runs/${dup.id}/reports`)).json().reports;
      expect(dupReports).toHaveLength(0);

      // The original is untouched.
      const reloadedOriginal = (await request('GET', `/api/projects/${id}/agent-runs/${original.id}`)).json().agentRun;
      expect(reloadedOriginal.status).toBe('completed');
      expect(reloadedOriginal.validationStatus).toBe('accepted');
    });
  });

  describe('promote to memory', () => {
    it('creates a normal memory entry with server-set provenance', async () => {
      const id = await project();
      const r = await run(id, { title: 'Investigation' });
      const response = await request('POST', `/api/projects/${id}/agent-runs/${r.id}/promote-memory`, {
        type: 'finding', title: 'Root cause found', body: 'It was a race condition.',
      });
      expect(response.statusCode).toBe(201);
      const entry = response.json().entry;
      expect(entry.sourceAgentRunId).toBe(r.id);
      expect(entry.sourceAgentRunTitle).toBe('Investigation');

      const related = (await request('GET', `/api/projects/${id}/agent-runs/${r.id}/related-memory`)).json().entries;
      expect(related.map((e: any) => e.id)).toEqual([entry.id]);
    });

    it('cannot be spoofed through the general memory create endpoint', async () => {
      const id = await project();
      const r = await run(id);
      const response = await request('POST', `/api/projects/${id}/memory`, {
        type: 'finding', title: 'Spoof attempt', body: 'x', sourceAgentRunId: r.id,
      });
      // Strict schema: an unknown field on the general endpoint is rejected outright.
      expect(response.statusCode).toBe(422);
    });

    it('rejects promoting against a run from another project', async () => {
      const id = await project();
      const other = await project();
      const foreign = await run(other);
      expect(
        (await request('POST', `/api/projects/${id}/agent-runs/${foreign.id}/promote-memory`, { type: 'finding', title: 'X', body: 'Y' })).statusCode,
      ).toBe(404);
    });

    it('rejects promote-memory on an archived project', async () => {
      const id = await project();
      const r = await run(id);
      await request('POST', `/api/projects/${id}/archive`);
      expect(
        (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/promote-memory`, { type: 'finding', title: 'X', body: 'Y' })).statusCode,
      ).toBe(409);
    });

    it('the promoted memory entry survives archiving the source Agent Run', async () => {
      const id = await project();
      const r = await run(id);
      const entry = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/promote-memory`, { type: 'finding', title: 'X', body: 'Y' })).json().entry;
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/archive`);
      const reloaded = (await request('GET', `/api/projects/${id}/memory/${entry.id}`)).json().entry;
      expect(reloaded.sourceAgentRunId).toBe(r.id);
    });
  });

  describe('search and filter', () => {
    it('searches title, prompt body, report body (including superseded versions) and validation note', async () => {
      const id = await project();
      const byTitle = await run(id, { title: 'Unique Zephyr title' });
      const byPrompt = await run(id, { title: 'Other' });
      await request('PATCH', `/api/projects/${id}/agent-runs/${byPrompt.id}/prompt`, { body: 'Contains Marmalade keyword' });

      const byReport = await sentRun(id, { title: 'Report holder' });
      const v1Draft = (await request('POST', `/api/projects/${id}/agent-runs/${byReport.id}/reports`, { body: 'Old Sasquatch text' })).json().report;
      await request('POST', `/api/projects/${id}/agent-runs/${byReport.id}/reports/${v1Draft.id}/finalize`);
      const v2Draft = (await request('POST', `/api/projects/${id}/agent-runs/${byReport.id}/reports`, { body: 'New text' })).json().report;
      await request('POST', `/api/projects/${id}/agent-runs/${byReport.id}/reports/${v2Draft.id}/finalize`);

      const byNote = await run(id, { title: 'Validated one' });
      await request('PATCH', `/api/projects/${id}/agent-runs/${byNote.id}/validation`, { status: 'rejected', note: 'Ptarmigan issue found' });

      expect((await request('GET', `/api/projects/${id}/agent-runs?search=Zephyr`)).json().agentRuns.map((r: any) => r.id)).toEqual([byTitle.id]);
      expect((await request('GET', `/api/projects/${id}/agent-runs?search=Marmalade`)).json().agentRuns.map((r: any) => r.id)).toEqual([byPrompt.id]);
      // Superseded revision text (v1's "Sasquatch") must still find the run.
      expect((await request('GET', `/api/projects/${id}/agent-runs?search=Sasquatch`)).json().agentRuns.map((r: any) => r.id)).toEqual([byReport.id]);
      expect((await request('GET', `/api/projects/${id}/agent-runs?search=Ptarmigan`)).json().agentRuns.map((r: any) => r.id)).toEqual([byNote.id]);
      expect((await request('GET', `/api/projects/${id}/agent-runs?search=nowhere-to-be-found`)).json().agentRuns).toEqual([]);
    });

    it('filters by status, agent and validation status', async () => {
      const id = await project();
      await run(id, { title: 'Draft', agentName: 'Claude' });
      const sent = await sentRun(id, { title: 'Sent', agentName: 'Codex' });
      await request('PATCH', `/api/projects/${id}/agent-runs/${sent.id}/validation`, { status: 'accepted' });

      expect((await request('GET', `/api/projects/${id}/agent-runs?status=draft`)).json().agentRuns).toHaveLength(1);
      expect((await request('GET', `/api/projects/${id}/agent-runs?status=sent`)).json().agentRuns).toHaveLength(1);
      expect((await request('GET', `/api/projects/${id}/agent-runs?agentName=Codex`)).json().agentRuns).toHaveLength(1);
      expect((await request('GET', `/api/projects/${id}/agent-runs?validationStatus=accepted`)).json().agentRuns).toHaveLength(1);
      expect((await request('GET', `/api/projects/${id}/agent-runs`)).json().agentRuns).toHaveLength(2);
    });

    it('hides archived runs by default and shows them with archived=true', async () => {
      const id = await project();
      const r = await run(id);
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/archive`);
      expect((await request('GET', `/api/projects/${id}/agent-runs`)).json().agentRuns).toEqual([]);
      expect((await request('GET', `/api/projects/${id}/agent-runs?archived=true`)).json().agentRuns).toHaveLength(1);
    });
  });

  describe('timeline', () => {
    it('reflects lifecycle events scoped to this run only', async () => {
      const id = await project();
      const r = await sentRun(id, { title: 'Timeline run' });
      const other = await run(id, { title: 'Other run' });
      await request('PATCH', `/api/projects/${id}/agent-runs/${other.id}`, { title: 'Should not appear' });

      const timeline = (await request('GET', `/api/projects/${id}/agent-runs/${r.id}/timeline`)).json().timeline;
      const eventTypes = timeline.map((t: any) => t.eventType);
      expect(eventTypes).toContain('agentrun.created');
      expect(eventTypes).toContain('agentprompt.updated');
      expect(eventTypes).toContain('agentrun.sent');
      expect(timeline.every((t: any) => t.label && typeof t.label === 'string')).toBe(true);
    });
  });

  describe('audit redaction', () => {
    it('never stores prompt body, report body or validation note in audit detail', async () => {
      const id = await project();
      const r = await run(id, { title: 'Secret-shaped content' });
      await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'password=hunter2 super secret prompt content' });
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/prompt/send`);
      const report = (await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'api_key=abc123 secret report content' })).json().report;
      await request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports/${report.id}/finalize`);
      await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/validation`, { status: 'rejected', note: 'token=zzz confidential validation note' });

      const rows = (await harness.ctx.db.query<{ detail: Record<string, unknown> }>(
        `SELECT detail FROM audit_events WHERE detail->>'agentRunId'=$1`, [r.id],
      )).rows;
      expect(rows.length).toBeGreaterThan(0);
      const serialized = JSON.stringify(rows.map((row) => row.detail));
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('secret report content');
      expect(serialized).not.toContain('confidential validation note');
    });
  });

  describe('concurrency', () => {
    it('two simultaneous sends do not corrupt state', async () => {
      const id = await project();
      const r = await run(id);
      await request('PATCH', `/api/projects/${id}/agent-runs/${r.id}/prompt`, { body: 'Race' });
      const [a, b] = await Promise.all([
        request('POST', `/api/projects/${id}/agent-runs/${r.id}/prompt/send`),
        request('POST', `/api/projects/${id}/agent-runs/${r.id}/prompt/send`),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
      const finalRun = (await request('GET', `/api/projects/${id}/agent-runs/${r.id}`)).json().agentRun;
      expect(finalRun.status).toBe('sent');
    });

    it('two simultaneous "start revision" attempts do not create duplicate drafts', async () => {
      const id = await project();
      const r = await sentRun(id);
      const [a, b] = await Promise.all([
        request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'A' }),
        request('POST', `/api/projects/${id}/agent-runs/${r.id}/reports`, { body: 'B' }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([201, 409]);
      const reports = (await request('GET', `/api/projects/${id}/agent-runs/${r.id}/reports`)).json().reports;
      expect(reports.filter((x: any) => x.status === 'draft')).toHaveLength(1);
    });
  });

  it('grants backup_reader read-only access and no DELETE to control_app on all three new tables', async () => {
    for (const table of ['agent_runs', 'agent_run_prompts', 'agent_reports']) {
      const result = await harness.ctx.db.query<{ can_read: boolean; can_write: boolean }>(
        `SELECT has_table_privilege('backup_reader',$1,'SELECT') can_read, has_table_privilege('control_app',$1,'DELETE') can_write`,
        [table],
      );
      expect(result.rows[0]).toEqual({ can_read: true, can_write: false });
    }
  });
});
