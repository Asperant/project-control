import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import type {
  AgentReport, AgentRun, AgentRunPrompt, AgentRunTimelineEntry, AgentValidationStatus,
  CreateMemoryEntryRequest, MemoryEntry, MemoryImportance, MemoryType, RoadmapMilestone,
} from '@project-control/contracts';
import { api } from '../../api-client';
import type { RelatedOptions } from './AgentRunsView';
import { useApiErrorHandler } from '../../hooks/useApiErrorHandler';
import { ErrorAlert } from '../ErrorAlert';

const formatTime = (iso: string): string => new Date(iso).toLocaleString();
const validationStatuses: AgentValidationStatus[] = ['not_reviewed', 'under_review', 'accepted', 'accepted_with_changes', 'rejected'];
const memoryTypes: MemoryType[] = ['decision', 'constraint', 'context', 'finding', 'handoff', 'lesson'];
const memoryImportances: MemoryImportance[] = ['normal', 'important', 'critical'];

/** Only http(s)/mailto/relative links are honoured; anything else renders as plain text. */
function isSafeHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(https?:|mailto:)/i.test(href) || href.startsWith('/') || href.startsWith('#');
}

async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export function AgentRunDetail({
  projectId, runId, canWrite, projectArchived, related, onBack, onSessionExpired, onChanged, onNavigateToRun,
}: {
  projectId: string; runId: string; canWrite: boolean; projectArchived: boolean; related: RelatedOptions;
  onBack: () => void; onSessionExpired: () => void; onChanged: () => void; onNavigateToRun: (runId: string) => void;
}): React.JSX.Element {
  const [agentRun, setAgentRun] = useState<AgentRun | null>(null);
  const [prompt, setPrompt] = useState<AgentRunPrompt | null>(null);
  const [reports, setReports] = useState<AgentReport[]>([]);
  const [timeline, setTimeline] = useState<AgentRunTimelineEntry[]>([]);
  const [relatedMemory, setRelatedMemory] = useState<MemoryEntry[]>([]);
  const { error, setError, handleError } = useApiErrorHandler(onSessionExpired, 'The Agent Run request failed.');
  const [busy, setBusy] = useState(false);

  const [editingMeta, setEditingMeta] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [promptDraft, setPromptDraft] = useState('');
  const [reportDraftBody, setReportDraftBody] = useState('');
  const [showAddReport, setShowAddReport] = useState(false);
  const [editingReportBody, setEditingReportBody] = useState<string | null>(null);
  const [expandedReportId, setExpandedReportId] = useState<string | null>(null);
  const [reportRawView, setReportRawView] = useState<Record<string, boolean>>({});
  const [showValidationForm, setShowValidationForm] = useState(false);
  const [validationStatusDraft, setValidationStatusDraft] = useState<AgentValidationStatus>('not_reviewed');
  const [validationNoteDraft, setValidationNoteDraft] = useState('');
  const [showPromote, setShowPromote] = useState(false);

  const archived = projectArchived || Boolean(agentRun?.archivedAt);
  const writable = canWrite && !archived;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const [runResponse, promptResponse, reportsResponse, timelineResponse, memoryResponse] = await Promise.all([
        api.getAgentRun(projectId, runId, signal),
        api.getAgentRunPrompt(projectId, runId, signal),
        api.listAgentReports(projectId, runId, signal),
        api.getAgentRunTimeline(projectId, runId, signal),
        api.getRelatedMemory(projectId, runId, signal),
      ]);
      setAgentRun(runResponse.agentRun);
      setPrompt(promptResponse.prompt);
      setReports(reportsResponse.reports);
      setTimeline(timelineResponse.timeline);
      setRelatedMemory(memoryResponse.entries);
      setValidationStatusDraft(runResponse.agentRun.validationStatus);
      setValidationNoteDraft(runResponse.agentRun.validationNote ?? '');
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      handleError(caught);
    }
  }, [projectId, runId, handleError]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function run<T>(action: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      await load();
      onChanged();
      return result;
    } catch (caught) {
      handleError(caught);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function handleDuplicate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { agentRun: duplicated } = await api.duplicateAgentRun(projectId, runId);
      onChanged();
      // Navigate to the new draft rather than re-showing this (unchanged) run.
      onNavigateToRun(duplicated.id);
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (!agentRun) return <p>{error?.message ?? 'Loading Agent Run…'}</p>;

  const currentDraftReport = reports.find((r) => r.status === 'draft') ?? null;
  const currentFinalReport = reports.find((r) => r.status === 'final') ?? null;
  const olderReports = reports.filter((r) => r.status === 'superseded');

  return (
    <section aria-labelledby="agent-run-heading" className="agent-run-detail">
      <div className="projects-toolbar">
        <button type="button" onClick={onBack}>← Back to Agent Runs</button>
        <h3 id="agent-run-heading" style={{ margin: 0 }}>{agentRun.title}</h3>
        <span className={`badge badge-unknown`}>{agentRun.status.replace(/_/g, ' ')}</span>
        <span className="badge badge-manual">{agentRun.agentName}</span>
      </div>

      <ErrorAlert error={error?.message ?? null} requestId={error?.requestId ?? null} />
      {archived && <div className="alert alert-warn" role="status">This Agent Run is archived. Changes are disabled.</div>}

      {/* --- Overview ---------------------------------------------------- */}
      <article className="card">
        <div className="card-head">
          <span className="card-title">Overview</span>
          {writable && !editingMeta && <button type="button" onClick={() => setEditingMeta(true)}>Edit</button>}
        </div>
        {editingMeta ? (
          <AgentRunMetaForm
            agentRun={agentRun} related={related} busy={busy}
            onCancel={() => setEditingMeta(false)}
            onSave={(body) => run(() => api.updateAgentRun(projectId, runId, body)).then(() => setEditingMeta(false))}
          />
        ) : (
          <>
            <p className="card-meta">
              {agentRun.relatedMilestoneTitle && <>Milestone: {agentRun.relatedMilestoneTitle} </>}
              {agentRun.relatedTaskTitle && <>· Task: {agentRun.relatedTaskTitle}</>}
              {!agentRun.relatedMilestoneTitle && !agentRun.relatedTaskTitle && <em className="hint">No related roadmap item.</em>}
            </p>
            <p className="card-meta">Created {formatTime(agentRun.createdAt)}</p>
          </>
        )}
        {writable && (
          <div className="roadmap-actions">
            {agentRun.status === 'draft' && <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'cancelled' }))}>Cancel</button>}
            {agentRun.status === 'sent' && <>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'in_progress' }))}>Mark in progress</button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'completed' }))}>Mark completed</button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'failed' }))}>Mark failed</button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'cancelled' }))}>Cancel</button>
            </>}
            {agentRun.status === 'in_progress' && <>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'completed' }))}>Mark completed</button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'failed' }))}>Mark failed</button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'cancelled' }))}>Cancel</button>
            </>}
            {agentRun.status === 'failed' && <>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'in_progress' }))}>Retry (in progress)</button>
              <button type="button" disabled={busy} onClick={() => void run(() => api.setAgentRunStatus(projectId, runId, { status: 'cancelled' }))}>Cancel</button>
            </>}
            <button type="button" disabled={busy} onClick={() => void handleDuplicate()}>Duplicate as new run</button>
            {!agentRun.archivedAt
              ? <button type="button" disabled={busy} onClick={() => void run(() => api.archiveAgentRun(projectId, runId))}>Archive</button>
              : <button type="button" disabled={busy} onClick={() => void run(() => api.reactivateAgentRun(projectId, runId))}>Reactivate</button>}
          </div>
        )}
      </article>

      {/* --- Prompt -------------------------------------------------------- */}
      <article className="card">
        <div className="card-head">
          <span className="card-title">Prompt</span>
          <span className="memory-badges">
            {prompt && <span className={`badge ${prompt.status === 'sent' ? 'badge-ok' : 'badge-unknown'}`}>{prompt.status}</span>}
          </span>
        </div>
        {!prompt ? (
          <p className="hint">No prompt yet.</p>
        ) : editingPrompt ? (
          <form className="memory-form" onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.updateAgentRunPrompt(projectId, runId, { body: promptDraft })).then(() => setEditingPrompt(false));
          }}>
            <div className="field">
              <label htmlFor="prompt-body">Prompt body</label>
              <textarea id="prompt-body" rows={8} required value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} />
            </div>
            <div className="roadmap-actions">
              <button type="submit" className="primary" disabled={busy || !promptDraft.trim()}>Save</button>
              <button type="button" disabled={busy} onClick={() => setEditingPrompt(false)}>Cancel</button>
            </div>
          </form>
        ) : (
          <>
            <pre className="agent-run-prompt-body">{prompt.body}</pre>
            <p className="card-meta">{prompt.status === 'sent' ? `Sent ${formatTime(prompt.sentAt!)}` : 'Draft — not sent yet.'}</p>
            <div className="roadmap-actions">
              <button type="button" onClick={() => void copyToClipboard(prompt.body)}>Copy Prompt</button>
              {writable && prompt.status === 'draft' && <button type="button" disabled={busy} onClick={() => { setPromptDraft(prompt.body); setEditingPrompt(true); }}>Edit</button>}
              {writable && prompt.status === 'draft' && <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.sendAgentRunPrompt(projectId, runId))}>Mark as Sent</button>}
            </div>
          </>
        )}
        {writable && !prompt && (
          <form className="memory-form" onSubmit={(e) => { e.preventDefault(); void run(() => api.updateAgentRunPrompt(projectId, runId, { body: promptDraft })); }}>
            <div className="field">
              <label htmlFor="new-prompt-body">Prompt body</label>
              <textarea id="new-prompt-body" rows={8} required value={promptDraft} onChange={(e) => setPromptDraft(e.target.value)} />
            </div>
            <button type="submit" className="primary" disabled={busy || !promptDraft.trim()}>Save draft prompt</button>
          </form>
        )}
      </article>

      {/* --- Agent Report ---------------------------------------------------- */}
      <article className="card">
        <div className="card-head"><span className="card-title">Agent Report</span></div>

        {currentDraftReport && (
          <div className="agent-report-draft">
            <span className="badge badge-unknown">Draft report</span>
            {editingReportBody !== null ? (
              <form className="memory-form" onSubmit={(e) => {
                e.preventDefault();
                void run(() => api.updateAgentReport(projectId, runId, currentDraftReport.id, { body: editingReportBody })).then(() => setEditingReportBody(null));
              }}>
                <textarea rows={8} required value={editingReportBody} onChange={(e) => setEditingReportBody(e.target.value)} />
                <div className="roadmap-actions">
                  <button type="submit" className="primary" disabled={busy || !editingReportBody.trim()}>Save</button>
                  <button type="button" disabled={busy} onClick={() => setEditingReportBody(null)}>Cancel</button>
                </div>
              </form>
            ) : (
              <>
                <pre className="agent-run-prompt-body">{currentDraftReport.body}</pre>
                {writable && (
                  <div className="roadmap-actions">
                    <button type="button" disabled={busy} onClick={() => setEditingReportBody(currentDraftReport.body)}>Edit</button>
                    <button type="button" className="primary" disabled={busy} onClick={() => void run(() => api.finalizeAgentReport(projectId, runId, currentDraftReport.id))}>Finalize</button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {!currentDraftReport && writable && (
          showAddReport ? (
            <form className="memory-form" onSubmit={(e) => {
              e.preventDefault();
              void run(() => api.createAgentReport(projectId, runId, { body: reportDraftBody })).then(() => { setShowAddReport(false); setReportDraftBody(''); });
            }}>
              <div className="field">
                <label htmlFor="report-body">{currentFinalReport ? 'Revision body' : 'Report body'}</label>
                <textarea id="report-body" rows={8} required value={reportDraftBody} onChange={(e) => setReportDraftBody(e.target.value)} />
              </div>
              <div className="roadmap-actions">
                <button type="submit" className="primary" disabled={busy || !reportDraftBody.trim()}>{currentFinalReport ? 'Start revision' : 'Add report'}</button>
                <button type="button" disabled={busy} onClick={() => setShowAddReport(false)}>Cancel</button>
              </div>
            </form>
          ) : (
            <button type="button" className="primary" onClick={() => setShowAddReport(true)}>{currentFinalReport ? 'Start revision' : 'Add report'}</button>
          )
        )}

        {!currentDraftReport && !currentFinalReport && !writable && <p className="hint">No report yet.</p>}

        {currentFinalReport && (
          <ReportCard
            report={currentFinalReport} raw={Boolean(reportRawView[currentFinalReport.id])}
            onToggleRaw={() => setReportRawView((s) => ({ ...s, [currentFinalReport.id]: !s[currentFinalReport.id] }))}
          />
        )}

        {olderReports.length > 0 && (
          <div className="agent-report-history">
            <span className="card-meta">Revision history</span>
            <ul className="steps">
              {olderReports.sort((a, b) => b.version - a.version).map((r) => (
                <li key={r.id}>
                  <button type="button" className="checkpoint-open" onClick={() => setExpandedReportId(expandedReportId === r.id ? null : r.id)}>
                    <span className="step-name">v{r.version} SUPERSEDED</span>
                  </button>
                </li>
              ))}
            </ul>
            {olderReports.filter((r) => r.id === expandedReportId).map((r) => (
              <ReportCard key={r.id} report={r}
                raw={Boolean(reportRawView[r.id])}
                onToggleRaw={() => setReportRawView((s) => ({ ...s, [r.id]: !s[r.id] }))}
              />
            ))}
          </div>
        )}
      </article>

      {/* --- User Validation --------------------------------------------------- */}
      <article className="card">
        <div className="card-head">
          <span className="card-title">User Validation</span>
          {writable && !showValidationForm && <button type="button" onClick={() => setShowValidationForm(true)}>Update validation</button>}
        </div>
        <p className="card-meta">
          <span className={`badge ${agentRun.validationStatus === 'accepted' || agentRun.validationStatus === 'accepted_with_changes' ? 'badge-ok' : agentRun.validationStatus === 'rejected' ? 'badge-down' : 'badge-unknown'}`}>
            {agentRun.validationStatus.replace(/_/g, ' ')}
          </span>
        </p>
        {agentRun.validationNote && <p className="card-detail agent-run-prompt-body">{agentRun.validationNote}</p>}
        {agentRun.validatedAt && <p className="card-meta">Last set {formatTime(agentRun.validatedAt)}</p>}
        {writable && showValidationForm && (
          <form className="memory-form" onSubmit={(e) => {
            e.preventDefault();
            void run(() => api.updateAgentRunValidation(projectId, runId, { status: validationStatusDraft, note: validationNoteDraft.trim() || null }))
              .then(() => setShowValidationForm(false));
          }}>
            <div className="field">
              <label htmlFor="validation-status">Status</label>
              <select id="validation-status" value={validationStatusDraft} onChange={(e) => setValidationStatusDraft(e.target.value as AgentValidationStatus)}>
                {validationStatuses.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="validation-note">Validation note (e.g. verify/verify-security/restore-test results)</label>
              <textarea id="validation-note" rows={4} maxLength={10000} value={validationNoteDraft} onChange={(e) => setValidationNoteDraft(e.target.value)} />
            </div>
            <div className="roadmap-actions">
              <button type="submit" className="primary" disabled={busy}>Save validation</button>
              <button type="button" disabled={busy} onClick={() => setShowValidationForm(false)}>Cancel</button>
            </div>
          </form>
        )}
      </article>

      {/* --- Related Memory ------------------------------------------------------ */}
      <article className="card">
        <div className="card-head">
          <span className="card-title">Related Memory</span>
          {writable && !showPromote && <button type="button" onClick={() => setShowPromote(true)}>Add to Memory</button>}
        </div>
        {relatedMemory.length === 0 ? <p className="hint">No related memory entries.</p> : (
          <ul className="chip-list">
            {relatedMemory.map((e) => <li key={e.id} className="chip">[{e.type}] {e.title}</li>)}
          </ul>
        )}
        {writable && showPromote && (
          <PromoteToMemoryForm
            related={related} busy={busy}
            onCancel={() => setShowPromote(false)}
            onSubmit={(body) => run(() => api.promoteAgentRunToMemory(projectId, runId, body)).then(() => setShowPromote(false))}
          />
        )}
      </article>

      {/* --- Timeline ---------------------------------------------------------------- */}
      <article className="card">
        <span className="card-title">Timeline</span>
        {timeline.length === 0 ? <p className="hint">No activity recorded yet.</p> : (
          <ul className="steps">
            {timeline.map((t) => (
              <li key={t.id}>
                <span className="step-name">{t.label}</span>
                <span className="step-time">{formatTime(t.occurredAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </article>
    </section>
  );
}

// ---------------------------------------------------------------------------

function AgentRunMetaForm({
  agentRun, related, busy, onCancel, onSave,
}: {
  agentRun: AgentRun; related: RelatedOptions; busy: boolean;
  onCancel: () => void; onSave: (body: { title: string; agentName: string; relatedTaskId: string | null; relatedMilestoneId: string | null }) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState(agentRun.title);
  const [agentName, setAgentName] = useState(agentRun.agentName);
  const [taskId, setTaskId] = useState(agentRun.relatedTaskId ?? '');
  const [milestoneId, setMilestoneId] = useState(agentRun.relatedMilestoneId ?? '');
  return (
    <form className="memory-form" onSubmit={(e) => { e.preventDefault(); onSave({ title: title.trim(), agentName: agentName.trim(), relatedTaskId: taskId || null, relatedMilestoneId: milestoneId || null }); }}>
      <div className="field"><label htmlFor="meta-title">Title</label><input id="meta-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label htmlFor="meta-agent">Agent</label><input id="meta-agent" required maxLength={80} value={agentName} onChange={(e) => setAgentName(e.target.value)} /></div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="meta-milestone">Related milestone</label>
          <select id="meta-milestone" value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
            <option value="">None</option>
            {related.milestones.map((m: RoadmapMilestone) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="meta-task">Related task</label>
          <select id="meta-task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">None</option>
            {related.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>
      </div>
      <div className="roadmap-actions">
        <button type="submit" className="primary" disabled={busy || !title.trim() || !agentName.trim()}>Save</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function ReportCard({ report, raw, onToggleRaw }: { report: AgentReport; raw: boolean; onToggleRaw: () => void }): React.JSX.Element {
  return (
    <div className="agent-report-card">
      <div className="card-head">
        <span className="card-title">Version {report.version} · {report.status.toUpperCase()}</span>
      </div>
      {report.finalizedAt && <p className="card-meta">Finalized {formatTime(report.finalizedAt)}</p>}
      <div className="roadmap-actions">
        <button type="button" aria-pressed={!raw} onClick={() => raw && onToggleRaw()}>Rendered</button>
        <button type="button" aria-pressed={raw} onClick={() => !raw && onToggleRaw()}>Raw</button>
        <button type="button" onClick={() => void copyToClipboard(report.body)}>Copy raw report</button>
      </div>
      {raw ? (
        <pre className="agent-run-prompt-body">{report.body}</pre>
      ) : (
        <div className="agent-report-rendered">
          <ReactMarkdown
            components={{
              a: ({ href, children, ...props }) => (isSafeHref(href) ? <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a> : <span>{children}</span>),
            }}
          >
            {report.body}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function PromoteToMemoryForm({
  related, busy, onCancel, onSubmit,
}: { related: RelatedOptions; busy: boolean; onCancel: () => void; onSubmit: (body: CreateMemoryEntryRequest) => void }): React.JSX.Element {
  const [type, setType] = useState<MemoryType>('finding');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [importance, setImportance] = useState<MemoryImportance>('normal');
  const [isPinned, setIsPinned] = useState(false);
  const [taskId, setTaskId] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  return (
    <form className="memory-form" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({ type, title: title.trim(), body: body.trim(), importance, isPinned, relatedTaskId: taskId || null, relatedMilestoneId: milestoneId || null });
    }}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="promote-type">Type *</label>
          <select id="promote-type" value={type} onChange={(e) => setType(e.target.value as MemoryType)}>
            {memoryTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="promote-importance">Importance</label>
          <select id="promote-importance" value={importance} onChange={(e) => setImportance(e.target.value as MemoryImportance)}>
            {memoryImportances.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
      </div>
      <div className="field"><label htmlFor="promote-title">Title *</label><input id="promote-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></div>
      <div className="field"><label htmlFor="promote-body">Body *</label><textarea id="promote-body" required rows={4} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} /></div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="promote-milestone">Related milestone</label>
          <select id="promote-milestone" value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
            <option value="">None</option>
            {related.milestones.map((m: RoadmapMilestone) => <option key={m.id} value={m.id}>{m.title}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="promote-task">Related task</label>
          <select id="promote-task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
            <option value="">None</option>
            {related.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
          </select>
        </div>
      </div>
      <label className="memory-pin-toggle"><input type="checkbox" checked={isPinned} onChange={(e) => setIsPinned(e.target.checked)} /> Pin this entry</label>
      <div className="roadmap-actions">
        <button type="submit" className="primary" disabled={busy || !title.trim() || !body.trim()}>Add to Memory</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
