import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  executeRepositoryActionRequestSchema, planGitCommitRequestSchema,
  repositoryActionListQuerySchema, uuidSchema,
} from '@project-control/contracts';
import type { AuditEventType } from '../audit.js';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../errors.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';
import type { TimelineEntityType, TimelineEventType } from '../timeline.js';
import {
  cancelRepositoryAction, executeRepositoryAction, getRepositoryAction, listRepositoryActions,
  planGitCommit, reconcileRepositoryAction,
} from '../repository-actions/store.js';

function parse<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Request body failed validation.', {
      fields: (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data as T;
}

function ids(request: FastifyRequest): Record<string, string> {
  const values = request.params as Record<string, string>;
  for (const [name, value] of Object.entries(values)) {
    if (!uuidSchema.safeParse(value).success) throw badRequest(`${name} must be a UUID.`);
  }
  return values;
}

/**
 * Repository Actions: plan -> confirm+execute -> verify -> settle. See
 * docs/repository-actions.md. Every write route here requires admin/operator,
 * matching every other mutation surface in this API — there is no separate
 * authorization system for the fact that this one happens to touch a
 * repository instead of PostgreSQL.
 */
export const repositoryActionRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);
  const requireWriter = [requireAuth, requireRole('admin', 'operator')];
  const auditFor = (request: FastifyRequest): MutationAudit => async (client, eventType, detail) =>
    ctx.audit.recordRequired(
      {
        eventType: eventType as AuditEventType,
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        subject: `project:${String(detail['projectId'])}`,
        detail,
      },
      client,
    );
  const timelineFor = (request: FastifyRequest): MutationTimeline => async (client, entry) =>
    ctx.timeline.recordRequired(
      {
        projectId: entry.projectId ?? null,
        entityType: entry.entityType as TimelineEntityType,
        entityId: entry.entityId,
        eventType: entry.eventType as TimelineEventType,
        summary: entry.summary,
        actorUserId: request.auth!.user.id,
        actorKind: 'user',
      },
      client,
    );

  app.get('/api/projects/:projectId/actions', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = ids(request);
    const query = parse(repositoryActionListQuerySchema, request.query);
    const result = await listRepositoryActions(ctx.db, projectId!, query.page, query.pageSize);
    return reply.send(result);
  });

  app.get('/api/projects/:projectId/actions/:actionId', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, actionId } = ids(request);
    return reply.send({ action: await getRepositoryAction(ctx.db, projectId!, actionId!) });
  });

  app.post('/api/projects/:projectId/actions/git-commit/plan', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId } = ids(request);
    const body = parse(planGitCommitRequestSchema, request.body);
    const action = await planGitCommit(
      ctx.db, ctx.runner, projectId!, request.auth!.user.id, body, auditFor(request), String(request.id),
    );
    return reply.code(201).send({ action });
  });

  app.post(
    '/api/projects/:projectId/actions/:actionId/execute',
    {
      preHandler: requireWriter,
      // A repository mutation deserves a tighter throttle than the general
      // API ceiling — this bounds how many commits one session can attempt
      // per minute regardless of how many are actually confirmed.
      config: { rateLimit: { max: 10, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      const { projectId, actionId } = ids(request);
      const body = parse(executeRepositoryActionRequestSchema, request.body);
      const action = await executeRepositoryAction(
        ctx.db, ctx.runner, projectId!, actionId!, request.auth!.user.id, body, auditFor(request), timelineFor(request), String(request.id),
      );
      return reply.send({ action });
    },
  );

  app.post('/api/projects/:projectId/actions/:actionId/cancel', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, actionId } = ids(request);
    return reply.send({ action: await cancelRepositoryAction(ctx.db, projectId!, actionId!, auditFor(request)) });
  });

  app.post('/api/projects/:projectId/actions/:actionId/reconcile', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, actionId } = ids(request);
    const action = await reconcileRepositoryAction(
      ctx.db, ctx.runner, projectId!, actionId!, auditFor(request), String(request.id),
    );
    return reply.send({ action });
  });
};
