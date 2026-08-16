import { describe, expect, it } from 'vitest';
import {
  executeRepositoryActionRequestSchema,
  gitCommitPlanSchema,
  planGitCommitRequestSchema,
  repositoryActionResultSchema,
  repositoryActionSchema,
} from './index.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const actionId = '00000000-0000-4000-8000-000000000002';
const userId = '00000000-0000-4000-8000-000000000003';
const sha = 'a'.repeat(40);
const now = '2026-08-16T10:00:00.000Z';

function plannedAction(overrides: Partial<ReturnType<typeof basePlannedAction>> = {}) {
  return { ...basePlannedAction(), ...overrides };
}

function basePlannedAction() {
  return {
    id: actionId,
    projectId,
    kind: 'git.commit' as const,
    status: 'planned' as const,
    risk: 'medium' as const,
    plan: {
      kind: 'git.commit' as const,
      branch: 'feature/x',
      isDefaultBranch: false,
      expectedHead: sha,
      selectedPaths: ['README.md'],
      excludedProtectedPaths: [],
      message: 'feat: update readme',
    },
    fingerprint: 'a'.repeat(64),
    expiresAt: now,
    requestedBy: userId,
    startedAt: null,
    settledAt: null,
    result: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('Repository Actions contracts', () => {
  it('accepts a well-formed planned action', () => {
    expect(repositoryActionSchema.safeParse(plannedAction()).success).toBe(true);
  });

  it('rejects a path escaping the repository', () => {
    expect(planGitCommitRequestSchema.safeParse({
      paths: ['../outside.txt'], message: 'x',
    }).success).toBe(false);
    expect(planGitCommitRequestSchema.safeParse({
      paths: ['/etc/passwd'], message: 'x',
    }).success).toBe(false);
  });

  it('rejects an empty path selection', () => {
    expect(planGitCommitRequestSchema.safeParse({ paths: [], message: 'x' }).success).toBe(false);
  });

  it('rejects unknown fields on the plan request (no command-shaped extras)', () => {
    expect(planGitCommitRequestSchema.safeParse({
      paths: ['a.txt'], message: 'x', command: 'rm -rf /',
    }).success).toBe(false);
  });

  it('requires the execute request to carry a fingerprint and rejects extra fields', () => {
    expect(executeRepositoryActionRequestSchema.safeParse({}).success).toBe(false);
    expect(executeRepositoryActionRequestSchema.safeParse({
      fingerprint: 'z'.repeat(64),
    }).success).toBe(false); // not lowercase hex
    expect(executeRepositoryActionRequestSchema.safeParse({
      fingerprint: 'a'.repeat(64),
    }).success).toBe(true);
    expect(executeRepositoryActionRequestSchema.safeParse({
      fingerprint: 'a'.repeat(64), command: 'git push --force',
    }).success).toBe(false);
  });

  it('accepts a plan with a null expectedHead for an unborn branch', () => {
    const result = gitCommitPlanSchema.safeParse({
      kind: 'git.commit', branch: 'main', isDefaultBranch: true, expectedHead: null,
      selectedPaths: ['README.md'], excludedProtectedPaths: [], message: 'feat: initial commit',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a succeeded result without a commit', () => {
    expect(repositoryActionResultSchema.safeParse({
      succeeded: true, commit: null, reason: null, reconciledFromInterruption: false,
    }).success).toBe(false);
  });

  it('rejects a succeeded result that also carries a failure reason', () => {
    expect(repositoryActionResultSchema.safeParse({
      succeeded: true,
      commit: {
        kind: 'git.commit', commitSha: sha, shortSha: sha.slice(0, 7), previousHeadSha: null,
        branch: 'main', fileCount: 1, indexReconciled: true, verified: true,
      },
      reason: 'head_moved', reconciledFromInterruption: false,
    }).success).toBe(false);
  });

  it('rejects a failed result without a reason', () => {
    expect(repositoryActionResultSchema.safeParse({
      succeeded: false, commit: null, reason: null, reconciledFromInterruption: false,
    }).success).toBe(false);
  });

  it('accepts a well-formed failed result', () => {
    expect(repositoryActionResultSchema.safeParse({
      succeeded: false, commit: null, reason: 'head_moved', reconciledFromInterruption: false,
    }).success).toBe(true);
  });

  it('accepts a succeeded action with a matching commit result', () => {
    const action = plannedAction({
      status: 'succeeded',
      startedAt: now,
      settledAt: now,
      result: {
        succeeded: true,
        commit: {
          kind: 'git.commit', commitSha: sha, shortSha: sha.slice(0, 7), previousHeadSha: null,
          branch: 'feature/x', fileCount: 1, indexReconciled: true, verified: true,
        },
        reason: null,
        reconciledFromInterruption: false,
      },
    });
    expect(repositoryActionSchema.safeParse(action).success).toBe(true);
  });
});
