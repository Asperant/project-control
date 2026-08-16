import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common.js';

const gitShaSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const gitShortShaSchema = z.string().regex(/^[0-9a-f]{7,64}$/);
const boundedCountSchema = z.number().int().nonnegative();
const safeRemoteIdentitySchema = z.string().min(1).max(1024).refine(
  (value) => !/[\u0000-\u001f\u007f?#]/.test(value),
  'Remote identity metadata must not contain controls, query data, or fragments.',
);

const repositoryRelativePathSchema = z.string().min(1).max(4096).superRefine((path, ctx) => {
  if (path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Path must remain relative to the repository.' });
  }
});

const safeRemoteUrlSchema = z.string().min(1).max(2048).superRefine((value, ctx) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      const credentialBearingHttp = (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.username !== '';
      const supportedScheme = ['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol);
      if (!supportedScheme || credentialBearingHttp || parsed.password || parsed.search || parsed.hash) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Remote URL must not contain credentials or query data.' });
      }
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Remote URL is malformed.' });
    }
    return;
  }

  // Permit credential-free SCP-style SSH locations such as git@github.com:owner/repo.git.
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s?#]+$/.test(value)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Remote URL is not safe to expose.' });
  }
});

export const developmentStatusSchema = z.enum(['available', 'not_repository', 'unavailable']);
export const developmentErrorCodeSchema = z.enum([
  'runner_unavailable',
  'git_unavailable',
  'project_path_unavailable',
  'inspection_failed',
  'invalid_runner_response',
]);

export const checkpointGitStateSchema = z.object({
  status: developmentStatusSchema,
  capturedAt: timestampSchema,
  branch: z.string().min(1).max(1024).nullable(),
  detached: z.boolean(),
  headSha: gitShaSchema.nullable(),
  headShortSha: gitShortShaSchema.nullable(),
  dirty: z.boolean(),
  stagedCount: boundedCountSchema,
  unstagedCount: boundedCountSchema,
  untrackedCount: boundedCountSchema,
  conflictedCount: boundedCountSchema,
  remoteHost: safeRemoteIdentitySchema.max(253).nullable(),
  remoteOwner: safeRemoteIdentitySchema.nullable(),
  remoteRepository: safeRemoteIdentitySchema.nullable(),
  trackingRef: z.string().min(1).max(1024).nullable(),
}).strict().superRefine((state, ctx) => {
  if (state.headSha !== null && state.headShortSha !== null && !state.headSha.startsWith(state.headShortSha)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['headShortSha'], message: 'Short SHA must prefix HEAD SHA.' });
  }
  const hasChanges = state.stagedCount > 0 || state.unstagedCount > 0 || state.untrackedCount > 0 || state.conflictedCount > 0;
  if (state.status === 'available' && state.dirty !== hasChanges) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dirty'], message: 'dirty must match the compact change counts.' });
  }
  if (state.status !== 'available') {
    const hasRepositoryMetadata = state.branch !== null || state.detached || state.headSha !== null || state.headShortSha !== null
      || state.dirty || state.stagedCount !== 0 || state.unstagedCount !== 0 || state.untrackedCount !== 0
      || state.conflictedCount !== 0 || state.remoteHost !== null || state.remoteOwner !== null
      || state.remoteRepository !== null || state.trackingRef !== null;
    if (hasRepositoryMetadata) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Unavailable Git states cannot claim repository metadata.' });
    }
  }
});
export type CheckpointGitState = z.infer<typeof checkpointGitStateSchema>;

export const developmentFileSchema = z.object({
  path: repositoryRelativePathSchema,
  oldPath: repositoryRelativePathSchema.nullable(),
  state: z.enum(['added', 'modified', 'deleted', 'renamed', 'copied', 'type_changed', 'conflicted', 'unmerged', 'untracked', 'unknown']),
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
}).strict().superRefine((file, ctx) => {
  if (!file.staged && !file.unstaged && !file.untracked) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'A changed file must identify at least one working-tree category.' });
  }
  if (file.oldPath !== null && file.state !== 'renamed' && file.state !== 'copied') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['oldPath'], message: 'oldPath is valid only for renamed or copied files.' });
  }
});

