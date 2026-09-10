import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  createCheckpointRequestSchema, createMemoryEntryRequestSchema, memoryListQuerySchema,
  supersedeMemoryEntryRequestSchema, updateMemoryEntryRequestSchema, uuidSchema,
} from '@project-control/contracts';
import type { AppContext } from '../context.js';
import type { AuditEventType } from '../audit.js';
import { AppError, badRequest } from '../errors.js';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import {
  createMemoryEntry, getMemoryEntry, listMemory, setMemoryArchived, setMemoryPinned,
  supersedeMemoryEntry, updateMemoryEntry,
} from '../memory/store.js';
import { archiveCheckpoint, createCheckpoint, getCheckpoint, listCheckpoints } from '../checkpoints/store.js';
import { getProjectContext } from '../context/store.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';
import type { TimelineEntityType, TimelineEventType } from '../timeline.js';

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Request body failed validation.', {
      fields: (result.error?.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message })),
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

export const memoryRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);
  const requireWriter = [requireAuth, requireRole('admin', 'operator')];
  const auditFor = (request: FastifyRequest): MutationAudit => async (client, eventType, detail) =>
    ctx.audit.recordRequired(
      { eventType: eventType as AuditEventType, outcome: 'success', actorUserId: request.auth!.user.id, requestId: request.id, subject: `project:${String(detail['projectId'])}`, detail },
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

  // --- Memory entries --------------------------------------------------------
  app.get('/api/projects/:projectId/memory', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = ids(request);
    const query = parse(memoryListQuerySchema, request.query);
    return reply.send({ entries: await listMemory(ctx.db, projectId!, query) });
  });
  app.get('/api/projects/:projectId/memory/:entryId', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, entryId } = ids(request);
    return reply.send({ entry: await getMemoryEntry(ctx.db, projectId!, entryId!) });
  });
  app.post('/api/projects/:projectId/memory', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId } = ids(request);
    const body = parse(createMemoryEntryRequestSchema, request.body);
    return reply.code(201).send({ entry: await createMemoryEntry(ctx.db, projectId!, request.auth!.user.id, body, auditFor(request), timelineFor(request)) });
  });
  app.patch('/api/projects/:projectId/memory/:entryId', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, entryId } = ids(request);
    const body = parse(updateMemoryEntryRequestSchema, request.body);
    return reply.send({ entry: await updateMemoryEntry(ctx.db, projectId!, entryId!, body, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/memory/:entryId/pin', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, entryId } = ids(request);
    return reply.send({ entry: await setMemoryPinned(ctx.db, projectId!, entryId!, true, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/memory/:entryId/unpin', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, entryId } = ids(request);
    return reply.send({ entry: await setMemoryPinned(ctx.db, projectId!, entryId!, false, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/memory/:entryId/archive', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, entryId } = ids(request);
    return reply.send({ entry: await setMemoryArchived(ctx.db, projectId!, entryId!, true, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/memory/:entryId/reactivate', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, entryId } = ids(request);
    return reply.send({ entry: await setMemoryArchived(ctx.db, projectId!, entryId!, false, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/memory/:entryId/supersede', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, entryId } = ids(request);
    const body = parse(supersedeMemoryEntryRequestSchema, request.body);
    const result = await supersedeMemoryEntry(ctx.db, projectId!, entryId!, request.auth!.user.id, body, auditFor(request), timelineFor(request));
    return reply.code(201).send(result);
  });

  // --- Checkpoints -------------------------------------------------------------
  app.get('/api/projects/:projectId/checkpoints', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = ids(request);
    const archived = (request.query as { archived?: string }).archived === 'true';
    return reply.send({ checkpoints: await listCheckpoints(ctx.db, projectId!, archived) });
  });
  app.get('/api/projects/:projectId/checkpoints/:checkpointId', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, checkpointId } = ids(request);
    return reply.send({ checkpoint: await getCheckpoint(ctx.db, projectId!, checkpointId!) });
  });
  app.post('/api/projects/:projectId/checkpoints', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId } = ids(request);
    const body = parse(createCheckpointRequestSchema, request.body ?? {});
    const checkpoint = await createCheckpoint(
      ctx.db, projectId!, request.auth!.user.id, body.sessionNote, auditFor(request), ctx.runner, timelineFor(request), String(request.id),
    );
    return reply.code(201).send({ checkpoint });
  });
  app.post('/api/projects/:projectId/checkpoints/:checkpointId/archive', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, checkpointId } = ids(request);
    return reply.send({ checkpoint: await archiveCheckpoint(ctx.db, projectId!, checkpointId!, auditFor(request)) });
  });

  // --- Current context / "Where was I?" ----------------------------------------
  app.get('/api/projects/:projectId/context', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = ids(request);
    return reply.send(await getProjectContext(ctx.db, projectId!));
  });
};
