import { z } from 'zod';
import { roadmapPrioritySchema, roadmapStatusSchema } from './roadmap.js';
import { recentAgentActivitySchema } from './agent-runs.js';
import { checkpointGitStateSchema } from './development.js';

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const optionalText = (max: number) => z.string().trim().max(max);

/**
 * Manual project memory and immutable checkpoints.
 *
 * Nothing here is AI-generated: every memory entry is authored by an operator,
 * and every checkpoint snapshot is a deterministic read of the roadmap and
 * memory tables at the moment it was saved. See docs/project-memory.md.
 */

export const memoryTypeSchema = z.enum(['decision', 'constraint', 'context', 'finding', 'handoff', 'lesson']);
export const memoryImportanceSchema = z.enum(['normal', 'important', 'critical']);
export const memoryStatusSchema = z.enum(['active', 'archived', 'superseded']);
export type MemoryType = z.infer<typeof memoryTypeSchema>;
export type MemoryImportance = z.infer<typeof memoryImportanceSchema>;
export type MemoryStatus = z.infer<typeof memoryStatusSchema>;

export const memoryEntrySchema = z.object({
  id: uuid,
  projectId: uuid,
  type: memoryTypeSchema,
  title: z.string(),
  body: z.string(),
  importance: memoryImportanceSchema,
  isPinned: z.boolean(),
  status: memoryStatusSchema,
  relatedTaskId: uuid.nullable(),
  relatedTaskTitle: z.string().nullable(),
  relatedMilestoneId: uuid.nullable(),
  relatedMilestoneTitle: z.string().nullable(),
  supersededById: uuid.nullable(),
  supersededByTitle: z.string().nullable(),
  supersedesIds: z.array(uuid),
  archivedAt: timestamp.nullable(),
  createdBy: uuid.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  // Set only by the promote-to-memory flow (see docs/agent-runs.md); the
  // general create/update endpoints for memory entries never accept this.
  sourceAgentRunId: uuid.nullable(),
  sourceAgentRunTitle: z.string().nullable(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

/**
 * Keyset-paginated, matching timeline.ts's established shape. `is_pinned` is
 * the *primary* sort key on this list (pinned entries always float to the
 * top), not `created_at` alone, so the cursor has to encode all three
 * columns the ORDER BY actually uses — see listMemory (memory/store.ts).
 *
 * `pageSize`/`nextCursor` default when absent so a caller that only reads
 * `entries` (e.g. the related-memory-by-agent-run response, which reuses
 * this schema unpaginated) still parses.
 */
export const memoryListResponseSchema = z.object({
  entries: z.array(memoryEntrySchema),
  pageSize: z.number().int().positive().optional().default(50),
  nextCursor: z.object({ isPinned: z.boolean(), createdAt: timestamp, id: uuid }).nullable().default(null),
});
export const memoryEntryResponseSchema = z.object({ entry: memoryEntrySchema });
export const supersedeMemoryEntryResponseSchema = z.object({ oldEntry: memoryEntrySchema, newEntry: memoryEntrySchema });
export type MemoryListResponse = z.infer<typeof memoryListResponseSchema>;
export type MemoryEntryResponse = z.infer<typeof memoryEntryResponseSchema>;
export type SupersedeMemoryEntryResponse = z.infer<typeof supersedeMemoryEntryResponseSchema>;

export const createMemoryEntryRequestSchema = z.object({
  type: memoryTypeSchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10000),
  importance: memoryImportanceSchema.default('normal'),
  isPinned: z.boolean().default(false),
  relatedTaskId: uuid.nullable().optional(),
  relatedMilestoneId: uuid.nullable().optional(),
}).strict();
export type CreateMemoryEntryRequest = z.infer<typeof createMemoryEntryRequestSchema>;

export const updateMemoryEntryRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  body: z.string().trim().min(1).max(10000).optional(),
  importance: memoryImportanceSchema.optional(),
  relatedTaskId: uuid.nullable().optional(),
  relatedMilestoneId: uuid.nullable().optional(),
}).strict();
export type UpdateMemoryEntryRequest = z.infer<typeof updateMemoryEntryRequestSchema>;

/**
 * Either points at an already-existing entry as the successor, or supplies the
 * fields for a brand-new one (the recommended UX: "Supersede" always creates a
 * fresh entry and links it automatically). Both paths go through the same
 * store-level cycle/self/cross-project checks.
 */