export const developmentCommitSchema = z.object({
  sha: gitShaSchema,
  shortSha: gitShortShaSchema,
  subject: z.string().max(1000),
  authorName: z.string().max(500),
  authoredAt: timestampSchema,
}).strict().superRefine((commit, ctx) => {
  if (!commit.sha.startsWith(commit.shortSha)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['shortSha'], message: 'Short SHA must prefix commit SHA.' });
  }
});

export const developmentRemoteSchema = z.object({
  name: z.string().min(1).max(255),
  rawUrl: safeRemoteUrlSchema.nullable(),
  normalizedHost: z.string().min(1).max(253).nullable(),
  owner: z.string().min(1).max(1024).nullable(),
  repository: z.string().min(1).max(1024).nullable(),
  trackingBranch: z.string().min(1).max(1024).nullable(),
  ahead: boundedCountSchema.nullable(),
  behind: boundedCountSchema.nullable(),
  comparisonBasis: z.enum(['local_tracking_ref', 'not_available']),
}).strict().superRefine((remote, ctx) => {
  if (remote.comparisonBasis === 'local_tracking_ref') {
    if (remote.trackingBranch === null || remote.ahead === null || remote.behind === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisonBasis'], message: 'Local tracking comparison requires a ref and both counts.' });
    }
  } else if (remote.ahead !== null || remote.behind !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['comparisonBasis'], message: 'Ahead/behind require a local tracking ref comparison.' });
  }
});

export const developmentGithubSchema = z.object({
  detected: z.boolean(),
  configured: z.literal(false),
  status: z.enum(['not_configured', 'unsupported']),
}).strict().superRefine((github, ctx) => {
  const expected = github.detected ? 'not_configured' : 'unsupported';
  if (github.status !== expected) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: `Expected ${expected} for GitHub detection state.` });
  }
});

export const checkpointGitComparisonSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('no_git_checkpoint') }).strict(),
  z.object({
    status: z.literal('unavailable'),
    checkpointStatus: developmentStatusSchema.nullable(),
    currentStatus: developmentStatusSchema,
  }).strict(),
  z.object({
    status: z.literal('compared'),
    repositoryStateChanged: z.boolean(),
    sameHead: z.boolean().nullable(),
    headChanged: z.boolean().nullable(),
    branchChanged: z.boolean().nullable(),
    workingTreeChanged: z.boolean().nullable(),
    previousHeadSha: gitShaSchema.nullable(),
    currentHeadSha: gitShaSchema.nullable(),
    previousBranch: z.string().max(1024).nullable(),
    currentBranch: z.string().max(1024).nullable(),
    checkpointDirty: z.boolean().nullable(),
    currentDirty: z.boolean().nullable(),
  }).strict().superRefine((comparison, ctx) => {
    if (comparison.sameHead !== null && comparison.headChanged !== null && comparison.sameHead === comparison.headChanged) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sameHead'], message: 'sameHead must be the inverse of headChanged when both are known.' });
    }
  }),
]);

export const developmentAttentionKeySchema = z.enum([
  'uncommitted_changes',
  'merge_conflicts',
  'detached_head',
  'git_inspection_unavailable',
  'repository_not_detected',
  'no_remote_configured',
  'local_branch_ahead',
  'local_branch_behind',
]);

export const developmentAttentionItemSchema = z.object({
  key: developmentAttentionKeySchema,
  label: z.string().min(1).max(500),
  count: z.number().int().positive(),
}).strict();

const developmentStateResponseBaseSchema = z.object({
  projectId: uuidSchema,
  status: developmentStatusSchema,
  errorCode: developmentErrorCodeSchema.nullable(),
  repository: z.object({ available: z.boolean(), isRepository: z.boolean() }).strict(),
  head: z.object({
    sha: gitShaSchema.nullable(),
    shortSha: gitShortShaSchema.nullable(),
    branch: z.string().min(1).max(1024).nullable(),
    detached: z.boolean(),
    unborn: z.boolean(),
  }).strict(),
  workingTree: z.object({
    clean: z.boolean().nullable(),
    stagedCount: boundedCountSchema,
    unstagedCount: boundedCountSchema,
    untrackedCount: boundedCountSchema,
    conflictedCount: boundedCountSchema,
    totalChangedCount: boundedCountSchema,
  }).strict(),
  files: z.array(developmentFileSchema).max(200),
  filesTruncated: z.boolean(),
  recentCommits: z.array(developmentCommitSchema).max(20),
  remote: developmentRemoteSchema.nullable(),
  github: developmentGithubSchema,
  checkpointComparison: checkpointGitComparisonSchema,
  attention: z.array(developmentAttentionItemSchema).max(8),
}).strict();

