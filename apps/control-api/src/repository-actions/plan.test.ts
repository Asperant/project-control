import { describe, expect, it } from 'vitest';
import { AppError } from '../errors.js';
import type { RunnerPathIdentity } from '../runner/project-schemas.js';
import {
  buildGitCommitPlan, classifyRisk, computeCommitFingerprint, isProtectedPath, selectCommitPaths,
} from './plan.js';

const sha = 'a'.repeat(40);
const blobHashA = 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0';
const blobHashB = '8c3f0d1e2a1a5f6b7c8d9e0f1a2b3c4d5e6f7081';

function changedFile(path: string, overrides: Partial<{ state: string; staged: boolean; unstaged: boolean; untracked: boolean }> = {}) {
  return { path, oldPath: null, state: 'modified', staged: false, unstaged: true, untracked: false, ...overrides };
}

function identity(path: string, overrides: Partial<RunnerPathIdentity> = {}): RunnerPathIdentity {
  return {
    path, kind: 'file', contentHash: blobHashA, mode: '100644',
    unsupportedReason: null, fallbackSize: 0, fallbackModifiedAt: null,
    ...overrides,
  };
}

describe('isProtectedPath', () => {
  it('matches known sensitive names', () => {
    for (const path of ['.env', '.env.production', 'backend/.env.local', 'id_rsa', 'keys/id_ed25519', 'server.key', 'a.pem', 'secrets/x.txt', '.ssh/config', '.aws/credentials']) {
      expect(isProtectedPath(path)).toBe(true);
    }
  });

  it('does not match ordinary source paths', () => {
    for (const path of ['README.md', 'src/index.ts', 'environment.ts', 'keys.md']) {
      expect(isProtectedPath(path)).toBe(false);
    }
  });
});

describe('selectCommitPaths', () => {
  it('excludes protected paths and reports them separately', () => {
    const result = selectCommitPaths(['README.md', '.env'], { files: [changedFile('README.md'), changedFile('.env')] });
    expect(result.selectedPaths).toEqual(['README.md']);
    expect(result.excludedProtectedPaths).toEqual(['.env']);
  });

  it('drops a requested path with no corresponding pending change', () => {
    const result = selectCommitPaths(['README.md', 'untouched.txt'], { files: [changedFile('README.md')] });
    expect(result.selectedPaths).toEqual(['README.md']);
    expect(result.excludedProtectedPaths).toEqual([]);
  });
});

describe('classifyRisk', () => {
  it('is high only when the branch matches a known default branch', () => {
    expect(classifyRisk('main', 'main', 'known')).toBe('high');
  });

  it('is medium for a non-default branch', () => {
    expect(classifyRisk('feature/x', 'main', 'known')).toBe('medium');
  });

  it('is medium, not high, for a merely inferred default branch match', () => {
    expect(classifyRisk('main', 'main', 'inferred')).toBe('medium');
  });
});

