import type { AutomationManifest, ServiceScope } from '@project-control/contracts';
import type { AppConfig } from './config.js';
import type { Db } from './db/pool.js';
import type { Logger } from './logger.js';
import type { AuditLog } from './audit.js';
import type { TimelineLog } from './timeline.js';
import type { SessionStore, AuthenticatedUser, SessionRecord } from './auth/session-store.js';
import type { ServiceTokenStore } from './auth/service-token-store.js';
import type { AutomationStore } from './automation/store.js';
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
  timeline: TimelineLog;
  sessions: SessionStore;
  serviceTokens: ServiceTokenStore;
  automation: AutomationStore;
  /** Loaded and validated once at boot — see automation/manifest.ts. Never
   * re-read per request; a manifest change requires a redeploy. */
  automationManifest: AutomationManifest;
  artifactStore: FilesystemArtifactStore;
  runner: RunnerClient;
};

/**
 * A resolved caller: either a human behind a session cookie, or a machine
 * behind a scoped Bearer token. `requirePrincipalKind`/`requireScope` in
 * auth/middleware.ts gate on this — see its module doc for why the two kinds
 * are never conflated into one role system.
 */
export type Principal =
  | { kind: 'user'; user: AuthenticatedUser; session: SessionRecord }
  | { kind: 'service'; account: { id: string; key: string }; token: { id: string; scopes: ServiceScope[] } };

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `requireAuth` for a cookie-authenticated request. Every existing
     * route keeps reading this unchanged. */
    auth?: {
      user: AuthenticatedUser;
      session: SessionRecord;
    };
    /** Set by `resolvePrincipal` for either kind of caller. New routes that
     * accept a machine caller read this instead of `auth`. */
    principal?: Principal;
  }
}
