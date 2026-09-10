import type { FastifyPluginAsync } from 'fastify';
import type { ServiceTokenListResponse, RevokeServiceTokenResponse } from '@project-control/contracts';
import { uuidSchema } from '@project-control/contracts';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import type { AppContext } from '../context.js';
import { badRequest, notFound } from '../errors.js';

/**
 * Service token administration: list and revoke, both human-only.
 *
 * Deliberately no create route here — a token is minted only by
 * `pcctl create-service-token`, at a host terminal, because the plaintext
 * exists exactly once and a browser response body is not a safe place for
 * it to exist even momentarily (response caching, dev-tools history,
 * screenshots). See docs/service-accounts.md.
 */
export const serviceTokenRoutes = (ctx: AppContext): FastifyPluginAsync => async (app) => {
  const requireAuth = createRequireAuth(ctx);
  const requireAdmin = [requireAuth, requireRole('admin')];

  app.get('/api/automation/service-tokens', { preHandler: requireAdmin }, async (_request, reply) => {
    const tokens = await ctx.serviceTokens.list();
    const body: ServiceTokenListResponse = { tokens };
    return reply.code(200).send(body);
  });

  app.post('/api/automation/service-tokens/:id/revoke', { preHandler: requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!uuidSchema.safeParse(id).success) throw badRequest('id must be a UUID.');

    const result = await ctx.serviceTokens.revoke(id);
    if (!result) throw notFound('No such service token.');

    if (!result.alreadyRevoked) {
      await ctx.audit.record({
        eventType: 'service.token_revoked',
        outcome: 'success',
        actorUserId: request.auth!.user.id,
        requestId: request.id,
        subject: `service_account:${result.summary.accountKey}`,
        detail: { tokenId: result.summary.id, prefix: result.summary.prefix },
      });
    }

    const body: RevokeServiceTokenResponse = { token: result.summary };
    return reply.code(200).send(body);
  });
};
