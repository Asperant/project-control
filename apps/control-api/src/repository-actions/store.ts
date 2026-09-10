import { randomUUID } from 'node:crypto';
import type {
  ExecuteRepositoryActionRequest, GitCommitPlan, PlanGitCommitRequest, RepositoryAction,
  RepositoryActionFailureReason, RepositoryActionResult, RepositoryActionRisk, RepositoryActionStatus,
} from '@project-control/contracts';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, badRequest, notFound } from '../errors.js';
import { getProjectGuard, assertProjectMutable, type Executor } from '../projects/guard.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';
import type { RunnerClient } from '../runner/client.js';
import { RunnerUnavailableError } from '../runner/client.js';
import {
  runnerGitCommitResultSchema, runnerGitSummaryResultSchema, runnerGitWriteStatusResultSchema,
  type RunnerPathIdentity,
} from '../runner/project-schemas.js';
import { loadDevelopmentSource } from '../development/service.js';
import { buildGitCommitPlan, computeCommitFingerprint } from './plan.js';

/**
 * Repository Actions: the platform's one controlled mutation path into a
 * registered project's own repository. See docs/repository-actions.md for
 * the full design; this module is the plan -> confirm+execute -> verify ->
 * settle state machine described there.
 *
 * A "planned" row commits the caller to nothing by itself — it is a preview,
 * expiring after PLAN_TTL_MS. Confirming and running are the same request
 * (executeRepositoryAction): there is no separate "confirmed but not yet
 * running" state for a race to land in.
 */

const PLAN_TTL_MS = 5 * 60 * 1000;

/** A 'running' row older than this without settling is treated as needing
 * reconciliation rather than assumed to still be in flight — see
 * reconcileRepositoryAction. Generous relative to the runner's own 60s
 * project.git.commit timeout. */
const RUNNING_STALE_MS = 5 * 60 * 1000;

type ProjectRow = { id: string; status: string; location_canonical_path: string };

type ActionRow = {
  id: string; project_id: string; kind: string; status: RepositoryActionStatus; risk: RepositoryActionRisk;
  plan_json: GitCommitPlan; fingerprint: string; expires_at: Date;
  requested_by: string | null; started_at: Date | null; settled_at: Date | null;
  result_json: RepositoryActionResult | null; created_at: Date; updated_at: Date;
};

