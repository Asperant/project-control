import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common.js';
import { recentAgentActivitySchema } from './agent-runs.js';
import { checkpointSummarySchema, memoryEntrySchema } from './memory.js';
import { roadmapPrioritySchema } from './roadmap.js';
import { developmentAttentionKeySchema, resumeDevelopmentStateSchema } from './development.js';

export const workSessionStatusSchema = z.enum(['open', 'closed']);
export type WorkSessionStatus = z.infer<typeof workSessionStatusSchema>;

export const workSessionAmendmentSchema = z.object({
  id: uuidSchema,
  workSessionId: uuidSchema,
  body: z.string(),
  createdBy: uuidSchema.nullable(),
  createdAt: timestampSchema,
});
export type WorkSessionAmendment = z.infer<typeof workSessionAmendmentSchema>;

export const workSessionSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  goal: z.string(),
  status: workSessionStatusSchema,
  startedAt: timestampSchema,
  endedAt: timestampSchema.nullable(),
  outcomeSummary: z.string().nullable(),
  blockers: z.string().nullable(),
  nextAction: z.string().nullable(),
  checkpointId: uuidSchema.nullable(),
  createdBy: uuidSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  amendments: z.array(workSessionAmendmentSchema),
}).superRefine((session, ctx) => {
  if (session.status === 'open' && (session.endedAt !== null || session.outcomeSummary !== null || session.blockers !== null || session.nextAction !== null || session.checkpointId !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Open Work Sessions cannot contain closure fields.' });
  }
  if (session.status === 'closed' && (session.endedAt === null || session.outcomeSummary === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Closed Work Sessions require endedAt and outcomeSummary.' });
  }
});
export type WorkSession = z.infer<typeof workSessionSchema>;

export const startWorkSessionRequestSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
}).strict();
export type StartWorkSessionRequest = z.infer<typeof startWorkSessionRequestSchema>;

export const updateWorkSessionRequestSchema = z.object({
  goal: z.string().trim().min(1).max(4000),
}).strict();
export type UpdateWorkSessionRequest = z.infer<typeof updateWorkSessionRequestSchema>;

export const closeWorkSessionRequestSchema = z.object({
  outcomeSummary: z.string().trim().min(1).max(10000),
  blockers: z.string().trim().min(1).max(4000).optional(),
  nextAction: z.string().trim().min(1).max(4000).optional(),
  createCheckpoint: z.boolean().optional().default(false),
  checkpointSessionNote: z.string().trim().max(4000).optional(),
}).strict().superRefine((value, ctx) => {
  if (!value.createCheckpoint && value.checkpointSessionNote !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['checkpointSessionNote'], message: 'Requires createCheckpoint=true.' });
  }
});
export type CloseWorkSessionRequest = z.infer<typeof closeWorkSessionRequestSchema>;

export const addWorkSessionAmendmentRequestSchema = z.object({
  body: z.string().trim().min(1).max(10000),
}).strict();
export type AddWorkSessionAmendmentRequest = z.infer<typeof addWorkSessionAmendmentRequestSchema>;

export const workSessionListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
  status: workSessionStatusSchema.optional(),
  beforeStartedAt: timestampSchema.optional(),
  beforeId: uuidSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.beforeStartedAt === undefined) !== (value.beforeId === undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['beforeStartedAt'], message: 'beforeStartedAt and beforeId must be supplied together.' });
  }
});
export type WorkSessionListQuery = z.infer<typeof workSessionListQuerySchema>;

export const workSessionResponseSchema = z.object({ workSession: workSessionSchema });
export const workSessionListResponseSchema = z.object({
  workSessions: z.array(workSessionSchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  nextCursor: z.object({ startedAt: timestampSchema, id: uuidSchema }).nullable().default(null),
});
export const workSessionAmendmentResponseSchema = z.object({ amendment: workSessionAmendmentSchema });
export type WorkSessionResponse = z.infer<typeof workSessionResponseSchema>;
export type WorkSessionListResponse = z.infer<typeof workSessionListResponseSchema>;
export type WorkSessionAmendmentResponse = z.infer<typeof workSessionAmendmentResponseSchema>;

// ---------------------------------------------------------------------------
// Purpose-built deterministic Resume Project read model.
// ---------------------------------------------------------------------------

const selectedResumeTaskSchema = z.object({
  taskId: uuidSchema,
  milestoneId: uuidSchema,
  milestoneTitle: z.string(),
  taskTitle: z.string(),
  taskStatus: z.enum(['planned', 'in_progress']),
  priority: roadmapPrioritySchema,
});

export const resumeCurrentFocusSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('work_session'), workSessionId: uuidSchema, goal: z.string(), startedAt: timestampSchema }),
  selectedResumeTaskSchema.extend({ kind: z.literal('roadmap_task') }),
  z.object({ kind: z.literal('none'), message: z.string() }),
]);

