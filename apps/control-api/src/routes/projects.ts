import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import {
  applyRescanRequestSchema,
  createProjectCommandRequestSchema,
  createProjectRequestSchema,
  createProjectRuleRequestSchema,
  createProjectTechnologyRequestSchema,
  deletedResponseSchema,
  inspectProjectRequestSchema,
  listProjectsQuerySchema,
  updateProjectCommandRequestSchema,
  updateProjectRequestSchema,
  updateProjectRuleRequestSchema,
  uuidSchema,
  type ApplyRescanResponse,
  type ListProjectsResponse,
  type ProjectActivityResponse,
  type ProjectCommandResponse,
  type ProjectInspectionResponse,
  type ProjectResponse,
  type ProjectRuleResponse,
  type ProjectTechnologyResponse,
  type RescanProjectResponse,
} from '@project-control/contracts';
import { z } from 'zod';

import type { AppContext } from '../context.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import { RunnerUnavailableError } from '../runner/client.js';
import { runnerInspectResultSchema, type RunnerInspectResult } from '../runner/project-schemas.js';
import { computeRescanDiff } from '../projects/diff.js';
import { normalizeRepositoryIdentity } from '../projects/repo-identity.js';
import {
  InspectionUnusableError,
  addRule,
  addUserCommand,
  addUserTechnology,
  applyRescan,
  archiveProject,
  createProjectFromInspection,
  deleteRule,
  deleteUserCommand,
  deleteUserTechnology,
  getInspectionForViewing,
  getProjectFull,
  getProjectRow,
  insertInspection,
  listCommands,
  listProjectActivity,
  listProjects,
  listRules,
  listTechnologies,
  reactivateProject,
  updateCommand,
  updateProjectCore,
  updateRule,
} from '../projects/store.js';
import { toProjectCommand, toProjectDetail, toProjectRule, toProjectSummary, toProjectTechnology } from '../projects/mapping.js';
import type { ProjectInspectionRow } from '../projects/types.js';

const PATH_REASON_MESSAGES: Record<string, string> = {
  no_allowed_roots_configured: 'No project roots have been configured on the server yet. Contact an administrator.',
  malformed_path: 'The path is malformed.',
  not_absolute: 'The path must be an absolute path (it must start with "/").',
  traversal_rejected: 'The path must not contain ".." segments.',
  not_found: 'The path does not exist, or this server cannot access it.',
  not_a_directory: 'The path exists but is not a directory.',
  is_allowed_root: 'This is an allowed root itself, not a project inside it.',
  outside_allowed_roots: 'The path is not inside any allowed project root.',
  invalid_path: 'The path could not be validated.',
};

function pathRejectionMessage(reason: string): string {
  return PATH_REASON_MESSAGES[reason] ?? PATH_REASON_MESSAGES['invalid_path']!;
}

function parseBody<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const fields = (parsed.error?.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError('validation_failed', 'Request body failed validation.', { fields });
  }
  return parsed.data as T;
}

function parseQuery<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, query: unknown): T {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    const fields = (parsed.error?.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError('validation_failed', 'Query parameters failed validation.', { fields });
  }
  return parsed.data as T;
}

function projectIdParam(request: FastifyRequest): string {
  const { id } = request.params as { id: string };
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) throw badRequest('Project id must be a UUID.');
  return parsed.data;
}

async function requireProject(ctx: AppContext, id: string) {
  const project = await getProjectRow(ctx.db, id);
  if (!project) throw notFound('Project not found.');
  return project;
}

function requireNotArchived(project: { status: string }): void {
  if (project.status === 'archived') {
    throw new AppError('conflict', 'This project is archived. Reactivate it before making changes.');
  }
}

