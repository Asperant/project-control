import { useEffect, useState } from 'react';
import type { RescanDiffEntry, RescanProjectResponse } from '@project-control/contracts';
import { api } from '../../api-client';
import { useApiErrorHandler } from '../../hooks/useApiErrorHandler';
import { ErrorAlert } from '../ErrorAlert';

const SEVERITY_CLASS: Record<RescanDiffEntry['severity'], string> = {
  info: 'alert-ok',
  warning: 'alert-warn',
  critical: 'alert-error',
};

/**
 * Rescan diff screen: re-inspects the project's folder, shows what changed
 * against the stored profile, and only writes anything once the operator
 * explicitly applies it. A changed repository identity additionally requires
 * a separate, explicit confirmation before it can be applied at all.
 */
export function RescanDiff({
  projectId,
  onDone,
  onSessionExpired,
}: {
  projectId: string;
  onDone: () => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [result, setResult] = useState<RescanProjectResponse | null>(null);
  const { error, setError, handleError } = useApiErrorHandler(onSessionExpired, 'The rescan could not be started.');
  const [confirmIdentity, setConfirmIdentity] = useState(false);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.rescanProject(projectId);
        if (!cancelled) setResult(response);
      } catch (caught) {
        if (cancelled) return;
        handleError(caught);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, handleError]);

  async function handleApply(): Promise<void> {
    if (!result) return;
    setApplying(true);
    setError(null);
    try {
      await api.applyRescan(projectId, {
        inspectionId: result.inspectionId,
        confirmRepositoryIdentityChange: confirmIdentity,
      });
      onDone();
    } catch (caught) {
      handleError(caught, 'The rescan could not be applied.');
    } finally {
      setApplying(false);
    }
  }

  return (
    <section aria-labelledby="rescan-heading">
      <h2 id="rescan-heading">Rescan changes</h2>

      <ErrorAlert error={error?.message ?? null} requestId={error?.requestId ?? null} />

      {!result && !error && <p>Scanning the folder…</p>}

      {result && (
        <>
          {result.diff.length === 0 ? (
            <p className="hint">No changes detected since the last inspection.</p>
          ) : (
            <ul className="steps">
              {result.diff.map((entry, i) => (
                <li key={i} className={`diff-entry ${SEVERITY_CLASS[entry.severity]}`}>
                  <span className="step-name">{entry.changeType.replace(/_/g, ' ')}</span>
                  <span>
                    {entry.previousValue ?? '(none)'} → {entry.newValue ?? '(none)'}
                  </span>
                  <span className="card-meta">{entry.severity}</span>
                </li>
              ))}
            </ul>
          )}

          {result.warnings.length > 0 && (
            <div className="alert alert-warn" role="status">
              {result.warnings.join(' ')}
            </div>
          )}

          {result.requiresConfirmation && (
            <div className="alert alert-error" role="alert">
              <label className="checkbox-field">
                <input type="checkbox" checked={confirmIdentity} onChange={(e) => setConfirmIdentity(e.target.checked)} />
                I confirm this folder now points at a different repository, and I want to update the project to match.
              </label>
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
            <button
              type="button"
              className="primary"
              disabled={applying || (result.requiresConfirmation && !confirmIdentity)}
              onClick={() => void handleApply()}
            >
              {applying ? 'Applying…' : result.diff.length === 0 ? 'Acknowledge' : 'Apply changes'}
            </button>
            <button type="button" onClick={onDone} disabled={applying}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
