import type { AgentRunStatus, AgentValidationStatus, RecentAgentActivity } from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';

/**
 * The single, shared read of "what agent work happened recently on this
 * project" used by both the checkpoint snapshot builder (checkpoints/snapshot.ts)
 * and the live "Where was I?" context (context/store.ts) — kept in one place
 * for the same reason loadRawProjectData is: two independently-written queries
 * for "the same thing" drift apart over time.
 *
 * Deliberately excludes prompt/report bodies (only ids/titles/statuses) and
 * draft/archived runs (nothing has actually happened on those yet, or they
 * have been explicitly put away).
 */

type RecentAgentActivityRow = {
  id: string; title: string; agent_name: string; status: AgentRunStatus;
  validation_status: AgentValidationStatus; related_task_id: string | null; activity_at: Date;
};

export async function loadRecentAgentActivity(db: Executor, projectId: string, limit: number): Promise<RecentAgentActivity[]> {
  const { rows } = await db.query<RecentAgentActivityRow>(
    `SELECT id, title, agent_name, status, validation_status, related_task_id,
            COALESCE(completed_at, failed_at, cancelled_at, started_at, sent_at) AS activity_at
       FROM agent_runs
      WHERE project_id=$1 AND archived_at IS NULL AND status <> 'draft'
      ORDER BY activity_at DESC, id
      LIMIT $2`,
    [projectId, limit],
  );
  return rows.map((r) => ({
    agentRunId: r.id,
    title: r.title,
    agentName: r.agent_name,
    status: r.status,
    validationStatus: r.validation_status,
    relatedTaskId: r.related_task_id,
    activityAt: r.activity_at.toISOString(),
  }));
}
