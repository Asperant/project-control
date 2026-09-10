import { useCallback, useEffect, useState } from 'react';
import type { AgentRun, AgentRunListQuery, AgentValidationStatus, RoadmapMilestone } from '@project-control/contracts';
import { api } from '../../api-client';
import { AgentRunDetail } from './AgentRunDetail';
import { useApiErrorHandler } from '../../hooks/useApiErrorHandler';
import { ErrorAlert } from '../ErrorAlert';

export type RelatedOptions = { milestones: RoadmapMilestone[]; tasks: Array<{ id: string; title: string; milestoneId: string }> };

const statusFilters: Array<AgentRunListQuery['status'] | 'all'> = ['all', 'draft', 'sent', 'in_progress', 'completed', 'failed', 'cancelled'];
const validationFilters: Array<AgentValidationStatus | 'all'> = ['all', 'not_reviewed', 'under_review', 'accepted', 'accepted_with_changes', 'rejected'];
const agentQuickPicks = ['Claude', 'Codex', 'Other'];
const formatTime = (iso: string): string => new Date(iso).toLocaleString();

export function AgentRunsView({
  projectId, canWrite, archived, onSessionExpired,
}: { projectId: string; canWrite: boolean; archived: boolean; onSessionExpired: () => void }): React.JSX.Element {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [related, setRelated] = useState<RelatedOptions>({ milestones: [], tasks: [] });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<AgentRunListQuery['status'] | 'all'>('all');
  const [agentName, setAgentName] = useState('');
  const [validationStatus, setValidationStatus] = useState<AgentValidationStatus | 'all'>('all');
  const [showArchived, setShowArchived] = useState(false);
  const { error, setError, handleError } = useApiErrorHandler(onSessionExpired, 'The Agent Runs request failed.');
  const [busy, setBusy] = useState(false);
  const [showNewRun, setShowNewRun] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  const writable = canWrite && !archived;

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const query: Partial<AgentRunListQuery> = {};
      if (search.trim()) query.search = search.trim();
      if (status !== 'all') query.status = status;
      if (agentName.trim()) query.agentName = agentName.trim();
      if (validationStatus !== 'all') query.validationStatus = validationStatus;
      if (showArchived) query.archived = 'true';

      const [runsResponse, roadmap] = await Promise.all([
        api.listAgentRuns(projectId, query, signal),
        api.getRoadmap(projectId, signal),
      ]);
      setRuns(runsResponse.agentRuns);
      setRelated({
        milestones: roadmap.milestones,
        tasks: roadmap.milestones.flatMap((m) => m.tasks.map((t) => ({ id: t.id, title: t.title, milestoneId: m.id }))),
      });
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      handleError(caught);
    }
  }, [projectId, search, status, agentName, validationStatus, showArchived, handleError]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function createRun(body: { title: string; agentName: string; relatedTaskId: string | null; relatedMilestoneId: string | null }): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const { agentRun } = await api.createAgentRun(projectId, body);
      setShowNewRun(false);
      await load();
      setSelectedRunId(agentRun.id);
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  if (selectedRunId) {
    return (
      <AgentRunDetail
        projectId={projectId} runId={selectedRunId} canWrite={canWrite} projectArchived={archived} related={related}
        onBack={() => { setSelectedRunId(null); void load(); }}
        onSessionExpired={onSessionExpired}
        onChanged={() => void load()}
        onNavigateToRun={setSelectedRunId}
      />
    );
  }

  const active = runs.filter((r) => ['sent', 'in_progress'].includes(r.status) || (r.status === 'draft' && !showArchived));
  const completedOrOther = runs.filter((r) => !active.includes(r));

  return (
    <section aria-labelledby="agent-runs-heading" className="agent-runs-view">
      <div className="projects-toolbar">
        <h2 id="agent-runs-heading" style={{ margin: 0 }}>Agent Runs</h2>
        <div className="spacer" />
        {writable && !showNewRun && <button type="button" className="primary" onClick={() => setShowNewRun(true)}>+ New Agent Run</button>}
      </div>

      {archived && <div className="alert alert-warn" role="status">This project is archived. Agent Run changes are disabled.</div>}
      <ErrorAlert error={error?.message ?? null} requestId={error?.requestId ?? null} />

      {writable && showNewRun && (
        <NewAgentRunForm related={related} busy={busy} onCancel={() => setShowNewRun(false)} onSubmit={createRun} />
      )}

      <div className="filter-bar" role="search">
        <input type="search" placeholder="Search title, prompt, report, validation note…" aria-label="Search Agent Runs" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
          {statusFilters.map((s) => <option key={s} value={s}>{s === 'all' ? 'All statuses' : s!.replace(/_/g, ' ')}</option>)}
        </select>
        <input type="text" placeholder="Agent (e.g. Claude)" aria-label="Filter by agent" value={agentName} onChange={(e) => setAgentName(e.target.value)} />
        <select aria-label="Filter by validation" value={validationStatus} onChange={(e) => setValidationStatus(e.target.value as typeof validationStatus)}>
          {validationFilters.map((v) => <option key={v} value={v}>{v === 'all' ? 'All validation' : v.replace(/_/g, ' ')}</option>)}
        </select>
        <label className="checkbox-field">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
        </label>
      </div>

      {runs.length === 0 ? (
        <p className="hint">No agent runs yet.</p>
      ) : (
        <>
          {active.length > 0 && <RunGroup title="Active" runs={active} onOpen={setSelectedRunId} />}
          {completedOrOther.length > 0 && <RunGroup title={showArchived ? 'Archived / other' : 'Completed / other'} runs={completedOrOther} onOpen={setSelectedRunId} />}
        </>
      )}
    </section>
  );
}

