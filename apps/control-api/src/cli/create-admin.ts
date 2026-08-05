import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
import { stdin, stdout } from 'node:process';
import pg from 'pg';
import { z } from 'zod';

import { hashPassword, validatePasswordStrength } from '../auth/password.js';

/**
 * Interactive bootstrap of the first administrator.
 *
 * This is the *only* way an account comes into existence in Stage 1. There is no
 * seeded user, no default password, and no environment variable that creates
 * one — so a deployment that is installed but never bootstrapped has no
 * credentials to guess.
 *
 * Run via: ./pcctl create-admin
 */

const emailSchema = z.string().trim().toLowerCase().email().max(320);
const nameSchema = z.string().trim().min(1).max(120);

/** Prompts on the TTY. Echo is disabled for secret input. */
function prompt(question: string, options: { silent?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!stdin.isTTY) {
      reject(
        new Error(
          'create-admin requires an interactive terminal. ' +
            'Run it directly (sudo ./pcctl create-admin), not from a script or CI job.',
        ),
      );
      return;
    }

    const rl = createInterface({ input: stdin, output: stdout, terminal: true });

    if (options.silent) {
      // Suppress echo so the password never appears on screen, in the scrollback
      // buffer, or in a terminal-recording tool.
      const originalWrite = (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (
        this: unknown,
        chunk: string,
      ) {
        if (chunk.includes(question)) {
          originalWrite.call(this, chunk);
        }
        // Everything else (the typed characters) is discarded.
      };
    }

    rl.question(question, (answer) => {
      rl.close();
      if (options.silent) stdout.write('\n');
      resolve(answer);
    });
  });
}

function readSecretFile(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r?\n$/, '');
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

  stdout.write('\n=== Project Control — create administrator ===\n\n');

  const emailRaw = await prompt('Email address: ');
  const email = emailSchema.parse(emailRaw);

  const nameRaw = await prompt('Display name: ');
  const displayName = nameSchema.parse(nameRaw);

  const password = await prompt('Password (input hidden): ', { silent: true });
  const strength = validatePasswordStrength(password);
  if (!strength.ok) throw new Error(strength.reason);

  const confirmation = await prompt('Confirm password: ', { silent: true });
  if (password !== confirmation) {
    throw new Error('Passwords do not match. No account was created.');
  }

  // Hashing happens before the database is touched, so a slow hash cannot hold a
  // transaction open.
  const passwordHash = await hashPassword(password);

  const client = new pg.Client({
    host,
    port,
    database,
    user,
    password: readSecretFile(passwordFile),
    application_name: 'control-api-create-admin',
  });

  await client.connect();
  try {
    await client.query('BEGIN');

    const existing = await client.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [
      email,
    ]);

    if (existing.rows.length > 0) {
      // Idempotent by intent: re-running this to reset a forgotten password is a
      // legitimate recovery path, but it must be an explicit, announced action.
      const answer = await prompt(
        `An account already exists for ${email}. Reset its password and role to admin? [yes/no]: `,
      );
      if (answer.trim().toLowerCase() !== 'yes') {
        await client.query('ROLLBACK');
        stdout.write('\nAborted. Nothing was changed.\n');
        return;
      }
      const id = existing.rows[0]?.id as string;
      await client.query(
        `UPDATE users
            SET password_hash = $2, display_name = $3, role = 'admin',
                is_active = TRUE, failed_login_count = 0, locked_until = NULL
          WHERE id = $1`,
        [id, passwordHash, displayName],
      );
      // Any session issued under the old password must die with it.
      await client.query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await client.query(
        `INSERT INTO audit_events (event_type, outcome, actor_user_id, subject, detail)
         VALUES ('admin.user.created', 'success', $1, $2, $3::jsonb)`,
        [id, email, JSON.stringify({ action: 'password_reset', via: 'create-admin-cli' })],
      );
      await client.query('COMMIT');
      stdout.write(`\nPassword reset for ${email}. All existing sessions were revoked.\n\n`);
      return;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role, is_active)
       VALUES ($1, $2, $3, 'admin', TRUE)
       RETURNING id`,
      [email, displayName, passwordHash],
    );
    const id = inserted.rows[0]?.id as string;

    await client.query(
      `INSERT INTO audit_events (event_type, outcome, actor_user_id, subject, detail)
       VALUES ('admin.user.created', 'success', $1, $2, $3::jsonb)`,
      [id, email, JSON.stringify({ action: 'bootstrap', via: 'create-admin-cli' })],
    );

    await client.query(
      `INSERT INTO system_settings (key, value, description)
       VALUES ('bootstrap.admin_created', 'true'::jsonb, 'Set by the create-admin CLI.')
       ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb`,
    );

    await client.query('COMMIT');
    stdout.write(`\nAdministrator ${email} created.\n`);
    stdout.write('Sign in at the Tailscale portal URL shown by: ./pcctl status\n\n');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\ncreate-admin failed: ${message}\n\n`);
  process.exit(1);
});
