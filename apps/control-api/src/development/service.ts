import type {
  CheckpointGitComparison, CheckpointGitState, DevelopmentAttentionItem,
  DevelopmentStateResponse,
} from '@project-control/contracts';
import { checkpointGitStateSchema, developmentStateResponseSchema } from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';
import { notFound } from '../errors.js';
import { RunnerUnavailableError, type RunnerClient } from '../runner/client.js';
import {
  runnerGitDevelopmentResultSchema,
  type RunnerGitDevelopment,
} from '../runner/project-schemas.js';

type ProjectDevelopmentRow = {
  id: string;
  status: string;
  location_canonical_path: string;
};

type GitCheckpointRow = {
  git_state: unknown;
  created_at: string;
  id: string;
};

export type DevelopmentSource = {
  project: ProjectDevelopmentRow;
  git: RunnerGitDevelopment;
};

function unavailableDevelopment(errorCode: string): RunnerGitDevelopment {
  return {
    repository: { available: false, isRepository: false, errorCode },
    head: { sha: null, shortSha: null, branch: null, detached: false, unborn: false },
    workingTree: {
      clean: true,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      conflictedCount: 0,
      totalChangedCount: 0,
      filesTruncated: false,
    },
    files: [],
    recentCommits: [],
    remote: null,
    github: { detected: false, configured: false, status: 'unavailable' },
  };
}

async function loadProject(db: Executor, projectId: string): Promise<ProjectDevelopmentRow> {
  const { rows } = await db.query<ProjectDevelopmentRow>(
    'SELECT id, status, location_canonical_path FROM projects WHERE id=$1',
    [projectId],
  );
  if (!rows[0]) throw notFound('Project not found.');
  return rows[0];
}

/**
 * Inspects only the canonical path persisted at registration time. The runner
 * independently canonicalises the path; a byte-for-byte mismatch is treated as
 * unavailable so symlink/path drift cannot silently inspect a different tree.
 */
export async function loadDevelopmentSource(
  db: Executor,
  runner: RunnerClient,
  projectId: string,
  requestId?: string,
): Promise<DevelopmentSource> {
  const project = await loadProject(db, projectId);
  try {
    const response = await runner.invoke(
      'project.git.development',
      { path: project.location_canonical_path },
      requestId,
    );
    if (!response.ok) {
      return { project, git: unavailableDevelopment('runner_unavailable') };
    }
    const parsed = runnerGitDevelopmentResultSchema.safeParse(response.result);
    if (!parsed.success) {
      return { project, git: unavailableDevelopment('invalid_runner_response') };
    }
    if (!parsed.data.valid) {
      return { project, git: unavailableDevelopment('project_path_unavailable') };
    }
    if (parsed.data.canonicalPath !== project.location_canonical_path) {
      return { project, git: unavailableDevelopment('project_path_unavailable') };
    }
    return { project, git: parsed.data.development };
  } catch (error) {
    const errorCode = error instanceof RunnerUnavailableError
      ? 'runner_unavailable'
      : 'inspection_failed';
    return { project, git: unavailableDevelopment(errorCode) };
  }
}

export function toCheckpointGitState(
  git: RunnerGitDevelopment,
  capturedAt = new Date().toISOString(),
): CheckpointGitState {
  const status = !git.repository.available
    ? 'unavailable'
    : git.repository.errorCode === 'not_repository'
      ? 'not_repository'
      : git.repository.errorCode !== null
        ? 'unavailable'
        : git.repository.isRepository
      ? 'available'
      : 'unavailable';
  return {
    status,
    capturedAt,
    branch: status === 'available' ? git.head.branch : null,
    detached: status === 'available' ? git.head.detached : false,
    headSha: status === 'available' ? git.head.sha : null,
    headShortSha: status === 'available' ? git.head.shortSha : null,
    dirty: status === 'available' ? !git.workingTree.clean : false,
    stagedCount: status === 'available' ? git.workingTree.stagedCount : 0,
    unstagedCount: status === 'available' ? git.workingTree.unstagedCount : 0,
    untrackedCount: status === 'available' ? git.workingTree.untrackedCount : 0,
    conflictedCount: status === 'available' ? git.workingTree.conflictedCount : 0,
    remoteHost: status === 'available' ? git.remote?.host ?? null : null,
    remoteOwner: status === 'available' ? git.remote?.owner ?? null : null,
    remoteRepository: status === 'available' ? git.remote?.repository ?? null : null,
    trackingRef: status === 'available' ? git.remote?.trackingBranch ?? null : null,
  };
}

