import type { WorkflowRunStatus, WorkflowRunStepStatus, WorkflowSeverity } from '@project-control/contracts';

const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  waiting_for_approval: 'Awaiting approval',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

const RUN_STATUS_CLASSES: Record<WorkflowRunStatus, string> = {
  queued: 'badge-unknown',
  running: 'badge-degraded',
  completed: 'badge-ok',
  failed: 'badge-down',
  waiting_for_approval: 'badge-manual',
  cancelled: 'badge-unknown',
  expired: 'badge-down',
};

export function RunStatusBadge({ status }: { status: WorkflowRunStatus }): React.JSX.Element {
  return <span className={`badge ${RUN_STATUS_CLASSES[status]}`}>{RUN_STATUS_LABELS[status]}</span>;
}

const SEVERITY_CLASSES: Record<WorkflowSeverity, string> = {
  info: 'badge-unknown',
  warning: 'badge-degraded',
  critical: 'badge-down',
};

export function SeverityBadge({ severity }: { severity: WorkflowSeverity }): React.JSX.Element {
  return <span className={`badge ${SEVERITY_CLASSES[severity]}`}>{severity}</span>;
}

const STEP_STATUS_CLASSES: Record<WorkflowRunStepStatus, string> = {
  passed: 'badge-ok',
  warning: 'badge-degraded',
  failed: 'badge-down',
  skipped: 'badge-unknown',
};

export function StepStatusBadge({ status }: { status: WorkflowRunStepStatus }): React.JSX.Element {
  return <span className={`badge ${STEP_STATUS_CLASSES[status]}`}>{status}</span>;
}
