import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { SearchResult, SearchSnippetSegment } from '@project-control/contracts';
import { ApiError, api } from '../../api-client';
import { EntityTypeBadge, entityLink } from '../timeline/links';

const DEBOUNCE_MS = 250;
const MIN_QUERY_LENGTH = 2;

/** Renders a snippet as real text nodes — segments come from the server
 * already split on ts_headline's match markers, never as an HTML string, so
 * there is nothing here to sanitize and nothing to render unsafely. */
function Snippet({ segments }: { segments: SearchSnippetSegment[] }): React.JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.matched ? <mark key={index}>{segment.text}</mark> : <span key={index}>{segment.text}</span>,
      )}
    </>
  );
}

/**
 * Header search: type-ahead over every indexed entity. Debounced and
 * request-cancelled on each keystroke so a fast typist never sees a stale
 * response arrive after a newer one.
 */
export function GlobalSearch({ onSessionExpired }: { onSessionExpired: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < MIN_QUERY_LENGTH) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void api.searchGlobal({ q: trimmed, limit: 15 }, controller.signal)
        .then((response) => {
          setResults(response.results);
          setOpen(true);
        })
        .catch((caught) => {
          if (caught instanceof DOMException && caught.name === 'AbortError') return;
          if (caught instanceof ApiError && caught.isAuthFailure) {
            onSessionExpired();
            return;
          }
          setResults([]);
        })
        .finally(() => setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, onSessionExpired]);

  useEffect(() => {
    function onOutsideClick(event: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onOutsideClick);
    return () => document.removeEventListener('mousedown', onOutsideClick);
  }, []);

  function openResult(result: SearchResult): void {
    const link = entityLink(result.entityType, result.projectId, result.entityId);
    setOpen(false);
    setQuery('');
    if (link) navigate(link);
  }

  return (
    <div className="global-search" ref={containerRef}>
      <input
        type="search"
        placeholder="Search…"
        aria-label="Search across all projects"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
      />

      {open && (
        <div className="global-search-results" role="listbox">
          {loading && <div className="global-search-status">Searching…</div>}
          {!loading && results.length === 0 && query.trim().length >= MIN_QUERY_LENGTH && (
            <div className="global-search-status">No results.</div>
          )}
          {results.map((result) => (
            <button
              key={`${result.entityType}:${result.entityId}`}
              type="button"
              role="option"
              aria-selected={false}
              className="global-search-result"
              onClick={() => openResult(result)}
            >
              <div className="card-head">
                <EntityTypeBadge entityType={result.entityType} />
                {result.projectName && <span className="card-meta">{result.projectName}</span>}
              </div>
              <span className="card-title">{result.title}</span>
              {result.snippet.length > 0 && (
                <p className="card-detail"><Snippet segments={result.snippet} /></p>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
