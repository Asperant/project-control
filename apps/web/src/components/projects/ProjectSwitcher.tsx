import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ProjectSummary } from '@project-control/contracts';
import { api } from '../../api-client';
import { rememberRecentProject, readRecentProjects } from './recentProjects';

/**
 * Header dropdown for jumping straight to another project — a "recent"
 * section (client-side only, see recentProjects.ts) plus a live filter over
 * every project, so switching projects never requires a trip back through
 * the projects list screen.
 */
export function ProjectSwitcher(): React.JSX.Element {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [results, setResults] = useState<ProjectSummary[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const recent = readRecentProjects();

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.listProjects({ search: filter || undefined, pageSize: 20 }, controller.signal)
        .then((response) => setResults(response.projects))
        .catch(() => setResults([]));
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, filter]);

  useEffect(() => {
    function onOutsideClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, []);

  function go(project: { id: string; name: string }): void {
    rememberRecentProject(project.id, project.name);
    setOpen(false);
    setFilter('');
    navigate(`/projects/${project.id}`);
  }

  return (
    <div className="project-switcher" ref={containerRef}>
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-haspopup="listbox">
        Switch project ▾
      </button>

      {open && (
        <div className="project-switcher-menu" role="listbox">
          <input
            type="search"
            placeholder="Filter projects…"
            aria-label="Filter projects"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            autoFocus
          />

          {!filter && recent.length > 0 && (
            <>
              <div className="menu-heading">Recent</div>
              {recent.map((project) => (
                <button key={project.id} type="button" role="option" aria-selected={false} onClick={() => go(project)}>
                  {project.name}
                </button>
              ))}
            </>
          )}

          <div className="menu-heading">{filter ? 'Matching' : 'All projects'}</div>
          {results.length === 0 && <span className="global-search-status">No projects found.</span>}
          {results.map((project) => (
            <button key={project.id} type="button" role="option" aria-selected={false} onClick={() => go(project)}>
              {project.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
