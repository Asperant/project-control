import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DevelopmentStateResponse } from '@project-control/contracts';
import { DevelopmentView } from './components/development/DevelopmentView';

const projectId = '00000000-0000-4000-8000-000000000001';
const sha = 'a'.repeat(40);

function state(overrides: Partial<DevelopmentStateResponse> = {}): DevelopmentStateResponse {
  return {
    projectId, status: 'available', errorCode: null, repository: { available: true, isRepository: true },
    head: { sha, shortSha: sha.slice(0, 7), branch: 'main', detached: false, unborn: false },
    workingTree: { clean: false, stagedCount: 1, unstagedCount: 1, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 1 },
    files: [{ path: 'src/long file.ts', oldPath: null, state: 'modified', staged: true, unstaged: true, untracked: false }],
    filesTruncated: false,
    recentCommits: [{ sha, shortSha: sha.slice(0, 7), subject: 'Add safe metadata', authorName: 'Developer', authoredAt: '2026-08-15T10:00:00.000Z' }],
    remote: { name: 'origin', rawUrl: 'https://github.com/acme/repo.git', normalizedHost: 'github.com', owner: 'acme', repository: 'repo', trackingBranch: 'origin/main', ahead: 1, behind: 0, comparisonBasis: 'local_tracking_ref' },
    github: { detected: true, configured: false, status: 'not_configured' },
    checkpointComparison: { status: 'compared', repositoryStateChanged: false, sameHead: true, headChanged: false, branchChanged: false, workingTreeChanged: true, previousHeadSha: sha, currentHeadSha: sha, previousBranch: 'main', currentBranch: 'main', checkpointDirty: false, currentDirty: true },
    attention: [{ key: 'uncommitted_changes', label: '1 uncommitted changed file', count: 1 }],
    ...overrides,
  };
}

function render(value: DevelopmentStateResponse, archived = false, canWrite = false): string {
  return renderToStaticMarkup(<DevelopmentView projectId={projectId} archived={archived} canWrite={canWrite} onSessionExpired={() => undefined} initialData={value} />);
}

describe('Development presentation', () => {
  it('renders all read-only metadata sections and backend comparison facts', () => {
    const html = render(state());
    expect(Array.from(html.matchAll(/<h3>(\d+)\./g), (match) => Number(match[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(html).toContain('src/long file.ts');
    expect(html).toContain('locally stored ref; may be stale');
    expect(html).toContain('Working tree state changed.');
    expect(html).not.toContain('git add');
    expect(html).not.toContain('git push');
  });

  it('renders explicit non-repository and unavailable states', () => {
    const empty = {
      head: { sha: null, shortSha: null, branch: null, detached: false, unborn: false },
      workingTree: { clean: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 0 },
      files: [], filesTruncated: false, recentCommits: [], remote: null,
      github: { detected: false as const, configured: false as const, status: 'unsupported' as const }, attention: [],
    };
    expect(render(state({ ...empty, status: 'not_repository', errorCode: null, repository: { available: true, isRepository: false }, checkpointComparison: { status: 'no_git_checkpoint' } }))).toContain('not a Git repository');
    const unavailable = render(state({ ...empty, status: 'unavailable', errorCode: 'runner_unavailable', repository: { available: false, isRepository: false }, checkpointComparison: { status: 'unavailable', checkpointStatus: null, currentStatus: 'unavailable' } }), true);
    expect(unavailable).toContain('Git inspection is unavailable');
    expect(unavailable).toContain('GitHub detection is unavailable');
    expect(unavailable).toContain('Development State remains readable and read-only');
  });
});
