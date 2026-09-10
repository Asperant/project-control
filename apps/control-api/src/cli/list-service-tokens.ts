import { stdout } from 'node:process';
import pg from 'pg';

import { readSecretFile } from '../secrets.js';

/**
 * Lists every service token — prefix, account, scopes and status only. The
 * token value itself was never stored, so there is nothing to redact and
 * nothing this command could ever leak.
 *
 * Run via: sudo ./pcctl list-service-tokens
 */

function status(row: { revoked_at: Date | null; expires_at: Date }): string {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at.getTime() <= Date.now()) return 'expired';
  return 'active';
}

async function main(): Promise<void> {
  const host = process.env['PC_PG_HOST'] ?? '127.0.0.1';
  const port = Number(process.env['PC_PG_PORT'] ?? 5432);
  const database = process.env['PC_PG_DATABASE'] ?? 'project_control';
  const user = process.env['PC_PG_MIGRATOR_USER'] ?? 'control_migrator';
  const passwordFile = process.env['PC_PG_MIGRATOR_PASSWORD_FILE'];
  if (!passwordFile) {
    throw new Error('PC_PG_MIGRATOR_PASSWORD_FILE must point at the migrator password secret.');
  }

  const client = new pg.Client({
    host,
    port,
    database,
    user,
    password: readSecretFile(passwordFile, 'migrator password'),
    application_name: 'control-api-list-service-tokens',
  });
  await client.connect();
  try {
    const { rows } = await client.query<{
      id: string;
      account_key: string;
      prefix: string;
      scopes: string[];
      expires_at: Date;
      last_used_at: Date | null;
      revoked_at: Date | null;
      created_at: Date;
    }>(
      `SELECT t.id, a.key AS account_key, t.prefix, t.scopes, t.expires_at, t.last_used_at, t.revoked_at, t.created_at
         FROM service_tokens t
         JOIN service_accounts a ON a.id = t.account_id
        ORDER BY t.created_at DESC`,
    );

    if (rows.length === 0) {
      stdout.write('\nno service tokens have been minted\n\n');
      return;
    }

    stdout.write(
      `\n${'ID'.padEnd(38)}${'ACCOUNT'.padEnd(18)}${'PREFIX'.padEnd(14)}${'STATUS'.padEnd(10)}${'LAST USED'.padEnd(22)}SCOPES\n`,
    );
    stdout.write(`${'─'.repeat(120)}\n`);
    for (const row of rows) {
      stdout.write(
        `${row.id.padEnd(38)}${row.account_key.padEnd(18)}${row.prefix.padEnd(14)}${status(row).padEnd(10)}` +
          `${(row.last_used_at ? row.last_used_at.toISOString() : 'never').padEnd(22)}${row.scopes.join(',')}\n`,
      );
    }
    stdout.write('\n');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nlist-service-tokens failed: ${message}\n\n`);
  process.exit(1);
});
