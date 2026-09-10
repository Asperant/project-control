import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { timelineListQuerySchema, uuidSchema } from '@project-control/contracts';
import type { AppContext } from '../context.js';
import { AppError, badRequest } from '../errors.js';
import { createRequireAuth } from '../auth/middleware.js';
import { listGlobalTimeline, listProjectTimeline } from '../timeline.js';

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Request query failed validation.', {
      fields: (result.error?.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data as T;
}
function projectIdParam(request: FastifyRequest): string {
  const { projectId } = request.params as { projectId: string };
  if (!uuidSchema.safeParse(projectId).success) throw badRequest('projectId must be a UUID.');
  return projectId;
}

/**
 * Read-only activity feeds over `timeline_events` — see timeline.ts's module
 * doc. Authenticated-only, same access level as every other read in this API
 * (no per-project ACL exists anywhere yet — see the search/timeline/navigation
 * plan's own scope note).
 */
export const timelineRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);

  app.get('/api/projects/:projectId/timeline', { preHandler: requireAuth }, async (request, reply) => {
    const projectId = projectIdParam(request);
    const query = parse(timelineListQuerySchema, request.query);
    return reply.send(await listProjectTimeline(ctx.db, projectId, query));
  });

  app.get('/api/timeline', { preHandler: requireAuth }, async (request, reply) => {
    const query = parse(timelineListQuerySchema, request.query);
    return reply.send(await listGlobalTimeline(ctx.db, query));
  });
};
