import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  addWorkSessionAmendmentRequestSchema, closeWorkSessionRequestSchema,
  startWorkSessionRequestSchema, updateWorkSessionRequestSchema, uuidSchema,
  workSessionListQuerySchema,
} from '@project-control/contracts';
import type { AuditEventType } from '../audit.js';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../errors.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';
import type { TimelineEntityType, TimelineEventType } from '../timeline.js';
import {
  addWorkSessionAmendment, closeWorkSession, getWorkSession, listWorkSessions,
  startWorkSession, updateWorkSession,
} from '../work-sessions/store.js';

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

export const workSessionRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
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
        requestId: request.id,
      },
      client,
    );

  app.get('/api/projects/:projectId/work-sessions', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = ids(request);
    const query = parse(workSessionListQuerySchema, request.query);
    const result = await listWorkSessions(ctx.db, projectId!, query);
    return reply.send({ ...result, page: query.page, pageSize: query.pageSize });
  });

  app.get('/api/projects/:projectId/work-sessions/:sessionId', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, sessionId } = ids(request);
    return reply.send({ workSession: await getWorkSession(ctx.db, projectId!, sessionId!) });
  });

  app.post('/api/projects/:projectId/work-sessions', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId } = ids(request);
    const body = parse(startWorkSessionRequestSchema, request.body);
    const workSession = await startWorkSession(
      ctx.db, projectId!, request.auth!.user.id, body, auditFor(request), timelineFor(request),
    );
    return reply.code(201).send({ workSession });
  });

  app.patch('/api/projects/:projectId/work-sessions/:sessionId', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, sessionId } = ids(request);
    const body = parse(updateWorkSessionRequestSchema, request.body);
    return reply.send({
      workSession: await updateWorkSession(ctx.db, projectId!, sessionId!, body, auditFor(request)),
    });
  });

  app.post('/api/projects/:projectId/work-sessions/:sessionId/close', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, sessionId } = ids(request);
    const body = parse(closeWorkSessionRequestSchema, request.body);
    return reply.send({
      workSession: await closeWorkSession(
        ctx.db, projectId!, sessionId!, request.auth!.user.id, body, auditFor(request), ctx.runner, timelineFor(request), String(request.id),
      ),
    });
  });

  app.post('/api/projects/:projectId/work-sessions/:sessionId/amendments', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, sessionId } = ids(request);
    const body = parse(addWorkSessionAmendmentRequestSchema, request.body);
    const amendment = await addWorkSessionAmendment(
      ctx.db, projectId!, sessionId!, request.auth!.user.id, body, auditFor(request),
    );
    return reply.code(201).send({ amendment });
  });
};
