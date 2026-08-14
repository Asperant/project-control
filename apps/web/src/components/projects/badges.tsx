import type { ProjectPriority, ProjectStatus } from '@project-control/contracts';

/** Small status/priority pills for the projects screens. Colour reinforces the label; it never replaces it. */

const STATUS_LABEL: Record<ProjectStatus, string> = {
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

const STATUS_CLASS: Record<ProjectStatus, string> = {
  active: 'badge-ok',
  paused: 'badge-manual',
  completed: 'badge-unknown',
  archived: 'badge-unknown',
};

export function ProjectStatusBadge({ status }: { status: ProjectStatus }): React.JSX.Element {
  return <span className={`badge ${STATUS_CLASS[status]}`}>{STATUS_LABEL[status]}</span>;
}

const PRIORITY_LABEL: Record<ProjectPriority, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const PRIORITY_CLASS: Record<ProjectPriority, string> = {
  low: 'badge-unknown',
  medium: 'badge-manual',
  high: 'badge-degraded',
  critical: 'badge-down',
};

export function ProjectPriorityBadge({ priority }: { priority: ProjectPriority }): React.JSX.Element {
  return <span className={`badge ${PRIORITY_CLASS[priority]}`}>{PRIORITY_LABEL[priority]}</span>;
}

export function AccessibilityBadge({ accessible }: { accessible: boolean }): React.JSX.Element {
  return accessible ? (
    <span className="badge badge-ok">Reachable</span>
  ) : (
    <span className="badge badge-down">Unreachable</span>
  );
}

const RELATIVE_TIME_DIVISIONS: Array<{ amount: number; unit: string }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 30, unit: 'day' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const elapsedSeconds = (Date.now() - new Date(iso).getTime()) / 1000;
  if (elapsedSeconds < 5) return 'just now';

  let amount = elapsedSeconds;
  let unit = 'second';
  for (const division of RELATIVE_TIME_DIVISIONS) {
    if (amount < division.amount) {
      unit = division.unit;
      break;
    }
    amount = amount / division.amount;
    unit = division.unit;
  }
  const rounded = Math.round(amount);
  return `${rounded} ${unit}${rounded === 1 ? '' : 's'} ago`;
}