export const resumeRecommendedNextActionSchema = z.discriminatedUnion('kind', [
  selectedResumeTaskSchema.extend({
    kind: z.literal('roadmap_task'),
    action: z.string(),
    actionSource: z.enum(['next_action', 'acceptance_criterion', 'task_title']),
  }),
  z.object({
    kind: z.literal('blocked'),
    message: z.string(),
    blockedTaskCount: z.number().int().nonnegative(),
    dependencyBlockedTaskCount: z.number().int().nonnegative(),
  }),
  z.object({ kind: z.literal('none_pending'), message: z.string() }),
]);

export const resumeAttentionItemSchema = z.object({
  key: z.union([
    z.enum(['blocked_tasks', 'unresolved_dependencies', 'incomplete_acceptance', 'agent_runs_awaiting_validation', 'failed_agent_runs', 'open_session_blockers']),
    developmentAttentionKeySchema,
  ]),
  label: z.string(),
  count: z.number().int().positive(),
});

export const resumeWorkItemSchema = z.object({
  taskId: uuidSchema,
  milestoneId: uuidSchema,
  milestoneTitle: z.string(),
  title: z.string(),
  status: z.enum(['in_progress', 'blocked']),
  blockedReason: z.string().nullable(),
  nextAction: z.string(),
});

export const resumeProjectResponseSchema = z.object({
  projectId: uuidSchema,
  readOnly: z.boolean(),
  developmentState: resumeDevelopmentStateSchema,
  currentFocus: resumeCurrentFocusSchema,
  recommendedNextAction: resumeRecommendedNextActionSchema,
  attentionRequired: z.object({
    blockedTaskCount: z.number().int().nonnegative(),
    unresolvedDependencyCount: z.number().int().nonnegative(),
    incompleteAcceptanceCount: z.number().int().nonnegative(),
    agentRunsAwaitingValidationCount: z.number().int().nonnegative(),
    failedAgentRunCount: z.number().int().nonnegative(),
    openSessionHasBlockers: z.boolean(),
    items: z.array(resumeAttentionItemSchema),
  }),
  activeWorkSession: workSessionSchema.nullable(),
  lastSession: workSessionSchema.nullable(),
  lastCheckpoint: checkpointSummarySchema.nullable(),
  changesSinceCheckpoint: z.object({
    hasCheckpoint: z.boolean(),
    sinceCheckpointId: uuidSchema.nullable(),
    sinceCreatedAt: timestampSchema.nullable(),
    items: z.array(z.object({ key: z.string(), label: z.string(), count: z.number().int().positive() })),
  }),
  activeAndBlockedWork: z.object({
    active: z.array(resumeWorkItemSchema),
    blocked: z.array(resumeWorkItemSchema),
  }),
  recentAgentWork: z.array(recentAgentActivitySchema),
  importantMemory: z.array(memoryEntrySchema),
  workSessionHistory: workSessionListResponseSchema,
}).superRefine((response, ctx) => {
  const sessions = [response.activeWorkSession, response.lastSession, ...response.workSessionHistory.workSessions]
    .filter((session): session is WorkSession => session !== null);
  if (sessions.some((session) => session.projectId !== response.projectId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['projectId'], message: 'Nested Work Sessions must belong to the resumed project.' });
  }
  if (response.activeWorkSession && response.activeWorkSession.status !== 'open') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['activeWorkSession'], message: 'The active Work Session must be open.' });
  }
  if (response.lastSession && response.lastSession.status !== 'closed') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lastSession'], message: 'The last Work Session must be closed.' });
  }
  if (response.workSessionHistory.workSessions.some((session) => session.status !== 'closed')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workSessionHistory'], message: 'Work Session history contains closed sessions only.' });
  }
});

export type ResumeCurrentFocus = z.infer<typeof resumeCurrentFocusSchema>;
export type ResumeRecommendedNextAction = z.infer<typeof resumeRecommendedNextActionSchema>;
export type ResumeProjectResponse = z.infer<typeof resumeProjectResponseSchema>;
