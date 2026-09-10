import pg from 'pg';
import { buildApp } from './app.js';
import { AuditLog } from './audit.js';
import { TimelineLog } from './timeline.js';
import { SessionStore } from './auth/session-store.js';
import { ServiceTokenStore } from './auth/service-token-store.js';
import { SERVICE_ACCOUNT_REGISTRY } from './auth/service-accounts.js';
import { AutomationStore } from './automation/store.js';
import { loadManifest } from './automation/manifest.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { createLogger } from './logger.js';
import { RunnerClient } from './runner/client.js';
import { FilesystemArtifactStore } from './storage/filesystem-store.js';
import { purgeExpiredInspections } from './projects/store.js';
import type { AppContext } from './context.js';

/**
 * Process entrypoint.
 *
 * Boot order is deliberate: configuration (which fails loudly on a missing
 * secret) → storage skeleton → database → migrations → HTTP listener. The
 * listener is opened last so the readiness probe never observes a server that
 * is up but not migrated.
 */

const MIGRATIONS_DIR = process.env['PC_MIGRATIONS_DIR'] ?? '/app/migrations';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.env);

  logger.info(
    { version: config.stackVersion, env: config.env, node: process.version },
    'control-api starting',
  );

  const artifactStore = new FilesystemArtifactStore({
    root: config.artifacts.root,
    maxBytes: config.artifacts.maxBytes,
  });
  await artifactStore.initialise();

  // Fails loudly, before the listener opens, on a missing or malformed
  // manifest — the same "refuses to start rather than run half-configured"
  // rule config.ts's own header comment states.
  const automationManifest = loadManifest(config.automation.manifestFile);
  logger.info({ workflows: automationManifest.workflows.length }, 'automation manifest loaded');

  const db = createPool(config);

  // Migrations run with the dedicated migrator role on a separate, short-lived
  // connection. The runtime pool never holds DDL privileges, so a compromised
  // request handler cannot alter the schema.
  if (process.env['PC_RUN_MIGRATIONS_ON_BOOT'] !== 'false') {
    const migratorPasswordFile = process.env['PC_PG_MIGRATOR_PASSWORD_FILE'];
    const migratorUser = process.env['PC_PG_MIGRATOR_USER'] ?? 'control_migrator';

    if (!migratorPasswordFile) {
      logger.warn('PC_PG_MIGRATOR_PASSWORD_FILE is unset; skipping automatic migrations');
    } else {
      const { readFileSync } = await import('node:fs');
      const client = new pg.Client({
        host: config.pg.host,
        port: config.pg.port,
        database: config.pg.database,
        user: migratorUser,
        password: readFileSync(migratorPasswordFile, 'utf8').replace(/\r?\n$/, ''),
        application_name: 'control-api-migrator',
      });
      await client.connect();
      try {
        const result = await runMigrations(client, {
          migrationsDir: MIGRATIONS_DIR,
          onEvent: (e) => logger[e.level](e.message),
        });
        logger.info(
          { applied: result.applied.length, skipped: result.skipped.length },
          'migrations complete',
        );
      } finally {
        await client.end();
      }
    }
  }

  const ctx: AppContext = {
    config,
    db,
    logger,
    audit: new AuditLog(db, logger),
    timeline: new TimelineLog(db, logger),
    sessions: new SessionStore(db, config),
    serviceTokens: new ServiceTokenStore(db),
    automation: new AutomationStore(db, automationManifest),
    automationManifest,
    artifactStore,
    runner: new RunnerClient({
      socketPath: config.runner.socketPath,
      timeoutMs: config.runner.timeoutMs,
    }),
  };

  // Reconciles the compiled-in service account registry into the database —
  // code is the source of truth, the row is a cache of it. Never touches
  // `status`, so an operator-disabled account survives a redeploy. Blocking
  // startup on this is deliberate: it is cheap, and a service account that
  // silently fails to reconcile would make `create-service-token` fail later
  // with a much less obvious error.
  for (const definition of SERVICE_ACCOUNT_REGISTRY) {
    await ctx.serviceTokens.ensureAccount(definition);
  }

  const app = await buildApp(ctx);

  // Periodic housekeeping. Cheap, and it keeps the sessions table from growing
  // without bound on a long-lived deployment.
  const sweepTimer = setInterval(
    () => {
      void (async () => {
        try {
          const sessions = await ctx.sessions.purgeExpired();
          const staging = await artifactStore.sweepTemporary();
          const inspections = await purgeExpiredInspections(db);
          if (sessions > 0 || staging > 0 || inspections > 0) {
            logger.info({ sessions, staging, inspections }, 'housekeeping sweep');
          }
        } catch (error) {
          logger.warn({ err: error }, 'housekeeping sweep failed');
        }
      })();
    },
    30 * 60 * 1000,
  );
  sweepTimer.unref();

  await app.listen({ host: config.http.host, port: config.http.port });
  logger.info({ host: config.http.host, port: config.http.port }, 'control-api listening');

  // --- Graceful shutdown -----------------------------------------------------
  // SIGTERM is what `docker compose stop` sends. Draining in-flight requests
  // before closing the pool avoids spurious errors in the logs on every restart.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(sweepTimer);
    void (async () => {
      try {
        await app.close();
        await db.end();
        logger.info('shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'error during shutdown');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // A rejected promise that nobody handled means the process is in an unknown
  // state; log it and let the container restart policy do its job.
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled rejection');
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'uncaught exception');
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  // The logger may not exist yet if config loading threw, so this is the one
  // place a bare console write is correct.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`control-api failed to start: ${message}\n`);
  process.exit(1);
});