export async function captureCheckpointGitState(
  db: Executor,
  runner: RunnerClient,
  projectId: string,
  requestId?: string,
): Promise<CheckpointGitState> {
  const source = await loadDevelopmentSource(db, runner, projectId, requestId);
  const capturedAt = new Date().toISOString();
  const candidate = toCheckpointGitState(source.git, capturedAt);
  const parsed = checkpointGitStateSchema.safeParse(candidate);
  return parsed.success
    ? parsed.data
    : {
        status: 'unavailable', capturedAt, branch: null, detached: false,
        headSha: null, headShortSha: null, dirty: false, stagedCount: 0,
        unstagedCount: 0, untrackedCount: 0, conflictedCount: 0,
        remoteHost: null, remoteOwner: null, remoteRepository: null, trackingRef: null,
      };
}

export function compareGitState(
  checkpoint: CheckpointGitState | null,
  current: CheckpointGitState,
): CheckpointGitComparison {
  if (!checkpoint) return { status: 'no_git_checkpoint' };
  if (current.status === 'unavailable') {
    return { status: 'unavailable', checkpointStatus: checkpoint.status, currentStatus: current.status };
  }
  const bothRepositories = checkpoint.status === 'available' && current.status === 'available';
  const knownHeads = bothRepositories && checkpoint.headSha !== null && current.headSha !== null;
  return {
    status: 'compared',
    repositoryStateChanged: checkpoint.status !== current.status,
    sameHead: knownHeads ? checkpoint.headSha === current.headSha : null,
    headChanged: knownHeads ? checkpoint.headSha !== current.headSha : null,
    branchChanged: bothRepositories
      ? checkpoint.branch !== current.branch || checkpoint.detached !== current.detached
      : null,
    workingTreeChanged: bothRepositories
      ? checkpoint.dirty !== current.dirty
      || checkpoint.stagedCount !== current.stagedCount
      || checkpoint.unstagedCount !== current.unstagedCount
      || checkpoint.untrackedCount !== current.untrackedCount
      || checkpoint.conflictedCount !== current.conflictedCount
      : null,
    previousHeadSha: checkpoint.headSha,
    currentHeadSha: current.headSha,
    previousBranch: checkpoint.branch,
    currentBranch: current.branch,
    checkpointDirty: checkpoint.status === 'available' ? checkpoint.dirty : null,
    currentDirty: current.status === 'available' ? current.dirty : null,
  };
}

function developmentAttention(git: RunnerGitDevelopment, status: CheckpointGitState['status']): DevelopmentAttentionItem[] {
  if (status === 'unavailable') {
    return [{ key: 'git_inspection_unavailable', label: 'Git inspection is unavailable.', count: 1 }];
  }
  if (status === 'not_repository') {
    return [{ key: 'repository_not_detected', label: 'The registered project is not a Git repository.', count: 1 }];
  }
  const items: DevelopmentAttentionItem[] = [];
  if (!git.workingTree.clean) items.push({ key: 'uncommitted_changes', label: `${git.workingTree.totalChangedCount} changed file${git.workingTree.totalChangedCount === 1 ? '' : 's'} in the working tree.`, count: git.workingTree.totalChangedCount || 1 });
  if (git.workingTree.conflictedCount) items.push({ key: 'merge_conflicts', label: `${git.workingTree.conflictedCount} merge conflict${git.workingTree.conflictedCount === 1 ? '' : 's'} require attention.`, count: git.workingTree.conflictedCount });
  if (git.head.detached) items.push({ key: 'detached_head', label: 'HEAD is detached.', count: 1 });
  if (!git.remote) items.push({ key: 'no_remote_configured', label: 'No origin remote is configured.', count: 1 });
  if (git.remote?.comparisonBasis === 'local_tracking_ref' && git.remote.ahead) items.push({ key: 'local_branch_ahead', label: `Local branch is ${git.remote.ahead} commit${git.remote.ahead === 1 ? '' : 's'} ahead of the locally stored tracking ref.`, count: git.remote.ahead });
  if (git.remote?.comparisonBasis === 'local_tracking_ref' && git.remote.behind) items.push({ key: 'local_branch_behind', label: `Local branch is ${git.remote.behind} commit${git.remote.behind === 1 ? '' : 's'} behind the locally stored tracking ref.`, count: git.remote.behind });
  return items;
}

