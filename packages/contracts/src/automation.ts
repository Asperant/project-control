import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common.js';
import { serviceScopeSchema } from './service-accounts.js';

/**
 * `GET /api/automation/whoami` — the one route both a user and a service
 * principal can call. Its only purpose is letting an operator confirm a
 * freshly minted token actually authenticates (see the manual checkpoint in
 * docs/service-accounts.md) without needing a browser session.
 */
export const whoamiResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('user'),
    userId: z.string().uuid(),
    role: z.enum(['admin', 'operator', 'viewer']),
  }).strict(),
  z.object({
    kind: z.literal('service'),
    accountKey: z.string().min(1).max(64),
    scopes: z.array(serviceScopeSchema),
  }).strict(),
]);
export type WhoamiResponse = z.infer<typeof whoamiResponseSchema>;

/**
 * Workflow manifest — the repository-owned definition of every workflow this
 * platform knows how to run. Read-only-mounted into the Control API and
 * validated at boot; a route can list a workflow and open/settle a run for
 * one, but no route (and no service token, however scoped) can ever create,
 * edit or remove an entry. See docs/automation.md.
 */
export const workflowTriggerSchema = z.enum(['manual', 'scheduled']);
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>;

export const workflowRunScopeSchema = z.enum(['global', 'project']);
export type WorkflowRunScope = z.infer<typeof workflowRunScopeSchema>;

export const workflowIdempotencyWindowSchema = z.enum(['none', 'hour', 'day']);
export type WorkflowIdempotencyWindow = z.infer<typeof workflowIdempotencyWindowSchema>;

export const workflowSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type WorkflowSeverity = z.infer<typeof workflowSeveritySchema>;

const workflowKeySchema = z.string().regex(/^[a-z0-9-]{3,48}$/, 'must be kebab-case, 3-48 characters');

export const workflowDefinitionSchema = z.object({
  key: workflowKeySchema,
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  trigger: workflowTriggerSchema,
  /** Documentation only — n8n's own schedule trigger holds the real cron.
   * Required when trigger is 'scheduled', absent otherwise (superRefine below). */
  schedule: z.string().min(1).max(120).optional(),
  scope: workflowRunScopeSchema,
  timeoutSeconds: z.number().int().positive().max(3600),
  idempotencyWindow: workflowIdempotencyWindowSchema,
  /** Scopes a service token must carry to open/claim a run for this workflow. */
  requiredScopes: z.array(serviceScopeSchema).min(1),
  notify: z.object({ info: z.boolean(), warning: z.boolean(), critical: z.boolean() }).strict(),
}).strict().superRefine((workflow, ctx) => {
  if (workflow.trigger === 'scheduled' && !workflow.schedule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A scheduled workflow must declare schedule.', path: ['schedule'] });
  }
  if (workflow.trigger === 'manual' && workflow.schedule) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A manual workflow must not declare schedule.', path: ['schedule'] });
  }
});
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

