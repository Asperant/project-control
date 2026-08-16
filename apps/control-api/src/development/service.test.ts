import { describe, expect, it } from 'vitest';
import { developmentStateResponseSchema, type CheckpointGitState } from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';
import type { RunnerClient, RunnerResponse } from '../runner/client.js';
import { captureCheckpointGitState, compareGitState, getProjectDevelopment, toCheckpointGitState } from './service.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const PATH = '/srv/projects/example';

const availableGit = {
  repository: { available: true, isRepository: true, errorCode: null },
  head: { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', branch: 'main', detached: false, unborn: false },
  workingTree: {
    clean: false, stagedCount: 1, unstagedCount: 0, untrackedCount: 0,
    conflictedCount: 0, totalChangedCount: 1, filesTruncated: false,
  },
  files: [{
    path: 'src/app.ts', oldPath: null, state: 'modified' as const, staged: true, unstaged: false, untracked: false,
    size: 128, modifiedAt: '2026-08-15T10:00:00.000000000Z',
  }],
  recentCommits: [{
    sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Safe metadata',
    authorName: 'Developer', authoredAt: '2026-08-15T10:00:00.000Z',
  }],
  remote: {
    name: 'origin' as const, rawUrl: 'https://github.com/example/project.git', host: 'github.com',
    owner: 'example', repository: 'project', trackingBranch: 'origin/main', ahead: 1, behind: 0,
    comparisonBasis: 'local_tracking_ref' as const,
  },
  github: { detected: true, configured: false, status: 'not_configured' as const },
};

function db(checkpoints: unknown[] = []): Executor {
  let checkpointPage = 0;
  return {
    query: async (sql: string) => {
      if (sql.includes('FROM projects')) {
        return { rows: [{ id: PROJECT_ID, status: 'archived', location_canonical_path: PATH }] };
      }
      const page = checkpoints.slice(checkpointPage * 100, (checkpointPage + 1) * 100);
      checkpointPage += 1;
      return { rows: page.map((git_state, index) => ({
        git_state,
        created_at: new Date(Date.UTC(2026, 7, 15, 10, 0, -(checkpointPage * 100 + index))).toISOString(),
        id: '11111111-1111-4111-8111-111111111111',
      })) };
    },
  } as unknown as Executor;
}

function runner(result: Record<string, unknown>, ok = true): RunnerClient {
  return {
    invoke: async () => ({
      requestId: 'request-id', operation: 'project.git.development', ok, result,
      error: ok ? null : { code: 'failed', message: 'safe' }, durationMs: 1, truncated: false,
    } satisfies RunnerResponse),
  } as unknown as RunnerClient;
}

describe('Development State service', () => {
  it('maps a validated canonical runner response and compares server-side', async () => {
    const checkpoint = toCheckpointGitState({
      ...availableGit,
      head: { ...availableGit.head, sha: 'b'.repeat(40), shortSha: 'bbbbbbb' },
      workingTree: { ...availableGit.workingTree, clean: true, stagedCount: 0, totalChangedCount: 0 },
      files: [],
    }, '2026-08-14T10:00:00.000Z');
    const response = await getProjectDevelopment(db([checkpoint]), runner({
      valid: true, canonicalPath: PATH, allowedRoot: '/srv/projects', development: availableGit,
    }), PROJECT_ID);

    expect(developmentStateResponseSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      status: 'available',
      repository: { available: true, isRepository: true },
      checkpointComparison: { status: 'compared', headChanged: true, workingTreeChanged: true },
    });
    expect(response.attention.map((item) => item.key)).toEqual(['uncommitted_changes', 'local_branch_ahead']);
  });

  it('treats a canonical-path mismatch and malformed result as safe unavailable responses', async () => {
    for (const result of [
      { valid: true, canonicalPath: '/srv/projects/elsewhere', allowedRoot: '/srv/projects', development: availableGit },
      { arbitrary: 'shape' },
      {
        valid: true, canonicalPath: PATH, allowedRoot: '/srv/projects',
        development: { ...availableGit, files: [{ ...availableGit.files[0]!, path: '/etc/passwd' }] },
      },
    ]) {
      const response = await getProjectDevelopment(db(), runner(result), PROJECT_ID);
      expect(developmentStateResponseSchema.parse(response)).toEqual(response);
      expect(response.status).toBe('unavailable');
      expect(response.files).toEqual([]);
      expect(response.checkpointComparison).toEqual({ status: 'no_git_checkpoint' });
    }
  });

  it('never invents a HEAD comparison when repository state is unavailable or changed', () => {
    const repository: CheckpointGitState = {
      ...toCheckpointGitState(availableGit, '2026-08-14T10:00:00.000Z'),
      dirty: false, stagedCount: 0,
    };
    const notRepository: CheckpointGitState = {
      status: 'not_repository', capturedAt: '2026-08-15T10:00:00.000Z', branch: null,
      detached: false, headSha: null, headShortSha: null, dirty: false, stagedCount: 0,
      unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, remoteHost: null,
      remoteOwner: null, remoteRepository: null, trackingRef: null,
    };
    expect(compareGitState(repository, notRepository)).toMatchObject({
      status: 'compared', repositoryStateChanged: true, sameHead: null, headChanged: null,
    });
    expect(compareGitState(repository, { ...notRepository, status: 'unavailable' })).toEqual({
      status: 'unavailable', checkpointStatus: 'available', currentStatus: 'unavailable',
    });
  });

  it('skips every newer invalid Git checkpoint and compares the latest schema-valid candidate', async () => {
    const valid = toCheckpointGitState({
      ...availableGit,
      head: { ...availableGit.head, sha: 'b'.repeat(40), shortSha: 'bbbbbbb' },
    }, '2026-08-14T10:00:00.000Z');
    const response = await getProjectDevelopment(
      db([...Array.from({ length: 101 }, () => ({ status: 'available' })), valid]),
      runner({ valid: true, canonicalPath: PATH, allowedRoot: '/srv/projects', development: availableGit }),
      PROJECT_ID,
    );
    expect(response.checkpointComparison).toMatchObject({ status: 'compared', headChanged: true });
  });

  it('fails checkpoint capture closed when remote identity contains query or fragment data', async () => {
    for (const repository of ['project?token=secret', 'project#private']) {
      const captured = await captureCheckpointGitState(db(), runner({
        valid: true,
        canonicalPath: PATH,
        allowedRoot: '/srv/projects',
        development: { ...availableGit, remote: { ...availableGit.remote, repository } },
      }), PROJECT_ID);
      expect(captured).toMatchObject({ status: 'unavailable', remoteRepository: null });
      expect(JSON.stringify(captured)).not.toContain('secret');
      expect(JSON.stringify(captured)).not.toContain('private');
    }
  });
});
