import { argv, stderr, stdout } from 'node:process';
import pg from 'pg';

import { findServiceAccountDefinition, SERVICE_ACCOUNT_REGISTRY } from '../auth/service-accounts.js';
import { generateServiceToken } from '../auth/service-tokens.js';
import { readSecretFile } from '../secrets.js';

/**
 * Mints a service token for a known machine identity.
 *
 * Non-interactive by design — unlike create-admin, nothing here is typed by a
 * human, so there is no TTY requirement. The generated token is written to
 * stdout exactly once and nowhere else: not to a file, not to a log line, not
 * to the audit trail (which records only the token's prefix and scopes).
 *
 * Run via: sudo ./pcctl create-service-token <account-key> [--ttl-days N]
 */

const DEFAULT_TTL_DAYS = 365;
const MAX_TTL_DAYS = 365;

function usage(): string {
  return (
    `usage: create-service-token <account-key> [--ttl-days N]\n` +
    `known account keys: ${SERVICE_ACCOUNT_REGISTRY.map((d) => d.key).join(', ')}`
  );
}

function parseArgs(args: string[]): { accountKey: string; ttlDays: number } {
  const accountKey = args[0];
  if (!accountKey) throw new Error(usage());

  let ttlDays = DEFAULT_TTL_DAYS;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === '--ttl-days') {
      const raw = args[i + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0 || value > MAX_TTL_DAYS) {
        throw new Error(`--ttl-days must be an integer between 1 and ${MAX_TTL_DAYS} (got: ${raw ?? ''})`);
      }
      ttlDays = value;
      i += 1;
    }
  }
  return { accountKey, ttlDays };
}

async function main(): Promise<void> {
  const { accountKey, ttlDays } = parseArgs(argv.slice(2));

  const definition = findServiceAccountDefinition(accountKey);
  if (!definition) {
    throw new Error(`unknown service account key: ${accountKey}\n${usage()}`);
  }

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
    application_name: 'control-api-create-service-token',
  });

  await client.connect();
  try {
    await client.query('BEGIN');

    // Reconciles the row from the compiled-in registry every run — the same
    // "code is the source of truth, the database catches up" pattern the
    // production boot path uses. Never touches `status`: an operator-disabled
    // account stays disabled even if this is run again.
    const account = await client.query<{ id: string; status: string }>(
      `INSERT INTO service_accounts (key, display_name, scopes)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE
         SET display_name = EXCLUDED.display_name, scopes = EXCLUDED.scopes
       RETURNING id, status`,
      [definition.key, definition.displayName, definition.scopes],
    );
    const accountRow = account.rows[0];
    if (!accountRow) throw new Error('service account upsert returned no row.');
    if (accountRow.status !== 'active') {
      throw new Error(
        `service account '${definition.key}' is disabled (status=${accountRow.status}); ` +
          're-enable it before minting a new token',
      );
    }

    const generated = generateServiceToken();
    const inserted = await client.query<{ id: string; expires_at: Date }>(
      `INSERT INTO service_tokens (account_id, token_hash, prefix, scopes, expires_at, created_by)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => $5), NULL)
       RETURNING id, expires_at`,
      [accountRow.id, generated.tokenHash, generated.prefix, definition.scopes, ttlDays],
    );
    const tokenRow = inserted.rows[0];
    if (!tokenRow) throw new Error('service token insert returned no row.');

    await client.query(
      `INSERT INTO audit_events (event_type, outcome, subject, detail)
       VALUES ('service.token_created', 'success', $1, $2::jsonb)`,
      [
        `service_account:${definition.key}`,
        JSON.stringify({
          tokenId: tokenRow.id,
          prefix: generated.prefix,
          scopes: definition.scopes,
          ttlDays,
          via: 'create-service-token-cli',
        }),
      ],
    );

    await client.query('COMMIT');

    stdout.write(`\nService token minted for '${definition.key}'.\n`);
    stdout.write(`Scopes:  ${definition.scopes.join(', ')}\n`);
    stdout.write(`Expires: ${tokenRow.expires_at.toISOString()}\n\n`);
    stdout.write(`${generated.token}\n\n`);
    stdout.write('Shown once. Not stored anywhere in plaintext — only its SHA-256 is kept.\n');
    stdout.write('Paste it into an n8n Header Auth credential:\n');
    stdout.write('  Header: Authorization\n');
    stdout.write('  Value:  Bearer <the value above>\n\n');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`\ncreate-service-token failed: ${message}\n\n`);
  process.exit(1);
});
