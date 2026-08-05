import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';

import { buildApp } from '../../src/app.js';
import { AuditLog } from '../../src/audit.js';
import { SessionStore } from '../../src/auth/session-store.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createLogger } from '../../src/logger.js';
import { RunnerClient } from '../../src/runner/client.js';
import { FilesystemArtifactStore } from '../../src/storage/filesystem-store.js';
import type { AppContext } from '../../src/context.js';

const exec = promisify(execFile);

/**
 * Integration harness.
 *
 * Starts a real, throwaway PostgreSQL container, runs the real migrations
 * against it, and builds the real Fastify app. Nothing is mocked — the point of
 * these tests is to catch the things a mock would paper over: SQL that does not
 * compile, grants that are wrong, cookie flags that Fastify silently drops.
 *
 * The container is disposable: random name, no published port on a fixed number,
 * tmpfs data directory, removed in teardown. It never touches a deployed stack.
 */

export type TestHarness = {
  app: Awaited<ReturnType<typeof buildApp>>;
  ctx: AppContext;
  config: AppConfig;
  artifactRoot: string;
  containerName: string;
  teardown: () => Promise<void>;
};

const CONTAINER_IMAGE =
  process.env['PC_TEST_POSTGRES_IMAGE'] ??
  'postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d';

async function waitForPostgres(containerName: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await exec('docker', ['exec', containerName, 'pg_isready', '-U', 'postgres', '-q']);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`PostgreSQL container ${containerName} did not become ready in ${timeoutMs} ms`);
}

