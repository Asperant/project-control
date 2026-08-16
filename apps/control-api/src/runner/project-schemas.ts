import { z } from 'zod';

/**
 * Validators for the `result` payload of the runner's project-registration
 * operations. `RunnerClient.invoke` already validates the outer envelope
 * (`runnerResponseSchema`); these narrow `result` — typed there only as
 * `Record<string, unknown>` — into something route handlers can use without
 * casting. The runner is a trusted component, but "trusted" still means every
 * boundary is parsed, not assumed, which is the same rule the rest of this
 * codebase applies to the browser and to the database.
 */

const gitRemoteSchema = z.object({ name: z.string(), url: z.string() });

export const runnerGitInfoSchema = z.object({
  present: z.boolean(),
  topLevelPath: z.string(),
  remotes: z.array(gitRemoteSchema),
  activeBranch: z.string(),
  detached: z.boolean(),
  defaultBranch: z.string(),
  defaultBranchConfidence: z.string(),
  lastCommitHash: z.string(),
  lastCommitShortHash: z.string(),
  lastCommitAt: z.string(),
  lastCommitSubject: z.string(),
  isDirty: z.boolean(),
  modifiedCount: z.number(),
  untrackedCount: z.number(),
});
export type RunnerGitInfo = z.infer<typeof runnerGitInfoSchema>;

const nullableStringSchema = z.string().nullable();

export const runnerGitDevelopmentSchema = z.object({
  repository: z.object({
    available: z.boolean(),
    isRepository: z.boolean(),
    errorCode: nullableStringSchema,
  }).strict(),
  head: z.object({
    sha: nullableStringSchema,
    shortSha: nullableStringSchema,
    branch: nullableStringSchema,
    detached: z.boolean(),
    unborn: z.boolean(),
  }).strict(),
  workingTree: z.object({
    clean: z.boolean(),
    stagedCount: z.number().int().nonnegative(),
    unstagedCount: z.number().int().nonnegative(),
    untrackedCount: z.number().int().nonnegative(),
    conflictedCount: z.number().int().nonnegative(),
    totalChangedCount: z.number().int().nonnegative(),
    filesTruncated: z.boolean(),
  }).strict(),
  files: z.array(z.object({
    path: z.string(),
    oldPath: nullableStringSchema,
    state: z.enum(['modified', 'added', 'deleted', 'renamed', 'type_changed', 'conflicted', 'untracked']),
    staged: z.boolean(),
    unstaged: z.boolean(),
    untracked: z.boolean(),
    // Working-tree file size and modification time, internal to this
    // schema only — never forwarded to the public developmentStateResponse.
    // Exists solely so Repository Actions can fingerprint "has this exact
    // file changed" more precisely than the coarse status category alone
    // distinguishes (two edits to the same file can both read as "modified,
    // unstaged"). See repository-actions/plan.ts.
    size: z.number().int().nonnegative(),
    // Deliberately a bare string, not a parsed/validated timestamp: this
    // value is never displayed and never compared for ordering, only hashed
    // verbatim as one input among several to a fingerprint. Constraining its
    // format would add a runtime failure mode for zero benefit.
    modifiedAt: z.string().nullable(),
  }).strict()).max(200),
  recentCommits: z.array(z.object({
    sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    shortSha: z.string().regex(/^[0-9a-f]{7,64}$/),
    subject: z.string(),
    authorName: z.string(),
    authoredAt: z.string().datetime({ offset: true }),
  }).strict()).max(20),
  remote: z.object({
    name: z.literal('origin'),
    rawUrl: nullableStringSchema,
    host: nullableStringSchema,
    owner: nullableStringSchema,
    repository: nullableStringSchema,
    trackingBranch: nullableStringSchema,
    ahead: z.number().int().nonnegative().nullable(),
    behind: z.number().int().nonnegative().nullable(),
    comparisonBasis: z.enum(['none', 'local_tracking_ref']),
  }).strict().nullable(),
  github: z.object({
    detected: z.boolean(),
    configured: z.boolean(),
    status: z.enum(['not_configured', 'unavailable', 'unsupported']),
  }).strict(),
}).strict();
export type RunnerGitDevelopment = z.infer<typeof runnerGitDevelopmentSchema>;

export const runnerGitDevelopmentResultSchema = z.union([
  z.object({ valid: z.literal(false), reason: z.string() }).strict(),
  z.object({
    valid: z.literal(true),
    canonicalPath: z.string(),
    allowedRoot: z.string(),
    development: runnerGitDevelopmentSchema,
  }).strict(),
]);
export type RunnerGitDevelopmentResult = z.infer<typeof runnerGitDevelopmentResultSchema>;

const invalidPathResultSchema = z.object({
  valid: z.literal(false),
  reason: z.string(),
});

