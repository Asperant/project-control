import { argv, stdout } from 'node:process';
import pg from 'pg';

import { readSecretFile } from '../secrets.js';

/**
 * Revokes a service token by id. Idempotent: revoking an already-revoked
 * token succeeds without writing a second audit row — see the
 * `revoked_at IS NULL` guard below and `guard_service_token_mutation` in
 * migrations/0015, which would otherwise reject a second UPDATE outright.
 *
 * Run via: sudo ./pcctl revoke-service-token <token-id>
 */

async function main(): Promise<void> {
  const tokenId = argv[2];
  if (!tokenId) throw new Error('usage: revoke-service-token <token-id>  (see: sudo ./pcctl list-service-tokens)');

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
    application_name: 'control-api-revoke-service-token',
  });
  await client.connect();
  try {
    await client.query('BEGIN');

    const updated = await client.query<{ id: string; prefix: string; account_key: string }>(
      `UPDATE service_tokens t
          SET revoked_at = now()
         FROM service_accounts a
        WHERE t.id = $1 AND t.account_id = a.id AND t.revoked_at IS NULL
      RETURNING t.id, t.prefix, a.key AS account_key`,
      [tokenId],
    );

    if (updated.rows.length > 0) {
      const row = updated.rows[0]!;
      await client.query(
        `INSERT INTO audit_events (event_type, outcome, subject, detail)
         VALUES ('service.token_revoked', 'success', $1, $2::jsonb)`,
        [
          `service_account:${row.account_key}`,
          JSON.stringify({ tokenId: row.id, prefix: row.prefix, via: 'revoke-service-token-cli' }),
        ],
      );
      await client.query('COMMIT');
      stdout.write(`\nrevoked token ${row.prefix}… (${row.account_key})\n\n`);
      return;
    }

    // Already revoked or never existed — tell the difference without a second
    // write, and without throwing over an already-satisfied revoke request.
    const existing = await client.query<{ id: string }>('SELECT id FROM service_tokens WHERE id = $1', [tokenId]);
    await client.query('ROLLBACK');
    if (existing.rows.length === 0) {
      throw new Error(`no such service token: ${tokenId}`);
    }
    stdout.write(`\ntoken ${tokenId} was already revoked; nothing to do\n\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nrevoke-service-token failed: ${message}\n\n`);
  process.exit(1);
});
