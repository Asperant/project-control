import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

/**
 * Migration runner.
 *
 * Properties that matter operationally:
 *
 *  - **Idempotent.** Applied versions are recorded and skipped, so running it on
 *    every container start is safe and is in fact what the entrypoint does.
 *  - **Checksum-verified.** If an already-applied file has been edited, the run
 *    aborts. Silently tolerating that would mean the recorded schema history no
 *    longer describes the live database.
 *  - **Serialised.** A session-level advisory lock ensures two API replicas
 *    starting at once cannot both apply the same migration.
 *  - **Atomic per migration.** Each file runs inside its own transaction along
 *    with its ledger insert, so a failure leaves no half-applied version.
 */

export type MigrationFile = {
  version: string;
  name: string;
  filePath: string;
  sql: string;
  checksum: string;
};

export type MigrationResult = {
  applied: string[];
  skipped: string[];
  /** True when `dryRun` was requested; nothing was committed. */
  dryRun: boolean;
};

/** Arbitrary but stable key so only this application contends on the lock. */
const ADVISORY_LOCK_KEY = 0x7063_0001;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export async function loadMigrations(dir: string): Promise<MigrationFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: MigrationFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = FILENAME_PATTERN.exec(entry.name);
    if (!match) {
      if (entry.name.endsWith('.sql')) {
        throw new Error(
          `Migration filename "${entry.name}" does not match NNNN_snake_case_name.sql`,
        );
      }
      continue;
    }
    const filePath = path.join(dir, entry.name);
    const sql = await readFile(filePath, 'utf8');
    files.push({
      version: match[1] as string,
      name: match[2] as string,
      filePath,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    });
  }

  files.sort((a, b) => a.version.localeCompare(b.version));

  const seen = new Set<string>();
  for (const f of files) {
    if (seen.has(f.version)) {
      throw new Error(`Duplicate migration version ${f.version}`);
    }
    seen.add(f.version);
  }
  return files;
}

/** Creates the ledger table if this is a virgin database. */
async function ensureLedger(client: pg.PoolClient | pg.Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version      TEXT        PRIMARY KEY,
      name         TEXT        NOT NULL,
      checksum     TEXT        NOT NULL,
      applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      execution_ms INTEGER     NOT NULL DEFAULT 0
    )
  `);
}

export type MigrateOptions = {
  migrationsDir: string;
  /** Validate and report what *would* run, without committing anything. */
  dryRun?: boolean;
  onEvent?: (event: { level: 'info' | 'warn'; message: string }) => void;
};

export async function runMigrations(
  client: pg.Client | pg.PoolClient,
  options: MigrateOptions,
): Promise<MigrationResult> {
  const emit = options.onEvent ?? (() => {});
  const migrations = await loadMigrations(options.migrationsDir);

  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
  try {
    await ensureLedger(client);

    const { rows } = await client.query<{ version: string; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.version, r]));

    // Fail fast on tampering before applying anything new.
    for (const migration of migrations) {
      const record = applied.get(migration.version);
      if (record && record.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version}_${migration.name} was modified after it was applied ` +
            `(recorded checksum ${record.checksum.slice(0, 12)}…, file checksum ` +
            `${migration.checksum.slice(0, 12)}…). Add a new migration instead of editing history.`,
        );
      }
    }

    // A version recorded in the database with no corresponding file means the
    // deployed code is older than the database — refuse rather than guess.
    for (const [version, record] of applied) {
      if (!migrations.some((m) => m.version === version)) {
        throw new Error(
          `Database has migration ${version}_${record.name} applied but no such file exists. ` +
            `The deployed code appears to be older than the database schema.`,
        );
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));
    const result: MigrationResult = {
      applied: [],
      skipped: migrations.filter((m) => applied.has(m.version)).map((m) => m.version),
      dryRun: options.dryRun === true,
    };

    if (pending.length === 0) {
      emit({ level: 'info', message: 'Schema is up to date; no migrations pending.' });
      return result;
    }

    for (const migration of pending) {
      const label = `${migration.version}_${migration.name}`;
      const started = Date.now();

      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        const elapsed = Date.now() - started;
        await client.query(
          `INSERT INTO schema_migrations (version, name, checksum, execution_ms)
           VALUES ($1, $2, $3, $4)`,
          [migration.version, migration.name, migration.checksum, elapsed],
        );

        if (options.dryRun) {
          // The SQL really executed, which is the only way to know it is valid;
          // rolling back leaves the database exactly as it was found.
          await client.query('ROLLBACK');
          emit({ level: 'info', message: `dry-run OK: ${label} (${elapsed} ms, rolled back)` });
        } else {
          await client.query('COMMIT');
          emit({ level: 'info', message: `applied ${label} (${elapsed} ms)` });
        }
        result.applied.push(migration.version);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Migration ${label} failed: ${message}`, { cause: error });
      }
    }

    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
  }
}
