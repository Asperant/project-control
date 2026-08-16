import { execFile } from 'node:child_process';
import { readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';
import { startRunnerProcess, type RunnerProcess } from './runner-process.js';

const exec = promisify(execFile);

/**
 * Repository Actions, end to end: a real runner process, a real write-enabled
 * git repository, a real PostgreSQL database with the real migrations
 * applied, and a real Fastify app. Nothing about the compare-and-swap commit,
 * the fingerprint staleness check, or protected-path exclusion is meaningfully
 * testable against a mock, so nothing here is mocked — matching
 * projects.test.ts's approach for the same reason.
 *
 * Project rows are created once in beforeAll rather than per test: a partial
 * unique index permits only one *active* project per canonical filesystem
 * path (see docs/security-model.md ยง11), so re-registering the same fixture
 * directory for every `it()` would collide. Tests that mutate the fixture
 * repository restore it (`git checkout -- README.md`) before the next test
 * runs.
 */

let harness: TestHarness;
let runner: RunnerProcess;
const hasDocker = await dockerAvailable();
const hasGo = await exec('go', ['version']).then(
  () => true,
  () => false,
);

const EMAIL = 'repo-actions@example.test';
const PASSWORD = 'a-perfectly-cromulent-repo-actions-password';
const VIEWER_EMAIL = 'repo-actions-viewer@example.test';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' };

async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: dir, env: gitEnv });
  return stdout.trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, 'init', '-q', '-b', 'main');
  await git(dir, 'config', 'user.email', 'owner@example.com');
  await git(dir, 'config', 'user.name', 'Owner');
  await writeFile(path.join(dir, 'README.md'), 'hello\n', 'utf8');
  await git(dir, 'add', 'README.md');
  await git(dir, 'commit', '-q', '-m', 'initial commit');
}

