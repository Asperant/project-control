import { z } from 'zod';
import { readSecretFile } from './secrets.js';

/**
 * Configuration loading.
 *
 * Two rules govern this file:
 *
 *  1. Secrets are read from *files*, never from environment variables. The
 *     environment of a process is readable via `/proc/<pid>/environ` and leaks
 *     into `docker inspect`, crash dumps and child processes; a 0600 file that
 *     is bind-mounted read-only does not. Every secret therefore has a
 *     `*_FILE` variable holding a path.
 *
 *  2. Configuration is validated once at boot and the process refuses to start
 *     if anything is missing or malformed. A half-configured API that starts and
 *     fails later is worse than one that never starts.
 */

const booleanish = z
  .string()
  .transform((v) => v.trim().toLowerCase())
  .pipe(z.enum(['true', 'false', '1', '0', 'yes', 'no']))
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['production', 'development', 'test']).default('production'),
  PC_STACK_VERSION: z.string().default('0.0.0-dev'),

  // --- HTTP ---------------------------------------------------------------
  // Binds inside the container network only; no host port is ever published.
  PC_API_HOST: z.string().default('0.0.0.0'),
  PC_API_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Max request body. Enforced by Fastify and independently by Caddy. */
  PC_API_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),

  // --- PostgreSQL ---------------------------------------------------------
  PC_PG_HOST: z.string().default('postgres'),
  PC_PG_PORT: z.coerce.number().int().min(1).max(65535).default(5432),
  PC_PG_DATABASE: z.string().default('project_control'),
  PC_PG_USER: z.string().default('control_app'),
  PC_PG_PASSWORD_FILE: z.string(),
  PC_PG_POOL_MAX: z.coerce.number().int().positive().max(50).default(10),
  PC_PG_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  // --- Sessions -----------------------------------------------------------
  PC_SESSION_SECRET_FILE: z.string(),
  PC_SESSION_COOKIE_NAME: z.string().default('pc_session'),
  /** Absolute lifetime: the session dies at this age regardless of activity. */
  PC_SESSION_ABSOLUTE_TTL_SECONDS: z.coerce.number().int().positive().default(43_200),
  /** Idle lifetime: the session dies after this much inactivity. */
  PC_SESSION_IDLE_TTL_SECONDS: z.coerce.number().int().positive().default(3_600),
  /**
   * `Secure` on the session cookie. True in every real deployment because the
   * browser always reaches the portal over Tailscale HTTPS. Only test harnesses
   * turn it off.
   */
  PC_SESSION_COOKIE_SECURE: booleanish.default(true),

  // --- Login throttling ---------------------------------------------------
  PC_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  PC_LOGIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(300),
  /** Consecutive failures before an individual account is temporarily locked. */
  PC_LOGIN_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(10),
  PC_LOGIN_LOCKOUT_SECONDS: z.coerce.number().int().positive().default(900),

  // --- Artifact store -----------------------------------------------------
  PC_ARTIFACT_ROOT: z.string().default('/data/artifacts'),
  PC_ARTIFACT_MAX_BYTES: z.coerce.number().int().positive().default(268_435_456),

  // --- Runner -------------------------------------------------------------
  PC_RUNNER_SOCKET: z.string().default('/run/project-control/runner.sock'),
  PC_RUNNER_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  // --- Observability ------------------------------------------------------
  PC_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  // --- External component hints (status dashboard only) -------------------
  PC_N8N_HEALTH_URL: z.string().default('http://n8n:5678/healthz'),
  PC_TAILSCALE_STATUS_FILE: z.string().default('/config/tailscale-status.json'),
  PC_BACKUP_STATUS_FILE: z.string().default('/config/backup-status.json'),
  PC_VERIFICATION_STATUS_FILE: z.string().default('/config/verification.json'),

  // --- Automation -----------------------------------------------------------
  PC_AUTOMATION_MANIFEST_FILE: z.string().default('/config/automation/manifest.json'),
});

export type AppConfig = Readonly<{
  env: 'production' | 'development' | 'test';
  stackVersion: string;
  http: { host: string; port: number; bodyLimitBytes: number };
  pg: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    poolMax: number;
    statementTimeoutMs: number;
  };
  session: {
    secret: string;
    cookieName: string;
    absoluteTtlSeconds: number;
    idleTtlSeconds: number;
    cookieSecure: boolean;
  };
  login: {
    rateLimitMax: number;
    rateLimitWindowSeconds: number;
    lockoutThreshold: number;
    lockoutSeconds: number;
  };
  artifacts: { root: string; maxBytes: number };
  runner: { socketPath: string; timeoutMs: number };
  logLevel: string;
  components: {
    n8nHealthUrl: string;
    tailscaleStatusFile: string;
    backupStatusFile: string;
    verificationStatusFile: string;
  };
  automation: { manifestFile: string };
}>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid Control API configuration:\n${issues}`);
  }
  const e = parsed.data;

  const sessionSecret = readSecretFile(e.PC_SESSION_SECRET_FILE, 'session signing secret');
  if (sessionSecret.length < 32) {
    throw new Error('Session signing secret must be at least 32 characters.');
  }

  return Object.freeze({
    env: e.NODE_ENV,
    stackVersion: e.PC_STACK_VERSION,
    http: {
      host: e.PC_API_HOST,
      port: e.PC_API_PORT,
      bodyLimitBytes: e.PC_API_BODY_LIMIT_BYTES,
    },
    pg: {
      host: e.PC_PG_HOST,
      port: e.PC_PG_PORT,
      database: e.PC_PG_DATABASE,
      user: e.PC_PG_USER,
      password: readSecretFile(e.PC_PG_PASSWORD_FILE, 'PostgreSQL password'),
      poolMax: e.PC_PG_POOL_MAX,
      statementTimeoutMs: e.PC_PG_STATEMENT_TIMEOUT_MS,
    },
    session: {
      secret: sessionSecret,
      cookieName: e.PC_SESSION_COOKIE_NAME,
      absoluteTtlSeconds: e.PC_SESSION_ABSOLUTE_TTL_SECONDS,
      idleTtlSeconds: e.PC_SESSION_IDLE_TTL_SECONDS,
      cookieSecure: e.PC_SESSION_COOKIE_SECURE,
    },
    login: {
      rateLimitMax: e.PC_LOGIN_RATE_LIMIT_MAX,
      rateLimitWindowSeconds: e.PC_LOGIN_RATE_LIMIT_WINDOW_SECONDS,
      lockoutThreshold: e.PC_LOGIN_LOCKOUT_THRESHOLD,
      lockoutSeconds: e.PC_LOGIN_LOCKOUT_SECONDS,
    },
    artifacts: { root: e.PC_ARTIFACT_ROOT, maxBytes: e.PC_ARTIFACT_MAX_BYTES },
    runner: { socketPath: e.PC_RUNNER_SOCKET, timeoutMs: e.PC_RUNNER_TIMEOUT_MS },
    logLevel: e.PC_LOG_LEVEL,
    components: {
      n8nHealthUrl: e.PC_N8N_HEALTH_URL,
      tailscaleStatusFile: e.PC_TAILSCALE_STATUS_FILE,
      backupStatusFile: e.PC_BACKUP_STATUS_FILE,
      verificationStatusFile: e.PC_VERIFICATION_STATUS_FILE,
    },
    automation: { manifestFile: e.PC_AUTOMATION_MANIFEST_FILE },
  });
}
