import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common.js';

/**
 * Project registration and identity.
 *
 * A project is a folder the operator already has on the Ubuntu host, pointed
 * at through its full path. Nothing here ever accepts a browser-side file
 * picker result or a raw filesystem listing — the path is text the operator
 * typed, the server resolves and validates it (see the runner's
 * `project.path.validate` / `project.inspect` operations), and nothing is
 * persisted until the operator confirms an inspection preview.
 */

// -----------------------------------------------------------------------------
// Enumerations
// -----------------------------------------------------------------------------

export const projectStatusSchema = z.enum(['active', 'paused', 'completed', 'archived']);
export type ProjectStatus = z.infer<typeof projectStatusSchema>;

export const projectPrioritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type ProjectPriority = z.infer<typeof projectPrioritySchema>;

export const technologyCategorySchema = z.enum([
  'language',
  'framework',
  'package_manager',
  'build_tool',
  'test_tool',
  'container',
  'database',
  'monorepo',
  'other',
]);
export type TechnologyCategory = z.infer<typeof technologyCategorySchema>;

/** 'manifest': found by the runner from a project-definition file. 'user': added by an operator. */
export const detectionSourceSchema = z.enum(['manifest', 'user']);
export type DetectionSource = z.infer<typeof detectionSourceSchema>;

export const ruleCategorySchema = z.enum([
  'architecture',
  'technology',
  'security',
  'testing',
  'workflow',
  'scope',
  'out_of_scope',
  'approval_required',
]);
export type RuleCategory = z.infer<typeof ruleCategorySchema>;

export const commandTypeSchema = z.enum(['test', 'lint', 'build', 'typecheck', 'validate', 'custom']);
export type CommandType = z.infer<typeof commandTypeSchema>;

/**
 * How confidently the default branch was determined — always from local git
 * refs only, never a network call. 'known' means a local `origin/HEAD` symref
 * was present; 'inferred' means a `main`/`master` local branch existed with no
 * symref to confirm it; 'unknown' means neither.
 */
export const defaultBranchConfidenceSchema = z.enum(['known', 'inferred', 'unknown']);
export type DefaultBranchConfidence = z.infer<typeof defaultBranchConfidenceSchema>;

// -----------------------------------------------------------------------------
// Shared value objects
// -----------------------------------------------------------------------------

/** A git remote. `url` has already had any embedded credential stripped. */
export const gitRemoteSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().max(2000),
});
export type GitRemote = z.infer<typeof gitRemoteSchema>;

export const projectLocationSchema = z.object({
  /** Exactly what the operator typed. Never silently rewritten. */
  inputPath: z.string().min(1).max(4096),
  /** The fully resolved, symlink-free path the runner validated. */
  canonicalPath: z.string().min(1).max(4096),
  /** Which configured allowed root the path was found under. */
  allowedRoot: z.string().min(1).max(4096),
  accessible: z.boolean(),
  checkedAt: timestampSchema,
});
export type ProjectLocation = z.infer<typeof projectLocationSchema>;

export const projectRepositorySchema = z.object({
  present: z.boolean(),
  topLevelPath: z.string().max(4096).nullable(),
  remotes: z.array(gitRemoteSchema),
  /** Credential-free, host-normalised identity used for duplicate detection. */
  normalizedIdentity: z.string().max(500).nullable(),
  activeBranch: z.string().max(255).nullable(),
  defaultBranch: z.string().max(255).nullable(),
  defaultBranchConfidence: defaultBranchConfidenceSchema.nullable(),
  lastCommitHash: z.string().regex(/^[0-9a-f]{40}$/).nullable(),
  lastCommitShortHash: z.string().max(40).nullable(),
  lastCommitAt: timestampSchema.nullable(),
  lastCommitSubject: z.string().max(500).nullable(),
  isDirty: z.boolean().nullable(),
  modifiedCount: z.number().int().nonnegative().nullable(),
  untrackedCount: z.number().int().nonnegative().nullable(),
  scannedAt: timestampSchema.nullable(),
});
export type ProjectRepository = z.infer<typeof projectRepositorySchema>;

