import { createHash } from 'node:crypto';
import type { GitCommitPlan, PlanGitCommitRequest, RepositoryActionRisk } from '@project-control/contracts';
import type { RunnerGitDevelopment, RunnerPathIdentity } from '../runner/project-schemas.js';
import { badRequest } from '../errors.js';

/**
 * Pure functions for building and fingerprinting a `git.commit` Repository
 * Action plan. Nothing here talks to the runner or the database — see
 * repository-actions/store.ts for the orchestration that calls these with a
 * fresh runner read.
 */

/**
 * Name-shape denylist. This is a UX convenience only: it lets the plan
 * preview exclude an obviously sensitive file (and say so) before the
 * operator ever sees it in a list of things they could select. It is not the
 * authority — the runner's own, independently maintained copy in
 * apps/runner/internal/gitwrite is what actually refuses the commit even if
 * this list were ever out of sync or bypassed by a modified client.
 */
const PROTECTED_PATH_PATTERNS: RegExp[] = [
  /(?:^|\/)\.env(?:\..+)?$/,
  /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /\.keystore$/, /\.kdbx$/,
  /(?:^|\/)id_rsa(?:\.pub)?$/, /(?:^|\/)id_ed25519(?:\.pub)?$/, /(?:^|\/)id_ecdsa(?:\.pub)?$/,
  /(?:^|\/)\.netrc$/, /(?:^|\/)\.npmrc$/, /(?:^|\/)\.pgpass$/,
  /(?:^|\/)credentials\.json$/, /(?:^|\/)service-account.*\.json$/,
  /(?:^|\/)secrets\//, /(?:^|\/)\.aws\//, /(?:^|\/)\.ssh\//,
];

