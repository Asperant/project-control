import type { SearchEntityType, TimelineEntityType } from '@project-control/contracts';

/**
 * Where a timeline entry or search result actually opens. Mirrors the tab
 * layout ProjectDetail.tsx owns — a roadmap_task and a roadmap_milestone both
 * land on the Roadmap tab because RoadmapView shows both together, not as
 * separate deep-linkable screens; the same is true for memory/checkpoint on
 * the Memory tab.
 */
export function entityLink(
  entityType: TimelineEntityType | SearchEntityType,
  projectId: string | null,
  entityId: string,
): string | null {
  switch (entityType) {
    case 'project':
      return `/projects/${entityId}`;
    case 'roadmap_milestone':
    case 'roadmap_task':
      return projectId ? `/projects/${projectId}/roadmap` : null;
    case 'memory':
    case 'checkpoint':
      return projectId ? `/projects/${projectId}/memory` : null;
    case 'work_session':
      return projectId ? `/projects/${projectId}/resume` : null;
    case 'agent_run':
      return projectId ? `/projects/${projectId}/agent-runs` : null;
    case 'action':
      return projectId ? `/projects/${projectId}/development` : null;
    case 'workflow_run':
      return '/automation';
    default:
      return null;
  }
}

const ENTITY_LABELS: Record<TimelineEntityType, string> = {
  project: 'Project',
  roadmap_milestone: 'Milestone',
  roadmap_task: 'Task',
  memory: 'Memory',
  checkpoint: 'Checkpoint',
  work_session: 'Work Session',
  agent_run: 'Agent Run',
  action: 'Repository Action',
  workflow_run: 'Automation Run',
};

export function entityLabel(entityType: TimelineEntityType | SearchEntityType): string {
  return ENTITY_LABELS[entityType as TimelineEntityType] ?? entityType;
}

export function EntityTypeBadge({ entityType }: { entityType: TimelineEntityType | SearchEntityType }): React.JSX.Element {
  return <span className="badge badge-unknown">{entityLabel(entityType)}</span>;
}