export const projectTechnologySchema = z.object({
  id: uuidSchema,
  name: z.string().min(1).max(120),
  category: technologyCategorySchema,
  version: z.string().max(60).nullable(),
  detectionSource: detectionSourceSchema,
  evidencePath: z.string().max(500).nullable(),
  isUserDefined: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ProjectTechnology = z.infer<typeof projectTechnologySchema>;

export const projectRuleSchema = z.object({
  id: uuidSchema,
  category: ruleCategorySchema,
  text: z.string().min(1).max(2000),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ProjectRule = z.infer<typeof projectRuleSchema>;

/**
 * Command metadata. `commandText` is a free-text description of a command
 * (e.g. "pnpm test") — it is never parsed as argv, never passed to a shell,
 * and never sent to the runner. Execution of project commands is out of
 * scope for this platform; see docs/architecture.md.
 */
export const projectCommandSchema = z.object({
  id: uuidSchema,
  type: commandTypeSchema,
  displayName: z.string().min(1).max(120),
  commandText: z.string().min(1).max(500),
  workingDirectory: z.string().min(1).max(500),
  detectionSource: detectionSourceSchema,
  isUserDefined: z.boolean(),
  enabled: z.boolean(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type ProjectCommand = z.infer<typeof projectCommandSchema>;

// -----------------------------------------------------------------------------
// Project (list / detail)
// -----------------------------------------------------------------------------

const projectCoreFields = {
  id: uuidSchema,
  name: z.string().min(1).max(200),
  shortCode: z.string().max(32).nullable(),
  status: projectStatusSchema,
  priority: projectPrioritySchema,
  tags: z.array(z.string().min(1).max(60)),
  location: projectLocationSchema,
  repository: projectRepositorySchema,
  lastInspectedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  archivedAt: timestampSchema.nullable(),
};

/** Lightweight technology summary shown on the project list card. */
export const projectTechnologySummarySchema = z.object({
  name: z.string(),
  category: technologyCategorySchema,
});

/** The list-view shape: everything a card or table row needs, nothing more. */
export const projectSummarySchema = z.object({
  ...projectCoreFields,
  technologies: z.array(projectTechnologySummarySchema),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

/** The detail-view shape: everything the project detail screen renders. */
export const projectDetailSchema = z.object({
  ...projectCoreFields,
  description: z.string(),
  purpose: z.string(),
  productGoal: z.string(),
  createdBy: uuidSchema.nullable(),
  technologies: z.array(projectTechnologySchema),
  rules: z.array(projectRuleSchema),
  commands: z.array(projectCommandSchema),
});
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

// -----------------------------------------------------------------------------
// Inspection (pre-save preview)
// -----------------------------------------------------------------------------

export const inspectProjectRequestSchema = z.object({
  /** The full folder path as typed by the operator. Never a picker result. */
  path: z.string().min(1).max(4096),
});
export type InspectProjectRequest = z.infer<typeof inspectProjectRequestSchema>;

export const inspectionTechnologySchema = z.object({
  name: z.string().min(1).max(120),
  category: technologyCategorySchema,
  version: z.string().max(60).nullable(),
  evidencePath: z.string().max(500).nullable(),
});
export type InspectionTechnology = z.infer<typeof inspectionTechnologySchema>;

export const inspectionCommandSchema = z.object({
  type: commandTypeSchema,
  displayName: z.string().min(1).max(120),
  commandText: z.string().min(1).max(500),
  workingDirectory: z.string().min(1).max(500),
  evidencePath: z.string().max(500).nullable(),
});
export type InspectionCommand = z.infer<typeof inspectionCommandSchema>;

/**
 * The pending-inspection preview. `inspectionId` is single-use and expires —
 * `POST /api/projects` must be called with it before `expiresAt`, and a
 * second use of the same id is rejected server-side.
 */
export const projectInspectionResponseSchema = z.object({
  inspectionId: uuidSchema,
  expiresAt: timestampSchema,
  scanVersion: z.string(),
  location: projectLocationSchema,
  repository: projectRepositorySchema,
  technologies: z.array(inspectionTechnologySchema),
  commands: z.array(inspectionCommandSchema),
  manifests: z.array(z.string()),
  warnings: z.array(z.string()),
  limitsHit: z.array(z.string()),
});
export type ProjectInspectionResponse = z.infer<typeof projectInspectionResponseSchema>;

// -----------------------------------------------------------------------------
// Create / update
// -----------------------------------------------------------------------------

const shortCodeSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'lowercase letters, digits and hyphens only, starting with a letter or digit')
  .nullable();

export const projectTechnologyInputSchema = z.object({
  name: z.string().min(1).max(120),
  category: technologyCategorySchema,
  version: z.string().max(60).nullable().optional(),
  detectionSource: detectionSourceSchema,
  evidencePath: z.string().max(500).nullable().optional(),
});
export type ProjectTechnologyInput = z.infer<typeof projectTechnologyInputSchema>;

export const projectRuleInputSchema = z.object({
  category: ruleCategorySchema,
  text: z.string().min(1).max(2000),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export type ProjectRuleInput = z.infer<typeof projectRuleInputSchema>;

export const projectCommandInputSchema = z.object({
  type: commandTypeSchema,
  displayName: z.string().min(1).max(120),
  commandText: z.string().min(1).max(500),
  workingDirectory: z.string().min(1).max(500).optional(),
  detectionSource: detectionSourceSchema,
  evidencePath: z.string().max(500).nullable().optional(),
  enabled: z.boolean().optional(),
});
export type ProjectCommandInput = z.infer<typeof projectCommandInputSchema>;

/**
 * `POST /api/projects` — creates a project from a confirmed inspection.
 *
 * The server re-validates `inspectionId` (owner, expiry, single-use,
 * fingerprint) rather than trusting `technologies`/`rules`/`commands` at face
 * value; those arrays are the operator's edited preview state, sent exactly
 * once, and become the initial rows for the new project.
 */
export const createProjectRequestSchema = z.object({
  inspectionId: uuidSchema,
  name: z.string().min(1).max(200),
  shortCode: shortCodeSchema.optional(),
  description: z.string().max(5000).optional(),
  purpose: z.string().max(2000).optional(),
  productGoal: z.string().max(2000).optional(),
  status: projectStatusSchema.exclude(['archived']).optional(),
  priority: projectPrioritySchema.optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
  technologies: z.array(projectTechnologyInputSchema).max(200).optional(),
  rules: z.array(projectRuleInputSchema).max(500).optional(),
  commands: z.array(projectCommandInputSchema).max(200).optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const projectResponseSchema = z.object({ project: projectDetailSchema });
export type ProjectResponse = z.infer<typeof projectResponseSchema>;

export const updateProjectRequestSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  shortCode: shortCodeSchema.optional(),
  description: z.string().max(5000).optional(),
  purpose: z.string().max(2000).optional(),
  productGoal: z.string().max(2000).optional(),
  // Archiving/reactivating go through their own endpoints, which additionally
  // record a dedicated audit event and (for reactivation) re-check for a
  // duplicate canonical path or repository identity.
  status: projectStatusSchema.exclude(['archived']).optional(),
  priority: projectPrioritySchema.optional(),
  tags: z.array(z.string().min(1).max(60)).max(50).optional(),
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

// -----------------------------------------------------------------------------
// List
// -----------------------------------------------------------------------------

export const projectSortFieldSchema = z.enum([
  'name',
  'createdAt',
  'updatedAt',
  'lastInspectedAt',
  'priority',
  'status',
]);
export type ProjectSortField = z.infer<typeof projectSortFieldSchema>;

export const projectSortOrderSchema = z.enum(['asc', 'desc']);
export type ProjectSortOrder = z.infer<typeof projectSortOrderSchema>;

export const listProjectsQuerySchema = z.object({
  search: z.string().max(200).optional(),
  status: projectStatusSchema.optional(),
  priority: projectPrioritySchema.optional(),
  technology: z.string().max(120).optional(),
  includeArchived: z.coerce.boolean().optional().default(false),
  sort: projectSortFieldSchema.optional().default('updatedAt'),
  order: projectSortOrderSchema.optional().default('desc'),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});
export type ListProjectsQuery = z.infer<typeof listProjectsQuerySchema>;

export const listProjectsResponseSchema = z.object({
  projects: z.array(projectSummarySchema),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type ListProjectsResponse = z.infer<typeof listProjectsResponseSchema>;

// -----------------------------------------------------------------------------
// Rules
// -----------------------------------------------------------------------------

export const createProjectRuleRequestSchema = projectRuleInputSchema;
export type CreateProjectRuleRequest = z.infer<typeof createProjectRuleRequestSchema>;

export const updateProjectRuleRequestSchema = z.object({
  category: ruleCategorySchema.optional(),
  text: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().optional(),
});
export type UpdateProjectRuleRequest = z.infer<typeof updateProjectRuleRequestSchema>;

export const projectRuleResponseSchema = z.object({ rule: projectRuleSchema });
export type ProjectRuleResponse = z.infer<typeof projectRuleResponseSchema>;

// -----------------------------------------------------------------------------
// Technologies (operator-managed only — detected rows come from inspection)
// -----------------------------------------------------------------------------

export const createProjectTechnologyRequestSchema = z.object({
  name: z.string().min(1).max(120),
  category: technologyCategorySchema,
  version: z.string().max(60).nullable().optional(),
});
export type CreateProjectTechnologyRequest = z.infer<typeof createProjectTechnologyRequestSchema>;

export const projectTechnologyResponseSchema = z.object({ technology: projectTechnologySchema });
export type ProjectTechnologyResponse = z.infer<typeof projectTechnologyResponseSchema>;

// -----------------------------------------------------------------------------
// Commands
// -----------------------------------------------------------------------------

export const createProjectCommandRequestSchema = z.object({
  type: commandTypeSchema,
  displayName: z.string().min(1).max(120),
  commandText: z.string().min(1).max(500),
  workingDirectory: z.string().min(1).max(500).optional(),
});
export type CreateProjectCommandRequest = z.infer<typeof createProjectCommandRequestSchema>;

export const updateProjectCommandRequestSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  commandText: z.string().min(1).max(500).optional(),
  workingDirectory: z.string().min(1).max(500).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateProjectCommandRequest = z.infer<typeof updateProjectCommandRequestSchema>;

export const projectCommandResponseSchema = z.object({ command: projectCommandSchema });
export type ProjectCommandResponse = z.infer<typeof projectCommandResponseSchema>;

// -----------------------------------------------------------------------------
// Rescan / diff
// -----------------------------------------------------------------------------

export const rescanChangeTypeSchema = z.enum([
  'branch_changed',
  'default_branch_changed',
  'remote_changed',
  'last_commit_changed',
  'working_tree_changed',
  'technology_added',
  'technology_removed',
  'command_added',
  'command_removed',
  'manifest_removed',
  'location_inaccessible',
  'repository_identity_changed',
  'repository_added',
  'repository_removed',
]);
export type RescanChangeType = z.infer<typeof rescanChangeTypeSchema>;

/**
 * 'critical' is reserved for a changed repository identity — the one change
 * the web panel refuses to apply without an explicit, separate confirmation
 * (`confirmRepositoryIdentityChange`), since it means the folder now points
 * at a different remote than the one this project was registered against.
 */
export const rescanSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type RescanSeverity = z.infer<typeof rescanSeveritySchema>;

export const rescanDiffEntrySchema = z.object({
  field: z.string(),
  changeType: rescanChangeTypeSchema,
  severity: rescanSeveritySchema,
  previousValue: z.string().max(2000).nullable(),
  newValue: z.string().max(2000).nullable(),
});
export type RescanDiffEntry = z.infer<typeof rescanDiffEntrySchema>;

export const rescanProjectResponseSchema = z.object({
  inspectionId: uuidSchema,
  expiresAt: timestampSchema,
  diff: z.array(rescanDiffEntrySchema),
  warnings: z.array(z.string()),
  requiresConfirmation: z.boolean(),
});
export type RescanProjectResponse = z.infer<typeof rescanProjectResponseSchema>;

export const applyRescanRequestSchema = z.object({
  inspectionId: uuidSchema,
  /** Diff entry `field` values to apply. Omitted = apply every non-critical entry. */
  acceptedFields: z.array(z.string().max(200)).max(200).optional(),
  confirmRepositoryIdentityChange: z.boolean().optional().default(false),
});
export type ApplyRescanRequest = z.infer<typeof applyRescanRequestSchema>;

export const applyRescanResponseSchema = z.object({
  project: projectDetailSchema,
  applied: z.array(z.string()),
});
export type ApplyRescanResponse = z.infer<typeof applyRescanResponseSchema>;

// -----------------------------------------------------------------------------
// Archive / reactivate / activity
// -----------------------------------------------------------------------------

export const projectActivityEntrySchema = z.object({
  id: z.number().int(),
  occurredAt: timestampSchema,
  eventType: z.string(),
  outcome: z.enum(['success', 'failure', 'denied', 'error']),
  actorUserId: uuidSchema.nullable(),
  detail: z.record(z.string(), z.unknown()),
});
export type ProjectActivityEntry = z.infer<typeof projectActivityEntrySchema>;

export const projectActivityResponseSchema = z.object({
  entries: z.array(projectActivityEntrySchema),
});
export type ProjectActivityResponse = z.infer<typeof projectActivityResponseSchema>;
