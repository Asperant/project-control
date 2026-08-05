import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { createHarness, dockerAvailable, rawCookie, readCookie, type TestHarness } from './helpers.js';

/**
 * Authentication and session security, against a real database and a real
 * Fastify instance.
 *
 * These assertions are the reason the harness bothers with a real PostgreSQL
 * container: cookie attributes, SQL grants and session expiry semantics are all
 * things a mock would report as working while production did something else.
 */

let harness: TestHarness;
const hasDocker = await dockerAvailable();

const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-test-password';

describe.skipIf(!hasDocker)('authentication', () => {
  beforeAll(async () => {
    harness = await createHarness();
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')`,
      [ADMIN_EMAIL, 'Test Admin', await hashPassword(ADMIN_PASSWORD)],
    );
  }, 120_000);

  afterAll(async () => {
    await harness?.teardown();
  });

  /**
   * Logs in from a unique source address.
   *
   * The login route is rate limited per client IP. Without a distinct address
   * per call, the suite would exhaust its own budget part-way through and later
   * tests would fail with 429 for reasons unrelated to what they assert. The
   * dedicated rate-limit test below deliberately reuses one address.
   */
  let clientCounter = 0;
  const login = (email = ADMIN_EMAIL, password = ADMIN_PASSWORD) => {
    clientCounter += 1;
    return harness.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email, password },
      remoteAddress: `10.10.${Math.floor(clientCounter / 250)}.${clientCounter % 250}`,
    });
  };

  // ---------------------------------------------------------------------------
  describe('login', () => {
    it('accepts correct credentials and returns the session envelope', async () => {
      const response = await login();
      expect(response.statusCode).toBe(200);

      const body = response.json();
      expect(body.user.email).toBe(ADMIN_EMAIL);
      expect(body.user.role).toBe('admin');
      expect(body.csrfToken).toHaveLength(43);
      expect(body.session.id).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('never returns a password hash', async () => {
      const response = await login();
      const raw = response.body;
      expect(raw).not.toContain('argon2');
      expect(raw).not.toContain('password_hash');
      expect(raw).not.toContain('passwordHash');
      expect(raw).not.toContain(ADMIN_PASSWORD);
    });

    it('sets HttpOnly, SameSite=Strict, Path=/ on the session cookie', async () => {
      const response = await login();
      const cookie = rawCookie(response.headers['set-cookie'], 'pc_session');

      expect(cookie).toBeTruthy();
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
      expect(cookie).toMatch(/Path=\//);
      // Host-only: no Domain attribute, so the cookie cannot leak to a sibling
      // hostname on the tailnet.
      expect(cookie).not.toMatch(/Domain=/i);
    });

    it('rejects a wrong password with the same message as an unknown account', async () => {
      const wrongPassword = await login(ADMIN_EMAIL, 'not-the-right-password');
      const unknownUser = await login('nobody@example.test', 'not-the-right-password');

      expect(wrongPassword.statusCode).toBe(401);
      expect(unknownUser.statusCode).toBe(401);
      // Account enumeration would be possible if these differed.
      expect(wrongPassword.json().error.message).toBe(unknownUser.json().error.message);
      expect(wrongPassword.json().error.code).toBe(unknownUser.json().error.code);
    });

    it('does not set a session cookie on a failed login', async () => {
      const response = await login(ADMIN_EMAIL, 'wrong');
      expect(readCookie(response.headers['set-cookie'], 'pc_session')).toBeNull();
    });

    it('rejects a malformed body as an auth failure, not a validation error', async () => {
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'not-an-email', password: '' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('records both success and failure in the audit trail', async () => {
      await login();
      await login(ADMIN_EMAIL, 'wrong-password');

      const { rows } = await harness.ctx.db.query<{ event_type: string; outcome: string }>(
        `SELECT event_type, outcome FROM audit_events
          WHERE event_type LIKE 'auth.login%' ORDER BY occurred_at DESC LIMIT 10`,
      );
      expect(rows.some((r) => r.event_type === 'auth.login.succeeded')).toBe(true);
      expect(rows.some((r) => r.event_type === 'auth.login.failed')).toBe(true);
    });

    it('never writes the password into the audit detail', async () => {
      await login(ADMIN_EMAIL, 'a-very-distinctive-wrong-password');
      const { rows } = await harness.ctx.db.query<{ detail: unknown }>(
        `SELECT detail FROM audit_events ORDER BY occurred_at DESC LIMIT 20`,
      );
      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain('a-very-distinctive-wrong-password');
      expect(serialised).not.toContain(ADMIN_PASSWORD);
    });
  });

  // ---------------------------------------------------------------------------
  describe('session resolution', () => {
    it('rejects an anonymous request to /api/auth/me', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe('unauthorized');
    });

    it('accepts a request carrying a valid session cookie', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session');

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { pc_session: token as string },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().user.email).toBe(ADMIN_EMAIL);
    });

    it('rejects a forged token', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { pc_session: 'a'.repeat(43) },
      });
      expect(response.statusCode).toBe(401);
    });

    it('stores only a hash of the token, never the token itself', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;

      const { rows } = await harness.ctx.db.query<{ token_hash: string }>(
        'SELECT token_hash FROM sessions ORDER BY created_at DESC LIMIT 1',
      );
      expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.token_hash).not.toBe(token);
      expect(rows[0]?.token_hash).not.toContain(token);
    });

    it('rejects a session after logout', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;
      const csrfToken = session.json().csrfToken as string;

      const logout = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { pc_session: token },
        headers: { 'x-csrf-token': csrfToken },
      });
      expect(logout.statusCode).toBe(200);

      const after = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { pc_session: token },
      });
      expect(after.statusCode).toBe(401);
    });

    it('rejects a session whose user has been deactivated', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;

      await harness.ctx.db.query('UPDATE users SET is_active = FALSE WHERE email = $1', [ADMIN_EMAIL]);
      const response = await harness.app.inject({
        method: 'GET', url: '/api/auth/me', cookies: { pc_session: token },
      });
      expect(response.statusCode).toBe(401);

      await harness.ctx.db.query('UPDATE users SET is_active = TRUE WHERE email = $1', [ADMIN_EMAIL]);
    });

    it('rejects an expired session', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;

      // created_at must move back too: the schema enforces
      // `expires_at > created_at`, so backdating only the expiry would violate
      // the constraint rather than produce an expired session.
      await harness.ctx.db.query(
        `UPDATE sessions
            SET created_at = now() - interval '2 hours',
                expires_at = now() - interval '1 minute'
          WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)`,
      );

      const response = await harness.app.inject({
        method: 'GET', url: '/api/auth/me', cookies: { pc_session: token },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a session that has been idle beyond the idle timeout', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;

      await harness.ctx.db.query(
        `UPDATE sessions SET last_seen_at = now() - interval '25 hours'
          WHERE id = (SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1)`,
      );

      const response = await harness.app.inject({
        method: 'GET', url: '/api/auth/me', cookies: { pc_session: token },
      });
      expect(response.statusCode).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------
  describe('CSRF protection', () => {
    it('rejects a state-changing request with no CSRF header', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { pc_session: token },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('csrf_failed');
    });

    it('rejects a CSRF token belonging to a different session', async () => {
      const sessionA = await login();
      const sessionB = await login();
      const tokenA = readCookie(sessionA.headers['set-cookie'], 'pc_session') as string;
      const csrfB = sessionB.json().csrfToken as string;

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        cookies: { pc_session: tokenA },
        headers: { 'x-csrf-token': csrfB },
      });
      expect(response.statusCode).toBe(403);
    });

    it('rejects a state-changing request from a foreign Origin', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;
      const csrfToken = session.json().csrfToken as string;

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/artifacts/self-test',
        cookies: { pc_session: token },
        headers: {
          'x-csrf-token': csrfToken,
          origin: 'https://attacker.example',
          host: 'portal.test.ts.net',
        },
      });
      expect(response.statusCode).toBe(403);
    });

    it('allows a GET with no CSRF token', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;

      const response = await harness.app.inject({
        method: 'GET', url: '/api/system/status', cookies: { pc_session: token },
      });
      expect(response.statusCode).toBe(200);
    });

    it('records a rejected CSRF attempt in the audit trail', async () => {
      const session = await login();
      const token = readCookie(session.headers['set-cookie'], 'pc_session') as string;

      await harness.app.inject({
        method: 'POST', url: '/api/auth/logout', cookies: { pc_session: token },
      });

      const { rows } = await harness.ctx.db.query(
        `SELECT 1 FROM audit_events WHERE event_type = 'auth.csrf.rejected' LIMIT 1`,
      );
      expect(rows.length).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  describe('rate limiting', () => {
    it('throttles repeated login attempts from the same client', async () => {
      const statuses: number[] = [];
      // The configured limit is 5 per window; the 6th onwards must be 429.
      for (let i = 0; i < 9; i += 1) {
        const response = await harness.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'ratelimit@example.test', password: 'wrong-password-value' },
          remoteAddress: '10.99.0.1',
        });
        statuses.push(response.statusCode);
      }
      expect(statuses).toContain(429);
    });
  });

  // ---------------------------------------------------------------------------
  describe('security headers', () => {
    it('sets the hardened header set on API responses', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/auth/me' });

      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
    });

    it('echoes a request id on every response', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/auth/me' });
      expect(response.headers['x-request-id']).toBeTruthy();
      expect(response.json().requestId).toBeTruthy();
    });
  });
});