function mapAction(row: ActionRow): RepositoryAction {
  return {
    id: row.id, projectId: row.project_id, kind: 'git.commit', status: row.status, risk: row.risk,
    plan: row.plan_json, fingerprint: row.fingerprint, expiresAt: row.expires_at.toISOString(),
    requestedBy: row.requested_by, startedAt: row.started_at?.toISOString() ?? null,
    settledAt: row.settled_at?.toISOString() ?? null, result: row.result_json,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

async function loadProjectRow(db: Executor, projectId: string): Promise<ProjectRow> {
  const { rows } = await db.query<ProjectRow>(
    'SELECT id, status, location_canonical_path FROM projects WHERE id=$1',
    [projectId],
  );
  if (!rows[0]) throw notFound('Project not found.');
  return rows[0];
}

async function loadActionRow(db: Executor, projectId: string, actionId: string, lock = false): Promise<ActionRow> {
  const { rows } = await db.query<ActionRow>(
    `SELECT * FROM project_actions WHERE id=$1 AND project_id=$2${lock ? ' FOR UPDATE' : ''}`,
    [actionId, projectId],
  );
  if (!rows[0]) throw notFound('Repository Action not found.');
  return rows[0];
}

type WriteStatusWithIdentities =
  | { writable: true; identities: RunnerPathIdentity[] }
  | { writable: false; reason: string };

/**
 * Reads the runner's own view of whether this project may accept a commit
 * right now and, in the same call, a bounded content identity (see
 * apps/runner/internal/gitinfo/identity.go) for exactly `paths` — never the
 * whole working tree. This is the one call site both planGitCommit (with the
 * caller's requested paths) and executeRepositoryAction (with the plan's
 * already-filtered selectedPaths, at execute time, for a *fresh* read) use;
 * keeping it in one function means the readiness check and the identity read
 * can never drift into two different runner calls with two different
 * consistency stories.
 */
async function loadWriteStatusWithIdentities(
  runner: RunnerClient, canonicalPath: string, paths: string[], requestId?: string,
): Promise<WriteStatusWithIdentities> {
  let response;
  try {
    response = await runner.invoke('project.git.write.status', { path: canonicalPath, paths }, requestId);
  } catch (error) {
    return { writable: false, reason: error instanceof RunnerUnavailableError ? 'runner_unavailable' : 'inspection_failed' };
  }
  if (!response.ok) return { writable: false, reason: 'runner_unavailable' };
  const parsed = runnerGitWriteStatusResultSchema.safeParse(response.result);
  if (!parsed.success) return { writable: false, reason: 'invalid_runner_response' };
  if (!parsed.data.valid) return { writable: false, reason: parsed.data.reason };
  if (!parsed.data.writable) return { writable: false, reason: parsed.data.reason };
  if (parsed.data.readyToCommit !== '') return { writable: false, reason: parsed.data.readyToCommit };
  return { writable: true, identities: parsed.data.pathIdentities ?? [] };
}

async function loadDefaultBranchInfo(
  runner: RunnerClient, canonicalPath: string, requestId?: string,
): Promise<{ defaultBranch: string; defaultBranchConfidence: string }> {
  try {
    const response = await runner.invoke('project.git.summary', { path: canonicalPath }, requestId);
    if (!response.ok) return { defaultBranch: '', defaultBranchConfidence: 'unknown' };
    const parsed = runnerGitSummaryResultSchema.safeParse(response.result);
    if (!parsed.success || !parsed.data.valid || !parsed.data.git) {
      return { defaultBranch: '', defaultBranchConfidence: 'unknown' };
    }
    return { defaultBranch: parsed.data.git.defaultBranch, defaultBranchConfidence: parsed.data.git.defaultBranchConfidence };
  } catch {
    return { defaultBranch: '', defaultBranchConfidence: 'unknown' };
  }
}

/**
 * Builds and stores a `git.commit` plan preview. Throws bad_request when the
 * selection is not plannable (nothing left after excluding protected/no-op
 * paths, or the repository is detached), and conflict when the project is
 * not currently write-enabled/ready, archived, or already has a pending
 * action.
 */
export async function planGitCommit(
  db: Db, runner: RunnerClient, projectId: string, actorId: string,
  body: PlanGitCommitRequest, audit: MutationAudit, requestId?: string,
): Promise<RepositoryAction> {
  const project = await getProjectGuard(db, projectId);
  assertProjectMutable(project, 'Repository Actions');
  const row = await loadProjectRow(db, projectId);

  // One call: readiness plus a bounded content identity for exactly the
  // caller's requested paths (some may not survive protected/no-op
  // filtering below — their identities are simply unused, never a problem,
  // since the runner bounds this to the ≤200 paths the contract already
  // caps a plan request at).
  const status = await loadWriteStatusWithIdentities(runner, row.location_canonical_path, body.paths, requestId);
  if (!status.writable) {
    throw new AppError('conflict', `This project cannot accept a commit right now (${status.reason.replaceAll('_', ' ')}).`);
  }

  const source = await loadDevelopmentSource(db, runner, projectId, requestId);
  if (source.git.repository.errorCode !== null || !source.git.repository.isRepository) {
    throw new AppError('conflict', 'Git state is currently unavailable for this project.');
  }
  const { defaultBranch, defaultBranchConfidence } = await loadDefaultBranchInfo(runner, row.location_canonical_path, requestId);

  const { plan, risk } = buildGitCommitPlan({
    canonicalPath: row.location_canonical_path,
    branch: source.git.head.branch ?? '',
    detached: source.git.head.detached,
    headSha: source.git.head.sha,
    defaultBranch, defaultBranchConfidence,
    development: source.git,
    request: body,
  });
  const fingerprint = computeCommitFingerprint({
    canonicalPath: row.location_canonical_path, branch: plan.branch, headSha: plan.expectedHead,
    detached: source.git.head.detached, selectedPaths: plan.selectedPaths, identities: status.identities,
  });

  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true), 'Repository Actions');
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + PLAN_TTL_MS);
    try {
      await client.query(
        `INSERT INTO project_actions (id, project_id, kind, status, risk, plan_json, fingerprint, expires_at, requested_by)
         VALUES ($1,$2,'git.commit','planned',$3,$4::jsonb,$5,$6,$7)`,
        [id, projectId, risk, JSON.stringify(plan), fingerprint, expiresAt.toISOString(), actorId],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new AppError('conflict', 'A Repository Action is already pending for this project.');
      throw error;
    }
    await audit(client, 'action.planned', {
      projectId, actionId: id, kind: 'git.commit', risk,
      branch: plan.branch, fileCount: plan.selectedPaths.length,
      protectedExcludedCount: plan.excludedProtectedPaths.length,
    });
    return mapAction(await loadActionRow(client, projectId, id));
  });
}