function RunGroup({ title, runs, onOpen }: { title: string; runs: AgentRun[]; onOpen: (id: string) => void }): React.JSX.Element {
  return (
    <article className="card">
      <span className="card-title">{title}</span>
      <ul className="memory-list">
        {runs.map((r) => (
          <li key={r.id}>
            <button type="button" className="agent-run-card-open" onClick={() => onOpen(r.id)}>
              <span className="card-title">{r.title}</span>
              <span className="memory-badges">
                <span className="badge badge-manual">{r.agentName}</span>
                <span className="badge badge-unknown">{r.status.replace(/_/g, ' ')}</span>
                <span className={`badge ${r.validationStatus === 'accepted' || r.validationStatus === 'accepted_with_changes' ? 'badge-ok' : r.validationStatus === 'rejected' ? 'badge-down' : 'badge-unknown'}`}>
                  {r.validationStatus.replace(/_/g, ' ')}
                </span>
                {r.archivedAt && <span className="badge badge-unknown">Archived</span>}
              </span>
              {(r.relatedMilestoneTitle || r.relatedTaskTitle) && (
                <span className="card-meta">
                  {r.relatedMilestoneTitle && <>Milestone: {r.relatedMilestoneTitle} </>}
                  {r.relatedTaskTitle && <>· Task: {r.relatedTaskTitle}</>}
                </span>
              )}
              {r.currentReportVersion !== null && <span className="card-meta">Current report: v{r.currentReportVersion}</span>}
              <span className="card-meta">{formatTime(r.createdAt)}</span>
            </button>
          </li>
        ))}
      </ul>
    </article>
  );
}

function NewAgentRunForm({
  related, busy, onCancel, onSubmit,
}: {
  related: RelatedOptions; busy: boolean; onCancel: () => void;
  onSubmit: (body: { title: string; agentName: string; relatedTaskId: string | null; relatedMilestoneId: string | null }) => void;
}): React.JSX.Element {
  const [title, setTitle] = useState('');
  const [agentPick, setAgentPick] = useState('Claude');
  const [customAgent, setCustomAgent] = useState('');
  const [taskId, setTaskId] = useState('');
  const [milestoneId, setMilestoneId] = useState('');
  const agentName = agentPick === 'Other' ? customAgent.trim() : agentPick;

  return (
    <article className="card">
      <span className="card-title">New Agent Run</span>
      <form className="memory-form" onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ title: title.trim(), agentName, relatedTaskId: taskId || null, relatedMilestoneId: milestoneId || null });
      }}>
        <div className="field">
          <label htmlFor="new-run-title">Title *</label>
          <input id="new-run-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="new-run-agent">Agent *</label>
            <select id="new-run-agent" value={agentPick} onChange={(e) => setAgentPick(e.target.value)}>
              {agentQuickPicks.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          {agentPick === 'Other' && (
            <div className="field">
              <label htmlFor="new-run-agent-custom">Agent name</label>
              <input id="new-run-agent-custom" required maxLength={80} value={customAgent} onChange={(e) => setCustomAgent(e.target.value)} />
            </div>
          )}
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="new-run-milestone">Related milestone</label>
            <select id="new-run-milestone" value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
              <option value="">None</option>
              {related.milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="new-run-task">Related task</label>
            <select id="new-run-task" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">None</option>
              {related.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
            </select>
          </div>
        </div>
        <div className="roadmap-actions">
          <button type="submit" className="primary" disabled={busy || !title.trim() || !agentName}>Create draft</button>
          <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
        </div>
      </form>
    </article>
  );
}
