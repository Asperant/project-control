import pg from 'pg';
import type { AppConfig } from '../config.js';

export type Db = pg.Pool;
export type DbClient = pg.PoolClient;

/**
 * PostgreSQL BIGINT (int8) arrives as a string by default because it can exceed
 * `Number.MAX_SAFE_INTEGER`. Every int8 column in this schema is a byte count or
 * a counter that is far below 2^53, and the contracts type them as `number`, so
 * a parser is registered rather than sprinkling `Number(...)` across the code.
 */
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number.parseInt(value, 10));

export function createPool(config: AppConfig): Db {
  const pool = new pg.Pool({
    host: config.pg.host,
    port: config.pg.port,
    database: config.pg.database,
    user: config.pg.user,
    password: config.pg.password,
    max: config.pg.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // A runaway query must not pin a connection forever; both server-side
    // timeouts are set so a hung statement cannot exhaust the pool.
    statement_timeout: config.pg.statementTimeoutMs,
    query_timeout: config.pg.statementTimeoutMs,
    application_name: 'control-api',
  });

  // An idle-client error (e.g. the server restarted) must never take the process
  // down; `pg` emits it on the pool and Node would otherwise treat it as fatal.
  pool.on('error', () => {
    // Intentionally silent here — the readiness probe surfaces the condition and
    // the pool reconnects on the next acquisition.
  });

  return pool;
}

/**
 * Runs `fn` inside a transaction, rolling back on any throw.
 *
 * Session creation and audit writes use this so a partially applied login can
 * never be observed.
 */
export async function withTransaction<T>(db: Db, fn: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already unusable; releasing it below discards it.
    }
    throw error;
  } finally {
    client.release();
  }
}