async function expireAction(db: Db, projectId: string, actionId: string, audit: MutationAudit, reason: string): Promise<void> {
  await withTransaction(db, async (client) => {
    const row = await loadActionRow(client, projectId, actionId, true);
    if (row.status !== 'planned') return; // already moved on by a concurrent request
    await client.query(
      `UPDATE project_actions SET status='expired', settled_at=now() WHERE id=$1`,
      [actionId],
    );
    await audit(client, 'action.expired', { projectId, actionId, reason });
  });
}

function commitFailureResult(reason: RepositoryActionFailureReason, reconciledFromInterruption = false): RepositoryActionResult {
  return { succeeded: false, commit: null, reason, reconciledFromInterruption };
}

/**
 * Confirms and runs a previously planned `git.commit` action in one request.
 *
 * Fingerprint handling has two layers: the client must echo back exactly the
 * fingerprint it was shown (a cheap, offline sanity check that the operator's
 * client is not out of sync with what is stored), and the server
 * independently recomputes the fingerprint from a *fresh* runner read before
 * transitioning out of 'planned' (the actual staleness check — the client
 * cannot forge a match to state it never observed, since it never sees this
 * recomputation).
 */
export async function executeRepositoryAction(
  db: Db, runner: RunnerClient, projectId: string, actionId: string, actorId: string,
  body: ExecuteRepositoryActionRequest, audit: MutationAudit, timeline: MutationTimeline, requestId?: string,
): Promise<RepositoryAction> {
  const project = await getProjectGuard(db, projectId);
  assertProjectMutable(project, 'Repository Actions');
  const planned = await loadActionRow(db, projectId, actionId);
  if (planned.status !== 'planned') {
    throw new AppError('conflict', `This action is ${planned.status} and cannot be executed.`);
  }
  if (planned.expires_at.getTime() <= Date.now()) {
    await expireAction(db, projectId, actionId, audit, 'ttl_elapsed');
    throw new AppError('conflict', 'This plan has expired. Create a new one.');
  }
  if (body.fingerprint !== planned.fingerprint) {
    throw badRequest('The confirmation fingerprint does not match the plan you were shown. Refresh and try again.');
  }
  if (planned.risk === 'high' && body.confirmBranch !== planned.plan_json.branch) {
    throw badRequest(`Type the branch name "${planned.plan_json.branch}" to confirm a commit to the default branch.`);
  }

  const row = await loadProjectRow(db, projectId);
  const fresh = await loadDevelopmentSource(db, runner, projectId, requestId);
  if (fresh.git.repository.errorCode !== null || !fresh.git.repository.isRepository) {
    await expireAction(db, projectId, actionId, audit, 'git_unavailable');
    throw new AppError('conflict', 'Git state is currently unavailable for this project.');
  }
  // A fresh, execute-time-only read of content identity for exactly the
  // paths this plan selected — never the paths originally requested, and
  // never cached from plan time. This is what actually catches a same-size,
  // same-mtime silent edit landing between plan and execute (see
  // repository-actions/plan.ts's computeCommitFingerprint doc).
  const freshStatus = await loadWriteStatusWithIdentities(runner, row.location_canonical_path, planned.plan_json.selectedPaths, requestId);
  if (!freshStatus.writable) {
    await expireAction(db, projectId, actionId, audit, 'state_changed');
    throw new AppError('conflict', `This project cannot accept a commit right now (${freshStatus.reason.replaceAll('_', ' ')}).`);
  }
  const freshFingerprint = computeCommitFingerprint({
    canonicalPath: row.location_canonical_path,
    branch: fresh.git.head.branch ?? '', headSha: fresh.git.head.sha, detached: fresh.git.head.detached,
    selectedPaths: planned.plan_json.selectedPaths, identities: freshStatus.identities,
  });
  if (freshFingerprint !== planned.fingerprint) {
    await expireAction(db, projectId, actionId, audit, 'state_changed');
    throw new AppError('conflict', 'The repository changed since this plan was created. Create a new plan to review the current state.');
  }

  await withTransaction(db, async (client) => {
    const locked = await loadActionRow(client, projectId, actionId, true);
    if (locked.status !== 'planned') throw new AppError('conflict', `This action is ${locked.status} and cannot be executed.`);
    await client.query(`UPDATE project_actions SET status='running', started_at=now() WHERE id=$1`, [actionId]);
    await audit(client, 'action.execution_started', { projectId, actionId, kind: 'git.commit', risk: locked.risk });
  });

  const plan = planned.plan_json;
  let result: RepositoryActionResult;
  try {
    const response = await runner.invoke('project.git.commit', {
      path: row.location_canonical_path, branch: plan.branch,
      expectedHead: plan.expectedHead ?? '', message: plan.message, paths: plan.selectedPaths,
    }, requestId);
    if (!response.ok) {
      result = commitFailureResult('runner_unavailable');
    } else {
      const parsed = runnerGitCommitResultSchema.safeParse(response.result);
      if (!parsed.success) {
        result = commitFailureResult('runner_unavailable');
      } else if (!parsed.data.valid) {
        // The project moved off the write-enabled list, or a similar
        // path-validation condition changed, between plan and execute.
        result = commitFailureResult('write_not_enabled');
      } else if (!parsed.data.committed) {
        result = commitFailureResult(asFailureReason(parsed.data.reason));
      } else {
        const postCommit = await loadDevelopmentSource(db, runner, projectId, requestId);
        const verified = postCommit.git.head.sha === parsed.data.commit.sha
          && postCommit.git.head.branch === parsed.data.commit.branch;
        result = {
          succeeded: true,
          commit: {
            kind: 'git.commit', commitSha: parsed.data.commit.sha, shortSha: parsed.data.commit.shortSha,
            previousHeadSha: parsed.data.commit.previousHeadSha, branch: parsed.data.commit.branch,
            fileCount: parsed.data.commit.fileCount, indexReconciled: parsed.data.commit.indexReconciled,
            verified,
          },
          reason: null, reconciledFromInterruption: false,
        };
      }
    }
  } catch (error) {
    result = commitFailureResult(error instanceof RunnerUnavailableError ? 'runner_unavailable' : 'verification_failed');
  }

  return withTransaction(db, async (client) => {
    const locked = await loadActionRow(client, projectId, actionId, true);
    if (locked.status !== 'running') return mapAction(locked); // settled by a concurrent reconcile
    await client.query(
      `UPDATE project_actions SET status=$1, settled_at=now(), result_json=$2::jsonb WHERE id=$3`,
      [result.succeeded ? 'succeeded' : 'failed', JSON.stringify(result), actionId],
    );
    await audit(client, result.succeeded ? 'action.execution_succeeded' : 'action.execution_failed', {
      projectId, actionId, kind: 'git.commit',
      commitSha: result.commit?.commitSha ?? null, verified: result.commit?.verified ?? null,
      reason: result.reason,
    });
    await timeline(client, {
      entityType: 'action', entityId: actionId, eventType: result.succeeded ? 'action.execution_succeeded' : 'action.execution_failed', projectId,
      summary: result.succeeded
        ? `Repository commit succeeded: "${plan.message.slice(0, 90)}"`
        : `Repository commit failed: "${plan.message.slice(0, 70)}" (${result.reason ?? 'unknown reason'})`,
    });
    return mapAction(await loadActionRow(client, projectId, actionId));
  });
}

