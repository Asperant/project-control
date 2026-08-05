import type { FastifyPluginAsync } from 'fastify';
import type { LivenessResponse, ReadinessResponse } from '@project-control/contracts';
import type { AppContext } from '../context.js';

/**
 * Liveness and readiness.
 *
 * These are the only unauthenticated routes in the API. They are reachable from
 * the container network (Docker's healthcheck runs inside the container) but not
 * from the host or the tailnet — Caddy does not proxy `/health/*`.
 *
 * The split matters for restart behaviour:
 *   /health/live   process is running. Never touches PostgreSQL, so a database
 *                  outage does not make Docker kill and restart the API, which
 *                  would only add churn to an already-degraded system.
 *   /health/ready  the API can actually serve requests. Goes red when a hard
 *                  dependency is down, so the proxy stops sending traffic.
 */
export const healthRoutes =
  (ctx: AppContext): FastifyPluginAsync =>
  async (app) => {
    const startedAt = Date.now();

    app.get('/health/live', async (_request, reply) => {
      const body: LivenessResponse = {
        status: 'live',
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      };
      return reply.code(200).send(body);
    });

    app.get('/health/ready', async (_request, reply) => {
      const checks: ReadinessResponse['checks'] = [];

      // --- PostgreSQL: hard dependency -------------------------------------
      try {
        const started = Date.now();
        await ctx.db.query('SELECT 1');
        checks.push({
          name: 'postgres',
          ok: true,
          detail: `Responded in ${Date.now() - started} ms.`,
        });
      } catch (error) {
        ctx.logger.warn({ err: error }, 'readiness: postgres probe failed');
        checks.push({
          name: 'postgres',
          ok: false,
          detail: 'Database is not reachable.',
        });
      }

      // --- Schema: hard dependency -----------------------------------------
      try {
        const { rows } = await ctx.db.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM schema_migrations',
        );
        const count = rows[0]?.count ?? 0;
        checks.push({
          name: 'schema',
          ok: count > 0,
          detail: count > 0 ? `${count} migration(s) applied.` : 'No migrations applied.',
        });
      } catch {
        checks.push({ name: 'schema', ok: false, detail: 'Migration ledger unreadable.' });
      }

      // --- Artifact store: hard dependency ---------------------------------
      const storeHealth = await ctx.artifactStore.health();
      checks.push({ name: 'artifact_store', ok: storeHealth.ok, detail: storeHealth.detail });

      const ready = checks.every((c) => c.ok);
      const body: ReadinessResponse = { status: ready ? 'ready' : 'not_ready', checks };
      return reply.code(ready ? 200 : 503).send(body);
    });
  };
