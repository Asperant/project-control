import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { searchQuerySchema } from '@project-control/contracts';
import type { AppContext } from '../context.js';
import { AppError } from '../errors.js';
import { createRequireAuth } from '../auth/middleware.js';
import { search } from '../search/store.js';

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: z.ZodError } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError('validation_failed', 'Request query failed validation.', {
      fields: (result.error?.issues ?? []).map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data as T;
}

/**
 * Full-text search over existing content — see search/store.ts. Same access
 * level as every other read (authenticated only); a search result never
 * exposes anything its own entity endpoint wouldn't already show the caller.
 */
export const searchRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);

  app.get('/api/search', { preHandler: requireAuth }, async (request, reply) => {
    const query = parse(searchQuerySchema, request.query);
    return reply.send(await search(ctx.db, query));
  });
};
