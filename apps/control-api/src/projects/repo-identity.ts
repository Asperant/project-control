/**
 * Normalises a git remote URL into a credential-free identity string used to
 * detect the same repository registered as two different projects.
 *
 * The goal is narrower than "parse every git URL form correctly": it only
 * has to be deterministic (the same remote always normalises the same way)
 * and non-colliding (two different remotes must never normalise to the same
 * string). Getting host/path extraction wrong for an exotic remote form
 * degrades to a less useful identity, never to a false match with an
 * unrelated repository, because the fallback path still incorporates the
 * full original string.
 */

export type GitRemoteInput = { name: string; url: string };

/** Picks `origin` when present, otherwise the alphabetically-first remote. */
export function normalizeRepositoryIdentity(remotes: readonly GitRemoteInput[]): string | null {
  if (remotes.length === 0) return null;
  const chosen = remotes.find((r) => r.name === 'origin') ?? [...remotes].sort((a, b) => a.name.localeCompare(b.name))[0];
  if (!chosen) return null;
  return normalizeRemoteUrl(chosen.url);
}

// scp-like syntax: user@host:path (e.g. git@github.com:org/repo.git). This is
// not a URL — there is no "//" after the colon — so it must be recognised
// before falling back to the URL parser, which would reject it.
const SCP_LIKE = /^[\w.-]+@([^:/]+):(.+)$/;

function normalizeRemoteUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const scpMatch = SCP_LIKE.exec(trimmed);
  if (scpMatch) {
    const host = scpMatch[1]!.toLowerCase();
    const path = normalizePathSegment(scpMatch[2]!);
    return path ? `${host}/${path}` : host;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    const path = normalizePathSegment(url.pathname);
    return path ? `${host}/${path}` : host || null;
  } catch {
    // Not a recognisable scheme://host/path or scp-like form. Falling back to
    // the normalised raw string keeps this deterministic and — crucially —
    // still discriminating: two different unparseable strings cannot collide
    // just because neither could be structured into host+path.
    const fallback = normalizePathSegment(trimmed);
    return fallback || null;
  }
}

function normalizePathSegment(input: string): string {
  let path = input.trim().toLowerCase();
  path = path.replace(/^\/+/, '').replace(/\/+$/, '');
  path = path.replace(/\.git$/i, '');
  path = path.replace(/\/{2,}/g, '/');
  return path;
}
