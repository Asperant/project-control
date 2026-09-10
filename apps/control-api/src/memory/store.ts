import { randomUUID } from 'node:crypto';
import type {
  CreateMemoryEntryRequest, MemoryEntry, MemoryImportance, MemoryListQuery, MemoryListResponse, MemoryType,
  SupersedeMemoryEntryRequest, UpdateMemoryEntryRequest,
} from '@project-control/contracts';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';
import { getProjectGuard, assertProjectMutable as assertProjectMutableBase, type Executor } from '../projects/guard.js';
import type { MutationAudit, MutationTimeline } from '../roadmap/store.js';

const SUBJECT = 'Memory';
function assertProjectMutable(project: { id: string; status: string }): void {
  assertProjectMutableBase(project, SUBJECT);
}

type MemoryRow = {
  id: string; project_id: string; type: MemoryType; title: string; body: string;
  importance: MemoryImportance; is_pinned: boolean;
  related_task_id: string | null; related_task_title: string | null;
  related_milestone_id: string | null; related_milestone_title: string | null;
  superseded_by_id: string | null; superseded_by_title: string | null;
  supersedes_ids: string[] | null;
  source_agent_run_id: string | null; source_agent_run_title: string | null;
  archived_at: Date | null; created_by: string | null; created_at: Date; updated_at: Date;
  /**
   * `created_at` re-rendered in Postgres at full microsecond precision,
   * forced to UTC. Only used to build a pagination cursor — never expose
   * `created_at.toISOString()` there instead: node-pg's TIMESTAMPTZ parser
   * (and JS `Date`) is millisecond-precision only, so two rows sharing a
   * timestamp down to the microsecond (realistic within one transaction)
   * would round to an identical millisecond string, and a page boundary
   * landing between them would send back a cursor equal to — not less
   * than — rows it hasn't returned yet, silently dropping them from the
   * next page.
   */
  cursor_created_at: string;
};

