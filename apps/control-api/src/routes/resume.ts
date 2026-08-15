import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { uuidSchema } from '@project-control/contracts';
import type { AppContext } from '../context.js';
import { createRequireAuth } from '../auth/middleware.js';
import { badRequest } from '../errors.js';
import { getProjectResume } from '../resume/store.js';

function projectId(request: FastifyRequest): string {
  const value = (request.params as { projectId: string }).projectId;
  if (!uuidSchema.safeParse(value).success) throw badRequest('projectId must be a UUID.');
  return value;
}

export const resumeRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);
  app.get('/api/projects/:projectId/resume', { preHandler: requireAuth }, async (request, reply) =>
    reply.send(await getProjectResume(ctx.db, projectId(request))),
  );
};