export function isProtectedPath(path: string): boolean {
  return PROTECTED_PATH_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * Splits a caller's requested path selection into what can actually be
 * planned (a protected-free subset that corresponds to a real pending change
 * in the working tree) and what was excluded because it matched the
 * protected-path denylist. A requested path with no corresponding entry in
 * `development.files` is silently dropped from both lists — selecting a path
 * that has not changed is not an error, just a no-op the operator's client
 * should not have offered, and the commit would be refused as an empty
 * selection regardless.
 */
export function selectCommitPaths(
  requested: string[],
  development: Pick<RunnerGitDevelopment, 'files'>,
): { selectedPaths: string[]; excludedProtectedPaths: string[] } {
  const changed = new Set(development.files.map((file) => file.path));
  const selectedPaths: string[] = [];
  const excludedProtectedPaths: string[] = [];
  for (const path of requested) {
    if (isProtectedPath(path)) {
      excludedProtectedPaths.push(path);
      continue;
    }
    if (changed.has(path)) selectedPaths.push(path);
  }
  return { selectedPaths, excludedProtectedPaths };
}

/**
 * Risk classification. Push does not exist in this version (see
 * docs/repository-actions.md for why), so the only meaningful axis today is
 * "does this commit land on the branch a human would call this project's
 * main line". `high` requires the runner's own local-ref-derived confidence
 * to be `known` (an explicit `origin/HEAD` symref) — an `inferred` guess
 * (falling back to a `main`/`master` branch existing locally) is treated as
 * `medium`, the same as any other branch, because presenting an inferred
 * guess as a hard "you are about to touch the default branch" warning would
 * overstate what the runner actually knows.
 */
export function classifyRisk(branch: string, defaultBranch: string, defaultBranchConfidence: string): RepositoryActionRisk {
  const isDefaultBranch = defaultBranchConfidence === 'known' && branch === defaultBranch;
  return isDefaultBranch ? 'high' : 'medium';
}

export type CommitFingerprintInput = {
  canonicalPath: string;
  branch: string;
  headSha: string | null;
  detached: boolean;
  selectedPaths: string[];
  /** Content identities for (at least) every path in selectedPaths — see
   * apps/runner/internal/gitinfo/identity.go. Extra entries (e.g. for a
   * request path that did not survive protected/no-op filtering) are simply
   * ignored; only selectedPaths participates in the digest. */
  identities: RunnerPathIdentity[];
};

/**
 * SHA-256 over a deterministic, canonically ordered summary of exactly the
 * repository state a `git.commit` plan depends on: identity (path, branch,
 * HEAD), and a *content-addressed* identity of every selected file — never
 * the file's own bytes. Recomputed from a fresh runner read at execute time;
 * any difference means the repository moved since the operator was shown the
 * preview, and the action is rejected rather than silently re-planned
 * against a state nobody confirmed. See repository-actions/store.ts.
 *
 * Deliberately does not attempt to independently detect every precondition
 * gitwrite itself enforces (merge in progress, unmerged paths, commit
 * identity) — the runner is the authority there and reports a stable reason
 * code if any of them holds at execute time. This fingerprint's job is
 * narrower: catch the case where the *content* of a file the operator
 * approved is no longer what they approved.
 *
 * Content identity, not size/mtime: an earlier version of this function used
 * only each file's git status category plus its working-tree size and
 * modification time. That is not content-safe — `cp -p`, `rsync -a`, or any
 * tool/editor that preserves timestamps can produce a byte-for-byte
 * different file at an identical size and mtime, which that version could
 * not distinguish from "unchanged". `identities` now carries a git-blob-
 * identity content hash (see gitinfo.ComputePathIdentity) computed by the
 * runner for exactly the selected paths — bounded per file
 * (gitinfo.MaxContentHashBytes) and never for the whole repository — plus
 * the file's mode, so a content-identical chmod is still detected as a
 * change. See plan.test.ts for the regression coverage of the exact
 * same-size/same-mtime scenario this replaces.
 */
export function computeCommitFingerprint(input: CommitFingerprintInput): string {
  const byPath = new Map(input.identities.map((identity) => [identity.path, identity]));
  const paths = [...input.selectedPaths].sort().map((path) => {
    const identity = byPath.get(path);
    return {
      path,
      kind: identity?.kind ?? null,
      contentHash: identity?.contentHash ?? null,
      mode: identity?.mode ?? null,
      unsupportedReason: identity?.unsupportedReason ?? null,
      // Only meaningful (and only ever set by the runner) when
      // unsupportedReason is "oversized" — the one case a full content read
      // is deliberately refused, so this weaker signal is the only thing
      // available to detect a change. See the package doc above.
      fallbackSize: identity?.unsupportedReason === 'oversized' ? identity.fallbackSize : null,
      fallbackModifiedAt: identity?.unsupportedReason === 'oversized' ? identity.fallbackModifiedAt : null,
    };
  });
  const canonical = JSON.stringify({
    canonicalPath: input.canonicalPath,
    branch: input.branch,
    headSha: input.headSha,
    detached: input.detached,
    paths,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export type BuildGitCommitPlanInput = {
  canonicalPath: string;
  branch: string;
  detached: boolean;
  headSha: string | null;
  defaultBranch: string;
  defaultBranchConfidence: string;
  development: Pick<RunnerGitDevelopment, 'files'>;
  request: PlanGitCommitRequest;
};

/**
 * Builds a plan preview — selection, risk and the resulting GitCommitPlan
 * shape — or throws a bad_request AppError when nothing plannable remains
 * after excluding protected paths and paths with no pending change. Does
 * *not* compute the fingerprint: that requires content identities for the
 * final selectedPaths, which only the caller (repository-actions/store.ts)
 * can fetch from the runner, since this function stays pure and runner-free.
 * Call computeCommitFingerprint separately once those identities are in
 * hand — see planGitCommit in store.ts for the exact sequencing.
 */
export function buildGitCommitPlan(input: BuildGitCommitPlanInput): {
  plan: GitCommitPlan;
  risk: RepositoryActionRisk;
} {
  if (input.detached) {
    throw badRequest('The repository is in a detached HEAD state; commits are only supported on a named branch.');
  }
  const { selectedPaths, excludedProtectedPaths } = selectCommitPaths(input.request.paths, input.development);
  if (selectedPaths.length === 0) {
    throw badRequest(
      excludedProtectedPaths.length > 0
        ? 'Every selected path is protected and cannot be committed.'
        : 'None of the selected paths have a pending change to commit.',
    );
  }

  const risk = classifyRisk(input.branch, input.defaultBranch, input.defaultBranchConfidence);
  const plan: GitCommitPlan = {
    kind: 'git.commit',
    branch: input.branch,
    isDefaultBranch: risk === 'high',
    expectedHead: input.headSha,
    selectedPaths,
    excludedProtectedPaths,
    message: input.request.message,
  };
  return { plan, risk };
}
