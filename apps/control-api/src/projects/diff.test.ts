import { describe, expect, it } from 'vitest';
import { computeRescanDiff } from './diff.js';
import type { RunnerInspectResult } from '../runner/project-schemas.js';
import type { ProjectCommandRow, ProjectRow, ProjectTechnologyRow } from './types.js';

function baseProject(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: 'p1',
    name: 'Demo',
    short_code: null,
    description: '',
    purpose: '',
    product_goal: '',
    status: 'active',
    priority: 'medium',
    tags: [],
    created_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    archived_at: null,
    last_inspected_at: null,
    location_input_path: '/home/user/Desktop/demo',
    location_canonical_path: '/home/user/Desktop/demo',
    location_allowed_root: '/home/user/Desktop',
    location_accessible: true,
    location_checked_at: new Date(),
    repo_present: true,
    repo_top_level_path: '/home/user/Desktop/demo',
    repo_remotes: [{ name: 'origin', url: 'https://github.com/org/repo.git' }],
    repo_normalized_identity: 'github.com/org/repo',
    repo_active_branch: 'main',
    repo_default_branch: 'main',
    repo_default_branch_confidence: 'known',
    repo_last_commit_hash: 'a'.repeat(40),
    repo_last_commit_short_hash: 'aaaaaaa',
    repo_last_commit_at: new Date(),
    repo_last_commit_subject: 'initial commit',
    repo_is_dirty: false,
    repo_modified_count: 0,
    repo_untracked_count: 0,
    repo_scanned_at: new Date(),
    ...overrides,
  };
}

function validScan(overrides: Partial<Extract<RunnerInspectResult, { valid: true }>> = {}): RunnerInspectResult {
  return {
    valid: true,
    canonicalPath: '/home/user/Desktop/demo',
    allowedRoot: '/home/user/Desktop',
    scanVersion: '1',
    gitAvailable: true,
    git: {
      present: true,
      topLevelPath: '/home/user/Desktop/demo',
      remotes: [{ name: 'origin', url: 'https://github.com/org/repo.git' }],
      activeBranch: 'main',
      detached: false,
      defaultBranch: 'main',
      defaultBranchConfidence: 'known',
      lastCommitHash: 'a'.repeat(40),
      lastCommitShortHash: 'aaaaaaa',
      lastCommitAt: new Date().toISOString(),
      lastCommitSubject: 'initial commit',
      isDirty: false,
      modifiedCount: 0,
      untrackedCount: 0,
    },
    technologies: [],
    commands: [],
    manifests: [],
    warnings: [],
    limitsHit: [],
    ...overrides,
  };
}

function tech(overrides: Partial<ProjectTechnologyRow> = {}): ProjectTechnologyRow {
  return {
    id: 't1',
    project_id: 'p1',
    name: 'React',
    category: 'framework',
    version: null,
    detection_source: 'manifest',
    evidence_path: 'package.json',
    is_user_defined: false,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

describe('computeRescanDiff', () => {
  it('reports no changes for an identical scan', () => {
    const project = baseProject();
    const { diff, requiresConfirmation } = computeRescanDiff(project, [], [], validScan());
    expect(diff).toEqual([]);
    expect(requiresConfirmation).toBe(false);
  });

  it('flags a changed repository identity as critical and requiring confirmation', () => {
    const project = baseProject();
    const scan = validScan({
      git: { ...validScan().git!, remotes: [{ name: 'origin', url: 'https://github.com/org/different-repo.git' }] },
    });
    const { diff, requiresConfirmation } = computeRescanDiff(project, [], [], scan);
    const identityEntry = diff.find((d) => d.changeType === 'repository_identity_changed');
    expect(identityEntry?.severity).toBe('critical');
    expect(requiresConfirmation).toBe(true);
  });

  it('flags a branch change as informational only', () => {
    const project = baseProject();
    const scan = validScan({ git: { ...validScan().git!, activeBranch: 'feature/x' } });
    const { diff, requiresConfirmation } = computeRescanDiff(project, [], [], scan);
    const branchEntry = diff.find((d) => d.changeType === 'branch_changed');
    expect(branchEntry?.severity).toBe('info');
    expect(branchEntry?.previousValue).toBe('main');
    expect(branchEntry?.newValue).toBe('feature/x');
    expect(requiresConfirmation).toBe(false);
  });

  it('reports a newly detected technology', () => {
    const project = baseProject();
    const scan = validScan({
      technologies: [{ name: 'React', category: 'framework', version: '', evidencePath: 'package.json' }],
    });
    const { diff } = computeRescanDiff(project, [], [], scan);
    const entry = diff.find((d) => d.changeType === 'technology_added');
    expect(entry).toBeDefined();
    expect(entry?.newValue).toContain('React');
  });

  it('reports a technology that is no longer detected', () => {
    const project = baseProject();
    const { diff } = computeRescanDiff(project, [tech()], [], validScan());
    const entry = diff.find((d) => d.changeType === 'technology_removed');
    expect(entry).toBeDefined();
  });

  it('does not report a technology as removed if it is user-defined, even if not re-detected', () => {
    const project = baseProject();
    const userTech = tech({ detection_source: 'user', is_user_defined: true, name: 'Custom Tool' });
    const { diff } = computeRescanDiff(project, [userTech], [], validScan());
    expect(diff.find((d) => d.changeType === 'technology_removed')).toBeUndefined();
  });

  it('reports the folder becoming inaccessible without requiring confirmation', () => {
    const project = baseProject();
    const invalidScan: RunnerInspectResult = { valid: false, reason: 'not_found' };
    const { diff, requiresConfirmation } = computeRescanDiff(project, [], [], invalidScan);
    expect(diff).toEqual([
      {
        field: 'location.accessible',
        changeType: 'location_inaccessible',
        severity: 'warning',
        previousValue: 'true',
        newValue: 'false',
      },
    ]);
    expect(requiresConfirmation).toBe(false);
  });

  it('reports a repository being removed (git init undone / .git deleted)', () => {
    const project = baseProject();
    const scan = validScan({ git: { ...validScan().git!, present: false, remotes: [] } });
    const { diff } = computeRescanDiff(project, [], [], scan);
    expect(diff.find((d) => d.changeType === 'repository_removed')).toBeDefined();
  });

  it('reports a working tree becoming dirty', () => {
    const project = baseProject({ repo_is_dirty: false, repo_modified_count: 0, repo_untracked_count: 0 });
    const scan = validScan({ git: { ...validScan().git!, isDirty: true, modifiedCount: 2, untrackedCount: 1 } });
    const { diff } = computeRescanDiff(project, [], [], scan);
    const entry = diff.find((d) => d.changeType === 'working_tree_changed');
    expect(entry?.severity).toBe('info');
  });

  const command: ProjectCommandRow = {
    id: 'c1',
    project_id: 'p1',
    type: 'test',
    display_name: 'test',
    command_text: 'pnpm test',
    working_directory: '.',
    detection_source: 'manifest',
    is_user_defined: false,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
  };

  it('reports a newly detected command and a removed one independently', () => {
    const project = baseProject();
    const scan = validScan({
      commands: [{ type: 'build', displayName: 'build', commandText: 'pnpm build', workingDirectory: '.', evidencePath: 'package.json' }],
    });
    const { diff } = computeRescanDiff(project, [], [command], scan);
    expect(diff.find((d) => d.changeType === 'command_added')).toBeDefined();
    expect(diff.find((d) => d.changeType === 'command_removed')).toBeDefined();
  });
});
