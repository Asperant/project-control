import { describe, expect, it } from 'vitest';
import { normalizeRepositoryIdentity } from './repo-identity.js';

describe('normalizeRepositoryIdentity', () => {
  it('returns null when there are no remotes', () => {
    expect(normalizeRepositoryIdentity([])).toBeNull();
  });

  it('prefers the "origin" remote when several are present', () => {
    const id = normalizeRepositoryIdentity([
      { name: 'upstream', url: 'https://example.com/upstream/repo.git' },
      { name: 'origin', url: 'https://example.com/mine/repo.git' },
    ]);
    expect(id).toBe('example.com/mine/repo');
  });

  it('normalises https and ssh forms of the same repository to the same identity', () => {
    const https = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://github.com/org/repo.git' }]);
    const ssh = normalizeRepositoryIdentity([{ name: 'origin', url: 'git@github.com:org/repo.git' }]);
    expect(https).toBe(ssh);
    expect(https).toBe('github.com/org/repo');
  });

  it('strips a trailing slash and the .git suffix', () => {
    const a = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://github.com/org/repo.git' }]);
    const b = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://github.com/org/repo/' }]);
    expect(a).toBe(b);
  });

  it('lower-cases the host and path so casing differences do not evade duplicate detection', () => {
    const id = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://GitHub.com/Org/Repo.git' }]);
    expect(id).toBe('github.com/org/repo');
  });

  it('does not merge two genuinely different repositories on the same host', () => {
    const a = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://github.com/org/repo-one.git' }]);
    const b = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://github.com/org/repo-two.git' }]);
    expect(a).not.toBe(b);
  });

  it('does not merge the same repo path across two different hosts', () => {
    const a = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://github.com/org/repo.git' }]);
    const b = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://gitlab.com/org/repo.git' }]);
    expect(a).not.toBe(b);
  });

  it('never lets an unparseable remote collide with a well-formed one', () => {
    const wellFormed = normalizeRepositoryIdentity([{ name: 'origin', url: 'https://github.com/org/repo.git' }]);
    const weird = normalizeRepositoryIdentity([{ name: 'origin', url: 'not a url at all' }]);
    expect(weird).not.toBe(wellFormed);
    expect(weird).not.toBeNull();
  });

  it('handles an SSH URL with an explicit ssh:// scheme', () => {
    const id = normalizeRepositoryIdentity([{ name: 'origin', url: 'ssh://git@github.com/org/repo.git' }]);
    expect(id).toBe('github.com/org/repo');
  });
});
