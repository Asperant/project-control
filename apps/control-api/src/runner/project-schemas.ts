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
