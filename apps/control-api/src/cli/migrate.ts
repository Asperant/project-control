import { readFileSync } from 'node:fs';
import pg from 'pg';
import { runMigrations } from '../db/migrate.js';

/**
 * Standalone migration CLI.
 *
 * Used by `./pcctl update` for the pre-update dry run, and available for manual
 * recovery. Connects as `control_migrator` — the only role with DDL rights.
 *
 *   node dist/cli/migrate.js            apply pending migrations
 *   node dist/cli/migrate.js --dry-run  validate without committing
 */
async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const migrationsDir = process.env['PC_MIGRATIONS_DIR'] ?? '/app/migrations';
  const passwordFile = process.env['PC_PG_MIGRATOR_PASSWORD_FILE'];

  if (!passwordFile) {
    throw new Error('PC_PG_MIGRATOR_PASSWORD_FILE must be set.');
  }

  const client = new pg.Client({
    host: process.env['PC_PG_HOST'] ?? '127.0.0.1',
    port: Number(process.env['PC_PG_PORT'] ?? 5432),
    database: process.env['PC_PG_DATABASE'] ?? 'project_control',
    user: process.env['PC_PG_MIGRATOR_USER'] ?? 'control_migrator',
    password: readFileSync(passwordFile, 'utf8').replace(/\r?\n$/, ''),
    application_name: 'control-api-migrate-cli',
  });

  await client.connect();
  try {
    const result = await runMigrations(client, {
      migrationsDir,
      dryRun,
      onEvent: (e) => process.stdout.write(`[${e.level}] ${e.message}\n`),
    });

    process.stdout.write(
      `\n${dryRun ? 'DRY RUN — nothing was committed.\n' : ''}` +
        `applied=${result.applied.length} already-applied=${result.skipped.length}\n`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`migrate failed: ${message}\n`);
  process.exit(1);
});
