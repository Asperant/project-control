import { useCallback, useEffect, useState } from 'react';
import type { ListProjectsQuery, ProjectPriority, ProjectStatus, ProjectSummary } from '@project-control/contracts';
import { ApiError, api } from '../../api-client';
import { AccessibilityBadge, ProjectPriorityBadge, ProjectStatusBadge, formatRelativeTime } from './badges';

const PAGE_SIZE = 20;

export function ProjectsList({
  onOpenProject,
  onNewProject,
  onSessionExpired,
  canWrite,
}: {
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onSessionExpired: () => void;
  canWrite: boolean;
}): React.JSX.Element {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ProjectStatus | ''>('');
  const [priority, setPriority] = useState<ProjectPriority | ''>('');
  const [technology, setTechnology] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);
  const [sort, setSort] = useState<ListProjectsQuery['sort']>('updatedAt');
  const [order, setOrder] = useState<ListProjectsQuery['order']>('desc');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      try {
        const response = await api.listProjects(
          {
            page,
            pageSize: PAGE_SIZE,
            search: search || undefined,
            status: status || undefined,
            priority: priority || undefined,
            technology: technology || undefined,
            includeArchived,
            sort,
            order,
          },
          signal,
        );
        setProjects(response.projects);
        setTotal(response.total);
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
          setError('Unable to load projects.');
        }
      } finally {
        setLoading(false);
      }
    },
    [page, search, status, priority, technology, includeArchived, sort, order, onSessionExpired],
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  // Any filter change resets to page 1 — otherwise a narrower result set can
  // leave the view on a now-nonexistent page.
  const withFilterReset = <T,>(setter: (value: T) => void) => (value: T) => {
    setPage(1);
    setter(value);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <section aria-labelledby="projects-heading">
      <div className="projects-toolbar">
        <h2 id="projects-heading" style={{ margin: 0 }}>
          Projects
        </h2>
        <div className="spacer" />
        {canWrite && (
          <button type="button" className="primary" onClick={onNewProject}>
            New project
          </button>
        )}
      </div>

      <div className="filter-bar" role="search">
        <input
          type="search"
          placeholder="Search name, description, purpose…"
          aria-label="Search projects"
          value={search}
          onChange={(e) => withFilterReset(setSearch)(e.target.value)}
        />
        <select aria-label="Filter by status" value={status} onChange={(e) => withFilterReset(setStatus)(e.target.value as ProjectStatus | '')}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="paused">Paused</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <select
          aria-label="Filter by priority"
          value={priority}
          onChange={(e) => withFilterReset(setPriority)(e.target.value as ProjectPriority | '')}
        >
          <option value="">All priorities</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
          <option value="critical">Critical</option>
        </select>
        <input
          type="text"
          placeholder="Technology (exact name)"
          aria-label="Filter by technology"
          value={technology}
          onChange={(e) => withFilterReset(setTechnology)(e.target.value)}
        />
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => withFilterReset(setIncludeArchived)(e.target.checked)}
          />
          Include archived
        </label>
        <select aria-label="Sort by" value={sort} onChange={(e) => setSort(e.target.value as ListProjectsQuery['sort'])}>
          <option value="updatedAt">Last updated</option>
          <option value="createdAt">Created</option>
          <option value="lastInspectedAt">Last inspected</option>
          <option value="name">Name</option>
          <option value="priority">Priority</option>
          <option value="status">Status</option>
        </select>
        <button type="button" onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')} title="Toggle sort order">
          {order === 'asc' ? '↑ Asc' : '↓ Desc'}
        </button>
      </div>

      {error && (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      )}

      {loading && !projects && <p>Loading projects…</p>}

      {projects && projects.length === 0 && !loading && (
        <p className="hint">No projects match these filters yet.</p>
      )}

      {projects && projects.length > 0 && (
        <>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Technologies</th>
                  <th>Branch</th>
                  <th>Working tree</th>
                  <th>Last commit</th>
                  <th>Last inspected</th>
                  <th>Folder</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr
                    key={project.id}
                    className="data-table-row"
                    tabIndex={0}
                    onClick={() => onOpenProject(project.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onOpenProject(project.id);
                    }}
                  >
                    <td>
                      <strong>{project.name}</strong>
                      {project.shortCode && <span className="card-meta"> · {project.shortCode}</span>}
                    </td>
                    <td>
                      <ProjectStatusBadge status={project.status} />
                    </td>
                    <td>
                      <ProjectPriorityBadge priority={project.priority} />
                    </td>
                    <td>
                      {project.technologies.length === 0
                        ? '—'
                        : project.technologies
                            .slice(0, 3)
                            .map((t) => t.name)
                            .join(', ') + (project.technologies.length > 3 ? `, +${project.technologies.length - 3}` : '')}
                    </td>
                    <td>{project.repository.present ? project.repository.activeBranch || '(detached)' : '—'}</td>
                    <td>
                      {project.repository.present
                        ? project.repository.isDirty
                          ? `dirty (${project.repository.modifiedCount ?? 0}+${project.repository.untrackedCount ?? 0})`
                          : 'clean'
                        : '—'}
                    </td>
                    <td>{project.repository.lastCommitShortHash ?? '—'}</td>
                    <td>{formatRelativeTime(project.lastInspectedAt)}</td>
                    <td>
                      <AccessibilityBadge accessible={project.location.accessible} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <button type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              ← Previous
            </button>
            <span className="hint">
              Page {page} of {totalPages} · {total} project{total === 1 ? '' : 's'}
            </span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              Next →
            </button>
          </div>
        </>
      )}
    </section>
  );
}
