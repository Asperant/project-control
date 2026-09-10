import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { TimelineEntry } from '@project-control/contracts';
import { api } from '../../api-client';
import { EntityTypeBadge, entityLink } from './links';
import { ErrorAlert } from '../ErrorAlert';
import { useApiErrorHandler } from '../../hooks/useApiErrorHandler';

const PAGE_SIZE = 30;

/**
 * A curated activity feed — either scoped to one project or the global,
 * cross-project view. Both are keyset-paginated ("Load more" appends a page
 * rather than replacing it, since a feed the user is mid-scroll on must not
 * jump when new activity lands above).
 */
export function TimelineFeed({
  scope,
  projectId,
  onSessionExpired,
}: {
  scope: 'project' | 'global';
  projectId?: string;
  onSessionExpired: () => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<{ occurredAt: string; id: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const { error, setError, handleError } = useApiErrorHandler(onSessionExpired, 'Unable to load the activity feed.');

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const page = scope === 'project' && projectId
          ? await api.getProjectTimeline(projectId, { pageSize: PAGE_SIZE }, signal)
          : await api.getGlobalTimeline({ pageSize: PAGE_SIZE }, signal);
        setEntries(page.entries);
        setNextCursor(page.nextCursor);
      } catch (caught) {
        handleError(caught);
      } finally {
        setLoading(false);
      }
    },
    [scope, projectId, handleError],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function loadMore(): Promise<void> {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const beforeId = nextCursor.id;
      const page = scope === 'project' && projectId
        ? await api.getProjectTimeline(projectId, { pageSize: PAGE_SIZE, beforeOccurredAt: nextCursor.occurredAt, beforeId })
        : await api.getGlobalTimeline({ pageSize: PAGE_SIZE, beforeOccurredAt: nextCursor.occurredAt, beforeId });
      setEntries((current) => [...current, ...page.entries]);
      setNextCursor(page.nextCursor);
    } catch (caught) {
      handleError(caught);
    } finally {
      setLoadingMore(false);
    }
  }

  function open(entry: TimelineEntry): void {
    const link = entityLink(entry.entityType, entry.projectId, entry.entityId ?? '');
    if (link) navigate(link);
  }

  if (loading) return <p>Loading activity…</p>;
  if (error) return <ErrorAlert error={error.message} requestId={error.requestId} />;
  if (entries.length === 0) return <p className="hint">No activity yet.</p>;

  return (
    <>
      <ul className="timeline-feed">
        {entries.map((entry) => {
          const link = entityLink(entry.entityType, entry.projectId, entry.entityId ?? '');
          return (
            <li key={entry.id} className="card timeline-entry">
              <div className="card-head">
                <EntityTypeBadge entityType={entry.entityType} />
                <span className="card-meta" title={new Date(entry.occurredAt).toISOString()}>
                  {new Date(entry.occurredAt).toLocaleString()}
                </span>
              </div>
              {link ? (
                <button type="button" className="link-button" onClick={() => open(entry)}>
                  {entry.summary}
                </button>
              ) : (
                <p className="card-detail">{entry.summary}</p>
              )}
            </li>
          );
        })}
      </ul>

      {nextCursor && (
        <button type="button" onClick={() => void loadMore()} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </>
  );
}
