import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { ErrorResponse } from '@project-control/contracts';

import type { AppContext } from './context.js';
import { AppError } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { systemRoutes } from './routes/system.js';
import { artifactRoutes } from './routes/artifacts.js';
import { projectRoutes } from './routes/projects.js';
import { roadmapRoutes } from './routes/roadmap.js';
import { memoryRoutes } from './routes/memory.js';
import { agentRunsRoutes } from './routes/agent-runs.js';
import { workSessionRoutes } from './routes/work-sessions.js';
import { resumeRoutes } from './routes/resume.js';

/**
 * Builds the Fastify instance.
 *
 * Separated from `index.ts` so integration tests can construct a real app —
 * real routes, real database, real storage — with no network listener and no
 * process-level side effects.
 */
// The return type is inferred rather than annotated as `FastifyInstance`:
// passing a concrete pino `Logger` via `loggerInstance` specialises Fastify's
// logger type parameter, and the default `FastifyInstance` alias (which uses
// `FastifyBaseLogger`) is not assignable from it.
export async function buildApp(ctx: AppContext) {
  const app = Fastify({
    loggerInstance: ctx.logger,
    // Correlates the HTTP log line, the audit row and the runner request.
    genReqId: (req) => {
      const supplied = req.headers['x-request-id'];
      if (typeof supplied === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(supplied)) return supplied;
      return randomUUID();
    },
    bodyLimit: ctx.config.http.bodyLimitBytes,
    // Caddy is the only thing that talks to this server and it runs on a private
    // Docker network, so forwarded headers are trusted from there — but only
    // from there. Fastify's default is `false`; enabling it lets Caddy's
    // X-Forwarded-For reach the rate limiter.
    trustProxy: true,
    // Never echo the framework name.
    return503OnClosing: true,
  });

  // ---------------------------------------------------------------------------
  // Security headers
  //
  // The API serves JSON only, so the CSP is maximally restrictive: nothing may
  // be loaded or executed from an API response under any circumstance. The web
  // panel's own (looser) CSP is set by Caddy for HTML routes.
  // ---------------------------------------------------------------------------
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
    // HSTS is set by Caddy, which is the component actually terminating a TLS
    // session from the browser's point of view. Setting it here too would be
    // harmless but misleading.
    hsts: false,
    xFrameOptions: { action: 'deny' },
    noSniff: true,
  });

  await app.register(cookie, {
    // Cookie *values* are opaque high-entropy tokens verified against the
    // database, so no signing secret is needed for integrity. The secret is
    // registered anyway so future signed cookies have one available.
    secret: ctx.config.session.secret,
    parseOptions: {},
  });

  // ---------------------------------------------------------------------------
  // Rate limiting
  //
  // A permissive global ceiling stops a runaway client; the login route sets a
  // far stricter per-route limit via its own `config.rateLimit`.
  // ---------------------------------------------------------------------------
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: 60_000,
    // Health checks come from Docker inside the container and must never be
    // throttled, or a burst of traffic would make the container look unhealthy.
    allowList: (req) => req.url.startsWith('/health/'),
    keyGenerator: (req) => req.ip,
    // The plugin *throws* whatever this returns, so it has to be an Error with a
    // statusCode — a plain object falls through to the generic branch of the
    // error handler and is reported as a 500. Returning an AppError also routes
    // it through the same serialiser as every other rejection, so the client
    // sees the standard envelope.
    errorResponseBuilder: (_req, context) =>
      new AppError('rate_limited', `Too many requests. Retry in ${Math.ceil(context.ttl / 1000)} s.`),
  });

  // Records rate-limited login attempts in the audit trail.
  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode === 429 && request.url === '/api/auth/login') {
      await ctx.audit.record({
        eventType: 'auth.login.rate_limited',
        outcome: 'denied',
        requestId: String(request.id),
        detail: { path: request.url },
      });
    }
  });

  // Every response carries its request id so an operator can jump straight from
  // a browser network tab to the matching audit row.
  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', String(request.id));
    return payload;
  });

  // ---------------------------------------------------------------------------
  // Error serialisation
  //
  // The single place where an error becomes an HTTP response. Anything that is
  // not a deliberate AppError is reported as a bare `internal_error`; the real
  // message and stack stay in the log. That is what keeps driver errors — which
  // routinely embed connection strings — out of the response body.
  // ---------------------------------------------------------------------------
  app.setErrorHandler((error, request, reply) => {
    const requestId = String(request.id);

    if (error instanceof AppError) {
      if (error.statusCode >= 500) {
        request.log.error({ err: error, code: error.code, detail: error.internalDetail }, 'request failed');
      } else {
        request.log.info({ code: error.code, detail: error.internalDetail }, 'request rejected');
      }
      const body: ErrorResponse = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.fields ? { fields: error.fields } : {}),
          ...(error.confirmation ? { confirmation: error.confirmation } : {}),
        },
        requestId,
      };
      return reply.code(error.statusCode).send(body);
    }

    // Fastify's own errors (body too large, malformed JSON, ...) carry a status.
    const status =
      typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? ((error as { statusCode: number }).statusCode)
        : 500;

    if (status === 413) {
      request.log.warn('request body exceeded the configured limit');
      return reply.code(413).send({
        error: { code: 'payload_too_large' as const, message: 'Request body is too large.' },
        requestId,
      } satisfies ErrorResponse);
    }
    if (status === 400) {
      request.log.info('malformed request');
      return reply.code(400).send({
        error: { code: 'bad_request' as const, message: 'Malformed request.' },
        requestId,
      } satisfies ErrorResponse);
    }
    if (status === 429) {
      // Backstop in case a plugin raises a throttling error that is not an
      // AppError; a 429 must never be reported to the client as a 500.
      request.log.info('rate limited');
      return reply.code(429).send({
        error: { code: 'rate_limited' as const, message: 'Too many requests.' },
        requestId,
      } satisfies ErrorResponse);
    }

    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({
      error: { code: 'internal_error' as const, message: 'An internal error occurred.' },
      requestId,
    } satisfies ErrorResponse);
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({
      error: { code: 'not_found' as const, message: 'Not found.' },
      requestId: String(request.id),
    } satisfies ErrorResponse),
  );

  // ---------------------------------------------------------------------------
  // Routes
  // ---------------------------------------------------------------------------
  await app.register(healthRoutes(ctx));
  await app.register(authRoutes(ctx));
  await app.register(systemRoutes(ctx));
  await app.register(artifactRoutes(ctx));
  await app.register(projectRoutes(ctx));
  await app.register(roadmapRoutes(ctx));
  await app.register(memoryRoutes(ctx));
  await app.register(agentRunsRoutes(ctx));
  await app.register(workSessionRoutes(ctx));
  await app.register(resumeRoutes(ctx));

  return app;
}
