import type { ServiceScope } from '@project-control/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { assertCsrf, assertOrigin, CSRF_HEADER } from './csrf.js';
import type { AuthenticatedUser, SessionRecord } from './session-store.js';
import { looksLikeServiceToken } from './service-tokens.js';

/**
 * Resolves the cookie-based session for a request: looks it up, then enforces
 * Origin and CSRF. Shared by `requireAuth` (the cookie-only gate every
 * existing route uses) and `resolvePrincipal` (the dual-kind gate new routes
 * opt into) so the two never drift into checking CSRF differently.
 */
async function authenticateSessionCookie(
  ctx: AppContext,
  request: FastifyRequest,
): Promise<{ user: AuthenticatedUser; session: SessionRecord }> {
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

  return resolved;
}

/**
 * Authentication and CSRF enforcement, applied as a single preHandler.
 *
 * Cookie-only, exactly as originally shipped. Every route file except the new
 * automation surface uses this, and it never looks at an Authorization
 * header — which is what makes "a Bearer token is rejected on every route
 * that has not opted into `resolvePrincipal`" true without a single explicit
 * check: the header is simply never read.
 */
export function createRequireAuth(ctx: AppContext) {
  return async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const resolved = await authenticateSessionCookie(ctx, request);
    request.auth = { user: resolved.user, session: resolved.session };
  };
}

/** Role gate, applied after `requireAuth`. Used only for admin/operator ops. */
export function requireRole(...roles: Array<'admin' | 'operator' | 'viewer'>) {
  return async function roleGuard(request: FastifyRequest): Promise<void> {
    const role = request.auth?.user.role;
    if (!role || !roles.includes(role)) {
      throw new AppError('forbidden', 'Your role does not permit this operation.');
    }
  };
}

/**
 * Dual-kind authentication: a session cookie (human) or an
 * `Authorization: Bearer pcs_...` service token (machine), never both.
 *
 * Only routes that explicitly use this as their preHandler ever accept a
 * Bearer token — every other route keeps using `requireAuth` above, which
 * cannot be satisfied by one no matter what the caller sends. That asymmetry
 * is the entire access-control model for machine callers: opt-in per route,
 * closed by default.
 *
 * A request carrying both a cookie and a Bearer header is rejected outright.
 * Accepting the cookie and ignoring the header (or vice versa) would let a
 * confused or compromised client silently authenticate as a different
 * principal than the one it thinks it presented.
 */
export function createResolvePrincipal(ctx: AppContext) {
  return async function resolvePrincipal(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const cookieToken = request.cookies[ctx.config.session.cookieName];
    const header = request.headers.authorization;
    const bearerToken =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : undefined;

    if (cookieToken && bearerToken) {
      await ctx.audit.record({
        eventType: 'service.token_rejected',
        outcome: 'denied',
        requestId: request.id,
        detail: { reason: 'mixed_credentials' },
      });
      throw new AppError('bad_request', 'Request must not carry both a session cookie and a Bearer token.');
    }

    if (bearerToken !== undefined) {
      if (!looksLikeServiceToken(bearerToken)) {
        throw new AppError('unauthorized', 'Bearer token is not a recognised service token.');
      }
      const resolved = await ctx.serviceTokens.resolve(bearerToken);
      if (!resolved) {
        await ctx.audit.record({
          eventType: 'service.token_rejected',
          outcome: 'denied',
          requestId: request.id,
          detail: { reason: 'token_not_resolvable' },
        });
        throw new AppError(
          'unauthorized',
          'Service token is invalid, revoked, expired, or its account is disabled.',
        );
      }
      request.principal = {
        kind: 'service',
        account: { id: resolved.account.id, key: resolved.account.key },
        token: { id: resolved.token.id, scopes: resolved.token.scopes },
      };
      return;
    }

    const resolved = await authenticateSessionCookie(ctx, request);
    request.auth = { user: resolved.user, session: resolved.session };
    request.principal = { kind: 'user', user: resolved.user, session: resolved.session };
  };
}

/**
 * Restricts a route to one kind of resolved principal. Used to keep a
 * mutation route reachable only by a human even after it is wired behind
 * `resolvePrincipal` for read access by both kinds — see
 * docs/service-accounts.md for why this is a separate gate from scope rather
 * than an implicit consequence of it.
 */
export function requirePrincipalKind(ctx: AppContext, ...kinds: Array<'user' | 'service'>) {
  return async function principalKindGuard(request: FastifyRequest): Promise<void> {
    const principal = request.principal;
    const kind = principal?.kind;
    if (!kind || !kinds.includes(kind)) {
      if (principal?.kind === 'service') {
        await ctx.audit.record({
          eventType: 'service.principal_kind_denied',
          outcome: 'denied',
          requestId: request.id,
          subject: `service_account:${principal.account.key}`,
          detail: { required: kinds, path: request.url },
        });
      }
      throw new AppError('forbidden', 'This operation requires a different kind of caller.');
    }
  };
}

/**
 * Requires a service principal to hold every listed scope. A user principal
 * always passes: a human's access is governed by `requireRole`, not by the
 * machine scope vocabulary, so this gate is a no-op for `kind: 'user'` by
 * design rather than by omission.
 */
export function requireScope(ctx: AppContext, ...scopes: ServiceScope[]) {
  return async function scopeGuard(request: FastifyRequest): Promise<void> {
    const principal = request.principal;
    if (!principal || principal.kind !== 'service') return;

    const missing = scopes.filter((scope) => !principal.token.scopes.includes(scope));
    if (missing.length > 0) {
      await ctx.audit.record({
        eventType: 'service.scope_denied',
        outcome: 'denied',
        requestId: request.id,
        subject: `service_account:${principal.account.key}`,
        detail: { required: scopes, missing, path: request.url },
      });
      throw new AppError('forbidden', 'Service token does not carry the required scope.');
    }
  };
}
