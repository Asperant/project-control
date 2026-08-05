import type { Db, DbClient } from './db/pool.js';
import type { Logger } from './logger.js';

/**
 * Append-only audit trail.
 *
 * `control_app` holds SELECT and INSERT on `audit_events` and nothing else, so
 * the application physically cannot rewrite or delete history even if this
 * module were compromised.
 */

export type AuditOutcome = 'success' | 'failure' | 'denied' | 'error';

/** Closed set of Stage 1 event types — new events are added deliberately. */
export type AuditEventType =
  | 'auth.login.succeeded'
  | 'auth.login.failed'
  | 'auth.login.rate_limited'
  | 'auth.login.locked_out'
  | 'auth.logout'
  | 'auth.session.rejected'
  | 'auth.csrf.rejected'
  | 'admin.user.created'
  | 'artifact.selftest'
  | 'artifact.stored'
  | 'runner.operation'
  | 'system.status.read'
  | 'system.migration.applied'
  | 'system.update'
  | 'system.rollback';

export type AuditEntry = {
  eventType: AuditEventType;
  outcome: AuditOutcome;
  actorUserId?: string | null;
  requestId?: string | null;
  subject?: string | null;
  detail?: Record<string, unknown>;
};

/**
 * Keys whose values are dropped before an audit row is written.
 *
 * The call sites do not pass secrets, but audit detail is the kind of structure
 * that grows by accretion, so the filter is enforced here rather than trusted at
 * every caller.
 */
const FORBIDDEN_DETAIL_KEYS = new Set([
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'csrftoken',
  'csrf_token',
  'sessiontoken',
  'session_token',
  'secret',
  'apikey',
  'api_key',
  'encryptionkey',
  'encryption_key',
  'authorization',
  'cookie',
]);

const MAX_DETAIL_STRING = 512;

/** Recursively strips forbidden keys and truncates long strings. */
export function sanitiseDetail(input: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 4) return { truncated: true };
  const output: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_DETAIL_KEYS.has(key.toLowerCase().replace(/[^a-z_]/g, ''))) {
      output[key] = '[redacted]';
      continue;
    }
    if (value === null || value === undefined) {
      output[key] = null;
    } else if (typeof value === 'string') {
      output[key] = value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      output[key] = value;
    } else if (Array.isArray(value)) {
      output[key] = value
        .slice(0, 20)
        .map((v) =>
          typeof v === 'object' && v !== null
            ? sanitiseDetail(v as Record<string, unknown>, depth + 1)
            : v,
        );
    } else if (typeof value === 'object') {
      output[key] = sanitiseDetail(value as Record<string, unknown>, depth + 1);
    } else {
      output[key] = String(value);
    }
  }
  return output;
}

export class AuditLog {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /**
   * Writes an audit row.
   *
   * Never throws. An audit failure must not turn a successful login into a 500 —
   * it is logged at `error` so the operator sees it, and the request proceeds.
   */
  async record(entry: AuditEntry, client?: DbClient): Promise<void> {
    const executor = client ?? this.db;
    try {
      await executor.query(
        `INSERT INTO audit_events (event_type, outcome, actor_user_id, request_id, subject, detail)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [
          entry.eventType,
          entry.outcome,
          entry.actorUserId ?? null,
          entry.requestId ?? null,
          entry.subject ?? null,
          JSON.stringify(sanitiseDetail(entry.detail ?? {})),
        ],
      );
    } catch (error) {
      this.logger.error(
        { err: error, eventType: entry.eventType },
        'failed to write audit event',
      );
    }
  }
}
