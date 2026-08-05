import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  loginRequestSchema,
  type AuthSessionResponse,
  type LogoutResponse,
  type User,
} from '@project-control/contracts';

import type { AppContext } from '../context.js';
import { AppError, unauthorized } from '../errors.js';
import { createRequireAuth } from '../auth/middleware.js';
import { verifyPassword, verifyPasswordDummy } from '../auth/password.js';
import type { AuthenticatedUser, SessionRecord } from '../auth/session-store.js';

type UserRow = {
  id: string;
  email: string;
  display_name: string;
  role: 'admin' | 'operator' | 'viewer';
  password_hash: string;
  is_active: boolean;
  failed_login_count: number;
  locked_until: Date | null;
  created_at: Date;
  last_login_at: Date | null;
};

function toPublicUser(user: AuthenticatedUser): User {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

export const authRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const requireAuth = createRequireAuth(ctx);

    /** Sets the session cookie with the full hardening set. */
    const setSessionCookie = (reply: FastifyReply, token: string): void => {
      reply.setCookie(ctx.config.session.cookieName, token, {
        httpOnly: true, // unreadable from JavaScript, so XSS cannot exfiltrate it
        secure: ctx.config.session.cookieSecure, // only ever sent over the Tailscale HTTPS portal
        sameSite: 'strict', // never attached to a cross-site request
        path: '/',
        maxAge: ctx.config.session.absoluteTtlSeconds,
        // No `domain`: the cookie stays host-only, so it cannot leak to a sibling
        // name on the tailnet.
      });
    };

    const clearSessionCookie = (reply: FastifyReply): void => {
      reply.clearCookie(ctx.config.session.cookieName, {
        httpOnly: true,
        secure: ctx.config.session.cookieSecure,
        sameSite: 'strict',
        path: '/',
      });
    };

    const sessionBody = (
      user: AuthenticatedUser,
      session: SessionRecord,
      csrfToken: string,
    ): AuthSessionResponse => ({
      user: toPublicUser(user),
      session: {
        id: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        idleTimeoutSeconds: ctx.config.session.idleTtlSeconds,
      },
      csrfToken,
    });

    // -------------------------------------------------------------------------
    // POST /api/auth/login
    // -------------------------------------------------------------------------
    app.post(
      '/api/auth/login',
      {
        config: {
          // Per-IP throttle. Because everything arrives via Caddy on loopback,
          // this is effectively a global limit on login attempts — which is the
          // intent for a single-operator portal.
          rateLimit: {
            max: ctx.config.login.rateLimitMax,
            timeWindow: ctx.config.login.rateLimitWindowSeconds * 1000,
          },
        },
      },
      async (request, reply) => {
        const parsed = loginRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          // Deliberately reported as a generic auth failure, not a validation
          // error: "that email is malformed" is still information.
          throw unauthorized('login body failed validation');
        }
        const { email, password } = parsed.data;

        const { rows } = await ctx.db.query<UserRow>(
          `SELECT id, email, display_name, role, password_hash, is_active,
                  failed_login_count, locked_until, created_at, last_login_at
             FROM users
            WHERE email = $1`,
          [email],
        );
        const row = rows[0];

        // --- No such user -------------------------------------------------
        if (!row) {
          // Burn equivalent Argon2id time so response latency does not reveal
          // whether the account exists.
          await verifyPasswordDummy(password);
          await ctx.audit.record({
            eventType: 'auth.login.failed',
            outcome: 'failure',
            requestId: request.id,
            subject: email,
            detail: { reason: 'unknown_account' },
          });
          throw unauthorized('unknown account');
        }

        // --- Locked out ---------------------------------------------------
        if (row.locked_until && row.locked_until.getTime() > Date.now()) {
          await verifyPasswordDummy(password);
          await ctx.audit.record({
            eventType: 'auth.login.locked_out',
            outcome: 'denied',
            actorUserId: row.id,
            requestId: request.id,
            subject: email,
            detail: { lockedUntil: row.locked_until.toISOString() },
          });
          throw unauthorized('account locked');
        }

        // --- Deactivated --------------------------------------------------
        if (!row.is_active) {
          await verifyPasswordDummy(password);
          await ctx.audit.record({
            eventType: 'auth.login.failed',
            outcome: 'denied',
            actorUserId: row.id,
            requestId: request.id,
            subject: email,
            detail: { reason: 'inactive_account' },
          });
          throw unauthorized('inactive account');
        }

        // --- Password ------------------------------------------------------
        const passwordOk = await verifyPassword(password, row.password_hash);
        if (!passwordOk) {
          const failures = row.failed_login_count + 1;
          const shouldLock = failures >= ctx.config.login.lockoutThreshold;

          await ctx.db.query(
            `UPDATE users
                SET failed_login_count = $2,
                    locked_until = CASE WHEN $3 THEN now() + ($4 || ' seconds')::interval ELSE locked_until END
              WHERE id = $1`,
            [row.id, failures, shouldLock, String(ctx.config.login.lockoutSeconds)],
          );

          await ctx.audit.record({
            eventType: shouldLock ? 'auth.login.locked_out' : 'auth.login.failed',
            outcome: 'failure',
            actorUserId: row.id,
            requestId: request.id,
            subject: email,
            detail: { reason: 'bad_password', consecutiveFailures: failures, locked: shouldLock },
          });
          throw unauthorized('bad password');
        }

        // --- Success --------------------------------------------------------
        const issued = await ctx.sessions.issue(row.id, request.headers['user-agent']);
        setSessionCookie(reply, issued.token);

        await ctx.audit.record({
          eventType: 'auth.login.succeeded',
          outcome: 'success',
          actorUserId: row.id,
          requestId: request.id,
          subject: email,
          detail: { sessionId: issued.session.id },
        });

        const user: AuthenticatedUser = {
          id: row.id,
          email: row.email,
          displayName: row.display_name,
          role: row.role,
          createdAt: row.created_at,
          lastLoginAt: new Date(),
        };

        return reply.code(200).send(sessionBody(user, issued.session, issued.csrfToken));
      },
    );

    // -------------------------------------------------------------------------
    // POST /api/auth/logout
    // -------------------------------------------------------------------------
    app.post('/api/auth/logout', { preHandler: requireAuth }, async (request, reply) => {
      const token = request.cookies[ctx.config.session.cookieName];
      if (token) await ctx.sessions.revokeByToken(token);
      clearSessionCookie(reply);

      await ctx.audit.record({
        eventType: 'auth.logout',
        outcome: 'success',
        actorUserId: request.auth?.user.id ?? null,
        requestId: request.id,
        detail: { sessionId: request.auth?.session.id ?? null },
      });

      const body: LogoutResponse = { loggedOut: true };
      return reply.code(200).send(body);
    });

    // -------------------------------------------------------------------------
    // GET /api/auth/me
    //
    // Also the CSRF token refresh path: the web panel calls this on load to
    // recover a usable token after a page reload, since the token is never
    // persisted client-side.
    // -------------------------------------------------------------------------
    app.get('/api/auth/me', { preHandler: requireAuth }, async (request, reply) => {
      const auth = request.auth;
      if (!auth) throw new AppError('unauthorized', 'Authentication required.');

      // The stored value is a hash, so the original token cannot be returned.
      // A fresh token is minted and swapped onto the session instead — which
      // additionally rotates the CSRF token on every page load.
      const { generateToken, hashToken } = await import('../auth/tokens.js');
      const csrfToken = generateToken();
      await ctx.db.query('UPDATE sessions SET csrf_token_hash = $2 WHERE id = $1', [
        auth.session.id,
        hashToken(csrfToken),
      ]);

      return reply.code(200).send(sessionBody(auth.user, auth.session, csrfToken));
    });
  };
