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
  | 'system.rollback'
  | 'project.inspection.started'
  | 'project.inspection.rejected'
  | 'project.created'
  | 'project.updated'
  | 'project.rescanned'
  | 'project.rescan.diff_applied'
  | 'project.archived'
  | 'project.reactivated'
  | 'project.rule.changed'
  | 'project.technology.changed'
  | 'project.command.changed'
  | 'roadmap.milestone.created' | 'roadmap.milestone.updated' | 'roadmap.milestone.reordered'
  | 'roadmap.milestone.blocked' | 'roadmap.milestone.completed' | 'roadmap.milestone.reopened'
  | 'roadmap.milestone.status_changed' | 'roadmap.milestone.archived' | 'roadmap.milestone.reactivated'
  | 'roadmap.task.created' | 'roadmap.task.updated' | 'roadmap.task.reordered' | 'roadmap.task.started'
  | 'roadmap.task.blocked' | 'roadmap.task.unblocked' | 'roadmap.task.completed' | 'roadmap.task.reopened'
  | 'roadmap.task.cancelled' | 'roadmap.task.status_changed'
  | 'roadmap.acceptance.created' | 'roadmap.acceptance.updated' | 'roadmap.acceptance.completed'
  | 'roadmap.acceptance.reopened' | 'roadmap.acceptance.reordered' | 'roadmap.acceptance.deleted'
  | 'roadmap.dependency.added' | 'roadmap.dependency.removed' | 'roadmap.dependency.override'
  | 'roadmap.note.created' | 'roadmap.note.updated' | 'roadmap.note.deleted'
  | 'memory.created' | 'memory.updated' | 'memory.pinned' | 'memory.unpinned'
  | 'memory.archived' | 'memory.reactivated' | 'memory.superseded'
  | 'checkpoint.created' | 'checkpoint.archived'
  | 'work_session.started' | 'work_session.goal_updated' | 'work_session.closed'
  | 'work_session.amendment_added' | 'work_session.checkpoint_created'
  | 'action.planned' | 'action.cancelled' | 'action.expired'
  | 'action.execution_started' | 'action.execution_succeeded' | 'action.execution_failed'
  | 'action.reconciled'
  | 'agentrun.created' | 'agentrun.updated' | 'agentrun.sent' | 'agentrun.started'
  | 'agentrun.completed' | 'agentrun.failed' | 'agentrun.cancelled'
  | 'agentrun.archived' | 'agentrun.reactivated' | 'agentrun.duplicated'
  | 'agentrun.memory_promoted'
  | 'agentprompt.updated'
  | 'agentreport.created' | 'agentreport.updated' | 'agentreport.finalized'
  | 'agentreport.revision_started' | 'agentreport.superseded'
  | 'agentvalidation.updated'
  | 'service.token_created' | 'service.token_revoked' | 'service.token_rejected'
  | 'service.scope_denied' | 'service.principal_kind_denied'
  | 'workflow.run_requested' | 'workflow.run_opened' | 'workflow.run_claimed'
  | 'workflow.run_step_recorded' | 'workflow.run_artifact_attached'
  | 'workflow.run_settled' | 'workflow.run_cancelled' | 'workflow.run_rejected';

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

/** Bounded redaction for operator-authored text that must remain in history. */
export function sanitiseAuditText(value: string): string {
  return value
    .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/gi, '[redacted credential block]')
    .replace(/\b(password|passwd|token|secret|api[_-]?key|encryption[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[redacted]@')
    .slice(0, 240);
}

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

  /**
   * Writes an audit row and propagates failure. Use this inside the same
   * transaction as a roadmap mutation whose success must never be unaudited.
   */
  async recordRequired(entry: AuditEntry, client: DbClient): Promise<void> {
    await client.query(
      `INSERT INTO audit_events (event_type, outcome, actor_user_id, request_id, subject, detail)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [entry.eventType, entry.outcome, entry.actorUserId ?? null, entry.requestId ?? null,
       entry.subject ?? null, JSON.stringify(sanitiseDetail(entry.detail ?? {}))],
    );
  }
}
