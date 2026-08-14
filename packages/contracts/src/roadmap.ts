import { z } from 'zod';

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });
const optionalText = (max: number) => z.string().trim().max(max);

export const roadmapStatusSchema = z.enum(['planned', 'in_progress', 'blocked', 'done', 'cancelled']);
export const roadmapPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RoadmapStatus = z.infer<typeof roadmapStatusSchema>;
export type RoadmapPriority = z.infer<typeof roadmapPrioritySchema>;

export const roadmapProgressSchema = z.object({ completed: z.number().int().nonnegative(), total: z.number().int().nonnegative(), percentage: z.number().int().min(0).max(100) });
export type RoadmapProgress = z.infer<typeof roadmapProgressSchema>;

export const roadmapTaskSchema = z.object({
  id: uuid, milestoneId: uuid, title: z.string(), description: z.string(), status: roadmapStatusSchema,
  priority: roadmapPrioritySchema, position: z.number().int().nonnegative(), blockedReason: z.string().nullable(),
  nextAction: z.string(), startedAt: timestamp.nullable(), completedAt: timestamp.nullable(), cancelledAt: timestamp.nullable(),
  createdBy: uuid.nullable(), createdAt: timestamp, updatedAt: timestamp,
  incompleteAcceptanceCount: z.number().int().nonnegative(), unresolvedDependencyCount: z.number().int().nonnegative(),
});
export type RoadmapTask = z.infer<typeof roadmapTaskSchema>;

export const roadmapMilestoneSchema = z.object({
  id: uuid, projectId: uuid, title: z.string(), description: z.string(), status: roadmapStatusSchema,
  priority: roadmapPrioritySchema, position: z.number().int().nonnegative(), targetDate: z.string().nullable(),
  blockedReason: z.string().nullable(), startedAt: timestamp.nullable(), completedAt: timestamp.nullable(),
  archivedAt: timestamp.nullable(), createdBy: uuid.nullable(), createdAt: timestamp, updatedAt: timestamp,
  progress: roadmapProgressSchema, tasks: z.array(roadmapTaskSchema),
});
export type RoadmapMilestone = z.infer<typeof roadmapMilestoneSchema>;

export const acceptanceCriterionSchema = z.object({ id: uuid, taskId: uuid, text: z.string(), position: z.number().int().nonnegative(), isCompleted: z.boolean(), completedAt: timestamp.nullable(), completedBy: uuid.nullable(), createdAt: timestamp, updatedAt: timestamp });
export const taskDependencySchema = z.object({ taskId: uuid, dependsOnTaskId: uuid, title: z.string(), status: roadmapStatusSchema, resolved: z.boolean(), createdAt: timestamp });
export const taskNoteSchema = z.object({ id: uuid, taskId: uuid, body: z.string(), createdBy: uuid.nullable(), createdAt: timestamp, updatedAt: timestamp });
export const roadmapActivitySchema = z.object({ id: z.string(), occurredAt: timestamp, eventType: z.string(), label: z.string(), outcome: z.string(), actorUserId: uuid.nullable() });

export const projectRoadmapResponseSchema = z.object({ projectId: uuid, readOnly: z.boolean(), progress: roadmapProgressSchema, milestones: z.array(roadmapMilestoneSchema) });
export const taskDetailResponseSchema = z.object({ task: roadmapTaskSchema, criteria: z.array(acceptanceCriterionSchema), dependencies: z.array(taskDependencySchema), notes: z.array(taskNoteSchema), activity: z.array(roadmapActivitySchema), dependencyCandidates: z.array(z.object({ id: uuid, milestoneId: uuid, title: z.string(), status: roadmapStatusSchema })) });
export const roadmapMutationResponseSchema = z.object({ roadmap: projectRoadmapResponseSchema });
export const taskDetailMutationResponseSchema = z.object({ detail: taskDetailResponseSchema });
export const roadmapActivityResponseSchema = z.object({ entries: z.array(roadmapActivitySchema) });

const milestoneInputSchema = z.object({ title: z.string().trim().min(1).max(200), description: optionalText(10000), status: roadmapStatusSchema, priority: roadmapPrioritySchema, targetDate: z.string().date().nullable().optional(), blockedReason: optionalText(2000).nullable().optional() }).strict();
export const createMilestoneRequestSchema = milestoneInputSchema.extend({ description: optionalText(10000).default(''), status: roadmapStatusSchema.default('planned'), priority: roadmapPrioritySchema.default('medium') }).superRefine((value, ctx) => { if (value.status === 'blocked' && !value.blockedReason) ctx.addIssue({ code: 'custom', path: ['blockedReason'], message: 'Required when status is blocked.' }); });
export const updateMilestoneRequestSchema = milestoneInputSchema.partial().strict();
export const changeMilestoneStatusRequestSchema = z.object({ status: roadmapStatusSchema, blockedReason: optionalText(2000).nullable().optional() }).strict();
export const createTaskRequestSchema = z.object({ title: z.string().trim().min(1).max(200), description: optionalText(10000).default(''), status: roadmapStatusSchema.exclude(['blocked']).default('planned'), priority: roadmapPrioritySchema.default('medium') }).strict();
export const updateTaskRequestSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), description: optionalText(10000).optional(), priority: roadmapPrioritySchema.optional(), nextAction: optionalText(4000).optional() }).strict();
export const changeTaskStatusRequestSchema = z.object({ status: roadmapStatusSchema, blockedReason: optionalText(2000).nullable().optional(), acknowledgeIncompleteAcceptance: z.boolean().optional(), acknowledgeIncompleteDependencies: z.boolean().optional() }).strict();
export const directionRequestSchema = z.object({ direction: z.enum(['up', 'down']) }).strict();
export const criterionRequestSchema = z.object({ text: z.string().trim().min(1).max(2000) }).strict();
export const criterionCompletionRequestSchema = z.object({ isCompleted: z.boolean() }).strict();
export const dependencyRequestSchema = z.object({ dependsOnTaskId: uuid }).strict();
export const noteRequestSchema = z.object({ body: z.string().trim().min(1).max(10000) }).strict();

export type CreateMilestoneRequest = z.infer<typeof createMilestoneRequestSchema>;
export type UpdateMilestoneRequest = z.infer<typeof updateMilestoneRequestSchema>;
export type ChangeMilestoneStatusRequest = z.infer<typeof changeMilestoneStatusRequestSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;
export type ChangeTaskStatusRequest = z.infer<typeof changeTaskStatusRequestSchema>;
export type DirectionRequest = z.infer<typeof directionRequestSchema>;
export type CriterionRequest = z.infer<typeof criterionRequestSchema>;
export type CriterionCompletionRequest = z.infer<typeof criterionCompletionRequestSchema>;
export type DependencyRequest = z.infer<typeof dependencyRequestSchema>;
export type NoteRequest = z.infer<typeof noteRequestSchema>;
export type ProjectRoadmapResponse = z.infer<typeof projectRoadmapResponseSchema>;
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;
