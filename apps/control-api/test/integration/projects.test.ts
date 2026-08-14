import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';
import { startRunnerProcess, type RunnerProcess } from './runner-process.js';

const exec = promisify(execFile);

/**
 * The project-registration feature, end to end: a real runner process reading
 * a real fixture directory, a real PostgreSQL database with the real
 * migrations applied, and a real Fastify app. Nothing about path validation,
 * duplicate detection or secret exclusion is meaningfully testable against a
 * mock, so nothing here is mocked.
 */

let harness: TestHarness;
let runner: RunnerProcess;
const hasDocker = await dockerAvailable();
const hasGo = await exec('go', ['version']).then(
  () => true,
  () => false,
);

const EMAIL = 'projects@example.test';
const PASSWORD = 'a-perfectly-cromulent-test-password';
const OTHER_EMAIL = 'other-user@example.test';

async function gitInit(dir: string): Promise<void> {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.com' };
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: dir, env });
  await exec('git', ['add', '.'], { cwd: dir, env });
  await exec('git', ['commit', '-q', '-m', 'initial commit'], { cwd: dir, env });
}

async function makeFixture(name: string, files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(runner.allowedRoot, name);
  await mkdir(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, 'utf8');
  }
  return dir;
}

describe.skipIf(!hasDocker || !hasGo)('project registration', () => {
  beforeAll(async () => {
    runner = await startRunnerProcess();
    harness = await createHarness({ runnerSocketPath: runner.socketPath });
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [EMAIL, 'Project Tester', await hashPassword(PASSWORD)],
    );
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [OTHER_EMAIL, 'Other User', await hashPassword(PASSWORD)],
    );
  }, 180_000);

  afterAll(async () => {
    await harness?.teardown();
    await runner?.stop();
  });

  let clientCounter = 0;
  const authenticate = async (email = EMAIL): Promise<{ token: string; csrfToken: string }> => {
    clientCounter += 1;
    const response = await harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password: PASSWORD },
      remoteAddress: `10.30.${Math.floor(clientCounter / 250)}.${clientCounter % 250}`,
    });
    return {
      token: readCookie(response.headers['set-cookie'], 'pc_session') as string,
      csrfToken: response.json().csrfToken as string,
    };
  };

  const authed = (auth: { token: string; csrfToken: string }) => ({
    cookies: { pc_session: auth.token },
    headers: { 'x-csrf-token': auth.csrfToken },
  });

  // ---------------------------------------------------------------------------
  describe('authentication', () => {
    it('requires authentication to inspect a path', async () => {
      const response = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: '/tmp' } });
      expect(response.statusCode).toBe(401);
    });

    it('requires authentication to list projects', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/projects' });
      expect(response.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('path validation', () => {
    it('rejects a path outside the allowed root', async () => {
      const auth = await authenticate();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/projects/inspections',
        payload: { path: '/etc' },
        ...authed(auth),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects a relative path', async () => {
      const auth = await authenticate();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/projects/inspections',
        payload: { path: 'relative/path' },
        ...authed(auth),
      });
      expect(response.statusCode).toBe(400);
    });

    it('rejects the allowed root itself', async () => {
      const auth = await authenticate();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/projects/inspections',
        payload: { path: runner.allowedRoot },
        ...authed(auth),
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // ---------------------------------------------------------------------------
  describe('inspection → create flow', () => {
    it('inspects a Node project and never leaks a secret file into the preview', async () => {
      const dir = await makeFixture('node-demo', {
        'package.json': JSON.stringify({
          name: 'demo',
          dependencies: { react: '^18.0.0' },
          scripts: { test: 'vitest run', build: 'vite build' },
        }),
        '.env': 'DATABASE_PASSWORD=supersecret\n',
      });

      const auth = await authenticate();
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/projects/inspections',
        payload: { path: dir },
        ...authed(auth),
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.location.canonicalPath).toBe(dir);
      expect(body.technologies.some((t: { name: string }) => t.name === 'React')).toBe(true);
      expect(response.body).not.toContain('supersecret');
      expect(response.body).not.toContain('.env');
    });

    it('creates a project from a confirmed inspection', async () => {
      const dir = await makeFixture('create-demo', { 'package.json': JSON.stringify({ name: 'demo' }) });
      const auth = await authenticate();

      const inspection = await harness.app.inject({
        method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth),
      });
      const inspectionId = inspection.json().inspectionId;

      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { inspectionId, name: 'Create Demo' },
        ...authed(auth),
      });

      expect(created.statusCode).toBe(201);
      const project = created.json().project;
      expect(project.name).toBe('Create Demo');
      expect(project.location.canonicalPath).toBe(dir);
      expect(project.status).toBe('active');
    });

    it('rejects creating a project from an already-used inspection', async () => {
      const dir = await makeFixture('double-use-demo');
      const auth = await authenticate();

      const inspection = await harness.app.inject({
        method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth),
      });
      const inspectionId = inspection.json().inspectionId;

      const first = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId, name: 'First' }, ...authed(auth),
      });
      expect(first.statusCode).toBe(201);

      const second = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId, name: 'Second' }, ...authed(auth),
      });
      expect(second.statusCode).toBe(404);
    });

    it('rejects using an inspection created by a different user', async () => {
      const dir = await makeFixture('cross-user-demo');
      const owner = await authenticate(EMAIL);
      const other = await authenticate(OTHER_EMAIL);

      const inspection = await harness.app.inject({
        method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(owner),
      });
      const inspectionId = inspection.json().inspectionId;

      const response = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId, name: 'Stolen' }, ...authed(other),
      });
      expect(response.statusCode).toBe(404);
    });

    it('does not create a project until the inspection is explicitly confirmed', async () => {
      const dir = await makeFixture('no-auto-create-demo');
      const auth = await authenticate();

      await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });

      const { rowCount } = await harness.ctx.db.query(`SELECT 1 FROM projects WHERE location_canonical_path = $1`, [dir]);
      expect(rowCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('duplicate detection', () => {
    it('rejects registering the same canonical path twice', async () => {
      const dir = await makeFixture('dup-path-demo');
      const auth = await authenticate();

      const insp1 = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const create1 = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp1.json().inspectionId, name: 'Dup A' }, ...authed(auth),
      });
      expect(create1.statusCode).toBe(201);

      const insp2 = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const create2 = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp2.json().inspectionId, name: 'Dup B' }, ...authed(auth),
      });
      expect(create2.statusCode).toBe(409);
    });

    it('rejects two different folders that share the same git remote', async () => {
      const dirA = await makeFixture('repo-a', { 'README.md': 'a' });
      await gitInit(dirA);
      await exec('git', ['remote', 'add', 'origin', 'https://example.com/org/shared.git'], { cwd: dirA });

      const dirB = await makeFixture('repo-b', { 'README.md': 'b' });
      await gitInit(dirB);
      await exec('git', ['remote', 'add', 'origin', 'https://example.com/org/shared.git'], { cwd: dirB });

      const auth = await authenticate();
      const inspA = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dirA }, ...authed(auth) });
      const createA = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: inspA.json().inspectionId, name: 'Repo A' }, ...authed(auth),
      });
      expect(createA.statusCode).toBe(201);

      const inspB = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dirB }, ...authed(auth) });
      const createB = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: inspB.json().inspectionId, name: 'Repo B' }, ...authed(auth),
      });
      expect(createB.statusCode).toBe(409);
    });

    it('allows two different git-less folders (both have a null repository identity)', async () => {
      const dirA = await makeFixture('gitless-a');
      const dirB = await makeFixture('gitless-b');
      const auth = await authenticate();

      for (const [dir, name] of [[dirA, 'Gitless A'], [dirB, 'Gitless B']] as const) {
        const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
        const created = await harness.app.inject({
          method: 'POST', url: '/api/projects', payload: { inspectionId: insp.json().inspectionId, name }, ...authed(auth),
        });
        expect(created.statusCode).toBe(201);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('project lifecycle', () => {
    it('lists, updates, archives and reactivates a project', async () => {
      const dir = await makeFixture('lifecycle-demo');
      const auth = await authenticate();

      const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const created = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp.json().inspectionId, name: 'Lifecycle Demo' }, ...authed(auth),
      });
      const id = created.json().project.id;

      const list = await harness.app.inject({ method: 'GET', url: '/api/projects?search=Lifecycle', ...authed(auth) });
      expect(list.statusCode).toBe(200);
      expect(list.json().projects.some((p: { id: string }) => p.id === id)).toBe(true);

      const updated = await harness.app.inject({
        method: 'PATCH', url: `/api/projects/${id}`, payload: { priority: 'critical', description: 'Updated' }, ...authed(auth),
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().project.priority).toBe('critical');

      const archived = await harness.app.inject({ method: 'POST', url: `/api/projects/${id}/archive`, ...authed(auth) });
      expect(archived.statusCode).toBe(200);
      expect(archived.json().project.status).toBe('archived');

      const excludedByDefault = await harness.app.inject({ method: 'GET', url: '/api/projects?search=Lifecycle', ...authed(auth) });
      expect(excludedByDefault.json().projects.some((p: { id: string }) => p.id === id)).toBe(false);

      const includedExplicitly = await harness.app.inject({
        method: 'GET', url: '/api/projects?search=Lifecycle&includeArchived=true', ...authed(auth),
      });
      expect(includedExplicitly.json().projects.some((p: { id: string }) => p.id === id)).toBe(true);

      const reactivated = await harness.app.inject({ method: 'POST', url: `/api/projects/${id}/reactivate`, ...authed(auth) });
      expect(reactivated.statusCode).toBe(200);
      expect(reactivated.json().project.status).toBe('active');
    });

    it('records audit events for inspection and creation', async () => {
      const dir = await makeFixture('audit-demo');
      const auth = await authenticate();

      const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp.json().inspectionId, name: 'Audit Demo' }, ...authed(auth),
      });

      const { rows } = await harness.ctx.db.query<{ event_type: string }>(
        `SELECT event_type FROM audit_events WHERE event_type IN ('project.inspection.started','project.created') ORDER BY occurred_at DESC LIMIT 5`,
      );
      expect(rows.map((r) => r.event_type)).toEqual(expect.arrayContaining(['project.inspection.started', 'project.created']));
    });
  });

  // ---------------------------------------------------------------------------
  describe('rules, technologies and commands', () => {
    it('manages rules end to end', async () => {
      const dir = await makeFixture('rules-demo');
      const auth = await authenticate();
      const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const created = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp.json().inspectionId, name: 'Rules Demo' }, ...authed(auth),
      });
      const id = created.json().project.id;

      const added = await harness.app.inject({
        method: 'POST', url: `/api/projects/${id}/rules`, payload: { category: 'security', text: 'No secrets in logs.' }, ...authed(auth),
      });
      expect(added.statusCode).toBe(201);
      const ruleId = added.json().rule.id;

      const updated = await harness.app.inject({
        method: 'PATCH', url: `/api/projects/${id}/rules/${ruleId}`, payload: { enabled: false }, ...authed(auth),
      });
      expect(updated.json().rule.enabled).toBe(false);

      const deleted = await harness.app.inject({ method: 'DELETE', url: `/api/projects/${id}/rules/${ruleId}`, ...authed(auth) });
      expect(deleted.statusCode).toBe(200);
    });

    it('lets an operator add a technology but not delete an auto-detected one', async () => {
      const dir = await makeFixture('tech-demo', { 'package.json': JSON.stringify({ dependencies: { react: '^18' } }) });
      const auth = await authenticate();
      const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const inspectedTechnologies = insp
        .json()
        .technologies.map((t: { name: string; category: string; version: string | null; evidencePath: string | null }) => ({
          ...t,
          detectionSource: 'manifest',
        }));
      const created = await harness.app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { inspectionId: insp.json().inspectionId, name: 'Tech Demo', technologies: inspectedTechnologies },
        ...authed(auth),
      });
      const project = created.json().project;
      const id = project.id;
      const detectedTech = project.technologies.find((t: { name: string }) => t.name === 'React');
      expect(detectedTech).toBeDefined();

      const addUser = await harness.app.inject({
        method: 'POST', url: `/api/projects/${id}/technologies`, payload: { name: 'Custom Tool', category: 'other' }, ...authed(auth),
      });
      expect(addUser.statusCode).toBe(201);

      const rejectDeleteDetected = await harness.app.inject({
        method: 'DELETE', url: `/api/projects/${id}/technologies/${detectedTech.id}`, ...authed(auth),
      });
      expect(rejectDeleteDetected.statusCode).toBe(404);

      const deleteUserAdded = await harness.app.inject({
        method: 'DELETE', url: `/api/projects/${id}/technologies/${addUser.json().technology.id}`, ...authed(auth),
      });
      expect(deleteUserAdded.statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('rescan and diff', () => {
    it('surfaces a branch change as an informational diff and applies it', async () => {
      const dir = await makeFixture('rescan-demo', { 'README.md': 'x' });
      await gitInit(dir);

      const auth = await authenticate();
      const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const created = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp.json().inspectionId, name: 'Rescan Demo' }, ...authed(auth),
      });
      const id = created.json().project.id;
      expect(created.json().project.repository.activeBranch).toBe('main');

      await exec('git', ['checkout', '-q', '-b', 'feature/x'], { cwd: dir });

      const rescan = await harness.app.inject({ method: 'POST', url: `/api/projects/${id}/rescan`, ...authed(auth) });
      expect(rescan.statusCode).toBe(201);
      const rescanBody = rescan.json();
      expect(rescanBody.requiresConfirmation).toBe(false);
      expect(rescanBody.diff.some((d: { changeType: string }) => d.changeType === 'branch_changed')).toBe(true);

      const apply = await harness.app.inject({
        method: 'POST', url: `/api/projects/${id}/rescan/apply`, payload: { inspectionId: rescanBody.inspectionId }, ...authed(auth),
      });
      expect(apply.statusCode).toBe(200);
      expect(apply.json().project.repository.activeBranch).toBe('feature/x');
    });

    it('requires explicit confirmation for a changed repository identity', async () => {
      const dir = await makeFixture('rescan-identity-demo', { 'README.md': 'x' });
      await gitInit(dir);
      await exec('git', ['remote', 'add', 'origin', 'https://example.com/org/original.git'], { cwd: dir });

      const auth = await authenticate();
      const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const created = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp.json().inspectionId, name: 'Identity Demo' }, ...authed(auth),
      });
      const id = created.json().project.id;

      await exec('git', ['remote', 'set-url', 'origin', 'https://example.com/org/renamed.git'], { cwd: dir });

      const rescan = await harness.app.inject({ method: 'POST', url: `/api/projects/${id}/rescan`, ...authed(auth) });
      expect(rescan.json().requiresConfirmation).toBe(true);

      const applyWithoutConfirm = await harness.app.inject({
        method: 'POST', url: `/api/projects/${id}/rescan/apply`, payload: { inspectionId: rescan.json().inspectionId }, ...authed(auth),
      });
      expect(applyWithoutConfirm.statusCode).toBe(409);

      const applyWithConfirm = await harness.app.inject({
        method: 'POST',
        url: `/api/projects/${id}/rescan/apply`,
        payload: { inspectionId: rescan.json().inspectionId, confirmRepositoryIdentityChange: true },
        ...authed(auth),
      });
      expect(applyWithConfirm.statusCode).toBe(200);
      expect(applyWithConfirm.json().project.repository.normalizedIdentity).toBe('example.com/org/renamed');
    });

    it('preserves a user-added rule and a user-added technology across a rescan apply', async () => {
      const dir = await makeFixture('rescan-preserve-demo', { 'package.json': JSON.stringify({ dependencies: { react: '^18' } }) });
      const auth = await authenticate();
      const insp = await harness.app.inject({ method: 'POST', url: '/api/projects/inspections', payload: { path: dir }, ...authed(auth) });
      const created = await harness.app.inject({
        method: 'POST', url: '/api/projects', payload: { inspectionId: insp.json().inspectionId, name: 'Preserve Demo' }, ...authed(auth),
      });
      const id = created.json().project.id;

      await harness.app.inject({
        method: 'POST', url: `/api/projects/${id}/rules`, payload: { category: 'scope', text: 'Keep this.' }, ...authed(auth),
      });
      await harness.app.inject({
        method: 'POST', url: `/api/projects/${id}/technologies`, payload: { name: 'Manual Tool', category: 'other' }, ...authed(auth),
      });

      const rescan = await harness.app.inject({ method: 'POST', url: `/api/projects/${id}/rescan`, ...authed(auth) });
      await harness.app.inject({
        method: 'POST', url: `/api/projects/${id}/rescan/apply`, payload: { inspectionId: rescan.json().inspectionId }, ...authed(auth),
      });

      const detail = await harness.app.inject({ method: 'GET', url: `/api/projects/${id}`, ...authed(auth) });
      const project = detail.json().project;
      expect(project.rules.some((r: { text: string }) => r.text === 'Keep this.')).toBe(true);
      expect(project.technologies.some((t: { name: string }) => t.name === 'Manual Tool')).toBe(true);
    });
  });
});
