import { z } from 'zod';

/**
 * Manual Agent Run provenance archive.
 *
 * This is an archive, not an integration: nothing here calls Claude, Codex, or
 * any other API. A user pastes a prompt in, sends it by hand, and pastes the
 * agent's report back in by hand. See docs/agent-runs.md.
 *
 * Agent Run *status* (what the agent/run lifecycle says happened) and
 * *validation status* (what the human actually confirmed) are deliberately
 * separate fields — a completed run can have a rejected validation.
 */

const uuid = z.string().uuid();
const timestamp = z.string().datetime({ offset: true });

export const agentRunStatusSchema = z.enum(['draft', 'sent', 'in_progress', 'completed', 'failed', 'cancelled']);
export const agentValidationStatusSchema = z.enum(['not_reviewed', 'under_review', 'accepted', 'accepted_with_changes', 'rejected']);
export const agentPromptStatusSchema = z.enum(['draft', 'sent']);
export const agentReportStatusSchema = z.enum(['draft', 'final', 'superseded']);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;
export type AgentValidationStatus = z.infer<typeof agentValidationStatusSchema>;
export type AgentPromptStatus = z.infer<typeof agentPromptStatusSchema>;
export type AgentReportStatus = z.infer<typeof agentReportStatusSchema>;

/** Status values reachable through the generic lifecycle endpoint; draft/sent are set by other flows. */
export const setAgentRunStatusRequestSchema = z.object({
  status: z.enum(['in_progress', 'completed', 'failed', 'cancelled']),
}).strict();
export type SetAgentRunStatusRequest = z.infer<typeof setAgentRunStatusRequestSchema>;

export const agentRunSchema = z.object({
  id: uuid,
  projectId: uuid,
  title: z.string(),
  agentName: z.string(),
  status: agentRunStatusSchema,
  relatedMilestoneId: uuid.nullable(),
  relatedMilestoneTitle: z.string().nullable(),
  relatedTaskId: uuid.nullable(),
  relatedTaskTitle: z.string().nullable(),
  validationStatus: agentValidationStatusSchema,
  validationNote: z.string().nullable(),
  validatedBy: uuid.nullable(),
  validatedAt: timestamp.nullable(),
  sentAt: timestamp.nullable(),
  startedAt: timestamp.nullable(),
  completedAt: timestamp.nullable(),
  failedAt: timestamp.nullable(),
  cancelledAt: timestamp.nullable(),
  createdBy: uuid.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: timestamp.nullable(),
  hasPrompt: z.boolean(),
  currentReportVersion: z.number().int().nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const agentRunListResponseSchema = z.object({ agentRuns: z.array(agentRunSchema) });
export const agentRunResponseSchema = z.object({ agentRun: agentRunSchema });
export type AgentRunListResponse = z.infer<typeof agentRunListResponseSchema>;
export type AgentRunResponse = z.infer<typeof agentRunResponseSchema>;

export const createAgentRunRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  agentName: z.string().trim().min(1).max(80),
  relatedMilestoneId: uuid.nullable().optional(),
  relatedTaskId: uuid.nullable().optional(),
}).strict();
export type CreateAgentRunRequest = z.infer<typeof createAgentRunRequestSchema>;

export const updateAgentRunRequestSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  agentName: z.string().trim().min(1).max(80).optional(),
  relatedMilestoneId: uuid.nullable().optional(),
  relatedTaskId: uuid.nullable().optional(),
}).strict();
export type UpdateAgentRunRequest = z.infer<typeof updateAgentRunRequestSchema>;

export const agentRunListQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: agentRunStatusSchema.optional(),
  agentName: z.string().trim().max(80).optional(),
  validationStatus: agentValidationStatusSchema.optional(),
  archived: z.literal('true').optional(),
}).strict();
export type AgentRunListQuery = z.infer<typeof agentRunListQuerySchema>;

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