const SELECT_ENTRY = `
  SELECT e.*, rt.title related_task_title, rm.title related_milestone_title, sb.title superseded_by_title,
    sar.title source_agent_run_title,
    (SELECT array_agg(p.id ORDER BY p.created_at) FROM project_memory_entries p WHERE p.superseded_by_id = e.id) supersedes_ids,
    to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
  FROM project_memory_entries e
  LEFT JOIN roadmap_tasks rt ON rt.id = e.related_task_id
  LEFT JOIN roadmap_milestones rm ON rm.id = e.related_milestone_id
  LEFT JOIN project_memory_entries sb ON sb.id = e.superseded_by_id
  LEFT JOIN agent_runs sar ON sar.id = e.source_agent_run_id
`;

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function mapEntry(row: MemoryRow): MemoryEntry {
  const status = row.superseded_by_id ? 'superseded' : row.archived_at ? 'archived' : 'active';
  return {
    id: row.id, projectId: row.project_id, type: row.type, title: row.title, body: row.body,
    importance: row.importance, isPinned: row.is_pinned, status,
    relatedTaskId: row.related_task_id, relatedTaskTitle: row.related_task_title,
    relatedMilestoneId: row.related_milestone_id, relatedMilestoneTitle: row.related_milestone_title,
    supersededById: row.superseded_by_id, supersededByTitle: row.superseded_by_title,
    supersedesIds: row.supersedes_ids ?? [],
    sourceAgentRunId: row.source_agent_run_id, sourceAgentRunTitle: row.source_agent_run_title,
    archivedAt: iso(row.archived_at), createdBy: row.created_by,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

async function loadEntry(db: Executor, projectId: string, entryId: string, lock = false): Promise<MemoryRow> {
  const { rows } = await db.query<MemoryRow>(
    `${SELECT_ENTRY} WHERE e.id=$1 AND e.project_id=$2${lock ? ' FOR UPDATE OF e' : ''}`,
    [entryId, projectId],
  );
  if (!rows[0]) throw notFound('Memory entry not found.');
  return rows[0];
}

/** Confirms a task belongs to the given project; used before linking related_task_id. */
async function assertTaskInProject(db: Executor, projectId: string, taskId: string): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM roadmap_tasks t JOIN roadmap_milestones m ON m.id=t.milestone_id WHERE t.id=$1 AND m.project_id=$2`,
    [taskId, projectId],
  );
  if (!rows[0]) throw notFound('Related task not found in this project.');
}

/** Confirms a milestone belongs to the given project; used before linking related_milestone_id. */
async function assertMilestoneInProject(db: Executor, projectId: string, milestoneId: string): Promise<void> {
  const { rows } = await db.query('SELECT 1 FROM roadmap_milestones WHERE id=$1 AND project_id=$2', [milestoneId, projectId]);
  if (!rows[0]) throw notFound('Related milestone not found in this project.');
}

export async function listMemory(db: Executor, projectId: string, query: MemoryListQuery): Promise<MemoryListResponse> {
  await getProjectGuard(db, projectId);
  const conditions = ['e.project_id = $1'];
  const params: unknown[] = [projectId];

  if (query.type) {
    params.push(query.type);
    conditions.push(`e.type = $${params.length}`);
  }
  if (query.pinned === 'true') {
    conditions.push('e.is_pinned AND e.archived_at IS NULL AND e.superseded_by_id IS NULL');
  } else if (query.archived === 'true') {
    conditions.push('e.archived_at IS NOT NULL AND e.superseded_by_id IS NULL');
  } else if (query.superseded === 'true') {
    conditions.push('e.superseded_by_id IS NOT NULL');
  } else {
    // Default view: active entries only. Archived/superseded rows are never
    // physically deleted, but they stay out of the everyday list unless asked
    // for explicitly.
    conditions.push('e.archived_at IS NULL AND e.superseded_by_id IS NULL');
  }
  if (query.search) {
    params.push(`%${query.search}%`);
    conditions.push(`(e.title ILIKE $${params.length} OR e.body ILIKE $${params.length})`);
  }
  if (query.importantOnly === 'true') {
    conditions.push(`(e.is_pinned OR e.importance IN ('important','critical'))`);
  }

  // Keyset cursor over (is_pinned, created_at, id) — is_pinned is the
  // *primary* sort key below, not created_at alone, so the cursor has to
  // carry all three columns the ORDER BY actually uses or a page boundary
  // that falls between two differently-pinned rows would skip or repeat one.
  if (query.beforeCreatedAt !== undefined) {
    params.push(query.beforeIsPinned === 'true', query.beforeCreatedAt, query.beforeId);
    conditions.push(`(e.is_pinned, e.created_at, e.id) < ($${params.length - 2}::boolean, $${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }

  params.push(query.pageSize);
  const { rows } = await db.query<MemoryRow>(
    `${SELECT_ENTRY} WHERE ${conditions.join(' AND ')} ORDER BY e.is_pinned DESC, e.created_at DESC, e.id DESC LIMIT $${params.length}`,
    params,
  );
  const entries = rows.map(mapEntry);
  const last = rows.at(-1);
  return {
    entries,
    pageSize: query.pageSize,
    nextCursor: rows.length === query.pageSize && last
      ? { isPinned: last.is_pinned, createdAt: last.cursor_created_at, id: last.id }
      : null,
  };
}

export async function getMemoryEntry(db: Executor, projectId: string, entryId: string): Promise<MemoryEntry> {
  return mapEntry(await loadEntry(db, projectId, entryId));
}

/**
 * Shared insert used by both ordinary memory creation and the promote-to-memory
 * flow (agent-runs/store.ts). `sourceAgentRunId` is never accepted from the
 * general create/supersede request bodies — see CreateMemoryEntryRequest,
 * which has no such field — so only a caller with a project-verified agent
 * run id in hand (the promote endpoint) can ever set it.
 */
export async function insertEntry(
  client: DbClient,
  projectId: string,
  actorId: string,
  input: {
    type: MemoryType; title: string; body: string; importance: MemoryImportance; isPinned: boolean;
    relatedTaskId?: string | null; relatedMilestoneId?: string | null; sourceAgentRunId?: string | null;
  },
): Promise<string> {
  if (input.relatedTaskId) await assertTaskInProject(client, projectId, input.relatedTaskId);
  if (input.relatedMilestoneId) await assertMilestoneInProject(client, projectId, input.relatedMilestoneId);
  const id = randomUUID();
  await client.query(
    `INSERT INTO project_memory_entries (id, project_id, type, title, body, importance, is_pinned, related_task_id, related_milestone_id, source_agent_run_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, projectId, input.type, input.title, input.body, input.importance, input.isPinned, input.relatedTaskId ?? null, input.relatedMilestoneId ?? null, input.sourceAgentRunId ?? null, actorId],
  );
  return id;
}

export async function listMemoryBySourceAgentRun(db: Executor, projectId: string, agentRunId: string): Promise<MemoryEntry[]> {
  await getProjectGuard(db, projectId);
  const { rows } = await db.query<MemoryRow>(
    `${SELECT_ENTRY} WHERE e.project_id=$1 AND e.source_agent_run_id=$2 ORDER BY e.created_at DESC`,
    [projectId, agentRunId],
  );
  return rows.map(mapEntry);
}

export async function createMemoryEntry(
  db: Db, projectId: string, actorId: string, input: CreateMemoryEntryRequest, audit: MutationAudit, timeline: MutationTimeline,
): Promise<MemoryEntry> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const id = await insertEntry(client, projectId, actorId, input);
    await audit(client, 'memory.created', { projectId, entryId: id, type: input.type, importance: input.importance, isPinned: input.isPinned });
    await timeline(client, {
      entityType: 'memory', entityId: id, eventType: 'memory.created', projectId,
      summary: `Memory created: "${input.title.slice(0, 100)}"`,
    });
    return mapEntry(await loadEntry(client, projectId, id));
  });
}

export async function updateMemoryEntry(
  db: Db, projectId: string, entryId: string, input: UpdateMemoryEntryRequest, audit: MutationAudit,
): Promise<MemoryEntry> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await loadEntry(client, projectId, entryId, true);
    if (row.superseded_by_id) throw new AppError('conflict', 'This memory entry has been superseded and is read-only.');
    if (row.archived_at) throw new AppError('conflict', 'This memory entry is archived. Reactivate it before editing.');

    const hasTask = Object.prototype.hasOwnProperty.call(input, 'relatedTaskId');
    const hasMilestone = Object.prototype.hasOwnProperty.call(input, 'relatedMilestoneId');
    if (hasTask && input.relatedTaskId) await assertTaskInProject(client, projectId, input.relatedTaskId);
    if (hasMilestone && input.relatedMilestoneId) await assertMilestoneInProject(client, projectId, input.relatedMilestoneId);

    await client.query(
      `UPDATE project_memory_entries SET
         title = COALESCE($3, title),
         body = COALESCE($4, body),
         importance = COALESCE($5, importance),
         related_task_id = CASE WHEN $6 THEN $7 ELSE related_task_id END,
         related_milestone_id = CASE WHEN $8 THEN $9 ELSE related_milestone_id END
       WHERE id=$1 AND project_id=$2`,
      [entryId, projectId, input.title ?? null, input.body ?? null, input.importance ?? null,
        hasTask, input.relatedTaskId ?? null, hasMilestone, input.relatedMilestoneId ?? null],
    );
    await audit(client, 'memory.updated', { projectId, entryId, changedFields: Object.keys(input) });
    return mapEntry(await loadEntry(client, projectId, entryId));
  });
}

export async function setMemoryPinned(db: Db, projectId: string, entryId: string, pinned: boolean, audit: MutationAudit): Promise<MemoryEntry> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await loadEntry(client, projectId, entryId, true);
    if (row.is_pinned === pinned) return mapEntry(row);
    await client.query('UPDATE project_memory_entries SET is_pinned=$1 WHERE id=$2', [pinned, entryId]);
    await audit(client, pinned ? 'memory.pinned' : 'memory.unpinned', { projectId, entryId });
    return mapEntry(await loadEntry(client, projectId, entryId));
  });
}

export async function setMemoryArchived(db: Db, projectId: string, entryId: string, archived: boolean, audit: MutationAudit): Promise<MemoryEntry> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await loadEntry(client, projectId, entryId, true);
    if (row.superseded_by_id) throw new AppError('conflict', 'This memory entry has been superseded and cannot be archived or reactivated directly.');
    if (archived && row.archived_at) return mapEntry(row);
    if (!archived && !row.archived_at) return mapEntry(row);
    await client.query('UPDATE project_memory_entries SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1', [entryId, archived]);
    await audit(client, archived ? 'memory.archived' : 'memory.reactivated', { projectId, entryId });
    return mapEntry(await loadEntry(client, projectId, entryId));
  });
}

async function nextSupersededBy(client: DbClient, entryId: string): Promise<string | null> {
  const result = await client.query<{ superseded_by_id: string | null }>(
    'SELECT superseded_by_id FROM project_memory_entries WHERE id=$1',
    [entryId],
  );
  const row = result.rows[0];
  return row ? row.superseded_by_id : null;
}

/** Walks the supersede chain from `startId`; throws if it ever reaches `forbiddenId`. */
async function assertNoSupersedeCycle(client: DbClient, startId: string, forbiddenId: string): Promise<void> {
  let cursor: string | null = startId;
  const seen = new Set<string>();
  while (cursor) {
    if (cursor === forbiddenId) {
      throw new AppError('conflict', 'This would create a circular supersede chain.');
    }
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = await nextSupersededBy(client, cursor);
  }
}

export async function supersedeMemoryEntry(
  db: Db, projectId: string, oldEntryId: string, actorId: string, input: SupersedeMemoryEntryRequest, audit: MutationAudit, timeline: MutationTimeline,
): Promise<{ oldEntry: MemoryEntry; newEntry: MemoryEntry }> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const old = await loadEntry(client, projectId, oldEntryId, true);
    if (old.superseded_by_id) throw new AppError('conflict', 'This memory entry has already been superseded.');

    let newEntryId: string;
    if ('newEntryId' in input) {
      newEntryId = input.newEntryId;
      if (newEntryId === oldEntryId) throw new AppError('conflict', 'A memory entry cannot supersede itself.');
      await loadEntry(client, projectId, newEntryId, true); // 404s on cross-project or missing
      await assertNoSupersedeCycle(client, newEntryId, oldEntryId);
    } else {
      newEntryId = await insertEntry(client, projectId, actorId, input);
    }

    await client.query('UPDATE project_memory_entries SET superseded_by_id=$1 WHERE id=$2', [newEntryId, oldEntryId]);
    await audit(client, 'memory.superseded', { projectId, oldEntryId, newEntryId });

    const [oldEntry, newEntry] = await Promise.all([
      loadEntry(client, projectId, oldEntryId).then(mapEntry),
      loadEntry(client, projectId, newEntryId).then(mapEntry),
    ]);
    await timeline(client, {
      entityType: 'memory', entityId: newEntryId, eventType: 'memory.superseded', projectId,
      summary: `Memory superseded: "${oldEntry.title.slice(0, 90)}" → "${newEntry.title.slice(0, 90)}"`,
    });
    return { oldEntry, newEntry };
  });
}
