import { useCallback, useEffect, useState } from 'react';
import type { DevelopmentStateResponse, RepositoryAction } from '@project-control/contracts';
import { ApiError, api } from '../../api-client';

type Props = {
  projectId: string;
  archived: boolean;
  canWrite: boolean;
  development: DevelopmentStateResponse;
  onSessionExpired: () => void;
  /** Re-fetches Development State after a successful commit, so the working
   * tree/HEAD shown elsewhere on this page reflects it immediately. */
  onCommitted: () => void;
};

type Step =
  | { kind: 'idle' }
  | { kind: 'select'; selectedPaths: Set<string>; message: string }
  | { kind: 'preview'; action: RepositoryAction; confirmBranch: string }
  | { kind: 'result'; action: RepositoryAction };

function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : 'no commit yet';
}

const FAILURE_COPY: Record<string, string> = {
  unsupported_git_layout: 'This repository layout (a worktree or submodule) is not supported.',
  detached_head: 'HEAD is detached; commits require a named branch.',
  branch_mismatch: 'The checked-out branch changed since this plan was created.',
  head_moved: 'The branch moved since this plan was created.',
  merge_in_progress: 'A merge, rebase, or cherry-pick is in progress.',
  unmerged_paths: 'The working tree has unmerged (conflicted) paths.',
  commit_identity_missing: 'This repository has no local user.name/user.email configured.',
  protected_path_selected: 'A protected path was selected.',
  submodule_path_selected: 'A selected path resolves to a submodule.',
  empty_selection: 'The selection produced no change to commit.',
  invalid_path: 'A selected path is not valid.',
  empty_message: 'The commit message was empty.',
  write_not_enabled: 'This project is not enabled for commits.',
  runner_unavailable: 'The host runner was unavailable during execution.',
  verification_failed: 'The commit could not be verified after execution.',
  execution_interrupted: 'Execution was interrupted before it could be verified.',
};

