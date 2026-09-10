import type { TimelineListQuery, TimelineListResponse } from '@project-control/contracts';
import type { Db, DbClient } from './db/pool.js';
import { getProjectGuard, type Executor } from './projects/guard.js';
import type { Logger } from './logger.js';
import { sanitiseAuditText } from './audit.js';

/**
 * A curated, append-only activity feed — see migrations/0019_timeline_events_schema.sql.
 *
 * `control_app` holds SELECT and INSERT on `timeline_events` and nothing else,
 * the same append-only guarantee `audit.ts` already relies on for
 * `audit_events`. This is a separate log with a separate purpose: audit_events
 * is a complete, internal accountability trail (every event type, including
 * auth/service-token/system events); timeline_events is a small, curated
 * subset meant to be shown to a human as "what happened" — only the entity
 * lifecycle events a person would actually want to see on a timeline, each
 * with an already-redacted, human-readable summary line.
 */

/** Closed set of entity kinds a timeline entry can belong to. */
export type TimelineEntityType =
  | 'project'
  | 'roadmap_milestone'
  | 'roadmap_task'
  | 'memory'
  | 'checkpoint'
  | 'work_session'
  | 'agent_run'
  | 'action'
  | 'workflow_run';

/**
 * Closed, curated set of timeline event types — deliberately a small subset
 * of audit.ts's AuditEventType. Not every mutation belongs on a timeline
 * (a reorder or an archive/unarchive toggle is audit history, not activity a
 * person scans a feed for); new entries are added deliberately.
 */
export type TimelineEventType =
  | 'project.created'
  | 'project.archived'
  | 'project.reactivated'
  | 'roadmap_milestone.created'
  | 'roadmap_milestone.completed'
  | 'roadmap_task.created'
  | 'roadmap_task.completed'
  | 'memory.created'
  | 'memory.superseded'
  | 'checkpoint.created'
  | 'work_session.started'
  | 'work_session.closed'
  | 'agent_run.created'
  | 'agent_run.completed'
  | 'agent_run.failed'
  | 'action.execution_succeeded'
  | 'action.execution_failed'
  | 'workflow_run.settled';

export type TimelineActorKind = 'user' | 'service' | 'system';

export type TimelineEntry = {
  /** Null for events with no project scope, e.g. a global automation run. */
  projectId: string | null;
  entityType: TimelineEntityType;
  entityId: string | null;
  eventType: TimelineEventType;
  /** A short, already-redacted, human-readable line. Never raw body/prompt/
   * report/snapshot content — see summariseForTimeline() call sites, which
   * curate this once at the point a feature is built. */
  summary: string;
  actorUserId?: string | null;
  actorKind: TimelineActorKind;
};

const MAX_SUMMARY = 300;

/** Bounds and redacts operator-authored text folded into a summary line. */
export function toSummaryFragment(value: string, maxLength = 120): string {
  return sanitiseAuditText(value).slice(0, maxLength);
}

export class TimelineLog {
  constructor(
    private readonly db: Db,
    private readonly logger: Logger,
  ) {}

  /**
   * Writes a timeline row. Never throws — mirrors AuditLog.record(): a
   * timeline write failure must not turn a successful mutation into a 500.
   */
  async record(entry: TimelineEntry, client?: DbClient): Promise<void> {
    const executor = client ?? this.db;
    try {
      await executor.query(
        `INSERT INTO timeline_events (project_id, entity_type, entity_id, event_type, summary, actor_user_id, actor_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          entry.projectId,
          entry.entityType,
          entry.entityId,
          entry.eventType,
          entry.summary.slice(0, MAX_SUMMARY),
          entry.actorUserId ?? null,
          entry.actorKind,
        ],
      );
    } catch (error) {
      this.logger.error({ err: error, eventType: entry.eventType }, 'failed to write timeline event');
    }
  }

  /**
   * Writes a timeline row and propagates failure. Use inside the same
   * transaction as the mutation it records, mirroring AuditLog.recordRequired().
   */
  async recordRequired(entry: TimelineEntry, client: DbClient): Promise<void> {
    await client.query(
      `INSERT INTO timeline_events (project_id, entity_type, entity_id, event_type, summary, actor_user_id, actor_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.projectId,
        entry.entityType,
        entry.entityId,
        entry.eventType,
        entry.summary.slice(0, MAX_SUMMARY),
        entry.actorUserId ?? null,
        entry.actorKind,
      ],
    );
  }
}

type TimelineRow = {
  id: number;
  project_id: string | null;
  entity_type: string;
  entity_id: string | null;
  event_type: string;
  summary: string;
  occurred_at: Date;
  actor_user_id: string | null;
  actor_kind: TimelineActorKind;
};

function mapRow(row: TimelineRow): TimelineListResponse['entries'][number] {
  return {
    id: row.id,
    projectId: row.project_id,
    entityType: row.entity_type as TimelineEntityType,
    entityId: row.entity_id,
    eventType: row.event_type as TimelineEventType,
    summary: row.summary,
    occurredAt: row.occurred_at.toISOString(),
    actorUserId: row.actor_user_id,
    actorKind: row.actor_kind,
  };
}

function buildResponse(rows: TimelineRow[], pageSize: number): TimelineListResponse {
  const entries = rows.map(mapRow);
  const last = rows.at(-1);
  return {
    entries,
    pageSize,
    nextCursor: rows.length === pageSize && last ? { occurredAt: last.occurred_at.toISOString(), id: last.id } : null,
  };
}

/** Keyset-paginated timeline for a single project. */
export async function listProjectTimeline(db: Executor, projectId: string, query: TimelineListQuery): Promise<TimelineListResponse> {
  await getProjectGuard(db, projectId);
  const { rows } = await db.query<TimelineRow>(
    `SELECT * FROM timeline_events
      WHERE project_id = $1
        AND ($2::text IS NULL OR entity_type = $2)
        AND ($3::timestamptz IS NULL OR (occurred_at, id) < ($3::timestamptz, $4::bigint))
      ORDER BY occurred_at DESC, id DESC
      LIMIT $5`,
    [projectId, query.entityType ?? null, query.beforeOccurredAt ?? null, query.beforeId ?? null, query.pageSize],
  );
  return buildResponse(rows, query.pageSize);
}

/** Keyset-paginated, cross-project activity feed. */
export async function listGlobalTimeline(db: Executor, query: TimelineListQuery): Promise<TimelineListResponse> {
  const { rows } = await db.query<TimelineRow>(
    `SELECT * FROM timeline_events
      WHERE ($1::text IS NULL OR entity_type = $1)
        AND ($2::timestamptz IS NULL OR (occurred_at, id) < ($2::timestamptz, $3::bigint))
      ORDER BY occurred_at DESC, id DESC
      LIMIT $4`,
    [query.entityType ?? null, query.beforeOccurredAt ?? null, query.beforeId ?? null, query.pageSize],
  );
  return buildResponse(rows, query.pageSize);
}
