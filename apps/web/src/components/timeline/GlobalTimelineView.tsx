import { TimelineFeed } from './TimelineFeed';

export function GlobalTimelineView({ onSessionExpired }: { onSessionExpired: () => void }): React.JSX.Element {
  return (
    <section aria-labelledby="activity-heading">
      <h2 id="activity-heading">Activity</h2>
      <p className="hint">What happened across every project, most recent first.</p>
      <TimelineFeed scope="global" onSessionExpired={onSessionExpired} />
    </section>
  );
}