export function ActionsPanel({ projectId, archived, canWrite, development, onSessionExpired, onCommitted }: Props): React.JSX.Element {
  const [pending, setPending] = useState<RepositoryAction | null>(null);
  const [history, setHistory] = useState<RepositoryAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleError = useCallback((caught: unknown, fallback: string) => {
    if (caught instanceof ApiError) {
      if (caught.isAuthFailure) {
        onSessionExpired();
        return;
      }
      setError(caught.message);
    } else {
      setError(fallback);
    }
  }, [onSessionExpired]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.listRepositoryActions(projectId, 1, 10);
      const open = response.actions.find((action) => action.status === 'planned' || action.status === 'running') ?? null;
      setPending(open);
      setHistory(response.actions.filter((action) => action !== open));
      setError(null);
    } catch (caught) {
      handleError(caught, 'Unable to load Repository Actions.');
    } finally {
      setLoading(false);
    }
  }, [handleError, projectId]);

  useEffect(() => { void load(); }, [load]);

  const readOnly = archived || !canWrite;
  const changedPaths = development.files.map((file) => file.path);

  function openSelect(): void {
    setError(null);
    setStep({ kind: 'select', selectedPaths: new Set(), message: '' });
  }

  function togglePath(path: string): void {
    if (step.kind !== 'select') return;
    const next = new Set(step.selectedPaths);
    if (next.has(path)) next.delete(path); else next.add(path);
    setStep({ ...step, selectedPaths: next });
  }

  async function submitPlan(): Promise<void> {
    if (step.kind !== 'select' || busy) return;
    const paths = [...step.selectedPaths];
    const message = step.message.trim();
    if (paths.length === 0 || !message) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.planGitCommit(projectId, { paths, message });
      setStep({ kind: 'preview', action: response.action, confirmBranch: '' });
      setPending(response.action);
    } catch (caught) {
      handleError(caught, 'Unable to plan this commit.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmExecute(): Promise<void> {
    if (step.kind !== 'preview' || busy) return;
    const { action, confirmBranch } = step;
    if (action.risk === 'high' && confirmBranch.trim() !== action.plan.branch) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.executeRepositoryAction(projectId, action.id, {
        fingerprint: action.fingerprint,
        ...(action.risk === 'high' ? { confirmBranch: confirmBranch.trim() } : {}),
      });
      setStep({ kind: 'result', action: response.action });
      setPending(null);
      await load();
      if (response.action.status === 'succeeded') onCommitted();
    } catch (caught) {
      handleError(caught, 'Unable to execute this Repository Action.');
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function cancelPlan(action: RepositoryAction): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.cancelRepositoryAction(projectId, action.id);
      setStep({ kind: 'idle' });
      setPending(null);
      await load();
    } catch (caught) {
      handleError(caught, 'Unable to cancel this Repository Action.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card actions-panel">
      <h3>8. Actions</h3>

      {readOnly && (
        <p className="hint">
          {archived ? 'This project is archived; Repository Actions are disabled.' : 'Your account has read-only access to Repository Actions.'}
        </p>
      )}
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      {!readOnly && step.kind === 'idle' && (
        pending ? (
          <div className="alert alert-warn" role="status">
            A commit is already {pending.status} for this project.
            {pending.status === 'planned' && (
              <button type="button" disabled={busy} onClick={() => void cancelPlan(pending)}>Cancel plan</button>
            )}
          </div>
        ) : (
          <button type="button" className="primary" disabled={changedPaths.length === 0} onClick={openSelect}>
            New commit…
          </button>
        )
      )}
      {!readOnly && step.kind === 'idle' && changedPaths.length === 0 && !pending && (
        <p className="hint">No changed files to commit.</p>
      )}

      {step.kind === 'select' && (
        <div className="actions-select">
          <p className="hint">Select the files this commit should include.</p>
          <ul className="actions-file-list">
            {development.files.map((file) => (
              <li key={file.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={step.selectedPaths.has(file.path)}
                    onChange={() => togglePath(file.path)}
                  />
                  <code>{file.path}</code> <span className="hint">{file.state.replaceAll('_', ' ')}</span>
                </label>
              </li>
            ))}
          </ul>
          <div className="field">
            <label htmlFor="actions-message">Commit message</label>
            <textarea
              id="actions-message"
              rows={3}
              value={step.message}
              onChange={(event) => setStep({ ...step, message: event.target.value })}
            />
          </div>
          <div className="actions-buttons">
            <button type="button" disabled={busy} onClick={() => setStep({ kind: 'idle' })}>Cancel</button>
            <button
              type="button"
              className="primary"
              disabled={busy || step.selectedPaths.size === 0 || !step.message.trim()}
              onClick={() => void submitPlan()}
            >
              {busy ? 'Planning…' : 'Preview commit'}
            </button>
          </div>
        </div>
      )}

      {step.kind === 'preview' && (
        <div className="actions-preview">
          <h4>Preview</h4>
          <dl className="development-facts">
            <div><dt>Branch</dt><dd>{step.action.plan.branch}{step.action.plan.isDefaultBranch && ' (default branch)'}</dd></div>
            <div><dt>Current HEAD</dt><dd><code>{shortSha(step.action.plan.expectedHead)}</code></dd></div>
            <div><dt>Files</dt><dd>{step.action.plan.selectedPaths.length}</dd></div>
          </dl>
          <ul className="actions-file-list">
            {step.action.plan.selectedPaths.map((path) => <li key={path}><code>{path}</code></li>)}
          </ul>
          {step.action.plan.excludedProtectedPaths.length > 0 && (
            <div className="alert alert-warn" role="status">
              {step.action.plan.excludedProtectedPaths.length} protected file{step.action.plan.excludedProtectedPaths.length === 1 ? '' : 's'} excluded: {step.action.plan.excludedProtectedPaths.join(', ')}
            </div>
          )}
          <p className="resume-copy">{step.action.plan.message}</p>
          {step.action.risk === 'high' && (
            <div className="alert alert-warn" role="alert">
              This commits to the project's default branch. Type <strong>{step.action.plan.branch}</strong> to confirm.
              <div className="field">
                <input
                  aria-label="Confirm branch name"
                  value={step.confirmBranch}
                  onChange={(event) => setStep({ ...step, confirmBranch: event.target.value })}
                />
              </div>
            </div>
          )}
          <p className="hint">This plan expires at {new Date(step.action.expiresAt).toLocaleTimeString()}.</p>
          <div className="actions-buttons">
            <button type="button" disabled={busy} onClick={() => void cancelPlan(step.action)}>Cancel</button>
            <button
              type="button"
              className="primary"
              disabled={busy || (step.action.risk === 'high' && step.confirmBranch.trim() !== step.action.plan.branch)}
              onClick={() => void confirmExecute()}
            >
              {busy ? 'Committing…' : 'Confirm commit'}
            </button>
          </div>
        </div>
      )}

      {step.kind === 'result' && (
        <div className={step.action.status === 'succeeded' ? 'alert alert-ok' : 'alert alert-error'} role="status">
          {step.action.status === 'succeeded' && step.action.result?.commit ? (
            <>Committed <code>{step.action.result.commit.shortSha}</code> to {step.action.result.commit.branch}.</>
          ) : (
            <>Commit failed: {FAILURE_COPY[step.action.result?.reason ?? ''] ?? 'An unknown error occurred.'}</>
          )}
          <div className="actions-buttons"><button type="button" onClick={() => setStep({ kind: 'idle' })}>Close</button></div>
        </div>
      )}

      <h4>History</h4>
      {loading ? <p className="hint">Loading…</p> : history.length === 0 ? <p className="hint">No Repository Actions yet.</p> : (
        <ul className="actions-history">
          {history.map((action) => (
            <li key={action.id}>
              <span className={`actions-status actions-status-${action.status}`}>{action.status}</span>
              <span>{action.plan.branch} · {action.plan.selectedPaths.length} file{action.plan.selectedPaths.length === 1 ? '' : 's'}</span>
              {action.result?.commit && <code>{action.result.commit.shortSha}</code>}
              {action.result?.reason && <span className="hint">{FAILURE_COPY[action.result.reason] ?? action.result.reason}</span>}
              <time dateTime={action.createdAt}>{new Date(action.createdAt).toLocaleString()}</time>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
