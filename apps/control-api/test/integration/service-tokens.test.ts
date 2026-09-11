import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/auth/password.js';
import { requirePrincipalKind, requireRole, requireScope } from '../../src/auth/middleware.js';
import { AppError } from '../../src/errors.js';
import type { FastifyRequest } from 'fastify';
import { createHarness, dockerAvailable, readCookie, type TestHarness } from './helpers.js';

/**
 * Service identity: machine (Bearer) principals alongside the existing human
 * (cookie) ones. Against a real database and a real Fastify instance, for the
 * same reason auth.test.ts is: grants, triggers and header parsing are all
 * things a mock would report as working while production did something else.
 */

let harness: TestHarness;
const hasDocker = await dockerAvailable();

const ADMIN_EMAIL = 'svc-admin@example.test';
const ADMIN_PASSWORD = 'a-sufficiently-long-test-password';
const VIEWER_EMAIL = 'svc-viewer@example.test';

describe.skipIf(!hasDocker)('service identity', () => {
  beforeAll(async () => {
    harness = await createHarness();
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'admin')`,
      [ADMIN_EMAIL, 'Test Admin', await hashPassword(ADMIN_PASSWORD)],
    );
    await harness.ctx.db.query(
      `INSERT INTO users (email, display_name, password_hash, role)
       VALUES ($1, $2, $3, 'viewer')`,
      [VIEWER_EMAIL, 'Test Viewer', await hashPassword(ADMIN_PASSWORD)],
    );
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
      payload: { email, password: ADMIN_PASSWORD },
      remoteAddress: `10.20.${Math.floor(clientCounter / 250)}.${clientCounter % 250}`,
    });
  };

  async function mintToken(overrides: {
    accountKey?: string;
    scopes?: Array<'automation:run' | 'project:read' | 'project:rescan' | 'action:plan' | 'system:read' | 'report:write'>;
    ttlDays?: number;
  } = {}): Promise<{ token: string; tokenId: string; accountId: string }> {
    const accountKey = overrides.accountKey ?? `test-account-${Math.random().toString(36).slice(2)}`;
    const account = await harness.ctx.serviceTokens.ensureAccount({
      key: accountKey,
      displayName: 'Test account',
      scopes: overrides.scopes ?? ['automation:run', 'project:read'],
    });
    const minted = await harness.ctx.serviceTokens.mint({
      accountId: account.id,
      accountKey: account.key,
      scopes: overrides.scopes ?? ['automation:run', 'project:read'],
      ttlDays: overrides.ttlDays ?? 30,
      createdByUserId: null,
    });
    return { token: minted.token, tokenId: minted.summary.id, accountId: account.id };
  }

  // ---------------------------------------------------------------------------
  describe('resolvePrincipal / whoami', () => {
    it('authenticates a service token over Bearer', async () => {
      const { token } = await mintToken();
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'service' });
    });

    it('authenticates a session cookie identically to requireAuth', async () => {
      const session = await login(ADMIN_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        cookies: { pc_session: cookie as string },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ kind: 'user' });
    });

    it('rejects a request with no credential at all', async () => {
      const response = await harness.app.inject({ method: 'GET', url: '/api/automation/whoami' });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a request carrying both a cookie and a Bearer token', async () => {
      const { token } = await mintToken();
      const session = await login(ADMIN_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        cookies: { pc_session: cookie as string },
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(400);

      const { rows } = await harness.ctx.db.query(
        `SELECT 1 FROM audit_events WHERE event_type = 'service.token_rejected' AND detail->>'reason' = 'mixed_credentials' LIMIT 1`,
      );
      expect(rows.length).toBe(1);
    });

    it('rejects a garbage Authorization header', async () => {
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: 'Bearer not-a-real-token' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('tolerates a trailing newline/space on the Authorization header (e.g. a copy-paste artefact)', async () => {
      const { token } = await mintToken();
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${token}\n` },
      });
      expect(response.statusCode).toBe(200);

      const withSpace = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${token} ` },
      });
      expect(withSpace.statusCode).toBe(200);
    });

    it('does not silently repair a token corrupted in the middle', async () => {
      const { token } = await mintToken();
      const corrupted = `${token.slice(0, 10)}\n${token.slice(10)}`;
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${corrupted}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a revoked token', async () => {
      const { token, tokenId } = await mintToken();
      await harness.ctx.serviceTokens.revoke(tokenId);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects an expired token', async () => {
      // expires_at is immutable once the row exists (see the database
      // invariants group below), so an already-expired token is minted
      // directly with a negative TTL rather than mutated into that state —
      // ServiceTokenStore.mint() itself does not clamp ttlDays; only the CLI
      // that fronts it does.
      const { token } = await mintToken({ ttlDays: -1 });

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a token whose account has been disabled', async () => {
      const { token, accountId } = await mintToken();
      await harness.ctx.db.query(`UPDATE service_accounts SET status = 'disabled' WHERE id = $1`, [accountId]);

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('never rejects a Bearer token on a route that only uses requireAuth', async () => {
      // /api/auth/me is cookie-only. A Bearer header must be silently ignored
      // (the route never reads it), which surfaces here as the same 401 an
      // anonymous request gets — not a 500, not an accidental accept.
      const { token } = await mintToken();
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(401);
    });

    it('touches last_used_at on a successful resolution', async () => {
      const { token, tokenId } = await mintToken();
      const before = await harness.ctx.db.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM service_tokens WHERE id = $1',
        [tokenId],
      );
      expect(before.rows[0]?.last_used_at).toBeNull();

      await harness.app.inject({
        method: 'GET',
        url: '/api/automation/whoami',
        headers: { authorization: `Bearer ${token}` },
      });

      const after = await harness.ctx.db.query<{ last_used_at: Date | null }>(
        'SELECT last_used_at FROM service_tokens WHERE id = $1',
        [tokenId],
      );
      expect(after.rows[0]?.last_used_at).not.toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('requirePrincipalKind / requireScope', () => {
    it('denies a service principal when only user is allowed, and audits it', async () => {
      const { token } = await mintToken();
      const resolved = await harness.ctx.serviceTokens.resolve(token);
      const fakeRequest = {
        id: 'test-request-id',
        url: '/fake/route',
        principal: {
          kind: 'service' as const,
          account: { id: resolved!.account.id, key: resolved!.account.key },
          token: { id: resolved!.token.id, scopes: resolved!.token.scopes },
        },
      } as unknown as FastifyRequest;

      const guard = requirePrincipalKind(harness.ctx, 'user');
      await expect(guard(fakeRequest)).rejects.toThrow(AppError);

      const { rows } = await harness.ctx.db.query(
        `SELECT 1 FROM audit_events WHERE event_type = 'service.principal_kind_denied' LIMIT 1`,
      );
      expect(rows.length).toBe(1);
    });

    it('allows a user principal through requirePrincipalKind unconditionally', async () => {
      const fakeRequest = {
        principal: { kind: 'user' as const, user: {}, session: {} },
      } as unknown as FastifyRequest;
      await expect(requirePrincipalKind(harness.ctx, 'user')(fakeRequest)).resolves.toBeUndefined();
    });

    it('denies a service principal missing a required scope, and audits it', async () => {
      const { token } = await mintToken({ scopes: ['project:read'] });
      const resolved = await harness.ctx.serviceTokens.resolve(token);
      const fakeRequest = {
        id: 'test-request-id-2',
        url: '/fake/route',
        principal: {
          kind: 'service' as const,
          account: { id: resolved!.account.id, key: resolved!.account.key },
          token: { id: resolved!.token.id, scopes: resolved!.token.scopes },
        },
      } as unknown as FastifyRequest;

      const guard = requireScope(harness.ctx, 'action:plan');
      await expect(guard(fakeRequest)).rejects.toThrow(AppError);

      const { rows } = await harness.ctx.db.query(
        `SELECT 1 FROM audit_events WHERE event_type = 'service.scope_denied' LIMIT 1`,
      );
      expect(rows.length).toBe(1);
    });

    it('is a no-op for a user principal regardless of the scopes required', async () => {
      const fakeRequest = {
        principal: { kind: 'user' as const, user: {}, session: {} },
      } as unknown as FastifyRequest;
      await expect(
        requireScope(harness.ctx, 'action:plan', 'report:write')(fakeRequest),
      ).resolves.toBeUndefined();
    });

    // requirePrincipalKind exists for a route resolvePrincipal serves to both
    // kinds where one specific action must stay human-only. It is deliberately
    // not retrofitted onto today's ~40 existing routes: every one of them
    // still uses requireAuth (cookie-only), which never reads Authorization at
    // all, so they are already unreachable by a service token — adding the
    // gate there would be dead code with no route ever setting
    // request.principal for it to inspect. The property this test actually
    // guards is that `requireRole`, unchanged since it was first written,
    // reads request.auth (never set for a service
    // principal — see resolvePrincipal), so the day any existing route is
    // ever switched from requireAuth to resolvePrincipal for read access,
    // its *existing* requireRole call keeps denying a service principal
    // automatically, with no additional gate required at the same time.
    it('requireRole denies a service principal even with no requirePrincipalKind gate present', async () => {
      const { token } = await mintToken();
      const resolved = await harness.ctx.serviceTokens.resolve(token);
      const fakeRequest = {
        principal: {
          kind: 'service' as const,
          account: { id: resolved!.account.id, key: resolved!.account.key },
          token: { id: resolved!.token.id, scopes: resolved!.token.scopes },
        },
        // auth is deliberately absent: resolvePrincipal never sets it for a
        // service principal, which is the entire mechanism this test proves.
      } as unknown as FastifyRequest;

      await expect(requireRole('admin', 'operator', 'viewer')(fakeRequest)).rejects.toThrow(AppError);
    });
  });

  // ---------------------------------------------------------------------------
  describe('database invariants', () => {
    it('stores only a hash of the token, never the token itself', async () => {
      const { token, tokenId } = await mintToken();
      const { rows } = await harness.ctx.db.query<{ token_hash: string }>(
        'SELECT token_hash FROM service_tokens WHERE id = $1',
        [tokenId],
      );
      expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.token_hash).not.toContain(token);
    });

    it('rejects a token whose scopes exceed its account scopes', async () => {
      const account = await harness.ctx.serviceTokens.ensureAccount({
        key: `narrow-account-${Math.random().toString(36).slice(2)}`,
        displayName: 'Narrow account',
        scopes: ['project:read'],
      });
      await expect(
        harness.ctx.db.query(
          `INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at)
           VALUES ($1, repeat('a', 64), 'pcs_deadbeef', ARRAY['automation:run'], now() + interval '1 day')`,
          [account.id],
        ),
      ).rejects.toThrow();
    });

    it('rejects an unknown scope value outright', async () => {
      const account = await harness.ctx.serviceTokens.ensureAccount({
        key: `bad-scope-account-${Math.random().toString(36).slice(2)}`,
        displayName: 'Bad scope account',
        scopes: ['project:read'],
      });
      await expect(
        harness.ctx.db.query(
          `UPDATE service_accounts SET scopes = ARRAY['not:a:real:scope'] WHERE id = $1`,
          [account.id],
        ),
      ).rejects.toThrow();
    });

    it('makes a settled revocation immutable — cannot be un-revoked', async () => {
      const { tokenId } = await mintToken();
      await harness.ctx.serviceTokens.revoke(tokenId);
      await expect(
        harness.ctx.db.query('UPDATE service_tokens SET revoked_at = NULL WHERE id = $1', [tokenId]),
      ).rejects.toThrow();
    });

    it('makes token identity immutable after creation', async () => {
      const { tokenId } = await mintToken();
      await expect(
        harness.ctx.db.query(`UPDATE service_tokens SET prefix = 'pcs_hijacked' WHERE id = $1`, [tokenId]),
      ).rejects.toThrow();
    });

    it('revoking twice is idempotent and audits only once', async () => {
      const { tokenId } = await mintToken();
      const first = await harness.ctx.serviceTokens.revoke(tokenId);
      const second = await harness.ctx.serviceTokens.revoke(tokenId);
      expect(first?.alreadyRevoked).toBe(false);
      expect(second?.alreadyRevoked).toBe(true);
    });

    it('an ensureAccount rerun never re-enables a disabled account', async () => {
      const key = `disable-check-${Math.random().toString(36).slice(2)}`;
      const account = await harness.ctx.serviceTokens.ensureAccount({
        key,
        displayName: 'Will be disabled',
        scopes: ['project:read'],
      });
      await harness.ctx.db.query(`UPDATE service_accounts SET status = 'disabled' WHERE id = $1`, [account.id]);

      const reconciled = await harness.ctx.serviceTokens.ensureAccount({
        key,
        displayName: 'Will be disabled',
        scopes: ['project:read'],
      });
      expect(reconciled.status).toBe('disabled');
    });
  });

  // ---------------------------------------------------------------------------
  describe('service token administration routes', () => {
    it('lets an admin list tokens without exposing the value', async () => {
      const { token: rawToken } = await mintToken();
      const session = await login(ADMIN_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');

      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/service-tokens',
        cookies: { pc_session: cookie as string },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain(rawToken);
    });

    it('denies a viewer', async () => {
      const session = await login(VIEWER_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/service-tokens',
        cookies: { pc_session: cookie as string },
      });
      expect(response.statusCode).toBe(403);
    });

    it('denies a service token entirely — this admin surface is human-only', async () => {
      const { token } = await mintToken();
      const response = await harness.app.inject({
        method: 'GET',
        url: '/api/automation/service-tokens',
        headers: { authorization: `Bearer ${token}` },
      });
      // requireAuth never reads Authorization at all, so this is the same
      // 401 an anonymous caller gets.
      expect(response.statusCode).toBe(401);
    });

    it('revokes a token and records the audit event exactly once', async () => {
      const { tokenId } = await mintToken();
      const session = await login(ADMIN_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');
      const csrfToken = session.json().csrfToken as string;

      const first = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/service-tokens/${tokenId}/revoke`,
        cookies: { pc_session: cookie as string },
        headers: { 'x-csrf-token': csrfToken },
      });
      expect(first.statusCode).toBe(200);
      expect(first.json().token.revokedAt).not.toBeNull();

      const second = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/service-tokens/${tokenId}/revoke`,
        cookies: { pc_session: cookie as string },
        headers: { 'x-csrf-token': csrfToken },
      });
      expect(second.statusCode).toBe(200);

      const byDetail = await harness.ctx.db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_events
          WHERE event_type = 'service.token_revoked' AND detail->>'tokenId' = $1`,
        [tokenId],
      );
      expect(byDetail.rows[0]?.n).toBe(1);
    });

    it('requires CSRF for revoke', async () => {
      const { tokenId } = await mintToken();
      const session = await login(ADMIN_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');

      const response = await harness.app.inject({
        method: 'POST',
        url: `/api/automation/service-tokens/${tokenId}/revoke`,
        cookies: { pc_session: cookie as string },
      });
      expect(response.statusCode).toBe(403);
    });

    it('returns 404 for an unknown token id', async () => {
      const session = await login(ADMIN_EMAIL);
      const cookie = readCookie(session.headers['set-cookie'], 'pc_session');
      const csrfToken = session.json().csrfToken as string;

      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/automation/service-tokens/00000000-0000-0000-0000-000000000000/revoke',
        cookies: { pc_session: cookie as string },
        headers: { 'x-csrf-token': csrfToken },
      });
      expect(response.statusCode).toBe(404);
    });
  });
});