export const supersedeMemoryEntryRequestSchema = z.union([
  z.object({ newEntryId: uuid }).strict(),
  z.object({
    type: memoryTypeSchema,
    title: z.string().trim().min(1).max(200),
    body: z.string().trim().min(1).max(10000),
    importance: memoryImportanceSchema.default('normal'),
    isPinned: z.boolean().default(false),
    relatedTaskId: uuid.nullable().optional(),
    relatedMilestoneId: uuid.nullable().optional(),
  }).strict(),
]);
export type SupersedeMemoryEntryRequest = z.infer<typeof supersedeMemoryEntryRequestSchema>;

export const memoryListQuerySchema = z.object({
  type: memoryTypeSchema.optional(),
  pinned: z.literal('true').optional(),
  archived: z.literal('true').optional(),
  superseded: z.literal('true').optional(),
  search: optionalText(200).optional(),
  // Restricts to entries getProjectResume actually needs (pinned or
  // importance in important/critical) — the same predicate
  // compareImportantMemory (resume/store.ts) filters for in JS, pushed into
  // SQL so the query itself is bounded instead of loading every entry.
  importantOnly: z.literal('true').optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional().default(50),
  // Cursor over (is_pinned, created_at, id) — is_pinned is the primary sort
  // key (see memoryListResponseSchema's doc comment), so all three must be
  // supplied together or not at all.
  beforeIsPinned: z.enum(['true', 'false']).optional(),
  beforeCreatedAt: timestamp.optional(),
  beforeId: uuid.optional(),
}).strict().superRefine((value, ctx) => {
  const cursorFields = [value.beforeIsPinned, value.beforeCreatedAt, value.beforeId];
  const presentCount = cursorFields.filter((field) => field !== undefined).length;
  if (presentCount !== 0 && presentCount !== 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['beforeCreatedAt'], message: 'beforeIsPinned, beforeCreatedAt and beforeId must be supplied together.' });
  }
});
export type MemoryListQuery = z.infer<typeof memoryListQuerySchema>;

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

const snapshotMilestoneSchema = z.object({ milestoneId: uuid, title: z.string(), priority: roadmapPrioritySchema, blockedReason: z.string().nullable() });
const snapshotTaskSchema = z.object({ taskId: uuid, title: z.string(), milestoneId: uuid, milestoneTitle: z.string(), status: roadmapStatusSchema, blockedReason: z.string().nullable(), nextAction: z.string() });
const snapshotAcceptanceSchema = z.object({ taskId: uuid, title: z.string(), milestoneId: uuid, milestoneTitle: z.string(), pendingCount: z.number().int().nonnegative() });
const snapshotDependencySchema = z.object({ taskId: uuid, title: z.string(), milestoneId: uuid, dependsOnTaskId: uuid, dependsOnTitle: z.string(), dependsOnStatus: roadmapStatusSchema });
const snapshotCompletedTaskSchema = z.object({ taskId: uuid, title: z.string(), milestoneId: uuid, milestoneTitle: z.string(), completedAt: timestamp });
const snapshotMemorySchema = z.object({ id: uuid, type: memoryTypeSchema, title: z.string(), importance: memoryImportanceSchema });

/**
 * Snapshot format versioning. v1 shipped without any Agent Run awareness; v2
 * adds a small, body-free `recentAgentActivity` list; v3 adds a compact,
 * metadata-only Git state. Old rows keep whatever
 * `snapshot_version` they were written with — they are never rewritten — so
 * all shapes must stay parseable indefinitely.
 */
const checkpointSnapshotBaseSchema = z.object({
  projectId: uuid,
  projectName: z.string(),
  projectStatus: z.string(),
  generatedAt: timestamp,
  currentFocus: z.array(snapshotMilestoneSchema),
  inProgressTasks: z.array(snapshotTaskSchema),
  blockedMilestones: z.array(snapshotMilestoneSchema),
  blockedTasks: z.array(snapshotTaskSchema),
  nextActions: z.array(snapshotTaskSchema),
  pendingAcceptance: z.array(snapshotAcceptanceSchema),
  unresolvedDependencies: z.array(snapshotDependencySchema),
  recentlyCompletedTasks: z.array(snapshotCompletedTaskSchema),
  pinnedMemory: z.array(snapshotMemorySchema),
  importantMemory: z.array(snapshotMemorySchema),
});

