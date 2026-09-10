import { Readable } from 'node:stream';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type {
  AddWorkflowRunStepRequest, AttachWorkflowRunArtifactRequest, AttachWorkflowRunArtifactResponse,
  ClaimWorkflowRunResponse, OpenWorkflowRunRequest, RequestWorkflowRunRequest,
  SettleWorkflowRunRequest, SettleWorkflowRunResponse, WhoamiResponse, WorkflowListResponse,
  WorkflowRunDetail, WorkflowRunListResponse, WorkflowRunResponse, WorkflowSummary,
} from '@project-control/contracts';
import {
  addWorkflowRunStepRequestSchema, attachWorkflowRunArtifactRequestSchema, openWorkflowRunRequestSchema,
  requestWorkflowRunRequestSchema, settleWorkflowRunRequestSchema, uuidSchema, workflowRunListQuerySchema,
} from '@project-control/contracts';
import {
  createRequireAuth, createResolvePrincipal, requirePrincipalKind, requireScope,
} from '../auth/middleware.js';
import type { AppContext } from '../context.js';
import { requireRole } from '../auth/middleware.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { findWorkflow } from '../automation/manifest.js';

function parse<T>(schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Request body failed validation.', {
      fields: (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data as T;
}

function runIdParam(request: FastifyRequest): string {
  const { id } = request.params as { id: string };
  if (!uuidSchema.safeParse(id).success) throw badRequest('id must be a UUID.');
  return id;
}

/**
 * The automation surface: workflow registry reads and the workflow run
 * lifecycle. See docs/automation.md.
 *
 * Every mutation route here is reachable by a service principal, except two
 * that are deliberately human-only regardless of scope: requesting a manual
 * run and cancelling one. Nothing on this surface can execute a Repository
 * Action, apply a rescan diff, or archive anything — see
 * docs/service-accounts.md for the scope vocabulary this depends on.
 */
export const automationRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);
  const resolvePrincipal = createResolvePrincipal(ctx);
  const requireHumanWriter = [requireAuth, requireRole('admin', 'operator')];
  const requireServiceRunner = [resolvePrincipal, requirePrincipalKind(ctx, 'service'), requireScope(ctx, 'automation:run')];
  const requireEitherReader = [resolvePrincipal, requireScope(ctx, 'system:read')];

  // ---------------------------------------------------------------------------
  // Identity diagnostic
  // ---------------------------------------------------------------------------
  app.get('/api/automation/whoami', { preHandler: resolvePrincipal }, async (request, reply) => {
    const principal = request.principal;
    if (!principal) throw new AppError('internal_error', 'Principal was not resolved.');

    const body: WhoamiResponse =
      principal.kind === 'user'
        ? { kind: 'user', userId: principal.user.id, role: principal.user.role }
        : { kind: 'service', accountKey: principal.account.key, scopes: principal.token.scopes };

    return reply.code(200).send(body);
  });

  // ---------------------------------------------------------------------------
  // Registry
  // ---------------------------------------------------------------------------
  app.get('/api/automation/workflows', { preHandler: requireEitherReader }, async (_request, reply) => {
    const summaries: WorkflowSummary[] = await Promise.all(
      ctx.automationManifest.workflows.map(async (workflow) => ({
        workflow,
        lastRun: await ctx.automation.lastRunFor(workflow.key),
      })),
    );
    const body: WorkflowListResponse = { workflows: summaries };
    return reply.code(200).send(body);
  });

  // ---------------------------------------------------------------------------
  // Runs — reads
  // ---------------------------------------------------------------------------
  app.get('/api/automation/runs', { preHandler: requireEitherReader }, async (request, reply) => {
    const query = parse(workflowRunListQuerySchema, request.query);
    const { runs, total } = await ctx.automation.list(query);
    const body: WorkflowRunListResponse = { runs, total };
    return reply.code(200).send(body);
  });

  app.get('/api/automation/runs/:id', { preHandler: requireEitherReader }, async (request, reply) => {
    const id = runIdParam(request);
    const run = await ctx.automation.get(id);
    if (!run) throw notFound('No such workflow run.');
    const steps = await ctx.automation.listSteps(id);
    const body: WorkflowRunDetail = { run, steps };
    return reply.code(200).send(body);
  });

  // ---------------------------------------------------------------------------
  // Runs — human-only lifecycle
  // ---------------------------------------------------------------------------
  app.post(
    '/api/automation/workflows/:key/request-run',
    { preHandler: requireHumanWriter },
    async (request, reply) => {
      const { key } = request.params as { key: string };
      const def = findWorkflow(ctx.automationManifest, key);
      if (!def) {
        await ctx.audit.record({
          eventType: 'workflow.run_rejected',
          outcome: 'denied',
          actorUserId: request.auth!.user.id,
          requestId: request.id,
          detail: { workflowKey: key, reason: 'unknown_workflow' },
        });
        throw notFound(`Unknown workflow: ${key}`);
      }

      const body = parse(requestWorkflowRunRequestSchema, request.body ?? {});
      const run = await ctx.automation.requestRun({
        workflowKey: def.key,
        projectId: body.projectId ?? null,
        triggeredByUserId: request.auth!.user.id,
      });

      await ctx.audit.record({
        eventType: 'workflow.run_requested',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        subject: `workflow:${def.key}`,
        detail: { runId: run.id, workflowKey: def.key, projectId: run.projectId },
      });

      const responseBody: WorkflowRunResponse = { run };
      return reply.code(201).send(responseBody);
    },
  );

  app.post('/api/automation/runs/:id/cancel', { preHandler: requireHumanWriter }, async (request, reply) => {
    const id = runIdParam(request);
    const run = await ctx.automation.cancel(id);

    await ctx.audit.record({
      eventType: 'workflow.run_cancelled',
      outcome: 'success',
      actorUserId: request.auth!.user.id,
      requestId: request.id,
      subject: `workflow:${run.workflowKey}`,
      detail: { runId: run.id, workflowKey: run.workflowKey },
    });

    const body: WorkflowRunResponse = { run };
    return reply.code(200).send(body);
  });

  // ---------------------------------------------------------------------------
  // Runs — service-only lifecycle
  // ---------------------------------------------------------------------------
  app.post('/api/automation/runs', { preHandler: requireServiceRunner }, async (request, reply) => {
    const body = parse<OpenWorkflowRunRequest>(openWorkflowRunRequestSchema, request.body);
    const principal = request.principal!;
    if (principal.kind !== 'service') throw new AppError('internal_error', 'Expected a service principal.');

    const def = findWorkflow(ctx.automationManifest, body.workflowKey);
    if (!def) {
      await ctx.audit.record({
        eventType: 'workflow.run_rejected',
        outcome: 'denied',
        requestId: request.id,
        subject: `service_account:${principal.account.key}`,
        detail: { workflowKey: body.workflowKey, reason: 'unknown_workflow' },
      });
      throw notFound(`Unknown workflow: ${body.workflowKey}`);
    }

    const run = await ctx.automation.openRun({
      workflowKey: def.key,
      projectId: body.projectId ?? null,
      serviceTokenId: principal.token.id,
      externalRef: body.externalRef ?? null,
    });

    await ctx.audit.record({
      eventType: 'workflow.run_opened',
      outcome: 'success',
      requestId: request.id,
      subject: `service_account:${principal.account.key}`,
      detail: { runId: run.id, workflowKey: def.key, projectId: run.projectId, externalRef: run.externalRef },
    });

    const responseBody: WorkflowRunResponse = { run };
    return reply.code(201).send(responseBody);
  });

  app.post('/api/automation/queue/claim', { preHandler: requireServiceRunner }, async (request, reply) => {
    const principal = request.principal!;
    if (principal.kind !== 'service') throw new AppError('internal_error', 'Expected a service principal.');

    const run = await ctx.automation.claim();
    if (!run) return reply.code(204).send();

    await ctx.audit.record({
      eventType: 'workflow.run_claimed',
      outcome: 'success',
      requestId: request.id,
      subject: `service_account:${principal.account.key}`,
      detail: { runId: run.id, workflowKey: run.workflowKey },
    });

    const body: ClaimWorkflowRunResponse = { run };
    return reply.code(200).send(body);
  });

  app.post('/api/automation/runs/:id/steps', { preHandler: requireServiceRunner }, async (request, reply) => {
    const id = runIdParam(request);
    const body = parse<AddWorkflowRunStepRequest>(addWorkflowRunStepRequestSchema, request.body);
    const principal = request.principal!;
    if (principal.kind !== 'service') throw new AppError('internal_error', 'Expected a service principal.');

    const step = await ctx.automation.addStep(id, {
      position: body.position,
      name: body.name,
      status: body.status,
      detail: body.detail ?? {},
    });

    await ctx.audit.record({
      eventType: 'workflow.run_step_recorded',
      outcome: 'success',
      requestId: request.id,
      subject: `service_account:${principal.account.key}`,
      detail: { runId: id, position: step.position, name: step.name, status: step.status },
    });

    return reply.code(201).send({ step });
  });

  app.post(
    '/api/automation/runs/:id/artifact',
    { preHandler: [resolvePrincipal, requirePrincipalKind(ctx, 'service'), requireScope(ctx, 'report:write')] },
    async (request, reply) => {
      const id = runIdParam(request);
      const body = parse<AttachWorkflowRunArtifactRequest>(attachWorkflowRunArtifactRequestSchema, request.body);
      const principal = request.principal!;
      if (principal.kind !== 'service') throw new AppError('internal_error', 'Expected a service principal.');

      const run = await ctx.automation.get(id);
      if (!run) throw notFound('No such workflow run.');
      if (run.status !== 'running') {
        throw new AppError('conflict', `Cannot attach an artefact to a run with status '${run.status}'.`);
      }

      const payload = Buffer.from(body.content, 'utf8');
      const stored = await ctx.artifactStore.put(Readable.from([payload]), {
        maxBytes: ctx.config.artifacts.maxBytes,
      });

      const inserted = await ctx.db.query<{ id: string }>(
        `INSERT INTO artifact_objects (sha256, filename, content_type, size_bytes, created_by)
         VALUES ($1, $2, $3, $4, NULL)
         RETURNING id`,
        [stored.sha256, body.filename, body.contentType, payload.length],
      );
      const artifactId = inserted.rows[0]!.id;

      await ctx.audit.record({
        eventType: 'workflow.run_artifact_attached',
        outcome: 'success',
        requestId: request.id,
        subject: `service_account:${principal.account.key}`,
        detail: { runId: id, artifactId, sha256: stored.sha256, sizeBytes: payload.length },
      });

      const responseBody: AttachWorkflowRunArtifactResponse = { artifactId, sha256: stored.sha256 };
      return reply.code(201).send(responseBody);
    },
  );

  app.post('/api/automation/runs/:id/settle', { preHandler: requireServiceRunner }, async (request, reply) => {
    const id = runIdParam(request);
    const body = parse<SettleWorkflowRunRequest>(settleWorkflowRunRequestSchema, request.body);
    const principal = request.principal!;
    if (principal.kind !== 'service') throw new AppError('internal_error', 'Expected a service principal.');

    const { run, notify } = await ctx.automation.settle(id, {
      status: body.status,
      summary: body.summary,
      severity: body.severity,
      linkedActionId: body.linkedActionId ?? null,
      artifactId: body.artifactId ?? null,
    });

    await ctx.audit.record({
      eventType: 'workflow.run_settled',
      outcome: 'success',
      requestId: request.id,
      subject: `service_account:${principal.account.key}`,
      detail: { runId: run.id, workflowKey: run.workflowKey, status: run.status, severity: body.severity, notify },
    });
    await ctx.timeline.record({
      projectId: run.projectId,
      entityType: 'workflow_run',
      entityId: run.id,
      eventType: 'workflow_run.settled',
      summary: `${run.workflowKey} ${run.status}: "${body.summary.slice(0, 90)}"`,
      actorUserId: null,
      actorKind: 'service',
      requestId: request.id,
    });

    const responseBody: SettleWorkflowRunResponse = { run, notify };
    return reply.code(200).send(responseBody);
  });
};
