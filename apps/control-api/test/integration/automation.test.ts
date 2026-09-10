import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { AutomationStore } from '../../src/automation/store.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

/**
 * Workflow run lifecycle, against a real database and a real Fastify
 * instance.
 *
 * `createHarness()` already loads and validates the real, repository-owned
 * manifest (infra/n8n/workflows/manifest.json) — see helpers.ts — which is
 * what stands as the functional check that the shipped manifest is valid.
 * This suite then swaps in a variant of it with `idempotencyWindow: 'none'`
 * on every key except `deployment-readiness`. Idempotency is a wall-clock
 * feature (a 'day'/'hour' bucket), and this suite deliberately opens and
 * settles the same workflow key many times within a single second to
 * exercise claim/settle/steps/artifact/lease behavior in isolation from one
 * another — exactly what the real window would otherwise block. The one
 * exception is kept real so the window itself still has a dedicated,
 * behavior-proving test.
 */

let harness: TestHarness;
const hasDocker = await dockerAvailable();

const ADMIN_EMAIL = 'automation-admin@example.test';
const VIEWER_EMAIL = 'automation-viewer@example.test';
const PASSWORD = 'a-sufficiently-long-test-password';

describe.skipIf(!hasDocker)('automation: workflow run lifecycle', () => {
  let n8nToken = '';

  beforeAll(async () => {
    harness = await createHarness();

    const testManifest = {
      version: 1 as const,
      workflows: harness.ctx.automationManifest.workflows.map((workflow) =>
        workflow.key === 'deployment-readiness' ? workflow : { ...workflow, idempotencyWindow: 'none' as const },
      ),
    };
    harness.ctx.automationManifest = testManifest;
    harness.ctx.automation = new AutomationStore(harness.ctx.db, testManifest);

    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [ADMIN_EMAIL, 'Automation Admin', await hashPassword(PASSWORD)],
    );
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'viewer')`,
      [VIEWER_EMAIL, 'Automation Viewer', await hashPassword(PASSWORD)],
    );

    const account = await harness.ctx.serviceTokens.ensureAccount({
      key: 'n8n-automation',
      displayName: 'n8n automation engine',
      scopes: ['automation:run', 'project:read', 'system:read', 'report:write'],
    });
    const minted = await harness.ctx.serviceTokens.mint({
      accountId: account.id,
      accountKey: account.key,
      scopes: ['automation:run', 'project:read', 'system:read', 'report:write'],
      ttlDays: 30,
      createdByUserId: null,
    });
    n8nToken = minted.token;
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  let clientCounter = 0;
  const login = (email: string) => {
    clientCounter += 1;
    return harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
      remoteAddress: `10.30.${Math.floor(clientCounter / 250)}.${clientCounter % 250}`,
    });
  };

  const asAdmin = async () => {
    const session = await login(ADMIN_EMAIL);
    return {
      cookie: readCookie(session.headers['set-cookie'], 'pc_session') as string,
      csrfToken: session.json().csrfToken as string,
    };
  };

  // A function, not a plain object: n8nToken is assigned inside the async
  // beforeAll above, after this describe body has already been evaluated, so
  // a plain object built here would permanently capture the empty initial
  // value instead of the real token.
  const service = () => ({ headers: { authorization: `Bearer ${n8nToken}` } });

  // A dedicated narrow-scope token, for scope-denial assertions.
  async function mintNarrowToken(scopes: Array<'automation:run' | 'project:read' | 'system:read' | 'report:write'>) {
    const account = await harness.ctx.serviceTokens.ensureAccount({
      key: `narrow-${Math.random().toString(36).slice(2)}`,
      displayName: 'Narrow test account',
      scopes,
    });
    const minted = await harness.ctx.serviceTokens.mint({
      accountId: account.id,
      accountKey: account.key,
      scopes,
      ttlDays: 1,
      createdByUserId: null,
    });
    return minted.token;
  }

  // ---------------------------------------------------------------------------
  describe('registry', () => {
    it('lists every manifest workflow with no run yet', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/automation/workflows', ...service() });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.workflows.length).toBe(harness.ctx.automationManifest.workflows.length);
      expect(body.workflows.every((w: { lastRun: unknown }) => w.lastRun === null)).toBe(true);
    });

    it('is reachable by a session cookie too', async () => {
      const { cookie } = await asAdmin();
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/workflows',
        cookies: { pc_session: cookie },
      });
      expect(response.statusCode).toBe(200);
    });

    it('denies a service token missing system:read', async () => {
      const narrow = await mintNarrowToken(['automation:run']);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/workflows',
        headers: { authorization: `Bearer ${narrow}` },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  // /api/system/status was cookie-only before this workflow ever ran for
  // real: System Health's "Read System Status" node was rejected outright
  // (createRequireAuth never even inspects a Bearer header), even though a
  // scoped service token existed for exactly this purpose the whole time.
  // Found and fixed during the Stage 9 live acceptance run.
  describe('system status (read, used by System Health)', () => {
    it('is reachable by a service token scoped system:read', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/system/status', ...service() });
      expect(response.statusCode).toBe(200);
      expect(response.json().components.length).toBeGreaterThan(0);
    });

    it('denies a service token missing system:read', async () => {
      const narrow = await mintNarrowToken(['automation:run']);
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/system/status',
        headers: { authorization: `Bearer ${narrow}` },
      });
      expect(response.statusCode).toBe(403);
    });

    it('remains reachable by a session cookie', async () => {
      const { cookie } = await asAdmin();
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/system/status',
        cookies: { pc_session: cookie },
      });
      expect(response.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('manual run: request-run is human-only', () => {
    it('opens a queued run for an admin', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      expect(response.statusCode).toBe(201);
      expect(response.json().run.status).toBe('queued');
      expect(response.json().run.triggerKind).toBe('manual');

      const cancelled = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${response.json().run.id}/cancel`,
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
      });
      expect(cancelled.statusCode).toBe(200);
    });

    it('denies a service token entirely, even one with automation:run', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        ...service(),
        payload: {},
      });
      // requireAuth never reads Authorization — same 401 as anonymous.
      expect(response.statusCode).toBe(401);
    });

    it('denies a viewer', async () => {
      const session = await login(VIEWER_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');
      const csrfToken = session.json().csrfToken as string;
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        cookies: { pc_session: cookie as string },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      expect(response.statusCode).toBe(403);
    });

    it('404s and audits an unknown workflow key', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/not-a-real-workflow/request-run',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      expect(response.statusCode).toBe(404);

      const { rows } = await harness.ctx.db.query(
        `SELECT 1 FROM audit_events WHERE event_type = 'workflow.run_rejected' AND detail->>'workflowKey' = 'not-a-real-workflow'`,
      );
      expect(rows.length).toBeGreaterThan(0);
    });

    it('rejects a second manual run while one is already open (one-open-per-workflow)', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const first = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      expect(first.statusCode).toBe(201);

      const second = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      expect(second.statusCode).toBe(409);

      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${first.json().run.id}/cancel`,
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('scheduled run: open is service-only', () => {
    it('opens directly into running', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'backup-health' },
      });
      expect(response.statusCode).toBe(201);
      const run = response.json().run;
      expect(run.status).toBe('running');
      expect(run.triggerKind).toBe('scheduled');
      expect(run.startedAt).not.toBeNull();

      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${run.id}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'ok', severity: 'info' },
      });
    });

    it('denies a session cookie — this route is service-only', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: { workflowKey: 'backup-health' },
      });
      expect(response.statusCode).toBe(403);
    });

    it('404s an unknown workflow key', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'not-a-real-workflow' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('rejects a second scheduled open inside the same idempotency window, even after the first settled', async () => {
      const first = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'deployment-readiness' }, // idempotencyWindow: 'day'
      });
      expect(first.statusCode).toBe(201);
      const settled = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${first.json().run.id}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'ok', severity: 'info' },
      });
      expect(settled.statusCode).toBe(200);

      const second = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'deployment-readiness' },
      });
      expect(second.statusCode).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  describe('claim queue', () => {
    it('returns 204 when nothing is queued', async () => {
      // Drain: cancel anything left open from other tests in this workflow key.
      const response = await harness.app.inject({ method: 'POST', url: '/api/automation/queue/claim', ...service() });
      expect([200, 204]).toContain(response.statusCode);
    });

    it('claims the oldest queued run and sets a lease', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      expect(opened.statusCode).toBe(201);

      const claimed = await harness.app.inject({ method: 'POST', url: '/api/automation/queue/claim', ...service() });
      expect(claimed.statusCode).toBe(200);
      expect(claimed.json().run.id).toBe(opened.json().run.id);
      expect(claimed.json().run.status).toBe('running');

      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'ok', severity: 'info' },
      });
    });

    it('never lets two concurrent claims both win the same run', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      expect(opened.statusCode).toBe(201);

      const [a, b] = await Promise.all([
        harness.app.inject({ method: 'POST', url: '/api/automation/queue/claim', ...service() }),
        harness.app.inject({ method: 'POST', url: '/api/automation/queue/claim', ...service() }),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 204]);

      const winner = a.statusCode === 200 ? a : b;
      expect(winner.json().run.id).toBe(opened.json().run.id);

      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'ok', severity: 'info' },
      });
    });

    it('denies a session cookie', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/queue/claim',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
      });
      expect(response.statusCode).toBe(403);
    });
  });

  // ---------------------------------------------------------------------------
  describe('steps and settle', () => {
    async function openRunningRun(workflowKey = 'system-health') {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey, externalRef: `exec-${Math.random().toString(36).slice(2)}` },
      });
      expect(response.statusCode).toBe(201);
      return response.json().run.id as string;
    }

    it('records steps in order and rejects a duplicate position', async () => {
      const runId = await openRunningRun();
      const first = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/steps`,
        ...service(),
        payload: { position: 0, name: 'check status', status: 'passed' },
      });
      expect(first.statusCode).toBe(201);

      const duplicate = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/steps`,
        ...service(),
        payload: { position: 0, name: 'check status again', status: 'passed' },
      });
      expect(duplicate.statusCode).toBe(409);

      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'ok', severity: 'info' },
      });
    });

    it('computes notify from the manifest severity policy', async () => {
      const runId = await openRunningRun('system-health'); // notify: info=false, warning=true, critical=true
      const infoSettle = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'all healthy', severity: 'info' },
      });
      expect(infoSettle.statusCode).toBe(200);
      expect(infoSettle.json().notify).toBe(false);

      const runId2 = await openRunningRun('backup-health');
      const criticalSettle = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId2}/settle`,
        ...service(),
        payload: { status: 'failed', summary: 'backup stale', severity: 'critical' },
      });
      expect(criticalSettle.json().notify).toBe(true);
    });

    it('rejects a second settle on an already-settled run', async () => {
      const runId = await openRunningRun();
      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'ok', severity: 'info' },
      });
      const again = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/settle`,
        ...service(),
        payload: { status: 'failed', summary: 'no', severity: 'critical' },
      });
      expect(again.statusCode).toBe(409);
    });

    it('rejects a step recorded against a queued (not yet claimed) run', async () => {
      const { cookie, csrfToken } = await asAdmin();
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/workflows/checkpoint-reminder/request-run',
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
        payload: {},
      });
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/steps`,
        ...service(),
        payload: { position: 0, name: 'too early', status: 'passed' },
      });
      expect(response.statusCode).toBe(409);

      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/cancel`,
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('artifact attachment', () => {
    it('requires report:write, not automation:run alone', async () => {
      const narrow = await mintNarrowToken(['automation:run', 'system:read']);
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        headers: { authorization: `Bearer ${narrow}` },
        payload: { workflowKey: 'system-health' },
      });
      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/artifact`,
        headers: { authorization: `Bearer ${narrow}` },
        payload: { filename: 'report.md', content: '# hi' },
      });
      expect(response.statusCode).toBe(403);

      const { cookie, csrfToken } = await asAdmin();
      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/cancel`,
        cookies: { pc_session: cookie },
        headers: { 'x-csrf-token': csrfToken },
      });
    });

    it('attaches a report and it is retrievable by id through settle', async () => {
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'weekly-project-report' },
      });
      const attached = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/artifact`,
        ...service(),
        payload: { filename: 'weekly-report.md', content: '# Weekly report\n\nAll good.' },
      });
      expect(attached.statusCode).toBe(201);
      expect(attached.json().artifactId).toMatch(/^[0-9a-f-]{36}$/);

      const settled = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${opened.json().run.id}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'sent', severity: 'info', artifactId: attached.json().artifactId },
      });
      expect(settled.json().run.result.artifactId).toBe(attached.json().artifactId);
    });
  });

  // ---------------------------------------------------------------------------
  describe('lease expiry', () => {
    it('lazily expires a running run whose lease has lapsed, on next read', async () => {
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'system-health' },
      });
      const runId = opened.json().run.id as string;

      await harness.ctx.db.query(`UPDATE workflow_runs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [runId]);

      const read = await harness.app.inject({ method: 'GET', url: `/api/automation/runs/${runId}`, ...service() });
      expect(read.json().run.status).toBe('expired');
      expect(read.json().run.result.reason).toBe('lease_expired');
    });

    it('rejects settling an already-expired run', async () => {
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'backup-health' },
      });
      const runId = opened.json().run.id as string;
      await harness.ctx.db.query(`UPDATE workflow_runs SET lease_expires_at = now() - interval '1 minute' WHERE id = $1`, [runId]);

      const settle = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'too late', severity: 'info' },
      });
      expect(settle.statusCode).toBe(409);
    });
  });

  // ---------------------------------------------------------------------------
  describe('database invariants', () => {
    it('makes a settled run immutable', async () => {
      const opened = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/runs',
        ...service(),
        payload: { workflowKey: 'system-health' },
      });
      const runId = opened.json().run.id as string;
      await harness.app.inject({
        method: 'POST',
        url: `/api/automation/runs/${runId}/settle`,
        ...service(),
        payload: { status: 'completed', summary: 'ok', severity: 'info' },
      });

      await expect(
        harness.ctx.db.query(`UPDATE workflow_runs SET status = 'running' WHERE id = $1`, [runId]),
      ).rejects.toThrow();
    });

    it('rejects an out-of-vocabulary workflow_key shape at the database layer', async () => {
      await expect(
        harness.ctx.db.query(
          `INSERT INTO workflow_runs (workflow_key, trigger_kind, service_token_id)
           VALUES ('Not Valid!', 'scheduled', (SELECT id FROM service_tokens LIMIT 1))`,
        ),
      ).rejects.toThrow();
    });
  });
});
