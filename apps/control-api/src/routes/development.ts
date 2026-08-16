import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { uuidSchema } from '@project-control/contracts';
import type { AppContext } from '../context.js';
import { createRequireAuth } from '../auth/middleware.js';
import { badRequest } from '../errors.js';
import { getProjectDevelopment } from '../development/service.js';

function projectId(request: FastifyRequest): string {
  const value = (request.params as { projectId: string }).projectId;
  if (!uuidSchema.safeParse(value).success) throw badRequest('projectId must be a UUID.');
  return value;
}

/** Read-only by construction: this module registers no mutation route. */
export const developmentRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);
  app.get('/api/projects/:projectId/development', { preHandler: requireAuth }, async (request, reply) =>
    reply.send(await getProjectDevelopment(ctx.db, ctx.runner, projectId(request), String(request.id))),
  );
};
