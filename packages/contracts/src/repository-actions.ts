import { z } from 'zod';
import { sha256Schema, timestampSchema, uuidSchema } from './common.js';

/**
 * Repository Actions: controlled, previewed, explicitly confirmed mutations
 * against a registered project's own repository.
 *
 * The lifecycle is fixed and narrow by design — see docs/repository-actions.md:
 *
 *   plan (preview) -> execute (confirm + run, one request) -> verify -> settle
 *
 * There is no "awaiting confirmation" status distinct from `planned`: the
 * execute request itself carries the fingerprint the operator was shown, so
 * confirming and running are the same atomic step rather than two separate
 * states with a window between them.
 *
 * The only action kind in this version is `git.commit`. Nothing here can
 * express a shell command, an argv, or a working-directory override — every
 * field is either server-computed or a short, individually validated value
 * (a branch name, a commit message, a list of repository-relative paths).
 */

export const repositoryActionKindSchema = z.enum(['git.commit']);
export type RepositoryActionKind = z.infer<typeof repositoryActionKindSchema>;

export const repositoryActionStatusSchema = z.enum([
  'planned', 'running', 'succeeded', 'failed', 'cancelled', 'expired',
]);
export type RepositoryActionStatus = z.infer<typeof repositoryActionStatusSchema>;

export const repositoryActionRiskSchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RepositoryActionRisk = z.infer<typeof repositoryActionRiskSchema>;

const repositoryRelativePathSchema = z.string().min(1).max(4096).superRefine((path, ctx) => {
  if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Path must remain relative to the repository.' });
  }
});

/** What the operator requests: which paths, and what message to commit them with. */
export const planGitCommitRequestSchema = z.object({
  paths: z.array(repositoryRelativePathSchema).min(1).max(200),
  message: z.string().min(1).max(8192),
}).strict();
export type PlanGitCommitRequest = z.infer<typeof planGitCommitRequestSchema>;

/** The server-computed plan preview. Stored verbatim as project_actions.plan_json. */
export const gitCommitPlanSchema = z.object({
  kind: z.literal('git.commit'),
  branch: z.string().min(1).max(1024),
  isDefaultBranch: z.boolean(),
  /** null only when the branch is unborn (no commits yet). */
  expectedHead: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  selectedPaths: z.array(repositoryRelativePathSchema).min(1).max(200),
  /** Paths the operator selected that were silently unselectable because they
   * matched the protected-path denylist — shown back for transparency, never
   * committed regardless of what the caller sends. */
  excludedProtectedPaths: z.array(repositoryRelativePathSchema).max(200),
  message: z.string().min(1).max(8192),
}).strict();
export type GitCommitPlan = z.infer<typeof gitCommitPlanSchema>;

/** Confirms and runs a previously planned action in one request. */
export const executeRepositoryActionRequestSchema = z.object({
  fingerprint: sha256Schema,
  /** Required, and must equal the plan's branch, only when risk is 'high' —
   * a second, explicit acknowledgement for a commit to the default branch. */
  confirmBranch: z.string().min(1).max(1024).optional(),
}).strict();
export type ExecuteRepositoryActionRequest = z.infer<typeof executeRepositoryActionRequestSchema>;

export const gitCommitResultSchema = z.object({
  kind: z.literal('git.commit'),
  commitSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
  shortSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  previousHeadSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  branch: z.string().min(1).max(1024),
  fileCount: z.number().int().positive(),
  indexReconciled: z.boolean(),
  /** true when a post-execution read confirmed HEAD actually moved to
   * commitSha; false only for a result recovered by reconcile after an API
   * crash, where that confirmation could not be performed at execute time. */
  verified: z.boolean(),
}).strict();
export type GitCommitResult = z.infer<typeof gitCommitResultSchema>;

/** Stable failure reason codes surfaced from the runner or the Control API's
 * own re-validation. The web panel renders each of these as fixed copy. */
export const repositoryActionFailureReasonSchema = z.enum([
  'unsupported_git_layout', 'detached_head', 'branch_mismatch', 'head_moved',
  'merge_in_progress', 'unmerged_paths', 'commit_identity_missing',
  'protected_path_selected', 'submodule_path_selected', 'empty_selection',
  'invalid_path', 'empty_message', 'write_not_enabled', 'runner_unavailable',
  'verification_failed', 'execution_interrupted',
]);
export type RepositoryActionFailureReason = z.infer<typeof repositoryActionFailureReasonSchema>;

export const repositoryActionResultSchema = z.object({
  succeeded: z.boolean(),
  commit: gitCommitResultSchema.nullable(),
  reason: repositoryActionFailureReasonSchema.nullable(),
  /** Set only by the reconcile path, when a crash during execution made a
   * definitive verification impossible and the outcome was inferred from a
   * fresh repository read instead. */
  reconciledFromInterruption: z.boolean(),
}).strict().superRefine((result, ctx) => {
  if (result.succeeded && (result.commit === null || result.reason !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A succeeded result must carry a commit and no reason.' });
  }
  if (!result.succeeded && (result.commit !== null || result.reason === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A failed result must carry a reason and no commit.' });
  }
});
export type RepositoryActionResult = z.infer<typeof repositoryActionResultSchema>;

export const repositoryActionSchema = z.object({
  id: uuidSchema,
  projectId: uuidSchema,
  kind: repositoryActionKindSchema,
  status: repositoryActionStatusSchema,
  risk: repositoryActionRiskSchema,
  plan: gitCommitPlanSchema,
  /** Not a secret — a consistency checksum the client must echo back
   * verbatim on execute, proving it is confirming the exact plan it was
   * shown rather than one that has since gone stale. See
   * ExecuteRepositoryActionRequest and repository-actions/store.ts. */
  fingerprint: sha256Schema,
  expiresAt: timestampSchema,
  requestedBy: uuidSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  settledAt: timestampSchema.nullable(),
  result: repositoryActionResultSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();
export type RepositoryAction = z.infer<typeof repositoryActionSchema>;

export const repositoryActionResponseSchema = z.object({ action: repositoryActionSchema });
export type RepositoryActionResponse = z.infer<typeof repositoryActionResponseSchema>;

export const repositoryActionListResponseSchema = z.object({
  actions: z.array(repositoryActionSchema),
  total: z.number().int().nonnegative(),
});
export type RepositoryActionListResponse = z.infer<typeof repositoryActionListResponseSchema>;

export const repositoryActionListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(100).default(20),
});
export type RepositoryActionListQuery = z.infer<typeof repositoryActionListQuerySchema>;
