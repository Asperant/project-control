const STORAGE_KEY = 'pc.recentProjects';
const MAX_RECENT = 5;

type RecentProject = { id: string; name: string };

/**
 * Per-browser "recently viewed projects", nothing more — see the roadmap's
 * own explicit caution against hidden tracking. Lives only in this browser's
 * localStorage: never sent to the server, never shared across devices or
 * users, and easy for a person to reason about (it is exactly the list of
 * projects this browser has opened, most recent first).
 */
export function readRecentProjects(): RecentProject[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentProject =>
        typeof entry === 'object' && entry !== null
        && typeof (entry as RecentProject).id === 'string'
        && typeof (entry as RecentProject).name === 'string',
    );
  } catch {
    return [];
  }
}

export function rememberRecentProject(id: string, name: string): void {
  try {
    const current = readRecentProjects().filter((entry) => entry.id !== id);
    const next = [{ id, name }, ...current].slice(0, MAX_RECENT);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Private browsing / storage disabled: the switcher just shows no recents.
  }
}