export const automationManifestSchema = z.object({
  version: z.literal(1),
  workflows: z.array(workflowDefinitionSchema).min(1).max(64),
}).strict().superRefine((manifest, ctx) => {
  const seen = new Set<string>();
  for (const [index, workflow] of manifest.workflows.entries()) {
    if (seen.has(workflow.key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate workflow key: ${workflow.key}`,
        path: ['workflows', index, 'key'],
      });
    }
    seen.add(workflow.key);
  }
});
export type AutomationManifest = z.infer<typeof automationManifestSchema>;

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

export const workflowRunStatusSchema = z.enum([
  'queued', 'running', 'completed', 'failed', 'waiting_for_approval', 'cancelled', 'expired',
]);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;

export const workflowRunTriggerKindSchema = workflowTriggerSchema;

export const workflowRunStepStatusSchema = z.enum(['passed', 'failed', 'skipped', 'warning']);
export type WorkflowRunStepStatus = z.infer<typeof workflowRunStepStatusSchema>;

export const workflowRunStepSchema = z.object({
  id: uuidSchema,
  position: z.number().int().nonnegative(),
  name: z.string().min(1).max(200),
  status: workflowRunStepStatusSchema,
  detail: z.record(z.string(), z.unknown()),
  recordedAt: timestampSchema,
}).strict();
export type WorkflowRunStep = z.infer<typeof workflowRunStepSchema>;

export const workflowRunResultSchema = z.object({
  summary: z.string().min(1).max(2000),
  severity: workflowSeveritySchema,
  linkedActionId: uuidSchema.nullable(),
  artifactId: uuidSchema.nullable(),
  reason: z.string().min(1).max(120).nullable(),
}).strict();
export type WorkflowRunResult = z.infer<typeof workflowRunResultSchema>;

export const workflowRunSchema = z.object({
  id: uuidSchema,
  workflowKey: workflowKeySchema,
  projectId: uuidSchema.nullable(),
  status: workflowRunStatusSchema,
  triggerKind: workflowRunTriggerKindSchema,
  triggeredByUserId: uuidSchema.nullable(),
  serviceTokenId: uuidSchema.nullable(),
  externalRef: z.string().max(200).nullable(),
  queuedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  settledAt: timestampSchema.nullable(),
  result: workflowRunResultSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const workflowRunDetailSchema = z.object({
  run: workflowRunSchema,
  steps: z.array(workflowRunStepSchema),
});
export type WorkflowRunDetail = z.infer<typeof workflowRunDetailSchema>;

export const workflowRunListResponseSchema = z.object({
  runs: z.array(workflowRunSchema),
  total: z.number().int().nonnegative(),
});
export type WorkflowRunListResponse = z.infer<typeof workflowRunListResponseSchema>;

export const workflowRunListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
  workflowKey: workflowKeySchema.optional(),
  projectId: uuidSchema.optional(),
  status: workflowRunStatusSchema.optional(),
});
export type WorkflowRunListQuery = z.infer<typeof workflowRunListQuerySchema>;

/** `GET /api/automation/workflows` — manifest entry plus its most recent run. */
export const workflowSummarySchema = z.object({
  workflow: workflowDefinitionSchema,
  lastRun: workflowRunSchema.nullable(),
}).strict();
export type WorkflowSummary = z.infer<typeof workflowSummarySchema>;

export const workflowListResponseSchema = z.object({ workflows: z.array(workflowSummarySchema) });
export type WorkflowListResponse = z.infer<typeof workflowListResponseSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** User-initiated, from the panel's "Run now". */
export const requestWorkflowRunRequestSchema = z.object({
  projectId: uuidSchema.optional(),
}).strict();
export type RequestWorkflowRunRequest = z.infer<typeof requestWorkflowRunRequestSchema>;

/** Service-initiated, from n8n's own schedule trigger. Opens a run directly in 'running'. */
export const openWorkflowRunRequestSchema = z.object({
  workflowKey: workflowKeySchema,
  projectId: uuidSchema.optional(),
  externalRef: z.string().min(1).max(200).optional(),
}).strict();
export type OpenWorkflowRunRequest = z.infer<typeof openWorkflowRunRequestSchema>;

export const addWorkflowRunStepRequestSchema = z.object({
  position: z.number().int().nonnegative(),
  name: z.string().min(1).max(200),
  status: workflowRunStepStatusSchema,
  detail: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type AddWorkflowRunStepRequest = z.infer<typeof addWorkflowRunStepRequestSchema>;

export const settleWorkflowRunRequestSchema = z.object({
  status: z.enum(['completed', 'failed', 'waiting_for_approval']),
  summary: z.string().min(1).max(2000),
  severity: workflowSeveritySchema,
  linkedActionId: uuidSchema.optional(),
  /** The id returned by a prior POST /api/automation/runs/:id/artifact call. */
  artifactId: uuidSchema.optional(),
}).strict();
export type SettleWorkflowRunRequest = z.infer<typeof settleWorkflowRunRequestSchema>;

/** `POST /api/automation/runs/:id/artifact` — attaches a small text report to a run. */
export const attachWorkflowRunArtifactRequestSchema = z.object({
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(100).default('text/markdown'),
  content: z.string().min(1).max(524_288),
}).strict();
export type AttachWorkflowRunArtifactRequest = z.infer<typeof attachWorkflowRunArtifactRequestSchema>;

export const attachWorkflowRunArtifactResponseSchema = z.object({
  artifactId: uuidSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type AttachWorkflowRunArtifactResponse = z.infer<typeof attachWorkflowRunArtifactResponseSchema>;

export const settleWorkflowRunResponseSchema = z.object({
  run: workflowRunSchema,
  /** Server-computed from the workflow's manifest `notify` policy and the
   * settled severity — the workflow's own logic never decides this. */
  notify: z.boolean(),
});
export type SettleWorkflowRunResponse = z.infer<typeof settleWorkflowRunResponseSchema>;

export const workflowRunResponseSchema = z.object({ run: workflowRunSchema });
export type WorkflowRunResponse = z.infer<typeof workflowRunResponseSchema>;

export const claimWorkflowRunResponseSchema = z.object({ run: workflowRunSchema.nullable() });
export type ClaimWorkflowRunResponse = z.infer<typeof claimWorkflowRunResponseSchema>;
