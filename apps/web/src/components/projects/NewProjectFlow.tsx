import { useState } from 'react';
import type {
  CommandType,
  DetectionSource,
  ProjectCommandInput,
  ProjectInspectionResponse,
  ProjectPriority,
  ProjectRuleInput,
  ProjectTechnologyInput,
  RuleCategory,
  TechnologyCategory,
} from '@project-control/contracts';
import { ApiError, api } from '../../api-client';

/**
 * Register a project screen: type a folder path → inspect (server-side,
 * read-only) → review and edit the detected preview → save.
 *
 * Nothing is persisted until the operator explicitly saves; the inspection id
 * returned by `api.inspectProject` is single-use and expires server-side.
 */
export function NewProjectFlow({
  onCreated,
  onCancel,
  onSessionExpired,
}: {
  onCreated: (projectId: string) => void;
  onCancel: () => void;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const [path, setPath] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspection, setInspection] = useState<ProjectInspectionResponse | null>(null);

  const [name, setName] = useState('');
  const [shortCode, setShortCode] = useState('');
  const [description, setDescription] = useState('');
  const [purpose, setPurpose] = useState('');
  const [productGoal, setProductGoal] = useState('');
  const [status, setStatus] = useState<'active' | 'paused' | 'completed'>('active');
  const [priority, setPriority] = useState<ProjectPriority>('medium');
  const [tags, setTags] = useState('');
  const [technologies, setTechnologies] = useState<Array<ProjectTechnologyInput & { key: string }>>([]);
  const [rules, setRules] = useState<Array<ProjectRuleInput & { key: string }>>([]);
  const [commands, setCommands] = useState<Array<ProjectCommandInput & { key: string }>>([]);

  const [newTechName, setNewTechName] = useState('');
  const [newTechCategory, setNewTechCategory] = useState<TechnologyCategory>('other');
  const [newRuleCategory, setNewRuleCategory] = useState<RuleCategory>('scope');
  const [newRuleText, setNewRuleText] = useState('');
  const [newCommandType, setNewCommandType] = useState<CommandType>('custom');
  const [newCommandText, setNewCommandText] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  async function handleInspect(): Promise<void> {
    setInspecting(true);
    setInspectError(null);
    try {
      const result = await api.inspectProject({ path });
      setInspection(result);
      setName(suggestName(result.location.canonicalPath));
      setTechnologies(
        result.technologies.map((t, i) => ({
          key: `d-${i}`,
          name: t.name,
          category: t.category,
          version: t.version,
          evidencePath: t.evidencePath,
          detectionSource: 'manifest' as DetectionSource,
        })),
      );
      setCommands(
        result.commands.map((c, i) => ({
          key: `d-${i}`,
          type: c.type,
          displayName: c.displayName,
          commandText: c.commandText,
          workingDirectory: c.workingDirectory,
          evidencePath: c.evidencePath,
          detectionSource: 'manifest' as DetectionSource,
        })),
      );
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) {
          onSessionExpired();
          return;
        }
        setInspectError(caught.message);
      } else {
        setInspectError('The folder could not be inspected.');
      }
    } finally {
      setInspecting(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (!inspection) return;
    setSaving(true);
    setSaveError(null);
    try {
      const created = await api.createProject({
        inspectionId: inspection.inspectionId,
        name: name.trim(),
        shortCode: shortCode.trim() ? shortCode.trim() : undefined,
        description: description || undefined,
        purpose: purpose || undefined,
        productGoal: productGoal || undefined,
        status,
        priority,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        technologies: technologies.map(({ key: _key, ...rest }) => rest),
        rules: rules.map(({ key: _key, ...rest }) => rest),
        commands: commands.map(({ key: _key, ...rest }) => rest),
      });
      onCreated(created.project.id);
    } catch (caught) {
      if (caught instanceof ApiError) {
        if (caught.isAuthFailure) {
          onSessionExpired();
          return;
        }
        setSaveError(caught.message);
      } else {
        setSaveError('The project could not be saved.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (!inspection) {
    return (
      <section aria-labelledby="new-project-heading">
        <h2 id="new-project-heading">New project</h2>
        <article className="card" style={{ maxWidth: '40rem' }}>
          <div className="field">
            <label htmlFor="project-path">Project folder path</label>
            <input
              id="project-path"
              type="text"
              placeholder="/home/asrin/Desktop/workspace/my-project"
              value={path}
              disabled={inspecting}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && path.trim() && !inspecting) void handleInspect();
              }}
            />
          </div>
          <p className="hint">
            Enter the full path to a folder that already exists on the Ubuntu host. It must be inside a
            configured allowed root — the panel never browses the filesystem for you.
          </p>
          {inspectError && (
            <div className="alert alert-error" role="alert">
              {inspectError}
            </div>
          )}
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button type="button" className="primary" disabled={!path.trim() || inspecting} onClick={() => void handleInspect()}>
              {inspecting ? 'Inspecting…' : 'Inspect'}
            </button>
            <button type="button" onClick={onCancel} disabled={inspecting}>
              Cancel
            </button>
          </div>
        </article>
      </section>
    );
  }

  return (
    <section aria-labelledby="inspection-heading">
      <h2 id="inspection-heading">Review before saving</h2>

      <article className="card">
        <span className="card-title">Location</span>
        <p className="card-detail">
          Typed: <code>{inspection.location.inputPath}</code>
        </p>
        <p className="card-detail">
          Canonical: <code>{inspection.location.canonicalPath}</code>
        </p>
        <p className="card-meta">Allowed root: {inspection.location.allowedRoot}</p>
        {inspection.warnings.length > 0 && (
          <div className="alert alert-warn" role="status">
            {inspection.warnings.join(' ')}
          </div>
        )}
        {inspection.limitsHit.length > 0 && (
          <p className="hint">Scan limits reached: {inspection.limitsHit.join(', ')}</p>
        )}
      </article>

      {inspection.repository.present && (
        <article className="card">
          <span className="card-title">Repository</span>
          <p className="card-detail">
            Branch: {inspection.repository.activeBranch ?? '(detached HEAD)'} · Default:{' '}
            {inspection.repository.defaultBranch ?? 'unknown'} ({inspection.repository.defaultBranchConfidence})
          </p>
          <p className="card-detail">
            Last commit: {inspection.repository.lastCommitShortHash} — {inspection.repository.lastCommitSubject}
          </p>
          <p className="card-meta">
            {inspection.repository.isDirty
              ? `Dirty: ${inspection.repository.modifiedCount} modified, ${inspection.repository.untrackedCount} untracked`
              : 'Working tree clean'}
          </p>
          {inspection.repository.remotes.length > 0 && (
            <p className="card-meta">Remotes: {inspection.repository.remotes.map((r) => `${r.name} → ${r.url}`).join('; ')}</p>
          )}
        </article>
      )}

      <article className="card">
        <span className="card-title">Project details</span>
        <div className="field">
          <label htmlFor="np-name">Name</label>
          <input id="np-name" type="text" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="np-shortcode">Short code (optional)</label>
          <input id="np-shortcode" type="text" placeholder="my-project" value={shortCode} onChange={(e) => setShortCode(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="np-description">Description</label>
          <textarea id="np-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={2} />
        </div>
        <div className="field">
          <label htmlFor="np-purpose">Purpose</label>
          <textarea id="np-purpose" value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} />
        </div>
        <div className="field">
          <label htmlFor="np-goal">Product goal</label>
          <textarea id="np-goal" value={productGoal} onChange={(e) => setProductGoal(e.target.value)} rows={2} />
        </div>
        <div className="form-row">
          <div className="field">
            <label htmlFor="np-status">Status</label>
            <select
              id="np-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as 'active' | 'paused' | 'completed')}
            >
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="completed">Completed</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="np-priority">Priority</label>
            <select id="np-priority" value={priority} onChange={(e) => setPriority(e.target.value as ProjectPriority)}>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="critical">Critical</option>
            </select>
          </div>
        </div>
        <div className="field">
          <label htmlFor="np-tags">Tags (comma separated)</label>
          <input id="np-tags" type="text" value={tags} onChange={(e) => setTags(e.target.value)} />
        </div>
      </article>

      <article className="card">
        <span className="card-title">Technologies</span>
        <ul className="chip-list">
          {technologies.map((t) => (
            <li key={t.key} className="chip">
              {t.name} <span className="card-meta">({t.category})</span>
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${t.name}`}
                onClick={() => setTechnologies((cur) => cur.filter((x) => x.key !== t.key))}
              >
                ×
              </button>
            </li>
          ))}
          {technologies.length === 0 && <li className="hint">None detected or added yet.</li>}
        </ul>
        <div className="form-row">
          <input type="text" placeholder="Technology name" value={newTechName} onChange={(e) => setNewTechName(e.target.value)} />
          <select value={newTechCategory} onChange={(e) => setNewTechCategory(e.target.value as TechnologyCategory)}>
            {TECHNOLOGY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!newTechName.trim()}
            onClick={() => {
              setTechnologies((cur) => [
                ...cur,
                { key: `u-${Date.now()}`, name: newTechName.trim(), category: newTechCategory, detectionSource: 'user' },
              ]);
              setNewTechName('');
            }}
          >
            Add
          </button>
        </div>
      </article>

      <article className="card">
        <span className="card-title">Commands (metadata only — never executed by this platform)</span>
        <ul className="chip-list">
          {commands.map((c) => (
            <li key={c.key} className="chip">
              {c.type}: {c.commandText}
              <button
                type="button"
                className="chip-remove"
                aria-label={`Remove ${c.commandText}`}
                onClick={() => setCommands((cur) => cur.filter((x) => x.key !== c.key))}
              >
                ×
              </button>
            </li>
          ))}
          {commands.length === 0 && <li className="hint">None detected or added yet.</li>}
        </ul>
        <div className="form-row">
          <select value={newCommandType} onChange={(e) => setNewCommandType(e.target.value as CommandType)}>
            {COMMAND_TYPES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input type="text" placeholder="e.g. pnpm test" value={newCommandText} onChange={(e) => setNewCommandText(e.target.value)} />
          <button
            type="button"
            disabled={!newCommandText.trim()}
            onClick={() => {
              setCommands((cur) => [
                ...cur,
                {
                  key: `u-${Date.now()}`,
                  type: newCommandType,
                  displayName: newCommandType,
                  commandText: newCommandText.trim(),
                  workingDirectory: '.',
                  detectionSource: 'user',
                },
              ]);
              setNewCommandText('');
            }}
          >
            Add
          </button>
        </div>
      </article>

      <article className="card">
        <span className="card-title">Project rules</span>
        <ul className="chip-list">
          {rules.map((r) => (
            <li key={r.key} className="chip">
              [{r.category}] {r.text}
              <button
                type="button"
                className="chip-remove"
                aria-label="Remove rule"
                onClick={() => setRules((cur) => cur.filter((x) => x.key !== r.key))}
              >
                ×
              </button>
            </li>
          ))}
          {rules.length === 0 && <li className="hint">No rules added yet — you can add more later from the project page.</li>}
        </ul>
        <div className="form-row">
          <select value={newRuleCategory} onChange={(e) => setNewRuleCategory(e.target.value as RuleCategory)}>
            {RULE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <input type="text" placeholder="Rule text" value={newRuleText} onChange={(e) => setNewRuleText(e.target.value)} />
          <button
            type="button"
            disabled={!newRuleText.trim()}
            onClick={() => {
              setRules((cur) => [...cur, { key: `u-${Date.now()}`, category: newRuleCategory, text: newRuleText.trim() }]);
              setNewRuleText('');
            }}
          >
            Add
          </button>
        </div>
      </article>

      {saveError && (
        <div className="alert alert-error" role="alert">
          {saveError}
        </div>
      )}

      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
        <button type="button" className="primary" disabled={!name.trim() || saving} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : 'Save project'}
        </button>
        <button type="button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function suggestName(canonicalPath: string): string {
  const parts = canonicalPath.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

const TECHNOLOGY_CATEGORIES: TechnologyCategory[] = [
  'language',
  'framework',
  'package_manager',
  'build_tool',
  'test_tool',
  'container',
  'database',
  'monorepo',
  'other',
];

const RULE_CATEGORIES: RuleCategory[] = [
  'architecture',
  'technology',
  'security',
  'testing',
  'workflow',
  'scope',
  'out_of_scope',
  'approval_required',
];

const COMMAND_TYPES: CommandType[] = ['test', 'lint', 'build', 'typecheck', 'validate', 'custom'];
