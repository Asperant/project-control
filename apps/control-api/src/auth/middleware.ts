import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { assertCsrf, assertOrigin, CSRF_HEADER } from './csrf.js';

/**
 * Authentication and CSRF enforcement, applied as a single preHandler.
 *
 * Ordering is deliberate: the session is resolved first, then CSRF is checked
 * against *that session's* token. Checking CSRF first would require a
 * session-independent token, which is strictly weaker.
 */
export function createRequireAuth(ctx: AppContext) {
  return async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = request.cookies[ctx.config.session.cookieName];

    if (!token) {
      throw new AppError('unauthorized', 'Authentication required.');
    }

    const resolved = await ctx.sessions.resolve(token);
    if (!resolved) {
      // Covers expired, revoked, idle-timed-out and deactivated-user cases. The
      // client cannot tell which, by design.
      await ctx.audit.record({
        eventType: 'auth.session.rejected',
        outcome: 'denied',
        requestId: request.id,
        detail: { reason: 'session_not_resolvable' },
      });
      throw new AppError('unauthorized', 'Session is invalid or has expired.');
    }

    assertOrigin({
      method: request.method,
      origin: request.headers.origin,
      host: request.headers.host,
    });

    try {
      assertCsrf({
        method: request.method,
        headerValue: request.headers[CSRF_HEADER] as string | undefined,
        sessionCsrfHash: resolved.session.csrfTokenHash,
      });
    } catch (error) {
      await ctx.audit.record({
        eventType: 'auth.csrf.rejected',
        outcome: 'denied',
        actorUserId: resolved.user.id,
        requestId: request.id,
        detail: { method: request.method, path: request.url },
      });
      throw error;
    }

    request.auth = { user: resolved.user, session: resolved.session };
  };
}

/** Role gate, applied after `requireAuth`. Stage 1 uses it only for admin ops. */
export function requireRole(...roles: Array<'admin' | 'operator' | 'viewer'>) {
  return async function roleGuard(request: FastifyRequest): Promise<void> {
    const role = request.auth?.user.role;
    if (!role || !roles.includes(role)) {
      throw new AppError('forbidden', 'Your role does not permit this operation.');
    }
  };
}
