import { useCallback, useEffect, useState } from 'react';
import type { WorkflowRunDetail } from '@project-control/contracts';
import { api } from '../../api-client';
import { RunStatusBadge, SeverityBadge, StepStatusBadge } from './badges';
import { useApiErrorHandler } from '../../hooks/useApiErrorHandler';
import { ErrorAlert } from '../ErrorAlert';

const formatTime = (iso: string): string => new Date(iso).toLocaleString();

export function AutomationRunDetail({
  runId, canWrite, onBack, onSessionExpired,
}: { runId: string; canWrite: boolean; onBack: () => void; onSessionExpired: () => void }): React.JSX.Element {
  const [detail, setDetail] = useState<WorkflowRunDetail | null>(null);
  const { error, setError, handleError } = useApiErrorHandler(onSessionExpired, 'Unable to load this run.');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setDetail(await api.getAutomationRun(runId, signal));
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      handleError(caught);
    }
  }, [runId, handleError, setError]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function handleCancel(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await api.cancelWorkflowRun(runId);
      await load();
    } catch (caught) {
      handleError(caught, 'Unable to cancel this run.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !detail) {
    return (
      <section className="agent-run-detail">
        <button type="button" onClick={onBack}>&larr; Back</button>
        <ErrorAlert error={error.message} requestId={error.requestId} />
      </section>
    );
  }

  if (!detail) {
    return (
      <section className="agent-run-detail">
        <button type="button" onClick={onBack}>&larr; Back</button>
        <p>Loading run…</p>
      </section>
    );
  }

  const { run, steps } = detail;
  const canCancel = canWrite && (run.status === 'queued' || run.status === 'running');

  return (
    <section aria-labelledby="automation-run-heading" className="agent-run-detail">
      <div className="projects-toolbar">
        <button type="button" onClick={onBack}>&larr; Back</button>
        <h2 id="automation-run-heading" style={{ margin: 0 }}>{run.workflowKey}</h2>
        <RunStatusBadge status={run.status} />
        <div className="spacer" />
        {canCancel && (
          <button type="button" disabled={busy} onClick={() => void handleCancel()}>
            {busy ? 'Cancelling…' : 'Cancel run'}
          </button>
        )}
      </div>

      <ErrorAlert error={error?.message ?? null} requestId={error?.requestId ?? null} />

      <article className="card">
        <span className="card-title">Run</span>
        <div className="card-grid">
          <div>
            <span className="card-meta">Trigger</span>
            <p className="card-detail">{run.triggerKind}</p>
          </div>
          <div>
            <span className="card-meta">Queued</span>
            <p className="card-detail">{formatTime(run.queuedAt)}</p>
          </div>
          <div>
            <span className="card-meta">Started</span>
            <p className="card-detail">{run.startedAt ? formatTime(run.startedAt) : '—'}</p>
          </div>
          <div>
            <span className="card-meta">Settled</span>
            <p className="card-detail">{run.settledAt ? formatTime(run.settledAt) : '—'}</p>
          </div>
          {run.projectId && (
            <div>
              <span className="card-meta">Project</span>
              <p className="card-detail">{run.projectId}</p>
            </div>
          )}
          {run.externalRef && (
            <div>
              <span className="card-meta">n8n execution</span>
              <p className="card-detail">{run.externalRef}</p>
            </div>
          )}
        </div>
      </article>

      {run.result && (
        <article className="card">
          <span className="card-title">Result</span>
          <p className="card-detail">
            <SeverityBadge severity={run.result.severity} /> {run.result.summary}
          </p>
          {run.result.reason && <p className="card-meta">reason: {run.result.reason}</p>}
          {run.result.linkedActionId && (
            <p className="card-meta">Linked Repository Action: {run.result.linkedActionId}</p>
          )}
          {run.result.artifactId && (
            <p className="card-meta">Attached artefact: {run.result.artifactId}</p>
          )}
        </article>
      )}

      <article className="card">
        <span className="card-title">Steps</span>
        {steps.length === 0 ? (
          <p className="hint">No steps recorded yet.</p>
        ) : (
          <ul className="steps">
            {steps.map((step) => (
              <li key={step.id}>
                <StepStatusBadge status={step.status} />
                <span className="step-name">{step.name}</span>
                <span className="step-time">{formatTime(step.recordedAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}
