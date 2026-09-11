import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

/**
 * Artifact round-trip, PostgreSQL grant enforcement, and health endpoints —
 * against the real schema produced by the real migrations.
 */

let harness: TestHarness;
const hasDocker = await dockerAvailable();

const EMAIL = 'artifacts@example.test';
const PASSWORD = 'another-sufficiently-long-password';

describe.skipIf(!hasDocker)('artifacts, roles and health', () => {
  beforeAll(async () => {
    harness = await createHarness();
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')`,
      [EMAIL, 'Artifact Tester', await hashPassword(PASSWORD)],
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  // A distinct source address per login keeps the per-IP login rate limit from
  // firing part-way through the suite for reasons unrelated to the assertions.
  let clientCounter = 0;
  const authenticate = async (): Promise<{ token: string; csrfToken: string }> => {
    clientCounter += 1;
    const response = await harness.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { email: EMAIL, password: PASSWORD },
      remoteAddress: `10.20.${Math.floor(clientCounter / 250)}.${clientCounter % 250}`,
    });
    return {
      token: readCookie(response.headers['set-cookie'], 'pc_session') as string,
      csrfToken: response.json().csrfToken as string,
    };
  };

  // ---------------------------------------------------------------------------
  describe('health endpoints', () => {
    it('reports liveness without touching the database', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/health/live' });
      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe('live');
    });

    it('reports readiness with per-dependency detail', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.status).toBe('ready');
      const names = body.checks.map((c: { name: string }) => c.name);
      expect(names).toContain('postgres');
      expect(names).toContain('schema');
      expect(names).toContain('artifact_store');
    });

    it('does not require authentication for health', async () => {
      for (const url of ['/health/live', '/health/ready']) {
        const response = await harness.app.inject({ method: 'GET', url });
        expect(response.statusCode).toBe(200);
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe('artifact self-test endpoint', () => {
    it('requires authentication', async () => {
      const response = await harness.app.inject({ method: 'POST', url: '/api/artifacts/self-test' });
      expect(response.statusCode).toBe(401);
    });

    it('passes every stage of the round trip', async () => {
      const { token, csrfToken } = await authenticate();

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/artifacts/self-test',
        cookies: { pc_session: token },
        headers: { 'x-csrf-token': csrfToken },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.ok).toBe(true);
      expect(body.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(body.deduplicated).toBe(true);

      const failed = body.steps.filter((s: { ok: boolean }) => !s.ok);
      expect(failed).toEqual([]);

      const stepNames = body.steps.map((s: { step: string }) => s.step);
      expect(stepNames).toEqual(
        expect.arrayContaining([
          'store', 'exists', 'read-back-and-verify', 'deduplicate',
          'reject-path-traversal', 'enforce-size-limit', 'record-metadata',
        ]),
      );
    });

    it('records the artifact metadata in PostgreSQL', async () => {
      const { token, csrfToken } = await authenticate();
      const response = await harness.app.inject({
        method: 'POST', url: '/api/artifacts/self-test',
        cookies: { pc_session: token }, headers: { 'x-csrf-token': csrfToken },
      });
      const digest = response.json().sha256 as string;

      const { rows } = await harness.ctx.db.query<{ sha256: string; size_bytes: number }>(
        'SELECT sha256, size_bytes FROM artifact_objects WHERE sha256 = $1',
        [digest],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.size_bytes).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe('artifact store round trip', () => {
    it('preserves bytes exactly through store and retrieve', async () => {
      const payload = randomBytes(64 * 1024);
      const expected = createHash('sha256').update(payload).digest('hex');

      const stored = await harness.ctx.artifactStore.put(Readable.from([payload]), {
        maxBytes: 1024 * 1024,
      });
      expect(stored.sha256).toBe(expected);

      const stream = await harness.ctx.artifactStore.get(expected);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const readBack = Buffer.concat(chunks);

      expect(readBack.equals(payload)).toBe(true);
      expect(createHash('sha256').update(readBack).digest('hex')).toBe(expected);
    });

    it('deduplicates identical content across separate uploads', async () => {
      const payload = Buffer.from('dedup across calls');
      const first = await harness.ctx.artifactStore.put(Readable.from([payload]), { maxBytes: 4096 });
      const second = await harness.ctx.artifactStore.put(Readable.from([payload]), { maxBytes: 4096 });

      expect(first.deduplicated).toBe(false);
      expect(second.deduplicated).toBe(true);
      expect(second.sha256).toBe(first.sha256);
    });
  });

  // ---------------------------------------------------------------------------
  describe('PostgreSQL grant enforcement', () => {
    /**
     * These run as the real `control_app` role against the real schema. They are
     * the only way to know that migration 0002's grants do what the comments
     * claim — a mocked database would report whatever the mock was told to.
     */
    const asControlApp = async (sql: string): Promise<{ ok: boolean; error?: string }> => {
      try {
        await harness.ctx.db.query(sql);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    };

    it('permits INSERT into audit_events', async () => {
      const result = await asControlApp(
        `INSERT INTO audit_events (event_type, outcome) VALUES ('system.status.read', 'success')`,
      );
      expect(result.ok).toBe(true);
    });

    it('denies UPDATE on audit_events', async () => {
      const result = await asControlApp(`UPDATE audit_events SET outcome = 'failure' WHERE false`);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
    });

    it('denies DELETE on audit_events', async () => {
      const result = await asControlApp(`DELETE FROM audit_events WHERE false`);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
    });

    it('denies DDL to the runtime role', async () => {
      const result = await asControlApp(`CREATE TABLE privilege_probe (id int)`);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/permission denied/i);
    });

    it('denies DROP TABLE to the runtime role', async () => {
      const result = await asControlApp(`DROP TABLE users`);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must be owner|permission denied/i);
    });
  });

  // ---------------------------------------------------------------------------
  describe('cross-database isolation', () => {
    it('refuses a control_app connection to the n8n database', async () => {
      // Connecting with the runtime credential to the wrong database must fail
      // at the CONNECT privilege, before any query is possible.
      const client = new pg.Client({
        host: harness.config.pg.host,
        port: harness.config.pg.port,
        user: 'control_app',
        password: harness.config.pg.password,
        database: 'n8n',
        connectionTimeoutMillis: 5000,
      });

      let connected = false;
      try {
        await client.connect();
        connected = true;
        await client.end();
      } catch {
        connected = false;
      }
      expect(connected).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  describe('system status', () => {
    it('reports every core component', async () => {
      const { token } = await authenticate();
      const response = await harness.app.inject({
        method: 'GET', url: '/api/system/status', cookies: { pc_session: token },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const ids = body.components.map((c: { id: string }) => c.id);

      expect(ids).toEqual(
        expect.arrayContaining([
          'postgres', 'n8n', 'artifact_store', 'runner', 'backup', 'tailscale', 'verification',
        ]),
      );
      expect(body.components.find((c: { id: string }) => c.id === 'postgres').status).toBe('ok');
    });

    it('reports missing verification status as manual_configuration_required', async () => {
      const { token } = await authenticate();
      const response = await harness.app.inject({
        method: 'GET', url: '/api/system/status', cookies: { pc_session: token },
      });
      const verification = response.json().components.find((c: { id: string }) => c.id === 'verification');
      expect(verification.status).toBe('manual_configuration_required');
    });

    it('reports an unreachable runner as down rather than erroring', async () => {
      const { token } = await authenticate();
      const response = await harness.app.inject({
        method: 'GET', url: '/api/system/status', cookies: { pc_session: token },
      });

      expect(response.statusCode).toBe(200);
      const runner = response.json().components.find((c: { id: string }) => c.id === 'runner');
      // The harness points at a socket that does not exist.
      expect(runner.status).toBe('down');
      expect(runner.detail).toBeTruthy();
    });

    it('reports unconfigured components as manual_configuration_required', async () => {
      const { token } = await authenticate();
      const response = await harness.app.inject({
        method: 'GET', url: '/api/system/status', cookies: { pc_session: token },
      });

      const backup = response.json().components.find((c: { id: string }) => c.id === 'backup');
      expect(backup.status).toBe('manual_configuration_required');
    });

    it('never leaks a connection string or password into the status payload', async () => {
      const { token } = await authenticate();
      const response = await harness.app.inject({
        method: 'GET', url: '/api/system/status', cookies: { pc_session: token },
      });

      expect(response.body).not.toContain(harness.config.pg.password);
      expect(response.body).not.toContain('postgresql://');
      expect(response.body).not.toContain(harness.config.session.secret);
    });
  });

  // ---------------------------------------------------------------------------
  describe('request limits', () => {
    it('rejects a body larger than the configured limit', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'a@b.co', password: 'x'.repeat(2 * 1024 * 1024) },
      });
      expect([413, 401, 400]).toContain(response.statusCode);
      expect(response.statusCode).not.toBe(200);
    });

    it('returns a uniform error envelope for an unknown route', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/does-not-exist' });
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe('not_found');
      expect(response.json().requestId).toBeTruthy();
    });
  });
});