export const projectRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const requireAuth = createRequireAuth(ctx);
    const requireWriter = [requireAuth, requireRole('admin', 'operator')];

    // ---------------------------------------------------------------------
    // Inspection
    // ---------------------------------------------------------------------

    app.post('/api/projects/inspections', { preHandler: requireWriter }, async (request, reply) => {
      const body = parseBody(inspectProjectRequestSchema, request.body);
      const userId = request.auth!.user.id;
      const requestId = randomUUID();

      let invokeResult;
      try {
        invokeResult = await ctx.runner.invoke('project.inspect', { path: body.path }, requestId);
      } catch (error) {
        await ctx.audit.record({
          eventType: 'project.inspection.rejected',
          outcome: 'error',
          actorUserId: userId,
          requestId: request.id,
          detail: { reason: 'runner_unavailable' },
        });
        if (error instanceof RunnerUnavailableError) {
          throw new AppError('service_unavailable', 'The host runner is unavailable; cannot inspect the folder right now.');
        }
        throw error;
      }

      if (!invokeResult.ok) {
        await ctx.audit.record({
          eventType: 'project.inspection.rejected',
          outcome: 'error',
          actorUserId: userId,
          requestId: request.id,
          detail: { reason: invokeResult.error?.code ?? 'unknown' },
        });
        throw new AppError('bad_request', invokeResult.error?.message ?? 'The folder could not be inspected.');
      }

      const parsed = runnerInspectResultSchema.safeParse(invokeResult.result);
      if (!parsed.success) {
        await ctx.audit.record({
          eventType: 'project.inspection.rejected',
          outcome: 'error',
          actorUserId: userId,
          requestId: request.id,
          detail: { reason: 'malformed_runner_response' },
        });
        throw new AppError('internal_error', 'The runner returned an unexpected response shape.');
      }

      const result = parsed.data;
      if (!result.valid) {
        await ctx.audit.record({
          eventType: 'project.inspection.rejected',
          outcome: 'denied',
          actorUserId: userId,
          requestId: request.id,
          detail: { reason: result.reason },
        });
        throw badRequest(pathRejectionMessage(result.reason));
      }

      const inspection = await insertInspection(ctx.db, {
        createdBy: userId,
        projectId: null,
        inputPath: body.path,
        canonicalPath: result.canonicalPath,
        allowedRoot: result.allowedRoot,
        result,
        scanVersion: result.scanVersion,
      });

      await ctx.audit.record({
        eventType: 'project.inspection.started',
        outcome: 'success',
        actorUserId: userId,
        requestId: request.id,
        detail: { inspectionId: inspection.id, technologyCount: result.technologies.length },
      });

      const body_: ProjectInspectionResponse = toInspectionResponse(inspection);
      return reply.code(201).send(body_);
    });

    app.get('/api/projects/inspections/:id', { preHandler: requireAuth }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsedId = uuidSchema.safeParse(id);
      if (!parsedId.success) throw badRequest('Inspection id must be a UUID.');

      const inspection = await getInspectionForViewing(ctx.db, parsedId.data, request.auth!.user.id);
      if (!inspection) throw notFound('Inspection not found.');

      return reply.code(200).send(toInspectionResponse(inspection));
    });

    // ---------------------------------------------------------------------
    // Create / list / detail / update
    // ---------------------------------------------------------------------

    app.post('/api/projects', { preHandler: requireWriter }, async (request, reply) => {
      const body = parseBody(createProjectRequestSchema, request.body);
      const userId = request.auth!.user.id;

      let created;
      try {
        created = await createProjectFromInspection(ctx.db, { inspectionId: body.inspectionId, userId, request: body });
      } catch (error) {
        if (error instanceof InspectionUnusableError) {
          await ctx.audit.record({
            eventType: 'project.created',
            outcome: 'denied',
            actorUserId: userId,
            requestId: request.id,
            detail: { reason: 'inspection_unusable' },
          });
          throw notFound('Inspection not found, expired, already used, or owned by another user.');
        }
        throw error;
      }

      await ctx.audit.record({
        eventType: 'project.created',
        outcome: 'success',
        actorUserId: userId,
        requestId: request.id,
        detail: { projectId: created.project.id, name: created.project.name },
      });
      await ctx.timeline.record({
        projectId: created.project.id,
        entityType: 'project',
        entityId: created.project.id,
        eventType: 'project.created',
        summary: `Project registered: "${created.project.name.slice(0, 100)}"`,
        actorUserId: userId,
        actorKind: 'user',
      });

      const responseBody: ProjectResponse = {
        project: toProjectDetail(created.project, created.technologies, created.rules, created.commands),
      };
      return reply.code(201).send(responseBody);
    });

    app.get('/api/projects', { preHandler: requireAuth }, async (request, reply) => {
      const query = parseQuery(listProjectsQuerySchema, request.query);
      const { rows, total } = await listProjects(ctx.db, query);

      const responseBody: ListProjectsResponse = {
        projects: rows.map((r) => toProjectSummary(r, r.technologies)),
        page: query.page,
        pageSize: query.pageSize,
        total,
      };
      return reply.code(200).send(responseBody);
    });

    app.get('/api/projects/:id', { preHandler: requireAuth }, async (request, reply) => {
      const id = projectIdParam(request);
      const full = await getProjectFull(ctx.db, id);
      if (!full) throw notFound('Project not found.');

      const responseBody: ProjectResponse = {
        project: toProjectDetail(full.project, full.technologies, full.rules, full.commands),
      };
      return reply.code(200).send(responseBody);
    });

    app.patch('/api/projects/:id', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const existing = await requireProject(ctx, id);
      requireNotArchived(existing);

      const body = parseBody(updateProjectRequestSchema, request.body);
      await updateProjectCore(ctx.db, id, body);

      await ctx.audit.record({
        eventType: 'project.updated',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, fields: Object.keys(body) },
      });

      const full = await getProjectFull(ctx.db, id);
      const responseBody: ProjectResponse = { project: toProjectDetail(full!.project, full!.technologies, full!.rules, full!.commands) };
      return reply.code(200).send(responseBody);
    });

    // ---------------------------------------------------------------------
    // Archive / reactivate
    // ---------------------------------------------------------------------

    app.post('/api/projects/:id/archive', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await archiveProject(ctx.db, id);

      await ctx.audit.record({
        eventType: 'project.archived',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id },
      });
      await ctx.timeline.record({
        projectId: id, entityType: 'project', entityId: id, eventType: 'project.archived',
        summary: `Project archived: "${project.name.slice(0, 100)}"`,
        actorUserId: request.auth!.user.id, actorKind: 'user',
      });

      const [technologies, rules, commands] = await Promise.all([
        listTechnologies(ctx.db, id),
        listRules(ctx.db, id),
        listCommands(ctx.db, id),
      ]);
      const responseBody: ProjectResponse = { project: toProjectDetail(project, technologies, rules, commands) };
      return reply.code(200).send(responseBody);
    });

    app.post('/api/projects/:id/reactivate', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await reactivateProject(ctx.db, id);

      await ctx.audit.record({
        eventType: 'project.reactivated',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id },
      });
      await ctx.timeline.record({
        projectId: id, entityType: 'project', entityId: id, eventType: 'project.reactivated',
        summary: `Project reactivated: "${project.name.slice(0, 100)}"`,
        actorUserId: request.auth!.user.id, actorKind: 'user',
      });

      const [technologies, rules, commands] = await Promise.all([
        listTechnologies(ctx.db, id),
        listRules(ctx.db, id),
        listCommands(ctx.db, id),
      ]);
      const responseBody: ProjectResponse = { project: toProjectDetail(project, technologies, rules, commands) };
      return reply.code(200).send(responseBody);
    });

    // ---------------------------------------------------------------------
    // Activity
    // ---------------------------------------------------------------------

    app.get('/api/projects/:id/activity', { preHandler: requireAuth }, async (request, reply) => {
      const id = projectIdParam(request);
      await requireProject(ctx, id);
      const rows = await listProjectActivity(ctx.db, id);

      const responseBody: ProjectActivityResponse = {
        entries: rows.map((r) => ({
          id: r.id,
          occurredAt: r.occurred_at.toISOString(),
          eventType: r.event_type,
          outcome: r.outcome,
          actorUserId: r.actor_user_id,
          detail: r.detail,
        })),
      };
      return reply.code(200).send(responseBody);
    });

    // ---------------------------------------------------------------------
    // Rules
    // ---------------------------------------------------------------------

    app.post('/api/projects/:id/rules', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const body = parseBody(createProjectRuleRequestSchema, request.body);

      const rule = await addRule(ctx.db, id, body);
      await ctx.audit.record({
        eventType: 'project.rule.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'created', ruleId: rule.id, category: rule.category },
      });

      const responseBody: ProjectRuleResponse = { rule: toProjectRule(rule) };
      return reply.code(201).send(responseBody);
    });

    app.patch('/api/projects/:id/rules/:ruleId', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const { ruleId } = request.params as { ruleId: string };
      if (!uuidSchema.safeParse(ruleId).success) throw badRequest('Rule id must be a UUID.');
      const body = parseBody(updateProjectRuleRequestSchema, request.body);

      const rule = await updateRule(ctx.db, id, ruleId, body);
      await ctx.audit.record({
        eventType: 'project.rule.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'updated', ruleId },
      });

      const responseBody: ProjectRuleResponse = { rule: toProjectRule(rule) };
      return reply.code(200).send(responseBody);
    });

    app.delete('/api/projects/:id/rules/:ruleId', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const { ruleId } = request.params as { ruleId: string };
      if (!uuidSchema.safeParse(ruleId).success) throw badRequest('Rule id must be a UUID.');

      await deleteRule(ctx.db, id, ruleId);
      await ctx.audit.record({
        eventType: 'project.rule.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'deleted', ruleId },
      });

      return reply.code(200).send({ deleted: true } satisfies z.infer<typeof deletedResponseSchema>);
    });

    // ---------------------------------------------------------------------
    // Technologies (operator-managed additions/removals only)
    // ---------------------------------------------------------------------

    app.post('/api/projects/:id/technologies', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const body = parseBody(createProjectTechnologyRequestSchema, request.body);

      const technology = await addUserTechnology(ctx.db, id, { ...body, version: body.version ?? null });
      await ctx.audit.record({
        eventType: 'project.technology.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'created', name: technology.name, category: technology.category },
      });

      const responseBody: ProjectTechnologyResponse = { technology: toProjectTechnology(technology) };
      return reply.code(201).send(responseBody);
    });

    app.delete('/api/projects/:id/technologies/:technologyId', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const { technologyId } = request.params as { technologyId: string };
      if (!uuidSchema.safeParse(technologyId).success) throw badRequest('Technology id must be a UUID.');

      await deleteUserTechnology(ctx.db, id, technologyId);
      await ctx.audit.record({
        eventType: 'project.technology.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'deleted', technologyId },
      });

      return reply.code(200).send({ deleted: true } satisfies z.infer<typeof deletedResponseSchema>);
    });

    // ---------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------

    app.post('/api/projects/:id/commands', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const body = parseBody(createProjectCommandRequestSchema, request.body);

      const command = await addUserCommand(ctx.db, id, {
        type: body.type,
        displayName: body.displayName,
        commandText: body.commandText,
        workingDirectory: body.workingDirectory ?? '.',
      });
      await ctx.audit.record({
        eventType: 'project.command.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'created', type: command.type },
      });

      const responseBody: ProjectCommandResponse = { command: toProjectCommand(command) };
      return reply.code(201).send(responseBody);
    });

    app.patch('/api/projects/:id/commands/:commandId', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const { commandId } = request.params as { commandId: string };
      if (!uuidSchema.safeParse(commandId).success) throw badRequest('Command id must be a UUID.');
      const body = parseBody(updateProjectCommandRequestSchema, request.body);

      const command = await updateCommand(ctx.db, id, commandId, body);
      await ctx.audit.record({
        eventType: 'project.command.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'updated', commandId },
      });

      const responseBody: ProjectCommandResponse = { command: toProjectCommand(command) };
      return reply.code(200).send(responseBody);
    });

    app.delete('/api/projects/:id/commands/:commandId', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const { commandId } = request.params as { commandId: string };
      if (!uuidSchema.safeParse(commandId).success) throw badRequest('Command id must be a UUID.');

      await deleteUserCommand(ctx.db, id, commandId);
      await ctx.audit.record({
        eventType: 'project.command.changed',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        detail: { projectId: id, action: 'deleted', commandId },
      });

      return reply.code(200).send({ deleted: true } satisfies z.infer<typeof deletedResponseSchema>);
    });

    // ---------------------------------------------------------------------
    // Rescan / diff / apply
    // ---------------------------------------------------------------------

    app.post('/api/projects/:id/rescan', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const userId = request.auth!.user.id;

      let invokeResult;
      try {
        invokeResult = await ctx.runner.invoke('project.inspect', { path: project.location_canonical_path }, randomUUID());
      } catch (error) {
        if (error instanceof RunnerUnavailableError) {
          throw new AppError('service_unavailable', 'The host runner is unavailable; cannot rescan right now.');
        }
        throw error;
      }
      if (!invokeResult.ok) {
        throw new AppError('bad_request', invokeResult.error?.message ?? 'The folder could not be rescanned.');
      }
      const parsed = runnerInspectResultSchema.safeParse(invokeResult.result);
      if (!parsed.success) throw new AppError('internal_error', 'The runner returned an unexpected response shape.');
      const result = parsed.data;

      const inspection = await insertInspection(ctx.db, {
        createdBy: userId,
        projectId: id,
        inputPath: project.location_input_path,
        canonicalPath: result.valid ? result.canonicalPath : project.location_canonical_path,
        allowedRoot: result.valid ? result.allowedRoot : project.location_allowed_root,
        result,
        scanVersion: result.valid ? result.scanVersion : 'n/a',
      });

      const [currentTechnologies, currentCommands] = await Promise.all([listTechnologies(ctx.db, id), listCommands(ctx.db, id)]);
      const { diff, requiresConfirmation } = computeRescanDiff(project, currentTechnologies, currentCommands, result);

      await ctx.audit.record({
        eventType: 'project.rescanned',
        outcome: 'success',
        actorUserId: userId,
        requestId: request.id,
        detail: { projectId: id, inspectionId: inspection.id, changeCount: diff.length, requiresConfirmation },
      });

      const responseBody: RescanProjectResponse = {
        inspectionId: inspection.id,
        expiresAt: inspection.expires_at.toISOString(),
        diff,
        warnings: result.valid ? result.warnings : [],
        requiresConfirmation,
      };
      return reply.code(201).send(responseBody);
    });

    app.post('/api/projects/:id/rescan/apply', { preHandler: requireWriter }, async (request, reply) => {
      const id = projectIdParam(request);
      const project = await requireProject(ctx, id);
      requireNotArchived(project);
      const userId = request.auth!.user.id;
      const body = parseBody(applyRescanRequestSchema, request.body);

      const inspection = await getInspectionForViewing(ctx.db, body.inspectionId, userId);
      if (!inspection || inspection.project_id !== id || inspection.status !== 'pending' || inspection.expires_at.getTime() < Date.now()) {
        throw notFound('Inspection not found, expired, already used, or owned by another user.');
      }

      const result = inspection.result as unknown as RunnerInspectResult;
      const [currentTechnologies, currentCommands] = await Promise.all([listTechnologies(ctx.db, id), listCommands(ctx.db, id)]);
      const { diff, requiresConfirmation } = computeRescanDiff(project, currentTechnologies, currentCommands, result);

      if (requiresConfirmation && !body.confirmRepositoryIdentityChange) {
        throw new AppError(
          'conflict',
          'The repository identity has changed since this project was registered. Set confirmRepositoryIdentityChange to apply this rescan.',
        );
      }

      const repoFields = diff.filter((d) => d.field.startsWith('repository.'));
      const applyRepositoryFields =
        repoFields.length === 0 || !body.acceptedFields || body.acceptedFields.length === 0
          ? true
          : repoFields.some((d) => body.acceptedFields!.includes(d.field));

      let applied;
      try {
        applied = await applyRescan(ctx.db, { inspectionId: inspection.id, userId, projectId: id, applyRepositoryFields });
      } catch (error) {
        if (error instanceof InspectionUnusableError) throw notFound('Inspection not found, expired, or already used.');
        throw error;
      }

      await ctx.audit.record({
        eventType: 'project.rescan.diff_applied',
        outcome: 'success',
        actorUserId: userId,
        requestId: request.id,
        detail: { projectId: id, inspectionId: inspection.id, appliedRepositoryFields: applyRepositoryFields, changeCount: diff.length },
      });

      const appliedFields = diff
        .filter(
          (d) =>
            d.field === 'location.accessible' ||
            d.changeType === 'technology_added' ||
            d.changeType === 'technology_removed' ||
            d.changeType === 'command_added' ||
            d.changeType === 'command_removed' ||
            (applyRepositoryFields && d.field.startsWith('repository.')),
        )
        .map((d) => d.field);

      const responseBody: ApplyRescanResponse = {
        project: toProjectDetail(applied.project, applied.technologies, applied.rules, applied.commands),
        applied: appliedFields,
      };
      return reply.code(200).send(responseBody);
    });
  };