export const checkpointSnapshotV1Schema = checkpointSnapshotBaseSchema.extend({ version: z.literal(1) });
export const checkpointSnapshotV2Schema = checkpointSnapshotBaseSchema.extend({
  version: z.literal(2),
  recentAgentActivity: z.array(recentAgentActivitySchema),
});
export const checkpointSnapshotV3Schema = checkpointSnapshotBaseSchema.extend({
  version: z.literal(3),
  recentAgentActivity: z.array(recentAgentActivitySchema),
  gitState: checkpointGitStateSchema,
}).strict();
export const checkpointSnapshotSchema = z.discriminatedUnion('version', [checkpointSnapshotV1Schema, checkpointSnapshotV2Schema, checkpointSnapshotV3Schema]);
export type CheckpointSnapshotV1 = z.infer<typeof checkpointSnapshotV1Schema>;
export type CheckpointSnapshotV2 = z.infer<typeof checkpointSnapshotV2Schema>;
export type CheckpointSnapshotV3 = z.infer<typeof checkpointSnapshotV3Schema>;
export type CheckpointSnapshot = z.infer<typeof checkpointSnapshotSchema>;

export const checkpointSummarySchema = z.object({
  id: uuid,
  projectId: uuid,
  snapshotVersion: z.number().int(),
  sessionNote: z.string().nullable(),
  createdBy: uuid.nullable(),
  createdAt: timestamp,
  archivedAt: timestamp.nullable(),
});
export type CheckpointSummary = z.infer<typeof checkpointSummarySchema>;

export const checkpointDetailSchema = checkpointSummarySchema.extend({ snapshot: checkpointSnapshotSchema });
export type CheckpointDetail = z.infer<typeof checkpointDetailSchema>;

export const checkpointListQuerySchema = z.object({
  archived: z.literal('true').optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(50),
  beforeCreatedAt: timestamp.optional(),
  beforeId: uuid.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.beforeCreatedAt === undefined) !== (value.beforeId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['beforeCreatedAt'], message: 'beforeCreatedAt and beforeId must be supplied together.' });
  }
});
export type CheckpointListQuery = z.infer<typeof checkpointListQuerySchema>;

export const checkpointListResponseSchema = z.object({
  checkpoints: z.array(checkpointSummarySchema),
  pageSize: z.number().int().positive().optional().default(50),
  nextCursor: z.object({ createdAt: timestamp, id: uuid }).nullable().default(null),
});
export const checkpointDetailResponseSchema = z.object({ checkpoint: checkpointDetailSchema });
export const checkpointSummaryResponseSchema = z.object({ checkpoint: checkpointSummarySchema });
export type CheckpointListResponse = z.infer<typeof checkpointListResponseSchema>;
export type CheckpointDetailResponse = z.infer<typeof checkpointDetailResponseSchema>;
export type CheckpointSummaryResponse = z.infer<typeof checkpointSummaryResponseSchema>;

export const createCheckpointRequestSchema = z.object({ sessionNote: optionalText(4000).optional() }).strict();
export type CreateCheckpointRequest = z.infer<typeof createCheckpointRequestSchema>;

// ---------------------------------------------------------------------------
// Current context / "Where was I?"
// ---------------------------------------------------------------------------

export const projectContextResponseSchema = z.object({
  projectId: uuid,
  currentFocus: z.array(snapshotMilestoneSchema),
  inProgressTasks: z.array(snapshotTaskSchema),
  blocked: z.object({ milestones: z.array(snapshotMilestoneSchema), tasks: z.array(snapshotTaskSchema) }),
  nextActions: z.array(snapshotTaskSchema),
  pendingAcceptance: z.array(snapshotAcceptanceSchema),
  unresolvedDependencies: z.array(snapshotDependencySchema),
  pinnedContext: z.array(memoryEntrySchema),
  recentAgentWork: z.array(recentAgentActivitySchema),
  lastCheckpoint: checkpointSummarySchema.nullable(),
  changesSinceCheckpoint: z.object({
    hasCheckpoint: z.boolean(),
    sinceCheckpointId: uuid.nullable(),
    sinceCreatedAt: timestamp.nullable(),
    items: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int().positive() })),
  }),
});
export type ProjectContextResponse = z.infer<typeof projectContextResponseSchema>;