export const agentRunPromptSchema = z.object({
  id: uuid,
  agentRunId: uuid,
  promptVersion: z.number().int(),
  body: z.string(),
  status: agentPromptStatusSchema,
  sentAt: timestamp.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AgentRunPrompt = z.infer<typeof agentRunPromptSchema>;

export const agentRunPromptResponseSchema = z.object({ prompt: agentRunPromptSchema.nullable() });
export type AgentRunPromptResponse = z.infer<typeof agentRunPromptResponseSchema>;

export const upsertAgentRunPromptRequestSchema = z.object({
  body: z.string().trim().min(1).max(50000),
}).strict();
export type UpsertAgentRunPromptRequest = z.infer<typeof upsertAgentRunPromptRequestSchema>;

export const sendAgentRunPromptResponseSchema = z.object({ prompt: agentRunPromptSchema, agentRun: agentRunSchema });
export type SendAgentRunPromptResponse = z.infer<typeof sendAgentRunPromptResponseSchema>;

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export const agentReportSchema = z.object({
  id: uuid,
  agentRunId: uuid,
  version: z.number().int(),
  body: z.string(),
  status: agentReportStatusSchema,
  supersedesReportId: uuid.nullable(),
  supersededById: uuid.nullable(),
  finalizedAt: timestamp.nullable(),
  createdBy: uuid.nullable(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AgentReport = z.infer<typeof agentReportSchema>;

export const agentReportListResponseSchema = z.object({ reports: z.array(agentReportSchema) });
export const agentReportResponseSchema = z.object({ report: agentReportSchema });
export type AgentReportListResponse = z.infer<typeof agentReportListResponseSchema>;
export type AgentReportResponse = z.infer<typeof agentReportResponseSchema>;

export const createAgentReportRequestSchema = z.object({
  body: z.string().trim().min(1).max(100000),
}).strict();
export type CreateAgentReportRequest = z.infer<typeof createAgentReportRequestSchema>;

export const updateAgentReportRequestSchema = z.object({
  body: z.string().trim().min(1).max(100000),
}).strict();
export type UpdateAgentReportRequest = z.infer<typeof updateAgentReportRequestSchema>;

export const finalizeAgentReportResponseSchema = z.object({
  report: agentReportSchema,
  supersededReport: agentReportSchema.nullable(),
});
export type FinalizeAgentReportResponse = z.infer<typeof finalizeAgentReportResponseSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const updateAgentRunValidationRequestSchema = z.object({
  status: agentValidationStatusSchema,
  note: z.string().trim().max(10000).nullable().optional(),
}).strict();
export type UpdateAgentRunValidationRequest = z.infer<typeof updateAgentRunValidationRequestSchema>;

// ---------------------------------------------------------------------------
// Duplicate
// ---------------------------------------------------------------------------

export const duplicateAgentRunResponseSchema = z.object({ agentRun: agentRunSchema, prompt: agentRunPromptSchema.nullable() });
export type DuplicateAgentRunResponse = z.infer<typeof duplicateAgentRunResponseSchema>;

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export const agentRunTimelineEntrySchema = z.object({
  id: z.string(),
  occurredAt: timestamp,
  eventType: z.string(),
  label: z.string(),
  outcome: z.string(),
  actorUserId: uuid.nullable(),
});
export type AgentRunTimelineEntry = z.infer<typeof agentRunTimelineEntrySchema>;
export const agentRunTimelineResponseSchema = z.object({ timeline: z.array(agentRunTimelineEntrySchema) });
export type AgentRunTimelineResponse = z.infer<typeof agentRunTimelineResponseSchema>;

// ---------------------------------------------------------------------------
// Checkpoint / "Where was I?" — recent agent activity summary.
//
// Deliberately body-free: no prompt or report content is ever included in a
// checkpoint snapshot or the live context response.
// ---------------------------------------------------------------------------

export const recentAgentActivitySchema = z.object({
  agentRunId: uuid,
  title: z.string(),
  agentName: z.string(),
  status: agentRunStatusSchema,
  validationStatus: agentValidationStatusSchema,
  relatedTaskId: uuid.nullable(),
  activityAt: timestamp,
});
export type RecentAgentActivity = z.infer<typeof recentAgentActivitySchema>;
