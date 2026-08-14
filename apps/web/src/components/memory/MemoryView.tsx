import { useCallback, useEffect, useState } from 'react';
import type {
  CheckpointDetail, CheckpointSummary, CreateMemoryEntryRequest, MemoryEntry, MemoryImportance,
  MemoryType, ProjectContextResponse, RoadmapMilestone,
} from '@project-control/contracts';
import { ApiError, api } from '../../api-client';

const memoryTypes: MemoryType[] = ['decision', 'constraint', 'context', 'finding', 'handoff', 'lesson'];
const importances: MemoryImportance[] = ['normal', 'important', 'critical'];
type Filter = 'all' | MemoryType | 'pinned' | 'archived' | 'superseded';
const filters: Filter[] = ['all', ...memoryTypes, 'pinned', 'archived', 'superseded'];
const filterLabel = (f: Filter): string => (f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1));
const formatTime = (iso: string): string => new Date(iso).toLocaleString();

type RelatedOptions = { milestones: RoadmapMilestone[]; tasks: Array<{ id: string; title: string; milestoneId: string }> };

export function MemoryView({
  projectId, canWrite, archived, onSessionExpired,
}: { projectId: string; canWrite: boolean; archived: boolean; onSessionExpired: () => void }): React.JSX.Element {
  const [context, setContext] = useState<ProjectContextResponse | null>(null);
  const [entries, setEntries] = useState<MemoryEntry[]>([]);
  const [checkpoints, setCheckpoints] = useState<CheckpointSummary[]>([]);
  const [related, setRelated] = useState<RelatedOptions>({ milestones: [], tasks: [] });
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [showArchivedCheckpoints, setShowArchivedCheckpoints] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showWhereWasI, setShowWhereWasI] = useState(false);
  const [showAddMemory, setShowAddMemory] = useState(false);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [supersedingEntryId, setSupersedingEntryId] = useState<string | null>(null);
  const [expandedCheckpoint, setExpandedCheckpoint] = useState<CheckpointDetail | null>(null);
  const [showSaveCheckpoint, setShowSaveCheckpoint] = useState(false);
  const [sessionNote, setSessionNote] = useState('');

  const writable = canWrite && !archived;

  const handleError = useCallback((caught: unknown) => {
    if (caught instanceof ApiError) {
      if (caught.isAuthFailure) { onSessionExpired(); return; }
      setError(caught.message);
    } else {
      setError('The memory request failed.');
    }
  }, [onSessionExpired]);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const query: Record<string, string> = {};
      if (filter === 'pinned') query['pinned'] = 'true';
      else if (filter === 'archived') query['archived'] = 'true';
      else if (filter === 'superseded') query['superseded'] = 'true';
      else if (filter !== 'all') query['type'] = filter;
      if (search.trim()) query['search'] = search.trim();

      const [contextResponse, entriesResponse, checkpointsResponse, roadmap] = await Promise.all([
        api.getProjectContext(projectId, signal),
        api.listMemory(projectId, query, signal),
        api.listCheckpoints(projectId, showArchivedCheckpoints, signal),
        api.getRoadmap(projectId, signal),
      ]);
      setContext(contextResponse);
      setEntries(entriesResponse.entries);
      setCheckpoints(checkpointsResponse.checkpoints);
      setRelated({
        milestones: roadmap.milestones,
        tasks: roadmap.milestones.flatMap((m) => m.tasks.map((t) => ({ id: t.id, title: t.title, milestoneId: m.id }))),
      });
      setError(null);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === 'AbortError') return;
      handleError(caught);
    }
  }, [projectId, filter, search, showArchivedCheckpoints, handleError]);

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
      return result;
    } catch (caught) {
      handleError(caught);
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  async function saveCheckpoint(): Promise<void> {
    await run(() => api.createCheckpoint(projectId, sessionNote.trim() ? { sessionNote: sessionNote.trim() } : {}));
    setSessionNote('');
    setShowSaveCheckpoint(false);
  }

  async function openCheckpoint(id: string): Promise<void> {
    try {
      const { checkpoint } = await api.getCheckpoint(projectId, id);
      setExpandedCheckpoint(checkpoint);
    } catch (caught) {
      handleError(caught);
    }
  }

  if (!context) return <p>{error ?? 'Loading memory…'}</p>;

  return (
    <section aria-labelledby="memory-heading" className="memory-view">
      <h2 id="memory-heading">Memory</h2>
      {archived && <div className="alert alert-warn" role="status">This project is archived. Memory changes are disabled.</div>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}

      <CurrentContextCard context={context} expanded={showWhereWasI} onToggle={() => setShowWhereWasI(!showWhereWasI)} />

      <article className="card">
        <div className="card-head">
          <span className="card-title">Last checkpoint</span>
          {writable && !showSaveCheckpoint && (
            <button type="button" className="primary" disabled={busy} onClick={() => setShowSaveCheckpoint(true)}>Save checkpoint</button>
          )}
        </div>
        {context.lastCheckpoint ? (
          <>
            <p className="card-detail">{formatTime(context.lastCheckpoint.createdAt)}</p>
            {context.lastCheckpoint.sessionNote && <p className="card-detail">{context.lastCheckpoint.sessionNote}</p>}
          </>
        ) : (
          <p className="hint">No checkpoint saved yet.</p>
        )}
        {writable && showSaveCheckpoint && (
          <form className="memory-form" onSubmit={(e) => { e.preventDefault(); void saveCheckpoint(); }}>
            <div className="field">
              <label htmlFor="checkpoint-note">Session note (optional)</label>
              <textarea id="checkpoint-note" rows={2} maxLength={4000} value={sessionNote} onChange={(e) => setSessionNote(e.target.value)} placeholder="What did you just finish? What's next?" />
            </div>
            <div className="roadmap-actions">
              <button type="submit" className="primary" disabled={busy}>Save current project checkpoint</button>
              <button type="button" disabled={busy} onClick={() => { setShowSaveCheckpoint(false); setSessionNote(''); }}>Cancel</button>
            </div>
          </form>
        )}
      </article>

      <PinnedMemorySection entries={context.pinnedContext} />

      <MemoryEntriesSection
        entries={entries} filter={filter} search={search} writable={writable} busy={busy} related={related}
        showAddMemory={showAddMemory} editingEntryId={editingEntryId} supersedingEntryId={supersedingEntryId}
        onFilterChange={setFilter} onSearchChange={setSearch}
        onToggleAdd={() => setShowAddMemory(!showAddMemory)}
        onCreate={(body) => run(() => api.createMemoryEntry(projectId, body)).then(() => setShowAddMemory(false))}
        onStartEdit={setEditingEntryId} onCancelEdit={() => setEditingEntryId(null)}
        onSaveEdit={(id, body) => run(() => api.updateMemoryEntry(projectId, id, {
          title: body.title, body: body.body, importance: body.importance,
          relatedTaskId: body.relatedTaskId, relatedMilestoneId: body.relatedMilestoneId,
        })).then(() => setEditingEntryId(null))}
        onPin={(id) => run(() => api.pinMemoryEntry(projectId, id))}
        onUnpin={(id) => run(() => api.unpinMemoryEntry(projectId, id))}
        onArchive={(id) => run(() => api.archiveMemoryEntry(projectId, id))}
        onReactivate={(id) => run(() => api.reactivateMemoryEntry(projectId, id))}
        onStartSupersede={setSupersedingEntryId} onCancelSupersede={() => setSupersedingEntryId(null)}
        onSupersede={(id, body) => run(() => api.supersedeMemoryEntry(projectId, id, body)).then(() => setSupersedingEntryId(null))}
      />

      <article className="card">
        <div className="card-head">
          <span className="card-title">Checkpoint history</span>
          <label className="checkpoint-filter">
            <input type="checkbox" checked={showArchivedCheckpoints} onChange={(e) => setShowArchivedCheckpoints(e.target.checked)} /> Show archived
          </label>
        </div>
        {checkpoints.length === 0 ? (
          <p className="hint">{showArchivedCheckpoints ? 'No archived checkpoints.' : 'No checkpoints saved yet.'}</p>
        ) : (
          <ul className="checkpoint-history">
            {checkpoints.map((cp) => (
              <li key={cp.id}>
                <button type="button" className="checkpoint-open" onClick={() => void openCheckpoint(cp.id)}>
                  <time dateTime={cp.createdAt}>{formatTime(cp.createdAt)}</time>
                  <span>{cp.sessionNote || <em className="hint">No session note.</em>}</span>
                  {cp.archivedAt && <span className="badge badge-unknown">Archived</span>}
                </button>
                {writable && !cp.archivedAt && (
                  <button type="button" disabled={busy} onClick={() => void run(() => api.archiveCheckpoint(projectId, cp.id))}>Archive</button>
                )}
              </li>
            ))}
          </ul>
        )}
      </article>

      {expandedCheckpoint && <CheckpointDetailDialog checkpoint={expandedCheckpoint} onClose={() => setExpandedCheckpoint(null)} />}
    </section>
  );
}

