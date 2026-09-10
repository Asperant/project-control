import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations } from '../../src/db/migrate.js';
import { dockerAvailable } from './helpers.js';

/**
 * Upgrade-matrix testing, Part B: migration sequencing.
 *
 * `test/integration/helpers.ts`'s `createHarness()` already proves migrations
 * 0001..N apply cleanly, in order, against a truly empty database — every
 * integration suite in this directory (checkpoints, memory, timeline, ...)
 * does this implicitly on every run, because each gets its own freshly
 * created, never-before-migrated container. That is real coverage, not
 * incidental: a broken migration would fail every integration test file, not
 * just this one.
 *
 * What is NOT covered anywhere else: running the full migration sequence a
 * SECOND time against a database that already has it applied. `runMigrations`
 * is designed to be safe to call on every container boot (see its own doc
 * comment in migrate.ts), and migrate.test.ts's "migration dry-run
 * transaction" test proves the dry-run/rollback mechanics on a synthetic
 * 2-file set — but nothing exercises a real second run, with the real 23
 * migration files, against a real already-migrated PostgreSQL, to confirm it
 * is actually a clean no-op (nothing re-applied, no checksum or duplicate-key
 * errors from the `IF NOT EXISTS` / `ON CONFLICT DO NOTHING` guards the SQL
 * files themselves rely on). This file closes that gap.
 *
 * Deliberately minimal and self-contained: it duplicates the container/role
 * bootstrap from helpers.ts's createHarness() (rather than extending that
 * shared helper) so this file cannot change behavior for the other ~15
 * integration suites that depend on it.
 */

const exec = promisify(execFile);
const hasDocker = await dockerAvailable();

const CONTAINER_IMAGE =
  process.env['PC_TEST_POSTGRES_IMAGE'] ??
  'postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d';

const migrationsDir = path.resolve(import.meta.dirname, '../../../../migrations');

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

describe.skipIf(!hasDocker)('migration sequencing (0001..N), against a truly empty database', () => {
  let containerName: string;
  let migratorClient: pg.Client;

  beforeAll(async () => {
    const suffix = randomBytes(6).toString('hex');
    containerName = `pc-test-migrate-seq-${suffix}`;
    const superuserPassword = randomBytes(24).toString('base64url');

    await exec('docker', [
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

    try {
      await waitForPostgres(containerName);

      const { stdout: portMap } = await exec('docker', ['port', containerName, '5432/tcp']);
      const hostPort = Number(portMap.trim().split('\n')[0]?.split(':').pop());
      if (!Number.isInteger(hostPort)) throw new Error(`could not determine host port: ${portMap}`);

      // Roles, mirroring both the production init script and helpers.ts's
      // createHarness(): migrations 0002 onward GRANT to control_app and
      // backup_reader, so those roles must exist before 0001 even runs.
      const superClient = new pg.Client({ host: '127.0.0.1', port: hostPort, user: 'postgres', password: superuserPassword, database: 'postgres' });
      await superClient.connect();
      const migratorPassword = randomBytes(24).toString('base64url');
      const createRole = async (role: string, password: string): Promise<void> => {
        await superClient.query(
          `CREATE ROLE ${role} LOGIN PASSWORD ${superClient.escapeLiteral(password)} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
        );
      };
      await createRole('control_app', randomBytes(24).toString('base64url'));
      await createRole('control_migrator', migratorPassword);
      await createRole('backup_reader', randomBytes(24).toString('base64url'));
      await superClient.query('CREATE DATABASE project_control OWNER control_migrator');
      await superClient.query('REVOKE ALL ON DATABASE project_control FROM PUBLIC');
      await superClient.query('GRANT CONNECT ON DATABASE project_control TO control_app, control_migrator, backup_reader');
      await superClient.end();

      const controlSuper = new pg.Client({ host: '127.0.0.1', port: hostPort, user: 'postgres', password: superuserPassword, database: 'project_control' });
      await controlSuper.connect();
      await controlSuper.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await controlSuper.query('ALTER SCHEMA public OWNER TO control_migrator');
      await controlSuper.query('GRANT USAGE ON SCHEMA public TO control_app, backup_reader');
      await controlSuper.query('GRANT CREATE ON SCHEMA public TO control_migrator');
      await controlSuper.end();

      migratorClient = new pg.Client({ host: '127.0.0.1', port: hostPort, user: 'control_migrator', password: migratorPassword, database: 'project_control' });
      await migratorClient.connect();
    } catch (error) {
      await exec('docker', ['rm', '-f', containerName]).catch(() => {});
      throw error;
    }
  }, 120_000);

  afterAll(async () => {
    await migratorClient?.end().catch(() => {});
    await exec('docker', ['rm', '-f', containerName]).catch(() => {});
  });

  it('applies every migration file, in order, cleanly, against a database with no schema_migrations table at all', async () => {
    const files = await loadMigrations(migrationsDir);
    // Sanity check that this test is actually exercising the full, current set
    // — not a stale count baked in at write time.
    expect(files.length).toBeGreaterThanOrEqual(23);
    expect(files.map((f) => f.version)).toEqual([...files.map((f) => f.version)].sort());

    const result = await runMigrations(migratorClient, { migrationsDir });
    expect(result.dryRun).toBe(false);
    expect(result.skipped).toEqual([]);
    expect(result.applied).toEqual(files.map((f) => f.version));

    const { rows } = await migratorClient.query<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version',
    );
    expect(rows.map((r) => r.version)).toEqual(files.map((f) => f.version));
  });

  it('is idempotent: re-running the exact same full sequence against the now-migrated database applies nothing, skips every version, and raises no checksum or duplicate-object error', async () => {
    const files = await loadMigrations(migrationsDir);

    const result = await runMigrations(migratorClient, { migrationsDir });

    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(files.map((f) => f.version));

    // A third run, for good measure — proves this isn't a one-time fluke of
    // ledger state left over from the first re-run.
    const thirdRun = await runMigrations(migratorClient, { migrationsDir });
    expect(thirdRun.applied).toEqual([]);
    expect(thirdRun.skipped).toEqual(files.map((f) => f.version));
  });
});