function toInspectionResponse(row: ProjectInspectionRow): ProjectInspectionResponse {
  const result = row.result as unknown as RunnerInspectResult;
  if (!result.valid) {
    // Invalid results are only ever persisted for a rescan (see the rescan
    // route); viewing one directly is not a supported flow.
    throw new AppError('conflict', 'This inspection could not resolve the project folder; see the rescan diff instead.');
  }
  const identity = result.git ? normalizeRepositoryIdentity(result.git.remotes) : null;

  return {
    inspectionId: row.id,
    expiresAt: row.expires_at.toISOString(),
    scanVersion: row.scan_version,
    location: {
      inputPath: row.input_path,
      canonicalPath: row.canonical_path,
      allowedRoot: row.allowed_root,
      accessible: true,
      checkedAt: row.created_at.toISOString(),
    },
    repository: {
      present: Boolean(result.git?.present),
      topLevelPath: result.git?.topLevelPath || null,
      remotes: result.git?.remotes ?? [],
      normalizedIdentity: identity,
      activeBranch: result.git?.detached ? null : result.git?.activeBranch || null,
      defaultBranch: result.git?.defaultBranch || null,
      defaultBranchConfidence: (result.git?.defaultBranchConfidence as 'known' | 'inferred' | 'unknown' | undefined) || null,
      lastCommitHash: result.git?.lastCommitHash || null,
      lastCommitShortHash: result.git?.lastCommitShortHash || null,
      lastCommitAt: result.git?.lastCommitAt || null,
      lastCommitSubject: result.git?.lastCommitSubject || null,
      isDirty: result.git ? result.git.isDirty : null,
      modifiedCount: result.git ? result.git.modifiedCount : null,
      untrackedCount: result.git ? result.git.untrackedCount : null,
      scannedAt: row.created_at.toISOString(),
    },
    technologies: result.technologies.map((t) => ({
      name: t.name,
      category: t.category as ProjectInspectionResponse['technologies'][number]['category'],
      version: t.version || null,
      evidencePath: t.evidencePath || null,
    })),
    commands: result.commands.map((c) => ({
      type: c.type as ProjectInspectionResponse['commands'][number]['type'],
      displayName: c.displayName,
      commandText: c.commandText,
      workingDirectory: c.workingDirectory,
      evidencePath: c.evidencePath || null,
    })),
    manifests: result.manifests,
    warnings: result.warnings,
    limitsHit: result.limitsHit,
  };
}
