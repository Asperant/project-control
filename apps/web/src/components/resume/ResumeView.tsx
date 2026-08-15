import { useCallback, useEffect, useState } from 'react';
import type { ResumeProjectResponse, WorkSession } from '@project-control/contracts';
import { ApiError, api } from '../../api-client';
import { formatRelativeTime } from '../projects/badges';

type ResumeViewProps = {
  projectId: string;
  canWrite: boolean;
  archived: boolean;
  onSessionExpired: () => void;
  onOpenMemory: (checkpointId?: string) => void;
  /** Optional preloaded view model for server rendering and presentation tests. */
  initialData?: ResumeProjectResponse;
};

type Dialog =
  | { kind: 'edit'; session: WorkSession }
  | { kind: 'close'; session: WorkSession }
  | { kind: 'amend'; session: WorkSession }
  | null;

const PAGE_SIZE = 20;

function formatTimestamp(value: string | null): string {
  if (!value) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatElapsed(startedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - new Date(startedAt).getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function SessionDetails({ session, onOpenMemory }: { session: WorkSession; onOpenMemory: (checkpointId?: string) => void }): React.JSX.Element {
  return (
    <div className="resume-session-details">
      <p className="resume-copy"><strong>Goal:</strong> {session.goal}</p>
      <p className="card-meta">Started {formatTimestamp(session.startedAt)}{session.endedAt ? ` · Ended ${formatTimestamp(session.endedAt)}` : ''}</p>
      {session.outcomeSummary && <p className="resume-copy"><strong>Outcome:</strong> {session.outcomeSummary}</p>}
      {session.blockers && <p className="resume-copy"><strong>Blockers:</strong> {session.blockers}</p>}
      {session.nextAction && <p className="resume-copy"><strong>Next action:</strong> {session.nextAction}</p>}
      {session.checkpointId && (
        <button type="button" className="resume-text-button" onClick={() => onOpenMemory(session.checkpointId!)}>
          View linked checkpoint <code>{session.checkpointId.slice(0, 8)}</code>
        </button>
      )}
      {session.amendments.length > 0 && (
        <div className="resume-amendments">
          <strong>Corrections</strong>
          <ol>
            {session.amendments.map((amendment) => (
              <li key={amendment.id}>
                <span>{amendment.body}</span>
                <time dateTime={amendment.createdAt}>{formatTimestamp(amendment.createdAt)}</time>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

export function ResumeView({ projectId, canWrite, archived, onSessionExpired, onOpenMemory, initialData }: ResumeViewProps): React.JSX.Element {
  const [resume, setResume] = useState<ResumeProjectResponse | null>(initialData ?? null);
  const [history, setHistory] = useState<WorkSession[]>(initialData?.workSessionHistory.workSessions ?? []);
  const [historyPage, setHistoryPage] = useState(initialData?.workSessionHistory.page ?? 1);
  const [historyTotal, setHistoryTotal] = useState(initialData?.workSessionHistory.total ?? 0);
  const [historyCursor, setHistoryCursor] = useState(initialData?.workSessionHistory.nextCursor ?? null);
  const [loading, setLoading] = useState(!initialData);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [startGoal, setStartGoal] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dialogGoal, setDialogGoal] = useState('');
  const [outcome, setOutcome] = useState('');
  const [blockers, setBlockers] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [createCheckpoint, setCreateCheckpoint] = useState(false);
  const [checkpointNote, setCheckpointNote] = useState('');
  const [amendment, setAmendment] = useState('');

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

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const response = await api.getProjectResume(projectId, signal);
      setResume(response);
      setHistory(response.workSessionHistory.workSessions);
      setHistoryPage(response.workSessionHistory.page);
      setHistoryTotal(response.workSessionHistory.total);
      setHistoryCursor(response.workSessionHistory.nextCursor);
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      handleError(caught, 'Unable to load the project resume.');
    } finally {
      setLoading(false);
    }
  }, [handleError, projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    if (!dialog) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setDialog(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [busy, dialog]);

  useEffect(() => {
    if (!resume?.activeWorkSession) return;
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, [resume?.activeWorkSession]);

  async function refreshAfterMutation(): Promise<void> {
    await load();
    setDialog(null);
  }

  async function startSession(): Promise<void> {
    const goal = startGoal.trim();
    if (!goal || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.startWorkSession(projectId, { goal });
      setStartGoal('');
      await refreshAfterMutation();
    } catch (caught) {
      handleError(caught, 'Unable to start the work session.');
    } finally {
      setBusy(false);
    }
  }

  function openEdit(session: WorkSession): void {
    setDialogError(null);
    setDialogGoal(session.goal);
    setDialog({ kind: 'edit', session });
  }

  function openClose(session: WorkSession): void {
    setDialogError(null);
    setOutcome('');
    setBlockers('');
    setNextAction('');
    setCreateCheckpoint(false);
    setCheckpointNote('');
    setDialog({ kind: 'close', session });
  }

  function openAmendment(session: WorkSession): void {
    setDialogError(null);
    setAmendment('');
    setDialog({ kind: 'amend', session });
  }

  async function submitDialog(): Promise<void> {
    if (!dialog || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (dialog.kind === 'edit') {
        const goal = dialogGoal.trim();
        if (!goal) return;
        await api.updateWorkSession(projectId, dialog.session.id, { goal });
      } else if (dialog.kind === 'close') {
        const summary = outcome.trim();
        if (!summary) return;
        await api.closeWorkSession(projectId, dialog.session.id, {
          outcomeSummary: summary,
          ...(blockers.trim() ? { blockers: blockers.trim() } : {}),
          ...(nextAction.trim() ? { nextAction: nextAction.trim() } : {}),
          createCheckpoint,
          ...(createCheckpoint && checkpointNote.trim() ? { checkpointSessionNote: checkpointNote.trim() } : {}),
        });
      } else {
        const body = amendment.trim();
        if (!body) return;
        await api.addWorkSessionAmendment(projectId, dialog.session.id, { body });
      }
      await refreshAfterMutation();
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) onSessionExpired();
        else setDialogError(caught.message);
      } else {
        setDialogError('Unable to update the work session.');
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadOlder(): Promise<void> {
    if (!resume || loadingOlder) return;
    const nextPage = historyPage + 1;
    setLoadingOlder(true);
    setHistoryError(null);
    try {
      const response = await api.listWorkSessions(projectId, {
        page: nextPage,
        pageSize: PAGE_SIZE,
        status: 'closed',
        ...(historyCursor ? { beforeStartedAt: historyCursor.startedAt, beforeId: historyCursor.id } : {}),
      });
      setHistory((current) => {
        const known = new Set(current.map((session) => session.id));
        return [...current, ...response.workSessions.filter((session) => !known.has(session.id))];
      });
      setHistoryPage(response.page);
      setHistoryTotal(response.total);
      setHistoryCursor(response.nextCursor);
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) onSessionExpired();
        else setHistoryError(caught.message);
      } else {
        setHistoryError('Unable to load older work sessions.');
      }
    } finally {
      setLoadingOlder(false);
    }
  }

  if (loading && !resume) return <p role="status">Loading project resume…</p>;
  if (!resume) {
    return (
      <div className="alert alert-error" role="alert">
        {error ?? 'Project resume is unavailable.'} <button type="button" onClick={() => void load()}>Retry</button>
      </div>
    );
  }

  const readOnly = !canWrite || archived || resume.readOnly;
  const canLoadOlder = history.length < historyTotal && historyCursor !== null;
  const focus = resume.currentFocus;
  const recommendation = resume.recommendedNextAction;

  return (
    <div className="resume-view">
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {readOnly && <div className="alert alert-warn" role="status">{archived || resume.readOnly ? 'This archived project is read-only.' : 'Your account has read-only access to Work Sessions.'}</div>}

      <section className="card resume-primary" aria-labelledby="resume-focus">
        <h3 id="resume-focus">1. Current Focus</h3>
        {focus.kind === 'work_session' ? <><p className="resume-copy">{focus.goal}</p><p className="card-meta">Open session · started {formatRelativeTime(focus.startedAt)}</p></>
          : focus.kind === 'roadmap_task' ? <><p className="resume-copy">{focus.taskTitle}</p><p className="card-meta">{focus.milestoneTitle} · {focus.taskStatus.replaceAll('_', ' ')} · {focus.priority}</p></>
          : <p className="hint">{focus.message}</p>}
      </section>

      <section className="card resume-primary" aria-labelledby="resume-action">
        <h3 id="resume-action">2. Recommended Next Action</h3>
        {recommendation.kind === 'roadmap_task' ? <><p className="resume-copy">{recommendation.action}</p><p className="card-meta">{recommendation.taskTitle} · {recommendation.milestoneTitle} · Based on: {recommendation.actionSource.replaceAll('_', ' ')}</p></>
          : <p className={recommendation.kind === 'blocked' ? 'resume-copy resume-warning' : 'hint'}>{recommendation.message}</p>}
      </section>

      <section className="card" aria-labelledby="resume-attention">
        <h3 id="resume-attention">3. Attention Required</h3>
        {resume.attentionRequired.items.length === 0 ? <p className="hint">Nothing currently requires attention.</p> : (
          <ul className="resume-list">{resume.attentionRequired.items.map((item) => <li key={item.key}>{item.label}</li>)}</ul>
        )}
      </section>

      <section className="card" aria-labelledby="resume-active-session">
        <h3 id="resume-active-session">4. Active Work Session</h3>
        {resume.activeWorkSession ? (
          <>
            <SessionDetails session={resume.activeWorkSession} onOpenMemory={onOpenMemory} />
            <p className="card-meta">Open · elapsed {formatElapsed(resume.activeWorkSession.startedAt, now)}</p>
            {!readOnly && <div className="resume-actions"><button type="button" disabled={busy} onClick={() => openEdit(resume.activeWorkSession!)}>Edit goal</button><button type="button" className="primary" disabled={busy} onClick={() => openClose(resume.activeWorkSession!)}>End Session</button></div>}
          </>
        ) : (
          readOnly ? <p className="hint">No work session is open.</p> : (
            <div className="resume-start">
              <div className="field"><label htmlFor="resume-start-goal">Session goal</label><textarea id="resume-start-goal" rows={3} maxLength={4000} value={startGoal} onChange={(event) => setStartGoal(event.target.value)} /></div>
              <button type="button" className="primary" disabled={busy || !startGoal.trim()} onClick={() => void startSession()}>{busy ? 'Starting…' : 'Start Work Session'}</button>
            </div>
          )
        )}
      </section>

      <section className="card" aria-labelledby="resume-last-session">
        <h3 id="resume-last-session">5. Last Session</h3>
        {resume.lastSession ? <><SessionDetails session={resume.lastSession} onOpenMemory={onOpenMemory} />{!readOnly && <button type="button" onClick={() => openAmendment(resume.lastSession!)}>Add correction</button>}</> : <p className="hint">No completed work session yet.</p>}
      </section>

      <section className="card" aria-labelledby="resume-checkpoint">
        <h3 id="resume-checkpoint">6. Last Checkpoint</h3>
        {resume.lastCheckpoint ? <><p className="resume-copy">{resume.lastCheckpoint.sessionNote || 'Checkpoint saved without a session note.'}</p><p className="card-meta">{formatTimestamp(resume.lastCheckpoint.createdAt)} · snapshot v{resume.lastCheckpoint.snapshotVersion}</p><button type="button" onClick={() => onOpenMemory(resume.lastCheckpoint!.id)}>View in Memory</button></> : <p className="hint">No checkpoint has been created.</p>}
      </section>

      <section className="card" aria-labelledby="resume-changes">
        <h3 id="resume-changes">7. Changes Since Last Checkpoint</h3>
        {!resume.changesSinceCheckpoint.hasCheckpoint ? <p className="hint">Create a checkpoint to establish a comparison point.</p>
          : resume.changesSinceCheckpoint.items.length === 0 ? <p className="hint">No recorded changes since the last checkpoint.</p>
            : <ul className="resume-list">{resume.changesSinceCheckpoint.items.map((item) => <li key={item.key}>{item.label}</li>)}</ul>}
      </section>

      <section className="card" aria-labelledby="resume-work">
        <h3 id="resume-work">8. Active / Blocked Work</h3>
        {resume.activeAndBlockedWork.active.length === 0 && resume.activeAndBlockedWork.blocked.length === 0 ? <p className="hint">No active or blocked roadmap work.</p> : (
          <div className="resume-columns">
            <div><strong>Active</strong>{resume.activeAndBlockedWork.active.length === 0 ? <p className="hint">None.</p> : <ul className="resume-list">{resume.activeAndBlockedWork.active.map((item) => <li key={item.taskId}><span>{item.title}</span><small>{item.milestoneTitle} · {item.nextAction}</small></li>)}</ul>}</div>
            <div><strong>Blocked</strong>{resume.activeAndBlockedWork.blocked.length === 0 ? <p className="hint">None.</p> : <ul className="resume-list">{resume.activeAndBlockedWork.blocked.map((item) => <li key={item.taskId}><span>{item.title}</span><small>{item.blockedReason || 'No blocker detail recorded.'}</small></li>)}</ul>}</div>
          </div>
        )}
      </section>

      <section className="card" aria-labelledby="resume-agent-work">
        <h3 id="resume-agent-work">9. Recent Agent Work</h3>
        {resume.recentAgentWork.length === 0 ? <p className="hint">No recent Agent Run activity.</p> : <ul className="resume-list">{resume.recentAgentWork.map((run) => <li key={run.agentRunId}><span><strong>{run.agentName}</strong> · {run.title}</span><small>{run.status} · {run.validationStatus.replaceAll('_', ' ')} · {formatTimestamp(run.activityAt)}</small></li>)}</ul>}
      </section>

      <section className="card" aria-labelledby="resume-memory">
        <h3 id="resume-memory">10. Important Memory</h3>
        {resume.importantMemory.length === 0 ? <p className="hint">No current pinned or important memory.</p> : <ul className="resume-list">{resume.importantMemory.map((entry) => <li key={entry.id}><span><strong>{entry.title}</strong> · {entry.type}</span><small>{entry.isPinned ? 'Pinned · ' : ''}{entry.importance}</small><p>{entry.body}</p></li>)}</ul>}
      </section>

      <section className="card" aria-labelledby="resume-history">
        <h3 id="resume-history">11. Work Session History</h3>
        {history.length === 0 ? <p className="hint">No completed work sessions yet.</p> : (
          <ol className="resume-history">{history.map((session) => <li key={session.id}><SessionDetails session={session} onOpenMemory={onOpenMemory} />{!readOnly && session.status === 'closed' && <button type="button" onClick={() => openAmendment(session)}>Add correction</button>}</li>)}</ol>
        )}
        {canLoadOlder && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? 'Loading…' : `Load older (${historyTotal - history.length} remaining)`}</button>}
        {historyError && <div className="alert alert-error" role="alert">{historyError}</div>}
      </section>

      {dialog && (
        <div className="resume-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setDialog(null); }}>
          <div className="card resume-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-dialog-title">
            <div className="card-head"><h3 id="resume-dialog-title">{dialog.kind === 'edit' ? 'Edit session goal' : dialog.kind === 'close' ? 'End work session' : 'Add session correction'}</h3><button type="button" aria-label="Close dialog" disabled={busy} onClick={() => setDialog(null)}>×</button></div>
            {dialogError && <div className="alert alert-error" role="alert">{dialogError}</div>}
            {dialog.kind === 'edit' && <div className="field"><label htmlFor="resume-edit-goal">Goal</label><textarea id="resume-edit-goal" autoFocus rows={4} maxLength={4000} value={dialogGoal} onChange={(event) => setDialogGoal(event.target.value)} /></div>}
            {dialog.kind === 'close' && <>
              <div className="field"><label htmlFor="resume-outcome">Outcome / Summary (required)</label><textarea id="resume-outcome" autoFocus rows={5} maxLength={10000} value={outcome} onChange={(event) => setOutcome(event.target.value)} /></div>
              <div className="field"><label htmlFor="resume-blockers">Blockers (optional)</label><textarea id="resume-blockers" rows={3} maxLength={4000} value={blockers} onChange={(event) => setBlockers(event.target.value)} /></div>
              <div className="field"><label htmlFor="resume-next-action">Next Action (optional)</label><textarea id="resume-next-action" rows={3} maxLength={4000} value={nextAction} onChange={(event) => setNextAction(event.target.value)} /></div>
              <label className="checkbox-field"><input type="checkbox" checked={createCheckpoint} onChange={(event) => setCreateCheckpoint(event.target.checked)} /> Create checkpoint</label>
              {createCheckpoint && <div className="field"><label htmlFor="resume-checkpoint-note">Checkpoint / session note (optional)</label><textarea id="resume-checkpoint-note" rows={3} maxLength={4000} value={checkpointNote} onChange={(event) => setCheckpointNote(event.target.value)} /></div>}
              <p className="alert alert-warn">Confirm ending this session. Its historical fields become read-only; later corrections are append-only.</p>
            </>}
            {dialog.kind === 'amend' && <><p className="hint">This correction will be appended. The closed session will not be changed.</p><div className="field"><label htmlFor="resume-amendment">Correction</label><textarea id="resume-amendment" autoFocus rows={5} maxLength={10000} value={amendment} onChange={(event) => setAmendment(event.target.value)} /></div></>}
            <div className="resume-actions"><button type="button" disabled={busy} onClick={() => setDialog(null)}>Cancel</button><button type="button" className="primary" disabled={busy || (dialog.kind === 'edit' ? !dialogGoal.trim() : dialog.kind === 'close' ? !outcome.trim() : !amendment.trim())} onClick={() => void submitDialog()}>{busy ? 'Saving…' : dialog.kind === 'close' ? 'Confirm and End Session' : dialog.kind === 'amend' ? 'Add correction' : 'Save goal'}</button></div>
          </div>
        </div>
      )}
    </div>
  );
}
