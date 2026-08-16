import { describe, expect, it } from 'vitest';
import {
  checkpointGitComparisonSchema,
  checkpointSnapshotSchema,
  checkpointSnapshotV1Schema,
  checkpointSnapshotV2Schema,
  checkpointSnapshotV3Schema,
  developmentRemoteSchema,
  developmentStateResponseSchema,
} from './index.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const capturedAt = '2026-08-15T10:00:00.000Z';
const sha = 'a'.repeat(40);

describe('Development State contracts', () => {
  it('accepts a strict, bounded available repository response', () => {
    const result = developmentStateResponseSchema.safeParse(availableDevelopmentState());
    expect(result.success).toBe(true);
  });

  it('enforces response lifecycle and truncation invariants', () => {
    expect(developmentStateResponseSchema.safeParse({
      ...availableDevelopmentState(),
      status: 'unavailable',
      errorCode: null,
    }).success).toBe(false);

    expect(developmentStateResponseSchema.safeParse({
      ...availableDevelopmentState(),
      files: [],
      filesTruncated: false,
    }).success).toBe(false);

    expect(developmentStateResponseSchema.safeParse({
      ...availableDevelopmentState(),
      attention: [
        { key: 'uncommitted_changes', label: 'Dirty', count: 1 },
        { key: 'uncommitted_changes', label: 'Still dirty', count: 1 },
      ],
    }).success).toBe(false);
  });

  it('caps changed files at 200 and recent commits at 20', () => {
    const file = { path: 'src/index.ts', oldPath: null, state: 'modified', staged: false, unstaged: true, untracked: false };
    const commit = { sha, shortSha: sha.slice(0, 7), subject: 'Subject', authorName: 'Author', authoredAt: capturedAt };
    expect(developmentStateResponseSchema.safeParse({
      ...availableDevelopmentState(),
      workingTree: { clean: false, stagedCount: 0, unstagedCount: 201, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 201 },
      files: Array.from({ length: 201 }, (_, index) => ({ ...file, path: `src/${index}.ts` })),
      filesTruncated: false,
    }).success).toBe(false);
    expect(developmentStateResponseSchema.safeParse({
      ...availableDevelopmentState(),
      recentCommits: Array.from({ length: 21 }, () => commit),
    }).success).toBe(false);
  });

  it('accepts Git history order when author timestamps are non-monotonic', () => {
    const value = availableDevelopmentState();
    value.recentCommits = [
      { ...value.recentCommits[0]!, authoredAt: '2026-08-14T10:00:00.000Z' },
      { ...value.recentCommits[0]!, sha: 'b'.repeat(40), shortSha: 'bbbbbbb', authoredAt: '2026-08-15T10:00:00.000Z' },
    ];
    expect(developmentStateResponseSchema.safeParse(value).success).toBe(true);
  });

  it('rejects credential-bearing or query-bearing remote URLs', () => {
    const base = {
      name: 'origin', normalizedHost: 'github.com', owner: 'owner', repository: 'repo',
      trackingBranch: null, ahead: null, behind: null, comparisonBasis: 'not_available',
    } as const;
    expect(developmentRemoteSchema.safeParse({ ...base, rawUrl: 'https://user:token@github.com/owner/repo.git' }).success).toBe(false);
    expect(developmentRemoteSchema.safeParse({ ...base, rawUrl: 'https://github.com/owner/repo.git?token=secret' }).success).toBe(false);
    expect(developmentRemoteSchema.safeParse({ ...base, rawUrl: 'git@github.com:owner/repo.git' }).success).toBe(true);
    expect(developmentRemoteSchema.safeParse({ ...base, rawUrl: 'ssh://git@github.com/owner/repo.git' }).success).toBe(true);
  });

  it('accepts exactly the three checkpoint comparison states and checks known HEAD facts', () => {
    expect(checkpointGitComparisonSchema.safeParse({ status: 'no_git_checkpoint' }).success).toBe(true);
    expect(checkpointGitComparisonSchema.safeParse({ status: 'unavailable', checkpointStatus: 'available', currentStatus: 'unavailable' }).success).toBe(true);
    expect(checkpointGitComparisonSchema.safeParse({
      status: 'compared', repositoryStateChanged: false, sameHead: true, headChanged: true,
      branchChanged: false, workingTreeChanged: false, previousHeadSha: sha, currentHeadSha: sha,
      previousBranch: 'main', currentBranch: 'main', checkpointDirty: false, currentDirty: false,
    }).success).toBe(false);
  });
});