export const runnerPathValidateResultSchema = z.union([
  invalidPathResultSchema,
  z.object({
    valid: z.literal(true),
    canonicalPath: z.string(),
    allowedRoot: z.string(),
  }),
]);
export type RunnerPathValidateResult = z.infer<typeof runnerPathValidateResultSchema>;

export const runnerGitSummaryResultSchema = z.union([
  invalidPathResultSchema,
  z.object({
    valid: z.literal(true),
    canonicalPath: z.string(),
    allowedRoot: z.string(),
    gitAvailable: z.boolean(),
    git: runnerGitInfoSchema.optional(),
  }),
]);
export type RunnerGitSummaryResult = z.infer<typeof runnerGitSummaryResultSchema>;

const inspectTechnologySchema = z.object({
  name: z.string(),
  category: z.string(),
  version: z.string(),
  evidencePath: z.string(),
});
export type RunnerInspectTechnology = z.infer<typeof inspectTechnologySchema>;

const inspectCommandSchema = z.object({
  type: z.string(),
  displayName: z.string(),
  commandText: z.string(),
  workingDirectory: z.string(),
  evidencePath: z.string(),
});
export type RunnerInspectCommand = z.infer<typeof inspectCommandSchema>;

export const runnerInspectResultSchema = z.union([
  invalidPathResultSchema,
  z.object({
    valid: z.literal(true),
    canonicalPath: z.string(),
    allowedRoot: z.string(),
    scanVersion: z.string(),
    gitAvailable: z.boolean(),
    git: runnerGitInfoSchema.optional(),
    gitWarning: z.string().optional(),
    technologies: z.array(inspectTechnologySchema),
    commands: z.array(inspectCommandSchema),
    manifests: z.array(z.string()),
    warnings: z.array(z.string()),
    limitsHit: z.array(z.string()),
  }),
]);
export type RunnerInspectResult = z.infer<typeof runnerInspectResultSchema>;

/**
 * Validators for the `project.git.write.status` and `project.git.commit`
 * result payloads — the runner's write-capable operations. See
 * apps/runner/internal/gitwrite's package doc for what backs these, and
 * apps/runner/internal/operations/project_write_ops.go for the exact shapes
 * parsed here.
 */

const gitWritePreflightSchema = z.object({
  gitLayoutSupported: z.boolean(),
  branch: z.string().nullable(),
  detached: z.boolean(),
  headSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
  unborn: z.boolean(),
  mergeInProgress: z.boolean(),
  unmergedPaths: z.boolean(),
  identityConfigured: z.boolean(),
}).strict();
export type RunnerGitWritePreflight = z.infer<typeof gitWritePreflightSchema>;

// A bounded, deterministic identity of one repository-relative path's
// *current* working-tree content — never the content itself. See
// apps/runner/internal/gitinfo/identity.go's package doc for the exact
// algorithm (git's own blob object-id scheme) and every edge case
// (symlink, absent, oversized) this represents.
const pathIdentitySchema = z.object({
  path: z.string(),
  kind: z.enum(['file', 'symlink', 'absent', 'unsupported']),
  contentHash: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  mode: z.enum(['100644', '100755', '120000']).nullable(),
  unsupportedReason: z.string().nullable(),
  fallbackSize: z.number().int().nonnegative(),
  fallbackModifiedAt: z.string().nullable(),
}).strict();
export type RunnerPathIdentity = z.infer<typeof pathIdentitySchema>;

export const runnerGitWriteStatusResultSchema = z.union([
  invalidPathResultSchema,
  z.object({
    valid: z.literal(true), canonicalPath: z.string(), allowedRoot: z.string(),
    writable: z.literal(false), reason: z.string(),
  }).strict(),
  z.object({
    valid: z.literal(true), canonicalPath: z.string(), allowedRoot: z.string(),
    writable: z.literal(true), preflight: gitWritePreflightSchema, readyToCommit: z.string(),
    pathIdentities: z.array(pathIdentitySchema).max(200).optional(),
  }).strict(),
]);
export type RunnerGitWriteStatusResult = z.infer<typeof runnerGitWriteStatusResultSchema>;

export const runnerGitCommitResultSchema = z.union([
  invalidPathResultSchema,
  z.object({
    valid: z.literal(true), canonicalPath: z.string(), allowedRoot: z.string(),
    committed: z.literal(false), reason: z.string(),
  }).strict(),
  z.object({
    valid: z.literal(true), canonicalPath: z.string(), allowedRoot: z.string(),
    committed: z.literal(true),
    commit: z.object({
      sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
      shortSha: z.string().regex(/^[0-9a-f]{7,64}$/),
      previousHeadSha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).nullable(),
      branch: z.string().min(1),
      fileCount: z.number().int().positive(),
      indexReconciled: z.boolean(),
    }).strict(),
  }).strict(),
]);
export type RunnerGitCommitResult = z.infer<typeof runnerGitCommitResultSchema>;
