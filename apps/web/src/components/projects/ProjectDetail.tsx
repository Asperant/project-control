import { useCallback, useEffect, useState } from 'react';
import type {
  CommandType,
  ProjectActivityEntry,
  ProjectDetail as ProjectDetailType,
  ProjectPriority,
  RuleCategory,
  TechnologyCategory,
} from '@project-control/contracts';
import { ApiError, api } from '../../api-client';
import { AccessibilityBadge, ProjectPriorityBadge, ProjectStatusBadge, formatRelativeTime } from './badges';
import { RoadmapView } from '../roadmap/RoadmapView';
import { MemoryView } from '../memory/MemoryView';
import { AgentRunsView } from '../agent-runs/AgentRunsView';
import { ResumeView } from '../resume/ResumeView';
import { DevelopmentView } from '../development/DevelopmentView';

export function ProjectDetail({
  projectId,
  canWrite,
  onBack,
  onRescan,
  onSessionExpired,
}: {
  projectId: string;
  canWrite: boolean;
  onBack: () => void;
  onRescan: (projectId: string) => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [project, setProject] = useState<ProjectDetailType | null>(null);
  const [activity, setActivity] = useState<ProjectActivityEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'overview' | 'resume' | 'development' | 'roadmap' | 'memory' | 'agent-runs'>('overview');
  const [memoryCheckpointId, setMemoryCheckpointId] = useState<string | null>(null);

  const [editingInfo, setEditingInfo] = useState(false);
  const [form, setForm] = useState<{
    name: string;
    description: string;
    purpose: string;
    productGoal: string;
    priority: ProjectPriority;
    status: 'active' | 'paused' | 'completed';
    tags: string;
  } | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const [detail, activityResponse] = await Promise.all([
          api.getProject(projectId, signal),
          api.getProjectActivity(projectId),
        ]);
        setProject(detail.project);
        setActivity(activityResponse.entries);
        setError(null);
      } catch (caught) {
        if (caught instanceof DOMException && caught.name === 'AbortError') return;
        if (caught instanceof ApiError) {
          if (caught.isAuthFailure) {
            onSessionExpired();
            return;
          }
          setError(caught.message);
        } else {
          setError('Unable to load the project.');
        }
      }
    },
    [projectId, onSessionExpired],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  function beginEdit(): void {
    if (!project) return;
    setForm({
      name: project.name,
      description: project.description,
      purpose: project.purpose,
      productGoal: project.productGoal,
      priority: project.priority,
      status: project.status === 'archived' ? 'active' : project.status,
      tags: project.tags.join(', '),
    });
    setEditingInfo(true);
  }

  async function saveEdit(): Promise<void> {
    if (!form) return;
    setBusy(true);
    try {
      await api.updateProject(projectId, {
        name: form.name,
        description: form.description,
        purpose: form.purpose,
        productGoal: form.productGoal,
        priority: form.priority,
        status: form.status,
        tags: form.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      setEditingInfo(false);
      await load();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  function handleError(caught: unknown): void {
    if (caught instanceof ApiError) {
      if (caught.isAuthFailure) {
        onSessionExpired();
        return;
      }
      setError(caught.message);
    } else {
      setError('The request failed.');
    }
  }

  async function handleArchive(): Promise<void> {
    setBusy(true);
    try {
      await api.archiveProject(projectId);
      await load();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function handleReactivate(): Promise<void> {
    setBusy(true);
    try {
      await api.reactivateProject(projectId);
      await load();
    } catch (caught) {
      handleError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function handleRescan(): Promise<void> {
    onRescan(projectId);
  }

  if (error && !project) {
    return (
      <section>
        <div className="alert alert-error" role="alert">
          {error}
        </div>
        <button type="button" onClick={onBack}>
          ← Back to projects
        </button>
      </section>
    );
  }

  if (!project) return <p>Loading project…</p>;

  return (
    <section aria-labelledby="detail-heading">
      <div className="projects-toolbar">
        <button type="button" onClick={onBack}>
          ← Back
        </button>
        <h2 id="detail-heading" style={{ margin: 0 }}>
          {project.name}
        </h2>
        <ProjectStatusBadge status={project.status} />
        <ProjectPriorityBadge priority={project.priority} />
        <div className="spacer" />
        {canWrite && project.status !== 'archived' && (
          <>
            <button type="button" onClick={() => void handleRescan()} disabled={busy}>
              Rescan
            </button>
            <button type="button" onClick={() => void handleArchive()} disabled={busy}>
              Archive
            </button>
          </>
        )}
        {canWrite && project.status === 'archived' && (
          <button type="button" className="primary" onClick={() => void handleReactivate()} disabled={busy}>
            Reactivate
          </button>
        )}
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}
      {project.status === 'archived' && (
        <div className="alert alert-warn" role="status">
          This project is archived. Reactivate it to make changes.
        </div>
      )}

      <nav className="detail-tabs" aria-label="Project detail sections">
        <button type="button" aria-current={view === 'overview' ? 'page' : undefined} onClick={() => setView('overview')}>Overview</button>
        <button type="button" aria-current={view === 'resume' ? 'page' : undefined} onClick={() => setView('resume')}>Resume</button>
        <button type="button" aria-current={view === 'development' ? 'page' : undefined} onClick={() => setView('development')}>Development</button>
        <button type="button" aria-current={view === 'roadmap' ? 'page' : undefined} onClick={() => setView('roadmap')}>Roadmap</button>
        <button type="button" aria-current={view === 'memory' ? 'page' : undefined} onClick={() => { setMemoryCheckpointId(null); setView('memory'); }}>Memory</button>
        <button type="button" aria-current={view === 'agent-runs' ? 'page' : undefined} onClick={() => setView('agent-runs')}>Agent Runs</button>
      </nav>

      {view === 'resume' ? (
        <ResumeView projectId={projectId} canWrite={canWrite} archived={project.status === 'archived'} onSessionExpired={onSessionExpired} onOpenMemory={(checkpointId) => { setMemoryCheckpointId(checkpointId ?? null); setView('memory'); }} />
      ) : view === 'development' ? (
        <DevelopmentView projectId={projectId} archived={project.status === 'archived'} onSessionExpired={onSessionExpired} />
      ) : view === 'roadmap' ? (
        <RoadmapView projectId={projectId} canWrite={canWrite} archived={project.status === 'archived'} onSessionExpired={onSessionExpired} />
      ) : view === 'memory' ? (
        <MemoryView projectId={projectId} canWrite={canWrite} archived={project.status === 'archived'} onSessionExpired={onSessionExpired} checkpointToOpen={memoryCheckpointId} />
      ) : view === 'agent-runs' ? (
        <AgentRunsView projectId={projectId} canWrite={canWrite} archived={project.status === 'archived'} onSessionExpired={onSessionExpired} />
      ) : <>

      <article className="card">
        <div className="card-head">
          <span className="card-title">General information</span>
          {canWrite && project.status !== 'archived' && !editingInfo && (
            <button type="button" onClick={beginEdit}>
              Edit
            </button>
          )}
        </div>

        {editingInfo && form ? (
          <div>
            <div className="field">
              <label htmlFor="edit-name">Name</label>
              <input id="edit-name" type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="edit-description">Description</label>
              <textarea
                id="edit-description"
                rows={2}
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="edit-purpose">Purpose</label>
              <textarea id="edit-purpose" rows={2} value={form.purpose} onChange={(e) => setForm({ ...form, purpose: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="edit-goal">Product goal</label>
              <textarea
                id="edit-goal"
                rows={2}
                value={form.productGoal}
                onChange={(e) => setForm({ ...form, productGoal: e.target.value })}
              />
            </div>
            <div className="form-row">
              <div className="field">
                <label htmlFor="edit-status">Status</label>
                <select
                  id="edit-status"
                  value={form.status}
                  onChange={(e) => setForm({ ...form, status: e.target.value as 'active' | 'paused' | 'completed' })}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="completed">Completed</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="edit-priority">Priority</label>
                <select
                  id="edit-priority"
                  value={form.priority}
                  onChange={(e) => setForm({ ...form, priority: e.target.value as ProjectPriority })}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="critical">Critical</option>
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="edit-tags">Tags (comma separated)</label>
              <input id="edit-tags" type="text" value={form.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" className="primary" disabled={busy} onClick={() => void saveEdit()}>
                Save
              </button>
              <button type="button" disabled={busy} onClick={() => setEditingInfo(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="card-detail">{project.description || <em>No description.</em>}</p>
            {project.purpose && <p className="card-detail">Purpose: {project.purpose}</p>}
            {project.productGoal && <p className="card-detail">Goal: {project.productGoal}</p>}
            {project.tags.length > 0 && <p className="card-meta">Tags: {project.tags.join(', ')}</p>}
          </>
        )}
      </article>

      <article className="card">
        <span className="card-title">Local folder</span>
        <p className="card-detail">
          <code>{project.location.canonicalPath}</code>
        </p>
        <p className="card-meta">
          Allowed root: {project.location.allowedRoot} · <AccessibilityBadge accessible={project.location.accessible} /> · checked{' '}
          {formatRelativeTime(project.location.checkedAt)}
        </p>
      </article>

      <article className="card">
        <span className="card-title">Repository</span>
        {project.repository.present ? (
          <>
            <p className="card-detail">
              Branch: {project.repository.activeBranch ?? '(detached)'} · Default: {project.repository.defaultBranch ?? 'unknown'} (
              {project.repository.defaultBranchConfidence})
            </p>
            <p className="card-detail">
              Last commit: {project.repository.lastCommitShortHash} — {project.repository.lastCommitSubject}
            </p>
            <p className="card-meta">
              {project.repository.isDirty
                ? `Dirty: ${project.repository.modifiedCount} modified, ${project.repository.untrackedCount} untracked`
                : 'Working tree clean'}{' '}
              · scanned {formatRelativeTime(project.repository.scannedAt)}
            </p>
            {project.repository.remotes.length > 0 && (
              <p className="card-meta">Remotes: {project.repository.remotes.map((r) => `${r.name} → ${r.url}`).join('; ')}</p>
            )}
          </>
        ) : (
          <p className="card-detail hint">This folder is not a git repository.</p>
        )}
      </article>

      <TechnologiesSection project={project} canWrite={canWrite} onChanged={load} onError={handleError} />
      <RulesSection project={project} canWrite={canWrite} onChanged={load} onError={handleError} />
      <CommandsSection project={project} canWrite={canWrite} onChanged={load} onError={handleError} />

      <article className="card">
        <span className="card-title">Recent activity</span>
        {activity.length === 0 && <p className="hint">No activity recorded yet.</p>}
        <ul className="steps">
          {activity.map((entry) => (
            <li key={entry.id}>
              <span className="step-name">{entry.eventType}</span>
              <span>{entry.outcome}</span>
              <span className="step-time">{formatRelativeTime(entry.occurredAt)}</span>
            </li>
          ))}
        </ul>
      </article>
      </>}
    </section>
  );
}

// ---------------------------------------------------------------------------

function TechnologiesSection({
  project,
  canWrite,
  onChanged,
  onError,
}: {
  project: ProjectDetailType;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [category, setCategory] = useState<TechnologyCategory>('other');
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    setBusy(true);
    try {
      await api.addProjectTechnology(project.id, { name: name.trim(), category });
      setName('');
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(technologyId: string): Promise<void> {
    setBusy(true);
    try {
      await api.deleteProjectTechnology(project.id, technologyId);
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card">
      <span className="card-title">Technical profile</span>
      <ul className="chip-list">
        {project.technologies.map((t) => (
          <li key={t.id} className="chip">
            {t.name} <span className="card-meta">({t.category}{t.version ? ` ${t.version}` : ''})</span>
            {t.detectionSource === 'user' ? ' · manual' : ' · detected'}
            {canWrite && t.isUserDefined && (
              <button type="button" className="chip-remove" aria-label={`Remove ${t.name}`} disabled={busy} onClick={() => void remove(t.id)}>
                ×
              </button>
            )}
          </li>
        ))}
        {project.technologies.length === 0 && <li className="hint">No technologies recorded.</li>}
      </ul>
      {canWrite && project.status !== 'archived' && (
        <div className="form-row">
          <input type="text" placeholder="Technology name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={category} onChange={(e) => setCategory(e.target.value as TechnologyCategory)}>
            {(['language', 'framework', 'package_manager', 'build_tool', 'test_tool', 'container', 'database', 'monorepo', 'other'] as const).map(
              (c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ),
            )}
          </select>
          <button type="button" disabled={!name.trim() || busy} onClick={() => void add()}>
            Add
          </button>
        </div>
      )}
    </article>
  );
}

function RulesSection({
  project,
  canWrite,
  onChanged,
  onError,
}: {
  project: ProjectDetailType;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}): React.JSX.Element {
  const [category, setCategory] = useState<RuleCategory>('scope');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    setBusy(true);
    try {
      await api.addProjectRule(project.id, { category, text: text.trim() });
      setText('');
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(ruleId: string, enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await api.updateProjectRule(project.id, ruleId, { enabled });
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(ruleId: string): Promise<void> {
    setBusy(true);
    try {
      await api.deleteProjectRule(project.id, ruleId);
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card">
      <span className="card-title">Project rules</span>
      <ul className="steps">
        {project.rules.map((rule) => (
          <li key={rule.id}>
            <span className="step-name">[{rule.category}]</span>
            <span style={{ opacity: rule.enabled ? 1 : 0.5 }}>{rule.text}</span>
            {canWrite && project.status !== 'archived' && (
              <span className="spacer-inline">
                <button type="button" disabled={busy} onClick={() => void toggle(rule.id, !rule.enabled)}>
                  {rule.enabled ? 'Disable' : 'Enable'}
                </button>
                <button type="button" disabled={busy} onClick={() => void remove(rule.id)}>
                  Delete
                </button>
              </span>
            )}
          </li>
        ))}
        {project.rules.length === 0 && <li className="hint">No rules yet.</li>}
      </ul>
      {canWrite && project.status !== 'archived' && (
        <div className="form-row">
          <select value={category} onChange={(e) => setCategory(e.target.value as RuleCategory)}>
            {(
              ['architecture', 'technology', 'security', 'testing', 'workflow', 'scope', 'out_of_scope', 'approval_required'] as const
            ).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input type="text" placeholder="Rule text" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="button" disabled={!text.trim() || busy} onClick={() => void add()}>
            Add
          </button>
        </div>
      )}
    </article>
  );
}

function CommandsSection({
  project,
  canWrite,
  onChanged,
  onError,
}: {
  project: ProjectDetailType;
  canWrite: boolean;
  onChanged: () => Promise<void>;
  onError: (e: unknown) => void;
}): React.JSX.Element {
  const [type, setType] = useState<CommandType>('custom');
  const [commandText, setCommandText] = useState('');
  const [busy, setBusy] = useState(false);

  async function add(): Promise<void> {
    setBusy(true);
    try {
      await api.addProjectCommand(project.id, { type, displayName: type, commandText: commandText.trim() });
      setCommandText('');
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function toggle(commandId: string, enabled: boolean): Promise<void> {
    setBusy(true);
    try {
      await api.updateProjectCommand(project.id, commandId, { enabled });
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function remove(commandId: string): Promise<void> {
    setBusy(true);
    try {
      await api.deleteProjectCommand(project.id, commandId);
      await onChanged();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="card">
      <span className="card-title">Command metadata</span>
      <p className="hint">Recorded for reference only — this platform never executes a project command.</p>
      <ul className="steps">
        {project.commands.map((cmd) => (
          <li key={cmd.id}>
            <span className="step-name">{cmd.type}</span>
            <span style={{ opacity: cmd.enabled ? 1 : 0.5 }}>
              <code>{cmd.commandText}</code> in {cmd.workingDirectory}
            </span>
            {cmd.detectionSource === 'user' ? ' · manual' : ' · detected'}
            {canWrite && project.status !== 'archived' && (
              <span className="spacer-inline">
                <button type="button" disabled={busy} onClick={() => void toggle(cmd.id, !cmd.enabled)}>
                  {cmd.enabled ? 'Disable' : 'Enable'}
                </button>
                {cmd.isUserDefined && (
                  <button type="button" disabled={busy} onClick={() => void remove(cmd.id)}>
                    Delete
                  </button>
                )}
              </span>
            )}
          </li>
        ))}
        {project.commands.length === 0 && <li className="hint">No commands recorded.</li>}
      </ul>
      {canWrite && project.status !== 'archived' && (
        <div className="form-row">
          <select value={type} onChange={(e) => setType(e.target.value as CommandType)}>
            {(['test', 'lint', 'build', 'typecheck', 'validate', 'custom'] as const).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input type="text" placeholder="e.g. pnpm test" value={commandText} onChange={(e) => setCommandText(e.target.value)} />
          <button type="button" disabled={!commandText.trim() || busy} onClick={() => void add()}>
            Add
          </button>
        </div>
      )}
    </article>
  );
}
