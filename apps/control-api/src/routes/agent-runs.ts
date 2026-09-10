import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  agentRunListQuerySchema, createAgentRunRequestSchema, createAgentReportRequestSchema,
  createMemoryEntryRequestSchema, setAgentRunStatusRequestSchema, updateAgentReportRequestSchema,
  updateAgentRunRequestSchema, updateAgentRunValidationRequestSchema, upsertAgentRunPromptRequestSchema,
  uuidSchema,
} from '@project-control/contracts';
import type { AppContext } from '../context.js';
import type { AuditEventType } from '../audit.js';
import { AppError, badRequest } from '../errors.js';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import {
  createAgentReport, createAgentRun, duplicateAgentRun, finalizeAgentReport, getAgentRun, getAgentRunPrompt,
  listAgentReports, listAgentRuns, loadAgentRunTimeline, promoteAgentRunToMemory, sendAgentRunPrompt,
  setAgentRunArchived, setAgentRunStatus, updateAgentReport, updateAgentRun, updateAgentRunValidation,
  upsertAgentRunPrompt,
} from '../agent-runs/store.js';
import { listMemoryBySourceAgentRun } from '../memory/store.js';
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

export const agentRunsRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
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

  // --- Agent Runs --------------------------------------------------------
  app.get('/api/projects/:projectId/agent-runs', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId } = ids(request);
    const query = parse(agentRunListQuerySchema, request.query);
    return reply.send(await listAgentRuns(ctx.db, projectId!, query));
  });
  app.get('/api/projects/:projectId/agent-runs/:runId', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send({ agentRun: await getAgentRun(ctx.db, projectId!, runId!) });
  });
  app.post('/api/projects/:projectId/agent-runs', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId } = ids(request);
    const body = parse(createAgentRunRequestSchema, request.body);
    return reply.code(201).send({ agentRun: await createAgentRun(ctx.db, projectId!, request.auth!.user.id, body, auditFor(request), timelineFor(request)) });
  });
  app.patch('/api/projects/:projectId/agent-runs/:runId', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    const body = parse(updateAgentRunRequestSchema, request.body);
    return reply.send({ agentRun: await updateAgentRun(ctx.db, projectId!, runId!, body, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/status', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    const body = parse(setAgentRunStatusRequestSchema, request.body);
    return reply.send({ agentRun: await setAgentRunStatus(ctx.db, projectId!, runId!, body.status, auditFor(request), timelineFor(request)) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/archive', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send({ agentRun: await setAgentRunArchived(ctx.db, projectId!, runId!, true, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/reactivate', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send({ agentRun: await setAgentRunArchived(ctx.db, projectId!, runId!, false, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/duplicate', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    const result = await duplicateAgentRun(ctx.db, projectId!, runId!, request.auth!.user.id, auditFor(request));
    return reply.code(201).send(result);
  });

  // --- Prompt --------------------------------------------------------------
  app.get('/api/projects/:projectId/agent-runs/:runId/prompt', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send({ prompt: await getAgentRunPrompt(ctx.db, projectId!, runId!) });
  });
  app.patch('/api/projects/:projectId/agent-runs/:runId/prompt', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    const body = parse(upsertAgentRunPromptRequestSchema, request.body);
    return reply.send({ prompt: await upsertAgentRunPrompt(ctx.db, projectId!, runId!, body.body, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/prompt/send', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send(await sendAgentRunPrompt(ctx.db, projectId!, runId!, auditFor(request)));
  });

  // --- Reports ---------------------------------------------------------------
  app.get('/api/projects/:projectId/agent-runs/:runId/reports', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send({ reports: await listAgentReports(ctx.db, projectId!, runId!) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/reports', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    const body = parse(createAgentReportRequestSchema, request.body);
    return reply.code(201).send({ report: await createAgentReport(ctx.db, projectId!, runId!, request.auth!.user.id, body.body, auditFor(request)) });
  });
  app.patch('/api/projects/:projectId/agent-runs/:runId/reports/:reportId', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId, reportId } = ids(request);
    const body = parse(updateAgentReportRequestSchema, request.body);
    return reply.send({ report: await updateAgentReport(ctx.db, projectId!, runId!, reportId!, body.body, auditFor(request)) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/reports/:reportId/finalize', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId, reportId } = ids(request);
    return reply.send(await finalizeAgentReport(ctx.db, projectId!, runId!, reportId!, auditFor(request)));
  });

  // --- Validation --------------------------------------------------------------
  app.patch('/api/projects/:projectId/agent-runs/:runId/validation', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    const body = parse(updateAgentRunValidationRequestSchema, request.body);
    return reply.send({ agentRun: await updateAgentRunValidation(ctx.db, projectId!, runId!, request.auth!.user.id, body, auditFor(request)) });
  });

  // --- Timeline / related memory / promote --------------------------------------
  app.get('/api/projects/:projectId/agent-runs/:runId/timeline', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send({ timeline: await loadAgentRunTimeline(ctx.db, projectId!, runId!) });
  });
  app.get('/api/projects/:projectId/agent-runs/:runId/related-memory', { preHandler: requireAuth }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    return reply.send({ entries: await listMemoryBySourceAgentRun(ctx.db, projectId!, runId!) });
  });
  app.post('/api/projects/:projectId/agent-runs/:runId/promote-memory', { preHandler: requireWriter }, async (request, reply) => {
    const { projectId, runId } = ids(request);
    const body = parse(createMemoryEntryRequestSchema, request.body);
    return reply.code(201).send({ entry: await promoteAgentRunToMemory(ctx.db, projectId!, runId!, request.auth!.user.id, body, auditFor(request)) });
  });
};
