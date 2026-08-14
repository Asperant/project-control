import { z } from 'zod';
import { roadmapPrioritySchema, roadmapStatusSchema } from './roadmap.js';

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
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;

export const memoryListResponseSchema = z.object({ entries: z.array(memoryEntrySchema) });
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
}).strict();
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

export const checkpointSnapshotSchema = z.object({
  version: z.literal(1),
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

export const checkpointListResponseSchema = z.object({ checkpoints: z.array(checkpointSummarySchema) });
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
  lastCheckpoint: checkpointSummarySchema.nullable(),
  changesSinceCheckpoint: z.object({
    hasCheckpoint: z.boolean(),
    sinceCheckpointId: uuid.nullable(),
    sinceCreatedAt: timestamp.nullable(),
    items: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int().positive() })),
  }),
});
export type ProjectContextResponse = z.infer<typeof projectContextResponseSchema>;