function asFailureReason(reason: string): RepositoryActionFailureReason {
  const known: readonly string[] = [
    'unsupported_git_layout', 'detached_head', 'branch_mismatch', 'head_moved',
    'merge_in_progress', 'unmerged_paths', 'commit_identity_missing',
    'protected_path_selected', 'submodule_path_selected', 'empty_selection',
    'invalid_path', 'empty_message',
  ];
  return known.includes(reason) ? (reason as RepositoryActionFailureReason) : 'runner_unavailable';
}

export async function cancelRepositoryAction(
  db: Db, projectId: string, actionId: string, audit: MutationAudit,
): Promise<RepositoryAction> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true), 'Repository Actions');
    const row = await loadActionRow(client, projectId, actionId, true);
    if (row.status !== 'planned') throw new AppError('conflict', `This action is ${row.status} and cannot be cancelled.`);
    await client.query(`UPDATE project_actions SET status='cancelled', settled_at=now() WHERE id=$1`, [actionId]);
    await audit(client, 'action.cancelled', { projectId, actionId });
    return mapAction(await loadActionRow(client, projectId, actionId));
  });
}

/**
 * Resolves a 'running' action abandoned mid-flight by a Control API crash.
 * Never retries the write; only ever reads current repository state and
 * settles the row from that observation. See the module doc for why 'failed'
 * is the conservative outcome when HEAD did not move.
 */