/** True when Docker is usable, so suites can skip cleanly rather than fail. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await exec('docker', ['info'], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

export async function createHarness(): Promise<TestHarness> {
  const suffix = randomBytes(6).toString('hex');
  const containerName = `pc-test-pg-${suffix}`;
  const superuserPassword = randomBytes(24).toString('base64url');

  // --- 1. Throwaway PostgreSQL ------------------------------------------------
  // Port 0 lets the kernel assign a free port, so parallel runs never collide.
  const { stdout: portOut } = await exec('docker', [
    'run', '--detach',
    '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${superuserPassword}`,
    '--env', 'POSTGRES_USER=postgres',
    '--env', 'POSTGRES_DB=postgres',
    '--env', 'PGDATA=/tmp/pgdata',
    '--tmpfs', '/tmp:rw,size=512m',
    '--tmpfs', '/run/postgresql:rw,size=32m',
    '--user', '999:999',
    '--security-opt', 'no-new-privileges:true',
    '--cap-drop', 'ALL',
    '--label', 'com.project-control.test=true',
    CONTAINER_IMAGE,
    'postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off', '-c', 'synchronous_commit=off',
  ]);
  void portOut;

  const teardownContainer = async (): Promise<void> => {
    await exec('docker', ['rm', '-f', containerName]).catch(() => {});
  };

  try {
    await waitForPostgres(containerName);

    const { stdout: portMap } = await exec('docker', ['port', containerName, '5432/tcp']);
    const hostPort = Number(portMap.trim().split('\n')[0]?.split(':').pop());
    if (!Number.isInteger(hostPort)) throw new Error(`could not determine host port: ${portMap}`);

    // --- 2. Roles and databases, mirroring the production init script --------
    const superClient = new pg.Client({
      host: '127.0.0.1',
      port: hostPort,
      user: 'postgres',
      password: superuserPassword,
      database: 'postgres',
    });
    await superClient.connect();

    const appPassword = randomBytes(24).toString('base64url');
    const migratorPassword = randomBytes(24).toString('base64url');
    const n8nPassword = randomBytes(24).toString('base64url');
    const backupPassword = randomBytes(24).toString('base64url');

    // CREATE ROLE is a utility statement: PostgreSQL does not accept bind
    // parameters in it, so the password must be embedded as a literal. It is
    // escaped with the driver's own escapeLiteral rather than interpolated —
    // the production init script solves the same problem with psql's :'var'
    // quoting.
    const createRole = async (role: string, password: string): Promise<void> => {
      await superClient.query(
        `CREATE ROLE ${role} LOGIN PASSWORD ${superClient.escapeLiteral(password)} ` +
          `NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
      );
    };

    await createRole('control_app', appPassword);
    await createRole('control_migrator', migratorPassword);
    await createRole('n8n_app', n8nPassword);
    await createRole('backup_reader', backupPassword);

    await superClient.query('CREATE DATABASE project_control OWNER control_migrator');
    await superClient.query('CREATE DATABASE n8n OWNER n8n_app');

    await superClient.query('REVOKE ALL ON DATABASE project_control FROM PUBLIC');
    await superClient.query('REVOKE ALL ON DATABASE n8n FROM PUBLIC');
    await superClient.query(
      'GRANT CONNECT ON DATABASE project_control TO control_app, control_migrator, backup_reader',
    );
    await superClient.query('GRANT CONNECT ON DATABASE n8n TO n8n_app, backup_reader');
    await superClient.end();

    // Schema hardening, as the production init script does.
    const controlSuper = new pg.Client({
      host: '127.0.0.1', port: hostPort, user: 'postgres',
      password: superuserPassword, database: 'project_control',
    });
    await controlSuper.connect();
    await controlSuper.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
    await controlSuper.query('ALTER SCHEMA public OWNER TO control_migrator');
    await controlSuper.query('GRANT USAGE ON SCHEMA public TO control_app, backup_reader');
    await controlSuper.query('GRANT CREATE ON SCHEMA public TO control_migrator');
    await controlSuper.end();

    // --- 3. Migrations, as control_migrator ---------------------------------
    const migrationsDir = path.resolve(import.meta.dirname, '../../../../migrations');
    const migratorClient = new pg.Client({
      host: '127.0.0.1', port: hostPort, user: 'control_migrator',
      password: migratorPassword, database: 'project_control',
    });
    await migratorClient.connect();
    await runMigrations(migratorClient, { migrationsDir });
    await migratorClient.end();

    // --- 4. Secret files, because config only reads secrets from files -------
    const secretsDir = await mkdtemp(path.join(tmpdir(), 'pc-test-secrets-'));
    const artifactRoot = await mkdtemp(path.join(tmpdir(), 'pc-test-artifacts-'));

    const pgPasswordFile = path.join(secretsDir, 'pg_password');
    const sessionSecretFile = path.join(secretsDir, 'session_secret');
    await writeFile(pgPasswordFile, `${appPassword}\n`, { mode: 0o600 });
    await writeFile(sessionSecretFile, `${randomBytes(48).toString('base64url')}\n`, { mode: 0o600 });

    const config = loadConfig({
      NODE_ENV: 'test',
      PC_STACK_VERSION: '0.0.0-test',
      PC_PG_HOST: '127.0.0.1',
      PC_PG_PORT: String(hostPort),
      PC_PG_DATABASE: 'project_control',
      PC_PG_USER: 'control_app',
      PC_PG_PASSWORD_FILE: pgPasswordFile,
      PC_SESSION_SECRET_FILE: sessionSecretFile,
      // Supertest-style injection is not HTTPS, so a Secure cookie would be
      // dropped by the test client. Production sets this to true.
      PC_SESSION_COOKIE_SECURE: 'false',
      PC_SESSION_IDLE_TTL_SECONDS: '3600',
      PC_SESSION_ABSOLUTE_TTL_SECONDS: '43200',
      PC_LOGIN_RATE_LIMIT_MAX: '5',
      PC_LOGIN_RATE_LIMIT_WINDOW_SECONDS: '300',
      PC_LOGIN_LOCKOUT_THRESHOLD: '10',
      PC_ARTIFACT_ROOT: artifactRoot,
      PC_ARTIFACT_MAX_BYTES: '1048576',
      PC_RUNNER_SOCKET: path.join(secretsDir, 'nonexistent-runner.sock'),
      PC_RUNNER_TIMEOUT_MS: '1000',
      PC_LOG_LEVEL: (process.env['PC_TEST_LOG_LEVEL'] ?? 'fatal') as string,
      PC_N8N_HEALTH_URL: 'http://127.0.0.1:1/healthz',
      PC_TAILSCALE_STATUS_FILE: path.join(secretsDir, 'no-tailscale.json'),
      PC_BACKUP_STATUS_FILE: path.join(secretsDir, 'no-backup.json'),
    } as NodeJS.ProcessEnv);

    const logger = createLogger(process.env['PC_TEST_LOG_LEVEL'] ?? 'fatal', 'test');
    const db = createPool(config);
    const artifactStore = new FilesystemArtifactStore({
      root: config.artifacts.root,
      maxBytes: config.artifacts.maxBytes,
    });
    await artifactStore.initialise();

    const ctx: AppContext = {
      config,
      db,
      logger,
      audit: new AuditLog(db, logger),
      sessions: new SessionStore(db, config),
      artifactStore,
      runner: new RunnerClient({
        socketPath: config.runner.socketPath,
        timeoutMs: config.runner.timeoutMs,
      }),
    };

    const app = await buildApp(ctx);
    await app.ready();

    return {
      app,
      ctx,
      config,
      artifactRoot,
      containerName,
      teardown: async () => {
        await app.close().catch(() => {});
        await db.end().catch(() => {});
        await rm(secretsDir, { recursive: true, force: true }).catch(() => {});
        await rm(artifactRoot, { recursive: true, force: true }).catch(() => {});
        await teardownContainer();
      },
    };
  } catch (error) {
    await teardownContainer();
    throw error;
  }
}

/** Extracts a cookie value from a set-cookie header list. */
export function readCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const header of headers) {
    const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(header);
    if (match) return decodeURIComponent(match[1] as string);
  }
  return null;
}

/** Returns the raw set-cookie entry for a named cookie, attributes included. */
export function rawCookie(setCookie: string | string[] | undefined, name: string): string | null {
  if (!setCookie) return null;
  const headers = Array.isArray(setCookie) ? setCookie : [setCookie];
  return headers.find((h) => h.startsWith(`${name}=`)) ?? null;
}