export const developmentStateResponseSchema = developmentStateResponseBaseSchema.superRefine((state, ctx) => {
  if ((state.status === 'unavailable') !== (state.errorCode !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'Only unavailable responses require an error code.' });
  }
  const expectedRepository = state.status === 'available';
  const expectedAvailability = state.status !== 'unavailable';
  if (state.repository.isRepository !== expectedRepository || state.repository.available !== expectedAvailability) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repository'], message: 'Repository flags must match development status.' });
  }
  if (state.head.sha !== null && state.head.shortSha !== null && !state.head.sha.startsWith(state.head.shortSha)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['head', 'shortSha'], message: 'Short SHA must prefix HEAD SHA.' });
  }
  if (state.files.length > state.workingTree.totalChangedCount) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: 'Rendered file count cannot exceed the total changed count.' });
  }
  const cleanFromCounts = state.workingTree.stagedCount === 0 && state.workingTree.unstagedCount === 0
    && state.workingTree.untrackedCount === 0 && state.workingTree.conflictedCount === 0
    && state.workingTree.totalChangedCount === 0;
  if (state.status === 'available' && state.workingTree.clean !== cleanFromCounts) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['workingTree', 'clean'], message: 'clean must match the working-tree counts.' });
  }
  if (state.filesTruncated !== (state.files.length < state.workingTree.totalChangedCount)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filesTruncated'], message: 'filesTruncated must reflect the bounded file list.' });
  }
  if (new Set(state.attention.map((item) => item.key)).size !== state.attention.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attention'], message: 'Development attention keys must be unique.' });
  }
  if (state.status !== 'available') {
    const hasRepositoryData = state.head.sha !== null || state.head.shortSha !== null || state.head.branch !== null
      || state.head.detached || state.head.unborn || state.workingTree.clean !== null
      || state.workingTree.stagedCount !== 0 || state.workingTree.unstagedCount !== 0
      || state.workingTree.untrackedCount !== 0 || state.workingTree.conflictedCount !== 0
      || state.workingTree.totalChangedCount !== 0 || state.files.length !== 0
      || state.recentCommits.length !== 0 || state.remote !== null;
    if (hasRepositoryData) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Non-repository states cannot claim live repository data.' });
    }
  }
});

export const resumeDevelopmentStateSchema = developmentStateResponseBaseSchema
  .omit({ projectId: true, files: true, filesTruncated: true, recentCommits: true })
  .superRefine((state, ctx) => {
    if ((state.status === 'unavailable') !== (state.errorCode !== null)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['errorCode'], message: 'Only unavailable responses require an error code.' });
    }
    if (state.repository.isRepository !== (state.status === 'available') || state.repository.available !== (state.status !== 'unavailable')) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['repository'], message: 'Repository flags must match development status.' });
    }
    if (state.status !== 'available' && (
      state.head.sha !== null || state.head.shortSha !== null || state.head.branch !== null || state.head.detached
      || state.head.unborn || state.workingTree.clean !== null || state.workingTree.totalChangedCount !== 0 || state.remote !== null
    )) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Non-repository states cannot claim live repository data.' });
    }
    if (new Set(state.attention.map((item) => item.key)).size !== state.attention.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['attention'], message: 'Development attention keys must be unique.' });
    }
  });

export type DevelopmentStatus = z.infer<typeof developmentStatusSchema>;
export type DevelopmentErrorCode = z.infer<typeof developmentErrorCodeSchema>;
export type DevelopmentFile = z.infer<typeof developmentFileSchema>;
export type DevelopmentCommit = z.infer<typeof developmentCommitSchema>;
export type DevelopmentRemote = z.infer<typeof developmentRemoteSchema>;
export type CheckpointGitComparison = z.infer<typeof checkpointGitComparisonSchema>;
export type DevelopmentAttentionKey = z.infer<typeof developmentAttentionKeySchema>;
export type DevelopmentAttentionItem = z.infer<typeof developmentAttentionItemSchema>;
export type DevelopmentStateResponse = z.infer<typeof developmentStateResponseSchema>;
export type ResumeDevelopmentState = z.infer<typeof resumeDevelopmentStateSchema>;