// ---------------------------------------------------------------------------

function Section({ title, empty, children }: { title: string; empty: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="context-section">
      <span className="context-section-title">{title}</span>
      {empty ? <p className="hint">Nothing here.</p> : children}
    </div>
  );
}

function CurrentContextCard({ context, expanded, onToggle }: { context: ProjectContextResponse; expanded: boolean; onToggle: () => void }): React.JSX.Element {
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-title">Current context</span>
        <button type="button" onClick={onToggle} aria-expanded={expanded}>{expanded ? 'Hide' : 'Where was I?'}</button>
      </div>
      {expanded && (
        <div className="context-grid">
          <Section title="Current focus" empty={context.currentFocus.length === 0}>
            <ul className="steps">{context.currentFocus.map((m) => <li key={m.milestoneId}><span className="step-name">{m.title}</span><span>{m.priority}</span></li>)}</ul>
          </Section>
          <Section title="In progress" empty={context.inProgressTasks.length === 0}>
            <ul className="steps">{context.inProgressTasks.map((t) => <li key={t.taskId}><span className="step-name">{t.title}</span><span>{t.milestoneTitle}</span></li>)}</ul>
          </Section>
          <Section title="Blocked" empty={context.blocked.milestones.length === 0 && context.blocked.tasks.length === 0}>
            <ul className="steps">
              {context.blocked.milestones.map((m) => <li key={m.milestoneId}><span className="step-name">{m.title}</span><span>{m.blockedReason}</span></li>)}
              {context.blocked.tasks.map((t) => <li key={t.taskId}><span className="step-name">{t.title}</span><span>{t.blockedReason}</span></li>)}
            </ul>
          </Section>
          <Section title="Next actions" empty={context.nextActions.length === 0}>
            <ol className="steps">{context.nextActions.map((t) => <li key={t.taskId}><span className="step-name">{t.title}</span><span>{t.nextAction}</span></li>)}</ol>
          </Section>
          <Section title="Pending acceptance" empty={context.pendingAcceptance.length === 0}>
            <ul className="steps">{context.pendingAcceptance.map((t) => <li key={t.taskId}><span className="step-name">{t.title}</span><span>{t.pendingCount} pending</span></li>)}</ul>
          </Section>
          <Section title="Unresolved dependencies" empty={context.unresolvedDependencies.length === 0}>
            <ul className="steps">{context.unresolvedDependencies.map((d) => <li key={`${d.taskId}-${d.dependsOnTaskId}`}><span className="step-name">{d.title}</span><span>waiting on {d.dependsOnTitle} ({d.dependsOnStatus})</span></li>)}</ul>
          </Section>
          <Section title="Pinned context" empty={context.pinnedContext.length === 0}>
            <ul className="steps">{context.pinnedContext.map((e) => <li key={e.id}><span className="step-name">[{e.type}] {e.title}</span></li>)}</ul>
          </Section>
          <Section title="Recent Agent Work" empty={context.recentAgentWork.length === 0}>
            <ul className="steps">
              {context.recentAgentWork.map((a) => (
                <li key={a.agentRunId}>
                  <span className="step-name">{a.agentName} — {a.title}</span>
                  <span>{a.status.replace(/_/g, ' ')} · {a.validationStatus.replace(/_/g, ' ')}</span>
                </li>
              ))}
            </ul>
          </Section>
          <Section title="Since your last checkpoint" empty={!context.changesSinceCheckpoint.hasCheckpoint || context.changesSinceCheckpoint.items.length === 0}>
            {!context.changesSinceCheckpoint.hasCheckpoint ? (
              <p className="hint">Save a checkpoint to start tracking changes between sessions.</p>
            ) : (
              <ul className="steps">{context.changesSinceCheckpoint.items.map((item) => <li key={item.key}><span>{item.label}</span></li>)}</ul>
            )}
          </Section>
        </div>
      )}
    </article>
  );
}

