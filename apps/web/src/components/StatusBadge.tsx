import type { ComponentStatus } from '@project-control/contracts';

/**
 * Status pill.
 *
 * The visible label always spells the status out. Colour is reinforcement, never
 * the sole carrier of meaning — which is both an accessibility requirement and
 * simply more legible on a screenshot pasted into a ticket.
 */

const LABELS: Record<ComponentStatus, string> = {
  ok: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
  manual_configuration_required: 'Setup required',
};

const CLASSES: Record<ComponentStatus, string> = {
  ok: 'badge-ok',
  degraded: 'badge-degraded',
  down: 'badge-down',
  unknown: 'badge-unknown',
  manual_configuration_required: 'badge-manual',
};

export function StatusBadge({ status }: { status: ComponentStatus }): React.JSX.Element {
  return (
    <span className={`badge ${CLASSES[status]}`}>
      {LABELS[status]}
    </span>
  );
}

export function OverallBadge({ overall }: { overall: 'ok' | 'degraded' | 'down' }): React.JSX.Element {
  return <StatusBadge status={overall} />;
}
