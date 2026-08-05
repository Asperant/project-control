import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import type { Logger } from './logger.js';
import type { AuditLog } from './audit.js';
import type { SessionStore, AuthenticatedUser, SessionRecord } from './auth/session-store.js';
import type { RunnerClient } from './runner/client.js';
import type { FilesystemArtifactStore } from './storage/filesystem-store.js';

/**
 * Everything a route needs, passed explicitly rather than reached for through a
 * module-level singleton. This is what makes the integration tests able to build
 * a fully real app against a throwaway database without any mocking framework.
 */
export type AppContext = {
  config: AppConfig;
  db: Db;
  logger: Logger;
  audit: AuditLog;
  sessions: SessionStore;
  artifactStore: FilesystemArtifactStore;
  runner: RunnerClient;
};

/** Attached to the request by `requireAuth` once the session is verified. */
declare module 'fastify' {
  interface FastifyRequest {
    auth?: {
      user: AuthenticatedUser;
      session: SessionRecord;
    };
  }
}