async function loadLatestComparableGitCheckpoint(
  db: Executor,
  projectId: string,
): Promise<CheckpointGitState | null> {
  const pageSize = 100;
  let beforeCreatedAt: string | null = null;
  let beforeId: string | null = null;
  for (;;) {
    const page = await db.query<GitCheckpointRow>(
      `SELECT snapshot_json->'gitState' AS git_state, created_at::text AS created_at, id FROM project_checkpoints
        WHERE project_id=$1 AND archived_at IS NULL AND snapshot_version=3
          AND snapshot_json->'gitState'->>'status' IN ('available','not_repository')
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [projectId, beforeCreatedAt, beforeId, pageSize],
    );
    const rows: GitCheckpointRow[] = page.rows;
    for (const row of rows) {
      const parsed = checkpointGitStateSchema.safeParse(row.git_state);
      if (parsed.success && (parsed.data.status === 'available' || parsed.data.status === 'not_repository')) {
        return parsed.data;
      }
    }
    if (rows.length < pageSize) return null;
    const last: GitCheckpointRow = rows.at(-1)!;
    beforeCreatedAt = last.created_at;
    beforeId = last.id;
  }
}

export async function getProjectDevelopment(
  db: Executor,
  runner: RunnerClient,
  projectId: string,
  requestId?: string,
): Promise<DevelopmentStateResponse> {
  const source = await loadDevelopmentSource(db, runner, projectId, requestId);
  const currentGitState = toCheckpointGitState(source.git);
  const checkpointGitState = await loadLatestComparableGitCheckpoint(db, projectId);
  const available = currentGitState.status === 'available';
  const statusError = source.git.repository.errorCode;
  const errorCode = currentGitState.status === 'unavailable'
    ? statusError === 'runner_unavailable' || statusError === 'git_unavailable'
      || statusError === 'project_path_unavailable' || statusError === 'inspection_failed'
      || statusError === 'invalid_runner_response'
      ? statusError
      : 'inspection_failed'
    : null;
  const result = {
    projectId,
    status: currentGitState.status,
    errorCode,
    repository: { available: currentGitState.status !== 'unavailable', isRepository: available },
    head: available ? source.git.head : { sha: null, shortSha: null, branch: null, detached: false, unborn: false },
    workingTree: available
      ? {
          clean: source.git.workingTree.clean,
          stagedCount: source.git.workingTree.stagedCount,
          unstagedCount: source.git.workingTree.unstagedCount,
          untrackedCount: source.git.workingTree.untrackedCount,
          conflictedCount: source.git.workingTree.conflictedCount,
          totalChangedCount: source.git.workingTree.totalChangedCount,
        }
      : { clean: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflictedCount: 0, totalChangedCount: 0 },
    files: available
      ? source.git.files.map((file) => ({
          ...file,
          state: file.state === 'conflicted' ? 'unmerged' as const : file.state,
        }))
      : [],
    filesTruncated: available ? source.git.workingTree.filesTruncated : false,
    recentCommits: available
      ? source.git.recentCommits.map((commit) => ({
          ...commit,
          authoredAt: new Date(commit.authoredAt).toISOString(),
        }))
      : [],
    remote: available && source.git.remote
      ? (() => {
          const hasLocalComparison = source.git.remote.comparisonBasis === 'local_tracking_ref'
            && source.git.remote.trackingBranch !== null
            && source.git.remote.ahead !== null
            && source.git.remote.behind !== null;
          return {
          name: source.git.remote.name,
          rawUrl: source.git.remote.rawUrl,
          normalizedHost: source.git.remote.host,
          owner: source.git.remote.owner,
          repository: source.git.remote.repository,
          trackingBranch: source.git.remote.trackingBranch,
          ahead: hasLocalComparison ? source.git.remote.ahead : null,
          behind: hasLocalComparison ? source.git.remote.behind : null,
          comparisonBasis: hasLocalComparison
            ? 'local_tracking_ref'
            : 'not_available',
          } as const;
        })()
      : null,
    github: available
      ? { detected: source.git.github.detected, configured: false, status: source.git.github.detected ? 'not_configured' : 'unsupported' }
      : { detected: false, configured: false, status: 'unsupported' },
    checkpointComparison: compareGitState(checkpointGitState, currentGitState),
    attention: developmentAttention(source.git, currentGitState.status),
  };
  const parsed = developmentStateResponseSchema.safeParse(result);
  if (parsed.success) return parsed.data;

  // Treat any semantic mismatch at the runner boundary (unsafe path, invalid
  // remote, inconsistent counts, etc.) like a malformed runner response. An
  // observational read must remain a safe 200 and expose none of that payload.
  const unavailable = toCheckpointGitState(
    unavailableDevelopment('invalid_runner_response'),
    new Date().toISOString(),
  );
  return developmentStateResponseSchema.parse({
    projectId,
    status: 'unavailable',
    errorCode: 'invalid_runner_response',
    repository: { available: false, isRepository: false },
    head: { sha: null, shortSha: null, branch: null, detached: false, unborn: false },
    workingTree: {
      clean: null, stagedCount: 0, unstagedCount: 0, untrackedCount: 0,
      conflictedCount: 0, totalChangedCount: 0,
    },
    files: [],
    filesTruncated: false,
    recentCommits: [],
    remote: null,
    github: { detected: false, configured: false, status: 'unsupported' },
    checkpointComparison: compareGitState(checkpointGitState, unavailable),
    attention: [{ key: 'git_inspection_unavailable', label: 'Git inspection is unavailable.', count: 1 }],
  });
}