describe('computeCommitFingerprint', () => {
  const base = {
    canonicalPath: '/home/asrin/Desktop/demo', branch: 'main', headSha: sha, detached: false,
    selectedPaths: ['README.md'], identities: [identity('README.md')],
  };

  it('is deterministic for identical input', () => {
    expect(computeCommitFingerprint(base)).toBe(computeCommitFingerprint(base));
  });

  it('changes when the HEAD sha changes', () => {
    const other = { ...base, headSha: 'b'.repeat(40) };
    expect(computeCommitFingerprint(base)).not.toBe(computeCommitFingerprint(other));
  });

  it('changes when the content hash changes', () => {
    const other = { ...base, identities: [identity('README.md', { contentHash: blobHashB })] };
    expect(computeCommitFingerprint(base)).not.toBe(computeCommitFingerprint(other));
  });

  // Regression test for the exact scenario the fingerprint re-review asked
  // to be proven: plan → edit content → keep size and mtime identical
  // (cp -p / rsync -a / an editor that preserves timestamps all produce
  // this) → execute must not silently succeed. The old size+mtime-only
  // fingerprint could not distinguish this from "unchanged"; content
  // identity (a distinct hash for distinct bytes) does, deterministically,
  // without ever comparing size or mtime.
  it('changes when a file is edited again with byte-identical size/mtime (the exact staleness scenario under review)', () => {
    const planTime = { ...base, identities: [identity('README.md', { contentHash: blobHashA })] };
    const executeTimeAfterSilentEdit = { ...base, identities: [identity('README.md', { contentHash: blobHashB })] };
    expect(computeCommitFingerprint(planTime)).not.toBe(computeCommitFingerprint(executeTimeAfterSilentEdit));
  });

  it('changes when only the file mode changes (e.g. chmod +x) with byte-identical content', () => {
    const other = { ...base, identities: [identity('README.md', { mode: '100755' })] };
    expect(computeCommitFingerprint(base)).not.toBe(computeCommitFingerprint(other));
  });

  it('changes when a selected file becomes absent (deleted after planning)', () => {
    const other = {
      ...base,
      identities: [identity('README.md', { kind: 'absent', contentHash: null, mode: null })],
    };
    expect(computeCommitFingerprint(base)).not.toBe(computeCommitFingerprint(other));
  });

  it('changes when a selected file becomes a symlink with the same path', () => {
    const symlinked = {
      ...base,
      identities: [identity('README.md', { kind: 'symlink', mode: '120000', contentHash: blobHashB })],
    };
    expect(computeCommitFingerprint(base)).not.toBe(computeCommitFingerprint(symlinked));
  });

  it('changes for an oversized file whose fallback size changes, even with no content hash available', () => {
    const oversizedBefore = {
      ...base,
      identities: [identity('README.md', {
        kind: 'unsupported', contentHash: null, mode: null,
        unsupportedReason: 'oversized', fallbackSize: 9_000_000, fallbackModifiedAt: '2026-08-16T10:00:00.000000000Z',
      })],
    };
    const oversizedAfter = {
      ...base,
      identities: [identity('README.md', {
        kind: 'unsupported', contentHash: null, mode: null,
        unsupportedReason: 'oversized', fallbackSize: 9_500_000, fallbackModifiedAt: '2026-08-16T10:00:00.000000000Z',
      })],
    };
    expect(computeCommitFingerprint(oversizedBefore)).not.toBe(computeCommitFingerprint(oversizedAfter));
  });

  it('ignores identities for paths outside selectedPaths', () => {
    const withExtra = { ...base, identities: [...base.identities, identity('unrelated.txt', { contentHash: blobHashB })] };
    expect(computeCommitFingerprint(base)).toBe(computeCommitFingerprint(withExtra));
  });

  it('is independent of the input path selection order', () => {
    const identities = [identity('a.txt'), identity('b.txt', { contentHash: blobHashB })];
    const forward = computeCommitFingerprint({ ...base, selectedPaths: ['a.txt', 'b.txt'], identities });
    const reverse = computeCommitFingerprint({ ...base, selectedPaths: ['b.txt', 'a.txt'], identities });
    expect(forward).toBe(reverse);
  });

  it('is independent of the input identities array order', () => {
    const forward = computeCommitFingerprint({
      ...base, selectedPaths: ['a.txt', 'b.txt'],
      identities: [identity('a.txt'), identity('b.txt', { contentHash: blobHashB })],
    });
    const reverse = computeCommitFingerprint({
      ...base, selectedPaths: ['a.txt', 'b.txt'],
      identities: [identity('b.txt', { contentHash: blobHashB }), identity('a.txt')],
    });
    expect(forward).toBe(reverse);
  });

  it('produces a lowercase 64-character hex digest', () => {
    expect(computeCommitFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stays bounded for a large number of selected paths', () => {
    const many = Array.from({ length: 200 }, (_, i) => `src/file-${i}.ts`);
    const identities = many.map((path, i) => identity(path, { contentHash: i % 2 === 0 ? blobHashA : blobHashB }));
    const start = Date.now();
    const result = computeCommitFingerprint({ ...base, selectedPaths: many, identities });
    expect(Date.now() - start).toBeLessThan(200);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildGitCommitPlan', () => {
  const baseInput = {
    canonicalPath: '/home/asrin/Desktop/demo', branch: 'feature/x', detached: false, headSha: sha,
    defaultBranch: 'main', defaultBranchConfidence: 'known' as const,
    development: { files: [changedFile('README.md')] },
    request: { paths: ['README.md'], message: 'feat: update readme' },
  };

  it('builds a medium-risk plan for a non-default branch', () => {
    const { plan, risk } = buildGitCommitPlan(baseInput);
    expect(risk).toBe('medium');
    expect(plan.selectedPaths).toEqual(['README.md']);
    expect(plan.isDefaultBranch).toBe(false);
  });

  it('builds a high-risk plan when committing to the known default branch', () => {
    const { plan, risk } = buildGitCommitPlan({ ...baseInput, branch: 'main' });
    expect(risk).toBe('high');
    expect(plan.isDefaultBranch).toBe(true);
  });

  it('throws when the repository is detached', () => {
    expect(() => buildGitCommitPlan({ ...baseInput, detached: true })).toThrow(AppError);
  });

  it('throws when every selected path is protected', () => {
    const input = {
      ...baseInput,
      development: { files: [changedFile('.env')] },
      request: { paths: ['.env'], message: 'x' },
    };
    expect(() => buildGitCommitPlan(input)).toThrow(AppError);
  });

  it('throws when no selected path has a pending change', () => {
    const input = { ...baseInput, development: { files: [] }, request: { paths: ['README.md'], message: 'x' } };
    expect(() => buildGitCommitPlan(input)).toThrow(AppError);
  });

  it('accepts a null expectedHead for an unborn branch, and no longer computes a fingerprint itself', () => {
    const { plan } = buildGitCommitPlan({ ...baseInput, headSha: null });
    expect(plan.expectedHead).toBeNull();
    expect('fingerprint' in plan).toBe(false);
  });
});