describe.skipIf(!hasDocker || !hasGo)('repository actions', () => {
  let auth: { token: string; csrfToken: string };
  let viewerAuth: { token: string; csrfToken: string };
  let writableDir: string;
  let unwritableDir: string;
  let writableProjectId: string;
  let unwritableProjectId: string;

  async function insertProject(canonicalPath: string, status = 'active'): Promise<string> {
    const id = randomUUID();
    await harness.ctx.db.query(
      `INSERT INTO projects(id,name,status,archived_at,location_input_path,location_canonical_path,location_allowed_root,created_by)
       VALUES ($1,$2,$3,CASE WHEN $3='archived' THEN now() END,$4,$4,$5,$6)`,
      [id, `Repo Action Test ${id.slice(0, 6)}`, status, canonicalPath, runner.allowedRoot, null],
    );
    return id;
  }

  beforeAll(async () => {
    runner = await startRunnerProcess({ writeEnabledProjectNames: ['writable-demo'] });
    harness = await createHarness({ runnerSocketPath: runner.socketPath });
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'admin')`,
      [EMAIL, 'Repo Actions Tester', await hashPassword(PASSWORD)],
    );
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, $3, 'viewer')`,
      [VIEWER_EMAIL, 'Repo Actions Viewer', await hashPassword(PASSWORD)],
    );

    writableDir = runner.writeEnabledPaths['writable-demo']!;
    await initRepo(writableDir);

    unwritableDir = path.join(runner.allowedRoot, 'not-write-enabled');
    await exec('mkdir', ['-p', unwritableDir]);
    await initRepo(unwritableDir);

    writableProjectId = await insertProject(writableDir);
    unwritableProjectId = await insertProject(unwritableDir);

    const login = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD }, remoteAddress: '10.88.0.4' });
    auth = { token: readCookie(login.headers['set-cookie'], 'pc_session')!, csrfToken: login.json().csrfToken };
    const viewerLogin = await harness.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: VIEWER_EMAIL, password: PASSWORD }, remoteAddress: '10.88.0.5' });
    viewerAuth = { token: readCookie(viewerLogin.headers['set-cookie'], 'pc_session')!, csrfToken: viewerLogin.json().csrfToken };
  }, 180_000);

  afterAll(async () => {
    await harness?.teardown();
    await runner?.stop();
  });

  const request = (method: string, url: string, payload?: unknown, session = auth) =>
    harness.app.inject({ method, url, ...(payload !== undefined ? { payload } : {}), cookies: { pc_session: session.token }, headers: { 'x-csrf-token': session.csrfToken } });

  it('requires authentication for every route', async () => {
    expect((await harness.app.inject({ method: 'GET', url: `/api/projects/${writableProjectId}/actions` })).statusCode).toBe(401);
    expect((await harness.app.inject({ method: 'POST', url: `/api/projects/${writableProjectId}/actions/git-commit/plan`, payload: {} })).statusCode).toBe(401);
  });

  it('rejects planning by a viewer role', async () => {
    const response = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, { paths: ['README.md'], message: 'x' }, viewerAuth);
    expect(response.statusCode).toBe(403);
  });

  it('rejects a plan for a project not on the write-enabled list', async () => {
    const response = await request('POST', `/api/projects/${unwritableProjectId}/actions/git-commit/plan`, { paths: ['README.md'], message: 'feat: x' });
    expect(response.statusCode).toBe(409);
  });

  it('rejects a plan whose entire selection is protected', async () => {
    await writeFile(path.join(writableDir, '.env'), 'SECRET=1\n', 'utf8');
    const response = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, { paths: ['.env'], message: 'feat: x' });
    expect(response.statusCode).toBe(400);
    await exec('rm', ['-f', path.join(writableDir, '.env')]);
  });

  it('plans, executes and verifies a full commit; the file lands on disk and HEAD moves', async () => {
    await writeFile(path.join(writableDir, 'README.md'), 'hello-changed\n', 'utf8');
    const before = await git(writableDir, 'rev-parse', 'HEAD');

    const planResponse = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, {
      paths: ['README.md'], message: 'feat: update readme',
    });
    expect(planResponse.statusCode).toBe(201);
    const planned = planResponse.json().action;
    expect(planned.status).toBe('planned');
    expect(planned.plan.selectedPaths).toEqual(['README.md']);
    expect(planned.plan.expectedHead).toBe(before);

    const execResponse = await request('POST', `/api/projects/${writableProjectId}/actions/${planned.id}/execute`, { fingerprint: planned.fingerprint });
    expect(execResponse.statusCode).toBe(200);

    const executed = execResponse.json().action;
    expect(executed.status).toBe('succeeded');
    expect(executed.result.succeeded).toBe(true);
    expect(executed.result.commit.verified).toBe(true);
    expect(executed.result.commit.branch).toBe('main');

    const headAfter = await git(writableDir, 'rev-parse', 'HEAD');
    expect(headAfter).toBe(executed.result.commit.commitSha);
    expect(headAfter).not.toBe(before);
    const fileContent = await readFile(path.join(writableDir, 'README.md'), 'utf8');
    expect(fileContent).toBe('hello-changed\n');
  });

  it('rejects execute with a fingerprint that does not match the stored plan', async () => {
    await writeFile(path.join(writableDir, 'README.md'), 'again\n', 'utf8');
    const planResponse = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, {
      paths: ['README.md'], message: 'feat: x',
    });
    const planned = planResponse.json().action;
    const response = await request('POST', `/api/projects/${writableProjectId}/actions/${planned.id}/execute`, { fingerprint: 'a'.repeat(64) });
    expect(response.statusCode).toBe(400);
    await request('POST', `/api/projects/${writableProjectId}/actions/${planned.id}/cancel`);
    await git(writableDir, 'checkout', '--', 'README.md');
  });

  it('expires a plan when the repository changes before execute', async () => {
    await writeFile(path.join(writableDir, 'README.md'), 'first-edit\n', 'utf8');
    const planResponse = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, {
      paths: ['README.md'], message: 'feat: x',
    });
    const planned = planResponse.json().action;

    // The repository changes again after the plan was shown.
    await writeFile(path.join(writableDir, 'README.md'), 'second-edit-not-what-was-planned\n', 'utf8');

    const response = await request('POST', `/api/projects/${writableProjectId}/actions/${planned.id}/execute`, { fingerprint: planned.fingerprint });
    expect(response.statusCode).toBe(409);

    const getResponse = await request('GET', `/api/projects/${writableProjectId}/actions/${planned.id}`);
    expect(getResponse.json().action.status).toBe('expired');
    await git(writableDir, 'checkout', '--', 'README.md');
  });

  // The exact scenario requested for the fingerprint security re-review:
  // plan → edit content → restore the original byte size → restore the
  // original mtime → execute. This is the scenario a size+mtime-only
  // fingerprint could not detect (cp -p, rsync -a, or a timestamp-preserving
  // editor all produce it with no adversarial intent required — see
  // apps/runner/internal/gitinfo/identity_test.go's
  // TestContentHashCatchesTheExactSizeAndMtimePreservingEditScenario for the
  // same proof at the Go layer, and plan.test.ts for the pure-function
  // proof). Run here against the real runner binary and a real repository so
  // the guarantee holds through the whole plan → runner → execute pipeline,
  // not just in one layer's unit tests.
  it('rejects execute when content changes but size and mtime are both restored to their original values', async () => {
    const target = path.join(writableDir, 'README.md');
    await writeFile(target, 'aaaaaaaaaa\n', 'utf8'); // 11 bytes
    const originalStat = await stat(target);

    const planResponse = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, {
      paths: ['README.md'], message: 'feat: same-size same-mtime edit',
    });
    expect(planResponse.statusCode).toBe(201);
    const planned = planResponse.json().action;
    const headBeforeExecuteAttempt = await git(writableDir, 'rev-parse', 'HEAD');

    // Same byte length (11), different content.
    await writeFile(target, 'bbbbbbbbbb\n', 'utf8');
    // Restore the exact original mtime (and atime, harmlessly) — this is
    // what `touch -d`, `cp -p`, and `rsync -a` all do.
    await utimes(target, originalStat.atime, originalStat.mtime);
    const restoredStat = await stat(target);
    expect(restoredStat.size).toBe(originalStat.size);
    // Rounded to whole milliseconds: utimes() was called with the exact
    // captured original Date, but some filesystems truncate/round timestamp
    // precision below 1ms on write, which is irrelevant to what this test
    // proves (content-hash detection is independent of mtime for a regular,
    // non-oversized file in the first place).
    expect(Math.round(restoredStat.mtimeMs)).toBe(Math.round(originalStat.mtimeMs));

    const response = await request('POST', `/api/projects/${writableProjectId}/actions/${planned.id}/execute`, { fingerprint: planned.fingerprint });

    // The commit must be refused, and — the property that actually matters —
    // no git mutation may have run: HEAD is unchanged and the planted
    // "bbbbbbbbbb" content is still sitting in the working tree exactly as
    // written, never committed.
    expect(response.statusCode).toBe(409);
    const headAfter = await git(writableDir, 'rev-parse', 'HEAD');
    expect(headAfter).toBe(headBeforeExecuteAttempt);
    const fileContent = await readFile(target, 'utf8');
    expect(fileContent).toBe('bbbbbbbbbb\n');
    const log = await git(writableDir, 'log', '--oneline', '-5');
    expect(log).not.toContain('same-size same-mtime edit');

    const getResponse = await request('GET', `/api/projects/${writableProjectId}/actions/${planned.id}`);
    expect(getResponse.json().action.status).toBe('expired');

    await git(writableDir, 'checkout', '--', 'README.md');
  });

  it('cancels a planned action', async () => {
    await writeFile(path.join(writableDir, 'README.md'), 'cancel-me\n', 'utf8');
    const planResponse = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, {
      paths: ['README.md'], message: 'feat: x',
    });
    const planned = planResponse.json().action;
    const cancelResponse = await request('POST', `/api/projects/${writableProjectId}/actions/${planned.id}/cancel`);
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().action.status).toBe('cancelled');

    // Revert the working tree so subsequent tests see a clean baseline.
    await git(writableDir, 'checkout', '--', 'README.md');
  });

  it('refuses a second concurrent plan while one is already pending for the same project', async () => {
    await writeFile(path.join(writableDir, 'README.md'), 'one\n', 'utf8');
    const first = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, { paths: ['README.md'], message: 'feat: one' });
    expect(first.statusCode).toBe(201);

    const second = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, { paths: ['README.md'], message: 'feat: two' });
    expect(second.statusCode).toBe(409);

    await request('POST', `/api/projects/${writableProjectId}/actions/${first.json().action.id}/cancel`);
    await git(writableDir, 'checkout', '--', 'README.md');
  });

  it('blocks planning for an archived project', async () => {
    await harness.ctx.db.query(`UPDATE projects SET status='archived', archived_at=now() WHERE id=$1`, [writableProjectId]);
    try {
      const response = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, { paths: ['README.md'], message: 'feat: x' });
      expect(response.statusCode).toBe(409);
    } finally {
      await harness.ctx.db.query(`UPDATE projects SET status='active', archived_at=NULL WHERE id=$1`, [writableProjectId]);
    }
  });

  it('records audit events for the full plan-execute lifecycle without leaking a diff or secret', async () => {
    await writeFile(path.join(writableDir, 'README.md'), 'audited-change\n', 'utf8');
    const planResponse = await request('POST', `/api/projects/${writableProjectId}/actions/git-commit/plan`, {
      paths: ['README.md'], message: 'feat: audited change',
    });
    const planned = planResponse.json().action;
    await request('POST', `/api/projects/${writableProjectId}/actions/${planned.id}/execute`, { fingerprint: planned.fingerprint });

    const { rows } = await harness.ctx.db.query<{ event_type: string; detail: Record<string, unknown> }>(
      `SELECT event_type, detail FROM audit_events WHERE subject=$1 AND occurred_at > now() - interval '1 minute' ORDER BY occurred_at`,
      [`project:${writableProjectId}`],
    );
    const eventTypes = rows.map((row) => row.event_type);
    expect(eventTypes).toContain('action.planned');
    expect(eventTypes).toContain('action.execution_started');
    expect(eventTypes).toContain('action.execution_succeeded');

    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('audited-change');
    expect(serialized.toLowerCase()).not.toContain('secret');
  });
});
