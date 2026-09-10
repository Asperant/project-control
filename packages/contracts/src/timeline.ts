import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common.js';

/**
 * The curated activity feed backed by `timeline_events` — see
 * apps/control-api/src/timeline.ts. Intentionally a small, closed subset of
 * entities/events, not a mirror of every audit event: this is what a person
 * scans to answer "what happened", not a complete accountability trail.
 */
export const timelineEntityTypeSchema = z.enum([
  'project',
  'roadmap_milestone',
  'roadmap_task',
  'memory',
  'checkpoint',
  'work_session',
  'agent_run',
  'action',
  'workflow_run',
]);
export type TimelineEntityType = z.infer<typeof timelineEntityTypeSchema>;

export const timelineEventTypeSchema = z.enum([
  'project.created',
  'project.archived',
  'project.reactivated',
  'roadmap_milestone.created',
  'roadmap_milestone.completed',
  'roadmap_task.created',
  'roadmap_task.completed',
  'memory.created',
  'memory.superseded',
  'checkpoint.created',
  'work_session.started',
  'work_session.closed',
  'agent_run.created',
  'agent_run.completed',
  'agent_run.failed',
  'action.execution_succeeded',
  'action.execution_failed',
  'workflow_run.settled',
]);
export type TimelineEventType = z.infer<typeof timelineEventTypeSchema>;

export const timelineActorKindSchema = z.enum(['user', 'service', 'system']);
export type TimelineActorKind = z.infer<typeof timelineActorKindSchema>;

export const timelineEntrySchema = z.object({
  // BIGINT identity, returned as a JS number: the shared pg pool parses INT8
  // as number (see apps/control-api/src/db/pool.ts), not as the driver's
  // string default — every bigint id in this API follows that convention.
  id: z.number().int().positive(),
  projectId: uuidSchema.nullable(),
  entityType: timelineEntityTypeSchema,
  entityId: uuidSchema.nullable(),
  eventType: timelineEventTypeSchema,
  summary: z.string().min(1).max(300),
  occurredAt: timestampSchema,
  actorUserId: uuidSchema.nullable(),
  actorKind: timelineActorKindSchema,
}).strict();
export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

/**
 * Keyset pagination, matching WorkSessionListQuery's established shape
 * (resume.ts) rather than introducing a new opaque-cursor convention: both
 * `before*` fields are supplied together or not at all, and the response
 * carries the same-shaped `nextCursor` to feed back in for the next page.
 */
export const timelineListQuerySchema = z.object({
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  entityType: timelineEntityTypeSchema.optional(),
  beforeOccurredAt: timestampSchema.optional(),
  beforeId: z.coerce.number().int().positive().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.beforeOccurredAt === undefined) !== (value.beforeId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['beforeOccurredAt'], message: 'beforeOccurredAt and beforeId must be supplied together.' });
  }
});
export type TimelineListQuery = z.infer<typeof timelineListQuerySchema>;

export const timelineListResponseSchema = z.object({
  entries: z.array(timelineEntrySchema),
  pageSize: z.number().int().positive(),
  nextCursor: z.object({ occurredAt: timestampSchema, id: z.number().int().positive() }).nullable().default(null),
}).strict();
export type TimelineListResponse = z.infer<typeof timelineListResponseSchema>;