export async function reconcileRepositoryAction(
  db: Db, runner: RunnerClient, projectId: string, actionId: string, audit: MutationAudit, requestId?: string,
): Promise<RepositoryAction> {
  const row = await loadActionRow(db, projectId, actionId);
  if (row.status !== 'running') {
    if (row.status === 'succeeded' || row.status === 'failed') return mapAction(row);
    throw new AppError('conflict', `This action is ${row.status}; nothing to reconcile.`);
  }
  if (!row.started_at || Date.now() - row.started_at.getTime() < RUNNING_STALE_MS) {
    throw new AppError('conflict', 'This action has not been running long enough to reconcile; it may still be in progress.');
  }

  const fresh = await loadDevelopmentSource(db, runner, projectId, requestId);
  const plan = row.plan_json;
  const headMoved = fresh.git.repository.isRepository && fresh.git.head.sha !== null
    && fresh.git.head.sha !== plan.expectedHead;

  const result: RepositoryActionResult = headMoved
    ? {
        succeeded: true,
        commit: {
          kind: 'git.commit', commitSha: fresh.git.head.sha!, shortSha: fresh.git.head.shortSha ?? fresh.git.head.sha!.slice(0, 7),
          previousHeadSha: plan.expectedHead, branch: fresh.git.head.branch ?? plan.branch,
          fileCount: plan.selectedPaths.length, indexReconciled: false, verified: false,
        },
        reason: null, reconciledFromInterruption: true,
      }
    : { succeeded: false, commit: null, reason: 'execution_interrupted', reconciledFromInterruption: true };

  return withTransaction(db, async (client) => {
    const locked = await loadActionRow(client, projectId, actionId, true);
    if (locked.status !== 'running') return mapAction(locked);
    await client.query(
      `UPDATE project_actions SET status=$1, settled_at=now(), result_json=$2::jsonb WHERE id=$3`,
      [result.succeeded ? 'succeeded' : 'failed', JSON.stringify(result), actionId],
    );
    await audit(client, 'action.reconciled', {
      projectId, actionId, succeeded: result.succeeded, commitSha: result.commit?.commitSha ?? null,
    });
    return mapAction(await loadActionRow(client, projectId, actionId));
  });
}

export async function getRepositoryAction(db: Executor, projectId: string, actionId: string): Promise<RepositoryAction> {
  await getProjectGuard(db, projectId);
  return mapAction(await loadActionRow(db, projectId, actionId));
}

export async function listRepositoryActions(
  db: Executor, projectId: string, page: number, pageSize: number,
): Promise<{ actions: RepositoryAction[]; total: number }> {
  await getProjectGuard(db, projectId);
  const offset = (page - 1) * pageSize;
  const [rowsResult, countResult] = await Promise.all([
    db.query<ActionRow>(
      `SELECT * FROM project_actions WHERE project_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3`,
      [projectId, pageSize, offset],
    ),
    db.query<{ total: number }>('SELECT count(*)::int total FROM project_actions WHERE project_id=$1', [projectId]),
  ]);
  return { actions: rowsResult.rows.map(mapAction), total: countResult.rows[0]?.total ?? 0 };
}

export type { ActionRow as RepositoryActionRow, DbClient };
