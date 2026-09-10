import { useCallback, useEffect, useState } from 'react';
import type { WorkflowRun, WorkflowRunStatus, WorkflowSummary } from '@project-control/contracts';
import { api } from '../../api-client';
import { AutomationRunDetail } from './AutomationRunDetail';
import { RunStatusBadge, SeverityBadge } from './badges';
import { ServiceTokensPanel } from './ServiceTokensPanel';
import { useApiErrorHandler } from '../../hooks/useApiErrorHandler';
import { ErrorAlert } from '../ErrorAlert';

const PAGE_SIZE = 20;
const formatTime = (iso: string): string => new Date(iso).toLocaleString();

const statusFilters: Array<WorkflowRunStatus | 'all'> = [
  'all', 'queued', 'running', 'completed', 'failed', 'waiting_for_approval', 'cancelled', 'expired',
];

/**
 * Automation: the workflow registry, run history, and (admin only) service
 * token inventory. See docs/automation.md.
 *
 * There is no "create workflow" or "create service token" affordance here by
 * design — see service-accounts.md for why minting a token is a `pcctl`
 * action, never a route, and automation.md for why a workflow definition is
 * a repository-owned file, never a database row a route could create.
 */
export function AutomationView({
  isAdmin, canWrite, onSessionExpired,
}: { isAdmin: boolean; canWrite: boolean; onSessionExpired: () => void }): React.JSX.Element {
  const [subTab, setSubTab] = useState<'workflows' | 'runs' | 'tokens'>('workflows');
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState<WorkflowRunStatus | 'all'>('all');
  const { error, setError, handleError } = useApiErrorHandler(onSessionExpired);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const loadWorkflows = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await api.listWorkflows(signal);
      setWorkflows(response.workflows);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      handleError(caught, 'Unable to load workflows.');
    }
  }, [handleError]);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await api.listAutomationRuns(
        { page, pageSize: PAGE_SIZE, ...(statusFilter !== 'all' ? { status: statusFilter } : {}) },
        signal,
      );
      setRuns(response.runs);
      setTotal(response.total);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      handleError(caught, 'Unable to load run history.');
    }
  }, [page, statusFilter, handleError]);

  useEffect(() => {
    const controller = new AbortController();
    void loadWorkflows(controller.signal);
    return () => controller.abort();
  }, [loadWorkflows]);

  useEffect(() => {
    const controller = new AbortController();
    void loadRuns(controller.signal);
    return () => controller.abort();
  }, [loadRuns]);

  async function handleRunNow(workflowKey: string): Promise<void> {
    setBusyKey(workflowKey);
    setError(null);
    try {
      const { run } = await api.requestWorkflowRun(workflowKey);
      await loadWorkflows();
      setSelectedRunId(run.id);
    } catch (caught) {
      handleError(caught, 'Unable to start this workflow.');
    } finally {
      setBusyKey(null);
    }
  }

  if (selectedRunId) {
    return (
      <AutomationRunDetail
        runId={selectedRunId}
        canWrite={canWrite}
        onBack={() => { setSelectedRunId(null); void loadWorkflows(); void loadRuns(); }}
        onSessionExpired={onSessionExpired}
      />
    );
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section aria-labelledby="automation-heading" className="agent-runs-view">
      <div className="projects-toolbar">
        <h2 id="automation-heading" style={{ margin: 0 }}>Automation</h2>
        <div className="spacer" />
        <nav className="tab-nav" aria-label="Automation sections">
          <button type="button" className={subTab === 'workflows' ? 'tab-active' : ''} onClick={() => setSubTab('workflows')}>
            Workflows
          </button>
          <button type="button" className={subTab === 'runs' ? 'tab-active' : ''} onClick={() => setSubTab('runs')}>
            Runs
          </button>
          {isAdmin && (
            <button type="button" className={subTab === 'tokens' ? 'tab-active' : ''} onClick={() => setSubTab('tokens')}>
              Service tokens
            </button>
          )}
        </nav>
      </div>

      <ErrorAlert error={error?.message ?? null} requestId={error?.requestId ?? null} />

      {subTab === 'workflows' && (
        <div className="card-grid">
          {workflows.length === 0 && <p className="hint">No workflows in the manifest.</p>}
          {workflows.map(({ workflow, lastRun }) => (
            <article key={workflow.key} className="card">
              <div className="card-head">
                <span className="card-title">{workflow.name}</span>
                {lastRun && <RunStatusBadge status={lastRun.status} />}
              </div>
              <p className="card-detail">{workflow.description}</p>
              <span className="card-meta">
                {workflow.trigger === 'scheduled' ? `Scheduled: ${workflow.schedule}` : 'Manual only'}
                {workflow.scope === 'project' ? ' · project-scoped' : ' · global'}
              </span>
              {lastRun ? (
                <button type="button" className="agent-run-card-open" onClick={() => setSelectedRunId(lastRun.id)}>
                  <span className="card-meta">
                    Last run {formatTime(lastRun.queuedAt)}
                    {lastRun.result && <> · <SeverityBadge severity={lastRun.result.severity} /> {lastRun.result.summary}</>}
                  </span>
                </button>
              ) : (
                <p className="card-meta">Never run.</p>
              )}
              {canWrite && workflow.trigger === 'manual' && (
                <div>
                  <button
                    type="button"
                    className="primary"
                    disabled={busyKey === workflow.key}
                    onClick={() => void handleRunNow(workflow.key)}
                  >
                    {busyKey === workflow.key ? 'Starting…' : 'Run now'}
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {subTab === 'runs' && (
        <>
          <div className="filter-bar" role="search">
            <select aria-label="Filter by status" value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value as typeof statusFilter); }}>
              {statusFilters.map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s.replace(/_/g, ' ')}</option>)}
            </select>
          </div>

          {runs.length === 0 ? (
            <p className="hint">No runs yet.</p>
          ) : (
            <article className="card">
              <ul className="memory-list">
                {runs.map((run) => (
                  <li key={run.id}>
                    <button type="button" className="agent-run-card-open" onClick={() => setSelectedRunId(run.id)}>
                      <span className="card-title">{run.workflowKey}</span>
                      <span className="memory-badges">
                        <RunStatusBadge status={run.status} />
                        {run.result && <SeverityBadge severity={run.result.severity} />}
                        <span className="badge badge-unknown">{run.triggerKind}</span>
                      </span>
                      <span className="card-meta">{formatTime(run.queuedAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </article>
          )}

          <div className="pagination">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>&larr; Previous</button>
            <span>Page {page} of {totalPages} · {total} run{total === 1 ? '' : 's'}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next &rarr;</button>
          </div>
        </>
      )}

      {subTab === 'tokens' && isAdmin && <ServiceTokensPanel onSessionExpired={onSessionExpired} />}
    </section>
  );
}
