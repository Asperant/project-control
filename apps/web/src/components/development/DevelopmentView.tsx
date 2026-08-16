import { useCallback, useEffect, useState } from 'react';
import type { DevelopmentStateResponse } from '@project-control/contracts';
import { ApiError, api } from '../../api-client';
import { ActionsPanel } from './ActionsPanel';

type Props = { projectId: string; archived: boolean; canWrite: boolean; onSessionExpired: () => void; initialData?: DevelopmentStateResponse };

function comparisonLines(value: DevelopmentStateResponse['checkpointComparison']): string[] {
  if (value.status === 'no_git_checkpoint') return ['No Git-aware checkpoint exists yet.'];
  if (value.status === 'unavailable') return ['A checkpoint comparison is unavailable for the current repository state.'];
  const lines = [value.repositoryStateChanged ? 'Repository state changed.' : 'Repository state unchanged.'];
  if (value.headChanged !== null) lines.push(value.headChanged ? 'HEAD changed.' : 'HEAD unchanged.');
  if (value.branchChanged !== null) lines.push(value.branchChanged ? 'Branch changed.' : 'Branch unchanged.');
  if (value.workingTreeChanged !== null) lines.push(value.workingTreeChanged ? 'Working tree state changed.' : 'Working tree state unchanged.');
  return lines;
}

export function DevelopmentView({ projectId, archived, canWrite, onSessionExpired, initialData }: Props): React.JSX.Element {
  const [state, setState] = useState<DevelopmentStateResponse | null>(initialData ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      setState(await api.getProjectDevelopment(projectId, signal));
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      if (caught instanceof ApiError && caught.isAuthFailure) onSessionExpired();
      else setError(caught instanceof ApiError ? caught.message : 'Development State could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [onSessionExpired, projectId]);

  useEffect(() => {
    if (initialData) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [initialData, load]);

  if (loading && !state) return <p role="status">Loading Development State…</p>;
  if (!state) return <div className="alert alert-error" role="alert">{error ?? 'Development State is unavailable.'} <button type="button" onClick={() => void load()}>Retry</button></div>;

  const liveMetadataAvailable = state.status === 'available';
  const unavailableCopy = state.status === 'not_repository'
    ? 'Not applicable because this folder is not a Git repository.'
    : 'Git metadata is unavailable.';

  return (
    <section className="development-view" aria-labelledby="development-heading">
      <div className="card-head"><h2 id="development-heading">Development</h2><button type="button" disabled={loading} onClick={() => void load()}>{loading ? 'Refreshing…' : 'Refresh'}</button></div>
      {archived && <div className="alert alert-warn" role="status">This archived project's Development State remains readable and read-only.</div>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {state.attention.length > 0 && <div className="alert alert-warn"><strong>Attention</strong><ul>{state.attention.map((item) => <li key={item.key}>{item.label}</li>)}</ul></div>}

      <article className="card"><h3>1. Repository Status</h3>
        {state.status === 'unavailable' ? <p className="hint">Git inspection is unavailable ({state.errorCode?.replaceAll('_', ' ')}).</p>
          : state.status === 'not_repository' ? <p className="hint">The registered folder is not a Git repository.</p>
            : <dl className="development-facts"><div><dt>Branch</dt><dd>{state.head.detached ? 'Detached HEAD' : state.head.branch ?? 'Unborn branch'}</dd></div><div><dt>HEAD</dt><dd><code>{state.head.shortSha ?? 'No commit yet'}</code></dd></div><div><dt>State</dt><dd>{state.workingTree.clean ? 'Clean' : 'Dirty'}</dd></div></dl>}
      </article>

      <article className="card"><h3>2. Working Tree</h3>{liveMetadataAvailable ? <dl className="development-counts"><div><dt>Staged</dt><dd>{state.workingTree.stagedCount}</dd></div><div><dt>Unstaged</dt><dd>{state.workingTree.unstagedCount}</dd></div><div><dt>Untracked</dt><dd>{state.workingTree.untrackedCount}</dd></div><div><dt>Conflicts</dt><dd>{state.workingTree.conflictedCount}</dd></div><div><dt>Total</dt><dd>{state.workingTree.totalChangedCount}</dd></div></dl> : <p className="hint">{unavailableCopy}</p>}</article>

      <article className="card"><h3>3. Changed Files</h3>{!liveMetadataAvailable ? <p className="hint">{unavailableCopy}</p> : state.files.length === 0 ? <p className="hint">No changed files to show.</p> : <ul className="development-files">{state.files.map((file) => <li key={`${file.oldPath ?? ''}:${file.path}`}><code>{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</code><span>{file.state.replaceAll('_', ' ')} · {[file.staged && 'staged', file.unstaged && 'unstaged', file.untracked && 'untracked'].filter(Boolean).join(', ')}</span></li>)}</ul>}{state.filesTruncated && <p className="hint">Showing {state.files.length} of {state.workingTree.totalChangedCount} changed files.</p>}</article>

      <article className="card"><h3>4. Recent Commits</h3>{!liveMetadataAvailable ? <p className="hint">{unavailableCopy}</p> : state.recentCommits.length === 0 ? <p className="hint">No commits are available.</p> : <ol className="development-commits">{state.recentCommits.map((commit) => <li key={commit.sha}><code>{commit.shortSha}</code><span>{commit.subject}</span><small>{commit.authorName} · {new Date(commit.authoredAt).toLocaleString()}</small></li>)}</ol>}</article>

      <article className="card"><h3>5. Remote / Tracking</h3>{!liveMetadataAvailable ? <p className="hint">{unavailableCopy}</p> : state.remote ? <dl className="development-facts"><div><dt>Origin</dt><dd>{state.remote.rawUrl ?? 'Configured, but not safe to display'}</dd></div><div><dt>Host</dt><dd>{state.remote.normalizedHost ?? 'Unknown'}</dd></div><div><dt>Tracking</dt><dd>{state.remote.trackingBranch ?? 'No local tracking ref'}</dd></div>{state.remote.comparisonBasis === 'local_tracking_ref' && <div><dt>Local comparison</dt><dd>{state.remote.ahead} ahead · {state.remote.behind} behind (locally stored ref; may be stale)</dd></div>}</dl> : <p className="hint">No origin remote is configured.</p>}</article>

      <article className="card"><h3>6. GitHub</h3><p>{state.status === 'unavailable' ? 'GitHub detection is unavailable.' : state.github.detected ? 'GitHub repository detected. Live GitHub metadata is not configured.' : 'No GitHub origin detected.'}</p></article>
      <article className="card"><h3>7. Checkpoint Comparison</h3><ul className="development-comparison">{comparisonLines(state.checkpointComparison).map((line) => <li key={line}>{line}</li>)}</ul></article>

      {liveMetadataAvailable && (
        <ActionsPanel
          projectId={projectId} archived={archived} canWrite={canWrite} development={state}
          onSessionExpired={onSessionExpired} onCommitted={() => void load()}
        />
      )}
    </section>
  );
}