function PinnedMemorySection({ entries }: { entries: MemoryEntry[] }): React.JSX.Element {
  return (
    <article className="card">
      <span className="card-title">Pinned memory</span>
      {entries.length === 0 ? <p className="hint">Nothing pinned yet.</p> : (
        <ul className="chip-list">
          {entries.map((e) => (
            <li key={e.id} className="chip">[{e.type}] {e.title} <span className="card-meta">({e.importance})</span></li>
          ))}
        </ul>
      )}
    </article>
  );
}

function RelatedFields({
  related, taskId, milestoneId, onChange,
}: { related: RelatedOptions; taskId: string; milestoneId: string; onChange: (field: 'relatedTaskId' | 'relatedMilestoneId', value: string) => void }): React.JSX.Element {
  return (
    <div className="form-row">
      <div className="field">
        <label htmlFor="memory-related-milestone">Related milestone</label>
        <select id="memory-related-milestone" value={milestoneId} onChange={(e) => onChange('relatedMilestoneId', e.target.value)}>
          <option value="">None</option>
          {related.milestones.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="memory-related-task">Related task</label>
        <select id="memory-related-task" value={taskId} onChange={(e) => onChange('relatedTaskId', e.target.value)}>
          <option value="">None</option>
          {related.tasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
        </select>
      </div>
    </div>
  );
}

function MemoryEntryForm({
  initial, related, busy, submitLabel, onCancel, onSubmit,
}: {
  initial?: Partial<MemoryEntry>; related: RelatedOptions; busy: boolean; submitLabel: string;
  onCancel: () => void; onSubmit: (body: CreateMemoryEntryRequest) => void;
}): React.JSX.Element {
  const [type, setType] = useState<MemoryType>(initial?.type ?? 'context');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [importance, setImportance] = useState<MemoryImportance>(initial?.importance ?? 'normal');
  const [isPinned, setIsPinned] = useState(initial?.isPinned ?? false);
  const [relatedTaskId, setRelatedTaskId] = useState(initial?.relatedTaskId ?? '');
  const [relatedMilestoneId, setRelatedMilestoneId] = useState(initial?.relatedMilestoneId ?? '');

  return (
    <form className="memory-form" onSubmit={(e) => {
      e.preventDefault();
      onSubmit({
        type, title: title.trim(), body: body.trim(), importance, isPinned,
        relatedTaskId: relatedTaskId || null, relatedMilestoneId: relatedMilestoneId || null,
      });
    }}>
      <div className="form-row">
        <div className="field">
          <label htmlFor="memory-type">Type *</label>
          <select id="memory-type" value={type} disabled={Boolean(initial)} onChange={(e) => setType(e.target.value as MemoryType)}>
            {memoryTypes.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="memory-importance">Importance</label>
          <select id="memory-importance" value={importance} onChange={(e) => setImportance(e.target.value as MemoryImportance)}>
            {importances.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="memory-title">Title *</label>
        <input id="memory-title" required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="memory-body">Body *</label>
        <textarea id="memory-body" required rows={3} maxLength={10000} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <RelatedFields related={related} taskId={relatedTaskId ?? ''} milestoneId={relatedMilestoneId ?? ''} onChange={(field, value) => { if (field === 'relatedTaskId') setRelatedTaskId(value); else setRelatedMilestoneId(value); }} />
      <label className="memory-pin-toggle">
        <input type="checkbox" checked={isPinned} onChange={(e) => setIsPinned(e.target.checked)} /> Pin this entry
      </label>
      <div className="roadmap-actions">
        <button type="submit" className="primary" disabled={busy || !title.trim() || !body.trim()}>{submitLabel}</button>
        <button type="button" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function MemoryEntriesSection({
  entries, filter, search, writable, busy, related, showAddMemory, editingEntryId, supersedingEntryId,
  onFilterChange, onSearchChange, onToggleAdd, onCreate, onStartEdit, onCancelEdit, onSaveEdit,
  onPin, onUnpin, onArchive, onReactivate, onStartSupersede, onCancelSupersede, onSupersede,
}: {
  entries: MemoryEntry[]; filter: Filter; search: string; writable: boolean; busy: boolean; related: RelatedOptions;
  showAddMemory: boolean; editingEntryId: string | null; supersedingEntryId: string | null;
  onFilterChange: (f: Filter) => void; onSearchChange: (s: string) => void; onToggleAdd: () => void;
  onCreate: (body: CreateMemoryEntryRequest) => void;
  onStartEdit: (id: string) => void; onCancelEdit: () => void; onSaveEdit: (id: string, body: CreateMemoryEntryRequest) => void;
  onPin: (id: string) => void; onUnpin: (id: string) => void; onArchive: (id: string) => void; onReactivate: (id: string) => void;
  onStartSupersede: (id: string) => void; onCancelSupersede: () => void;
  onSupersede: (id: string, body: CreateMemoryEntryRequest) => void;
}): React.JSX.Element {
  return (
    <article className="card">
      <div className="card-head">
        <span className="card-title">Memory entries</span>
        {writable && <button type="button" className="primary" onClick={onToggleAdd}>+ Add memory</button>}
      </div>

      <div className="memory-toolbar">
        <label className="visually-hidden" htmlFor="memory-search">Search memories</label>
        <input id="memory-search" type="search" placeholder="Search memories…" value={search} onChange={(e) => onSearchChange(e.target.value)} />
        <div className="memory-filters" role="group" aria-label="Filter memory entries">
          {filters.map((f) => (
            <button key={f} type="button" aria-pressed={filter === f} className={filter === f ? 'chip chip-active' : 'chip'} onClick={() => onFilterChange(f)}>
              {filterLabel(f)}
            </button>
          ))}
        </div>
      </div>

      {writable && showAddMemory && (
        <MemoryEntryForm related={related} busy={busy} submitLabel="Add memory" onCancel={onToggleAdd} onSubmit={onCreate} />
      )}

      {entries.length === 0 ? (
        <p className="hint">No memory entries match this view.</p>
      ) : (
        <ul className="memory-list">
          {entries.map((entry) => (
            <li key={entry.id}>
              {editingEntryId === entry.id ? (
                <MemoryEntryForm initial={entry} related={related} busy={busy} submitLabel="Save" onCancel={onCancelEdit} onSubmit={(body) => onSaveEdit(entry.id, body)} />
              ) : supersedingEntryId === entry.id ? (
                <div className="memory-supersede">
                  <p className="hint">Superseding <strong>{entry.title}</strong> — this creates a new entry and marks the current one as superseded.</p>
                  <MemoryEntryForm related={related} busy={busy} submitLabel="Supersede" onCancel={onCancelSupersede} onSubmit={(body) => onSupersede(entry.id, body)} />
                </div>
              ) : (
                <MemoryCard
                  entry={entry} writable={writable} busy={busy}
                  onEdit={() => onStartEdit(entry.id)} onPin={() => onPin(entry.id)} onUnpin={() => onUnpin(entry.id)}
                  onArchive={() => onArchive(entry.id)} onReactivate={() => onReactivate(entry.id)} onSupersede={() => onStartSupersede(entry.id)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function MemoryCard({
  entry, writable, busy, onEdit, onPin, onUnpin, onArchive, onReactivate, onSupersede,
}: {
  entry: MemoryEntry; writable: boolean; busy: boolean; onEdit: () => void; onPin: () => void; onUnpin: () => void;
  onArchive: () => void; onReactivate: () => void; onSupersede: () => void;
}): React.JSX.Element {
  const editable = writable && entry.status === 'active';
  return (
    <article className={`card memory-card memory-importance-${entry.importance}`}>
      <div className="card-head">
        <span className="card-title">[{entry.type}] {entry.title}</span>
        <span className="memory-badges">
          {entry.isPinned && <span className="badge badge-manual">Pinned</span>}
          {entry.status === 'archived' && <span className="badge badge-unknown">Archived</span>}
          {entry.status === 'superseded' && <span className="badge badge-unknown">Superseded</span>}
          <span className="badge badge-unknown">{entry.importance}</span>
        </span>
      </div>
      <p className="card-detail memory-body">{entry.body}</p>
      {(entry.relatedMilestoneTitle || entry.relatedTaskTitle) && (
        <p className="card-meta">
          {entry.relatedMilestoneTitle && <>Milestone: {entry.relatedMilestoneTitle} </>}
          {entry.relatedTaskTitle && <>· Task: {entry.relatedTaskTitle}</>}
        </p>
      )}
      {entry.status === 'superseded' && entry.supersededByTitle && <p className="card-meta">Superseded by: {entry.supersededByTitle}</p>}
      {entry.supersedesIds.length > 0 && <p className="card-meta">Supersedes {entry.supersedesIds.length} earlier entr{entry.supersedesIds.length === 1 ? 'y' : 'ies'}</p>}
      {entry.sourceAgentRunId && <p className="card-meta">Source: Agent Run — {entry.sourceAgentRunTitle}</p>}
      <p className="card-meta">{formatTime(entry.createdAt)}</p>
      {writable && (
        <div className="roadmap-actions">
          {editable && <button type="button" disabled={busy} onClick={onEdit}>Edit</button>}
          {entry.status === 'active' && (entry.isPinned ? <button type="button" disabled={busy} onClick={onUnpin}>Unpin</button> : <button type="button" disabled={busy} onClick={onPin}>Pin</button>)}
          {entry.status === 'active' && <button type="button" disabled={busy} onClick={onSupersede}>Supersede</button>}
          {entry.status === 'active' && <button type="button" disabled={busy} onClick={onArchive}>Archive</button>}
          {entry.status === 'archived' && <button type="button" disabled={busy} onClick={onReactivate}>Reactivate</button>}
        </div>
      )}
    </article>
  );
}

function CheckpointDetailDialog({ checkpoint, onClose }: { checkpoint: CheckpointDetail; onClose: () => void }): React.JSX.Element {
  const s = checkpoint.snapshot;
  return (
    <div className="checkpoint-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="checkpoint-dialog card" role="dialog" aria-modal="true" aria-label="Checkpoint detail" onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <span className="card-title">Checkpoint — {formatTime(checkpoint.createdAt)}</span>
          <button type="button" onClick={onClose} aria-label="Close checkpoint detail">×</button>
        </div>
        {checkpoint.sessionNote && <p className="card-detail">{checkpoint.sessionNote}</p>}
        <Section title="Current focus" empty={s.currentFocus.length === 0}>
          <ul className="steps">{s.currentFocus.map((m) => <li key={m.milestoneId}>{m.title}</li>)}</ul>
        </Section>
        <Section title="In progress" empty={s.inProgressTasks.length === 0}>
          <ul className="steps">{s.inProgressTasks.map((t) => <li key={t.taskId}>{t.title}</li>)}</ul>
        </Section>
        <Section title="Blocked" empty={s.blockedMilestones.length === 0 && s.blockedTasks.length === 0}>
          <ul className="steps">
            {s.blockedMilestones.map((m) => <li key={m.milestoneId}>{m.title}: {m.blockedReason}</li>)}
            {s.blockedTasks.map((t) => <li key={t.taskId}>{t.title}: {t.blockedReason}</li>)}
          </ul>
        </Section>
        <Section title="Next actions" empty={s.nextActions.length === 0}>
          <ul className="steps">{s.nextActions.map((t) => <li key={t.taskId}>{t.title} — {t.nextAction}</li>)}</ul>
        </Section>
        <Section title="Recently completed" empty={s.recentlyCompletedTasks.length === 0}>
          <ul className="steps">{s.recentlyCompletedTasks.map((t) => <li key={t.taskId}>{t.title}</li>)}</ul>
        </Section>
        <Section title="Pinned memory" empty={s.pinnedMemory.length === 0}>
          <ul className="steps">{s.pinnedMemory.map((m) => <li key={m.id}>[{m.type}] {m.title}</li>)}</ul>
        </Section>
      </div>
    </div>
  );
}