describe('Checkpoint snapshot version contracts', () => {
  it('preserves v1 and v2 parsing while accepting compact v3', () => {
    const base = checkpointBase();
    expect(checkpointSnapshotV1Schema.safeParse({ ...base, version: 1 }).success).toBe(true);
    expect(checkpointSnapshotV2Schema.safeParse({ ...base, version: 2, recentAgentActivity: [] }).success).toBe(true);
    expect(checkpointSnapshotV3Schema.safeParse({ ...base, version: 3, recentAgentActivity: [], gitState: checkpointGitState() }).success).toBe(true);
    expect(checkpointSnapshotSchema.safeParse({ ...base, version: 1 }).success).toBe(true);
    expect(checkpointSnapshotSchema.safeParse({ ...base, version: 2, recentAgentActivity: [] }).success).toBe(true);
    expect(checkpointSnapshotSchema.safeParse({ ...base, version: 3, recentAgentActivity: [], gitState: checkpointGitState() }).success).toBe(true);
  });

  it.each(['files', 'diff', 'sourceBody', 'rawUrl'])('forbids %s in compact v3 Git state', (field) => {
    expect(checkpointSnapshotV3Schema.safeParse({
      ...checkpointBase(), version: 3, recentAgentActivity: [],
      gitState: { ...checkpointGitState(), [field]: field === 'files' ? ['secret.env'] : 'sensitive' },
    }).success).toBe(false);
  });

  it('accepts neutral not-repository and unavailable snapshots but rejects claimed metadata', () => {
    for (const status of ['not_repository', 'unavailable'] as const) {
      expect(checkpointSnapshotV3Schema.safeParse({
        ...checkpointBase(), version: 3, recentAgentActivity: [], gitState: { ...checkpointGitState(), status },
      }).success).toBe(false);
      expect(checkpointSnapshotV3Schema.safeParse({
        ...checkpointBase(), version: 3, recentAgentActivity: [], gitState: checkpointGitState(status),
      }).success).toBe(true);
    }
  });
});

function availableDevelopmentState(): any {
  return {
    projectId, status: 'available', errorCode: null,
    repository: { available: true, isRepository: true },
    head: { sha, shortSha: sha.slice(0, 7), branch: 'main', detached: false, unborn: false },
    workingTree: { clean: false, stagedCount: 0, unstagedCount: 1, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 1 },
    files: [{ path: 'src/index.ts', oldPath: null, state: 'modified', staged: false, unstaged: true, untracked: false }],
    filesTruncated: false,
    recentCommits: [{ sha, shortSha: sha.slice(0, 7), subject: 'Subject', authorName: 'Author', authoredAt: capturedAt }],
    remote: { name: 'origin', rawUrl: 'https://github.com/owner/repo.git', normalizedHost: 'github.com', owner: 'owner', repository: 'repo', trackingBranch: 'origin/main', ahead: 1, behind: 0, comparisonBasis: 'local_tracking_ref' },
    github: { detected: true, configured: false, status: 'not_configured' },
    checkpointComparison: { status: 'no_git_checkpoint' },
    attention: [{ key: 'uncommitted_changes', label: 'Uncommitted changes', count: 1 }],
  };
}

function checkpointGitState(status: 'available' | 'not_repository' | 'unavailable' = 'available'): any {
  const available = status === 'available';
  return {
    status, capturedAt, branch: available ? 'main' : null, detached: false,
    headSha: available ? sha : null, headShortSha: available ? sha.slice(0, 7) : null,
    dirty: available, stagedCount: 0, unstagedCount: available ? 1 : 0, untrackedCount: 0,
    conflictedCount: 0, remoteHost: available ? 'github.com' : null,
    remoteOwner: available ? 'owner' : null, remoteRepository: available ? 'repo' : null,
    trackingRef: available ? 'origin/main' : null,
  };
}

function checkpointBase(): any {
  return {
    projectId, projectName: 'Project', projectStatus: 'active', generatedAt: capturedAt,
    currentFocus: [], inProgressTasks: [], blockedMilestones: [], blockedTasks: [], nextActions: [],
    pendingAcceptance: [], unresolvedDependencies: [], recentlyCompletedTasks: [], pinnedMemory: [], importantMemory: [],
  };
}
