import { randomUUID } from 'node:crypto';
import type { Db, DbClient } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { AppError, notFound } from '../errors.js';
import { sanitiseAuditText } from '../audit.js';
import type {
  ChangeMilestoneStatusRequest, ChangeTaskStatusRequest, CreateMilestoneRequest, CreateTaskRequest,
  ProjectRoadmapResponse, RoadmapMilestone, RoadmapTask, TaskDetailResponse, UpdateMilestoneRequest,
  UpdateTaskRequest,
} from '@project-control/contracts';

type Executor = Db | DbClient;
export type MutationAudit = (client: DbClient, eventType: string, detail: Record<string, unknown>) => Promise<void>;
type ProjectGuard = { id: string; status: string };
type MilestoneRow = {
  id: string; project_id: string; title: string; description: string; status: RoadmapMilestone['status'];
  priority: RoadmapMilestone['priority']; sort_order: number; target_date: string | Date | null; blocked_reason: string | null;
  started_at: Date | null; completed_at: Date | null; archived_at: Date | null; created_by: string | null;
  created_at: Date; updated_at: Date;
};
type TaskRow = {
  id: string; milestone_id: string; title: string; description: string; status: RoadmapTask['status'];
  priority: RoadmapTask['priority']; sort_order: number; blocked_reason: string | null; next_action: string;
  started_at: Date | null; completed_at: Date | null; cancelled_at: Date | null; created_by: string | null;
  created_at: Date; updated_at: Date; incomplete_acceptance_count?: number; unresolved_dependency_count?: number;
};

const transitions: Record<RoadmapTask['status'], RoadmapTask['status'][]> = {
  planned: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['blocked', 'done', 'cancelled'],
  blocked: ['in_progress', 'planned', 'cancelled'],
  done: ['in_progress', 'planned'],
  cancelled: ['planned'],
};

function iso(value: Date | null): string | null { return value?.toISOString() ?? null; }
function dateOnly(value: string | Date | null): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}
function progress(tasks: TaskRow[]) {
  const active = tasks.filter((task) => task.status !== 'cancelled');
  const completed = active.filter((task) => task.status === 'done').length;
  return { completed, total: active.length, percentage: active.length === 0 ? 0 : Math.round((completed / active.length) * 100) };
}
function mapTask(row: TaskRow): RoadmapTask {
  return {
    id: row.id, milestoneId: row.milestone_id, title: row.title, description: row.description, status: row.status,
    priority: row.priority, position: row.sort_order, blockedReason: row.blocked_reason, nextAction: row.next_action,
    startedAt: iso(row.started_at), completedAt: iso(row.completed_at), cancelledAt: iso(row.cancelled_at),
    createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    incompleteAcceptanceCount: Number(row.incomplete_acceptance_count ?? 0),
    unresolvedDependencyCount: Number(row.unresolved_dependency_count ?? 0),
  };
}

export async function getProjectGuard(db: Executor, projectId: string, lock = false): Promise<ProjectGuard> {
  const { rows } = await db.query<ProjectGuard>(`SELECT id, status FROM projects WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [projectId]);
  if (!rows[0]) throw notFound('Project not found.');
  return rows[0];
}
function assertProjectMutable(project: ProjectGuard): void {
  if (project.status === 'archived') throw new AppError('conflict', 'This project is archived. Roadmap changes are disabled.');
}
async function getMilestone(db: Executor, projectId: string, milestoneId: string, lock = false): Promise<MilestoneRow> {
  const { rows } = await db.query<MilestoneRow>(`SELECT * FROM roadmap_milestones WHERE id=$1 AND project_id=$2${lock ? ' FOR UPDATE' : ''}`, [milestoneId, projectId]);
  if (!rows[0]) throw notFound('Milestone not found.');
  return rows[0];
}
function assertMilestoneMutable(row: MilestoneRow): void {
  if (row.archived_at || row.status === 'cancelled') throw new AppError('conflict', 'This milestone is read-only. Reactivate it before changing its tasks.');
}
async function getTask(db: Executor, projectId: string, taskId: string, lock = false): Promise<TaskRow & { milestone_status: string; milestone_archived_at: Date | null }> {
  const { rows } = await db.query<TaskRow & { milestone_status: string; milestone_archived_at: Date | null }>(
    `SELECT t.*, m.status milestone_status, m.archived_at milestone_archived_at
       FROM roadmap_tasks t JOIN roadmap_milestones m ON m.id=t.milestone_id
      WHERE t.id=$1 AND m.project_id=$2${lock ? ' FOR UPDATE OF t, m' : ''}`, [taskId, projectId]);
  if (!rows[0]) throw notFound('Task not found.');
  return rows[0];
}
function assertTaskContainerMutable(row: { milestone_status: string; milestone_archived_at: Date | null }): void {
  if (row.milestone_archived_at || row.milestone_status === 'cancelled') throw new AppError('conflict', 'This milestone is read-only. Reactivate it before changing its tasks.');
}

export async function loadRoadmap(db: Executor, projectId: string): Promise<ProjectRoadmapResponse> {
  const project = await getProjectGuard(db, projectId);
  const [{ rows: milestones }, { rows: tasks }] = await Promise.all([
    db.query<MilestoneRow>('SELECT * FROM roadmap_milestones WHERE project_id=$1 ORDER BY sort_order, created_at', [projectId]),
    db.query<TaskRow>(`SELECT t.*,
       (SELECT count(*) FROM task_acceptance_criteria c WHERE c.task_id=t.id AND NOT c.is_completed) incomplete_acceptance_count,
       (SELECT count(*) FROM task_dependencies d JOIN roadmap_tasks dep ON dep.id=d.depends_on_task_id WHERE d.task_id=t.id AND dep.status <> 'done') unresolved_dependency_count
       FROM roadmap_tasks t JOIN roadmap_milestones m ON m.id=t.milestone_id WHERE m.project_id=$1 ORDER BY t.sort_order, t.created_at`, [projectId]),
  ]);
  const mapped: RoadmapMilestone[] = milestones.map((row) => {
    const children = tasks.filter((task) => task.milestone_id === row.id);
    return {
      id: row.id, projectId: row.project_id, title: row.title, description: row.description, status: row.status,
      priority: row.priority, position: row.sort_order, targetDate: dateOnly(row.target_date), blockedReason: row.blocked_reason,
      startedAt: iso(row.started_at), completedAt: iso(row.completed_at), archivedAt: iso(row.archived_at),
      createdBy: row.created_by, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
      progress: progress(children), tasks: children.map(mapTask),
    };
  });
  return { projectId, readOnly: project.status === 'archived', progress: progress(tasks), milestones: mapped };
}

export async function createMilestone(db: Db, projectId: string, actorId: string, input: CreateMilestoneRequest, audit: MutationAudit): Promise<string> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    if (input.status === 'blocked' && !input.blockedReason) throw new AppError('validation_failed', 'A block reason is required.', { fields: [{ path: 'blockedReason', message: 'Required when status is blocked.' }] });
    const id = randomUUID();
    await client.query(`INSERT INTO roadmap_milestones (id,project_id,title,description,status,priority,sort_order,target_date,blocked_reason,started_at,completed_at,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,(SELECT count(*) FROM roadmap_milestones WHERE project_id=$2),$7,$8,CASE WHEN $5='in_progress' THEN now() END,CASE WHEN $5='done' THEN now() END,$9)`,
      [id, projectId, input.title, input.description, input.status, input.priority, input.targetDate ?? null, input.blockedReason ?? null, actorId]);
    await audit(client,'roadmap.milestone.created',{projectId,milestoneId:id,status:input.status,priority:input.priority}); return id;
  });
}

export async function updateMilestone(db: Db, projectId: string, milestoneId: string, input: UpdateMilestoneRequest, audit: MutationAudit): Promise<void> {
  await withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await getMilestone(client, projectId, milestoneId, true);
    if (row.archived_at) throw new AppError('conflict', 'This milestone is archived. Reactivate it before editing.');
    if (input.status !== undefined || input.blockedReason !== undefined) throw new AppError('validation_failed', 'Use the status endpoint for lifecycle changes.');
    await client.query(`UPDATE roadmap_milestones SET title=COALESCE($3,title), description=COALESCE($4,description), priority=COALESCE($5,priority), target_date=CASE WHEN $6 THEN $7::date ELSE target_date END WHERE id=$1 AND project_id=$2`,
      [milestoneId, projectId, input.title ?? null, input.description ?? null, input.priority ?? null, Object.prototype.hasOwnProperty.call(input, 'targetDate'), input.targetDate ?? null]);
    await audit(client,'roadmap.milestone.updated',{projectId,milestoneId,changedFields:Object.keys(input)});
  });
}

export async function changeMilestoneStatus(db: Db, projectId: string, milestoneId: string, input: ChangeMilestoneStatusRequest, audit: MutationAudit): Promise<{ from: string }> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row = await getMilestone(client, projectId, milestoneId, true);
    if (row.archived_at) throw new AppError('conflict', 'Reactivate this milestone before changing its status.');
    if (row.status === input.status) return { from: row.status };
    if (row.status !== input.status && !transitions[row.status].includes(input.status)) throw new AppError('conflict', `Status cannot change from ${row.status} to ${input.status}.`);
    if (input.status === 'blocked' && !input.blockedReason) throw new AppError('validation_failed', 'A block reason is required.', { fields: [{ path: 'blockedReason', message: 'Required when status is blocked.' }] });
    await client.query(`UPDATE roadmap_milestones SET status=$3, blocked_reason=CASE WHEN $3='blocked' THEN $4 ELSE NULL END,
      started_at=CASE WHEN $3='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,
      completed_at=CASE WHEN $3='done' THEN now() WHEN status='done' THEN NULL ELSE completed_at END WHERE id=$1 AND project_id=$2`,
      [milestoneId, projectId, input.status, input.blockedReason ?? null]);
    const eventType=input.status==='blocked'?'roadmap.milestone.blocked':input.status==='done'?'roadmap.milestone.completed':(row.status==='done'||row.status==='cancelled')?'roadmap.milestone.reopened':'roadmap.milestone.status_changed';
    await audit(client,eventType,{projectId,milestoneId,from:row.status,to:input.status,blockReasonPresent:input.status==='blocked',...(input.status==='blocked'&&input.blockedReason?{blockedReason:sanitiseAuditText(input.blockedReason)}:{})}); return { from: row.status };
  });
}

async function reorderRows(client: DbClient, table: 'roadmap_milestones' | 'roadmap_tasks' | 'task_acceptance_criteria', parentColumn: string, parentId: string, id: string, direction: 'up' | 'down'): Promise<boolean> {
  const { rows } = await client.query<{ id: string }>(`SELECT id FROM ${table} WHERE ${parentColumn}=$1 ORDER BY sort_order, created_at FOR UPDATE`, [parentId]);
  const index = rows.findIndex((row) => row.id === id);
  if (index < 0) throw notFound('Roadmap item not found.');
  const target = direction === 'up' ? index - 1 : index + 1;
  if (target < 0 || target >= rows.length) return false;
  [rows[index], rows[target]] = [rows[target]!, rows[index]!];
  for (let position = 0; position < rows.length; position += 1) await client.query(`UPDATE ${table} SET sort_order=$1 WHERE id=$2`, [position, rows[position]!.id]);
  return true;
}
export async function reorderMilestone(db: Db, projectId: string, milestoneId: string, direction: 'up' | 'down', audit:MutationAudit): Promise<boolean> {
  return withTransaction(db, async (client) => { assertProjectMutable(await getProjectGuard(client, projectId, true)); const row=await getMilestone(client, projectId, milestoneId,true);assertMilestoneMutable(row); const moved=await reorderRows(client, 'roadmap_milestones', 'project_id', projectId, milestoneId, direction); if(moved)await audit(client,'roadmap.milestone.reordered',{projectId,milestoneId,direction}); return moved; });
}
export async function setMilestoneArchived(db: Db, projectId: string, milestoneId: string, archived: boolean,audit:MutationAudit): Promise<void> {
  await withTransaction(db, async (client) => { assertProjectMutable(await getProjectGuard(client, projectId, true)); const row = await getMilestone(client, projectId, milestoneId, true); if (!archived && !row.archived_at) return; if (archived && row.archived_at) return; await client.query('UPDATE roadmap_milestones SET archived_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1 AND project_id=$2', [milestoneId, projectId, archived]); await audit(client,archived?'roadmap.milestone.archived':'roadmap.milestone.reactivated',{projectId,milestoneId}); });
}

export async function createTask(db: Db, projectId: string, milestoneId: string, actorId: string, input: CreateTaskRequest,audit:MutationAudit): Promise<string> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    assertMilestoneMutable(await getMilestone(client, projectId, milestoneId, true));
    const id = randomUUID();
    await client.query(`INSERT INTO roadmap_tasks (id,milestone_id,title,description,status,priority,sort_order,started_at,completed_at,cancelled_at,created_by)
      VALUES ($1,$2,$3,$4,$5,$6,(SELECT count(*) FROM roadmap_tasks WHERE milestone_id=$2),CASE WHEN $5='in_progress' THEN now() END,CASE WHEN $5='done' THEN now() END,CASE WHEN $5='cancelled' THEN now() END,$7)`,
      [id, milestoneId, input.title, input.description, input.status, input.priority, actorId]);
    await audit(client,'roadmap.task.created',{projectId,milestoneId,taskId:id,status:input.status,priority:input.priority}); return id;
  });
}
export async function updateTask(db: Db, projectId: string, taskId: string, input: UpdateTaskRequest,audit:MutationAudit): Promise<void> {
  await withTransaction(db, async (client) => { assertProjectMutable(await getProjectGuard(client, projectId, true)); const row=await getTask(client, projectId, taskId, true); assertTaskContainerMutable(row); await client.query('UPDATE roadmap_tasks SET title=COALESCE($2,title),description=COALESCE($3,description),priority=COALESCE($4,priority),next_action=COALESCE($5,next_action) WHERE id=$1', [taskId,input.title??null,input.description??null,input.priority??null,input.nextAction??null]); await audit(client,'roadmap.task.updated',{projectId,milestoneId:row.milestone_id,taskId,changedFields:Object.keys(input)}); });
}
export async function changeTaskStatus(db: Db, projectId: string, taskId: string, input: ChangeTaskStatusRequest,audit:MutationAudit): Promise<{ from: string; acceptanceOverride: boolean; dependencyOverride: boolean }> {
  return withTransaction(db, async (client) => {
    assertProjectMutable(await getProjectGuard(client, projectId, true));
    const row=await getTask(client, projectId, taskId, true); assertTaskContainerMutable(row);
    if (row.status === input.status) return { from:row.status,acceptanceOverride:false,dependencyOverride:false };
    if (row.status !== input.status && !transitions[row.status].includes(input.status)) throw new AppError('conflict', `Status cannot change from ${row.status} to ${input.status}.`);
    if (input.status === 'blocked' && !input.blockedReason) throw new AppError('validation_failed', 'A block reason is required.', { fields: [{ path:'blockedReason',message:'Required when status is blocked.' }] });
    const acceptance = input.status === 'done' ? Number((await client.query<{ count:number }>('SELECT count(*) FROM task_acceptance_criteria WHERE task_id=$1 AND NOT is_completed',[taskId])).rows[0]!.count) : 0;
    const dependencies = input.status === 'in_progress' ? Number((await client.query<{ count:number }>(`SELECT count(*) FROM task_dependencies d JOIN roadmap_tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=$1 AND t.status <> 'done'`,[taskId])).rows[0]!.count) : 0;
    if (acceptance > 0 && !input.acknowledgeIncompleteAcceptance) throw new AppError('confirmation_required', `${acceptance} acceptance ${acceptance === 1 ? 'criterion is' : 'criteria are'} still incomplete. Confirm completion to continue.`, { confirmation:{kind:'incomplete_acceptance',count:acceptance} });
    if (dependencies > 0 && !input.acknowledgeIncompleteDependencies) throw new AppError('confirmation_required', `${dependencies} ${dependencies === 1 ? 'dependency is' : 'dependencies are'} not completed. Confirm start to continue.`, { confirmation:{kind:'incomplete_dependencies',count:dependencies} });
    await client.query(`UPDATE roadmap_tasks SET status=$2,blocked_reason=CASE WHEN $2='blocked' THEN $3 ELSE NULL END,
      started_at=CASE WHEN $2='in_progress' THEN COALESCE(started_at,now()) ELSE started_at END,
      completed_at=CASE WHEN $2='done' THEN now() WHEN status='done' THEN NULL ELSE completed_at END,
      cancelled_at=CASE WHEN $2='cancelled' THEN now() WHEN status='cancelled' THEN NULL ELSE cancelled_at END WHERE id=$1`,[taskId,input.status,input.blockedReason??null]);
    const eventType=input.status==='in_progress'&&row.status==='planned'?'roadmap.task.started':input.status==='blocked'?'roadmap.task.blocked':input.status==='done'?'roadmap.task.completed':input.status==='cancelled'?'roadmap.task.cancelled':(row.status==='done'||row.status==='cancelled')?'roadmap.task.reopened':row.status==='blocked'?'roadmap.task.unblocked':'roadmap.task.status_changed';
    await audit(client,eventType,{projectId,milestoneId:row.milestone_id,taskId,from:row.status,to:input.status,blockReasonPresent:input.status==='blocked',...(input.status==='blocked'&&input.blockedReason?{blockedReason:sanitiseAuditText(input.blockedReason)}:{}),acceptanceOverride:acceptance>0,dependencyOverride:dependencies>0,incompleteAcceptanceCount:acceptance,unresolvedDependencyCount:dependencies});
    if(dependencies>0)await audit(client,'roadmap.dependency.override',{projectId,milestoneId:row.milestone_id,taskId,count:dependencies});
    return { from: row.status, acceptanceOverride: acceptance > 0, dependencyOverride: dependencies > 0 };
  });
}
export async function reorderTask(db: Db, projectId:string, taskId:string, direction:'up'|'down',audit:MutationAudit):Promise<boolean>{ return withTransaction(db,async(client)=>{ assertProjectMutable(await getProjectGuard(client,projectId,true)); const row=await getTask(client,projectId,taskId,true); assertTaskContainerMutable(row); const moved=await reorderRows(client,'roadmap_tasks','milestone_id',row.milestone_id,taskId,direction);if(moved)await audit(client,'roadmap.task.reordered',{projectId,milestoneId:row.milestone_id,taskId,direction});return moved; }); }

export async function loadTaskDetail(db: Executor, projectId: string, taskId: string): Promise<TaskDetailResponse> {
  const task = await getTask(db, projectId, taskId);
  const [{rows:criteria},{rows:dependencies},{rows:notes},{rows:activity},{rows:candidates}] = await Promise.all([
    db.query<any>('SELECT * FROM task_acceptance_criteria WHERE task_id=$1 ORDER BY sort_order,created_at',[taskId]),
    db.query<any>(`SELECT d.*,t.title,t.status,(t.status='done') resolved FROM task_dependencies d JOIN roadmap_tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=$1 ORDER BY d.created_at`,[taskId]),
    db.query<any>('SELECT * FROM task_notes WHERE task_id=$1 AND deleted_at IS NULL ORDER BY created_at',[taskId]),
    db.query<any>(`SELECT id,occurred_at,event_type,outcome,actor_user_id,detail FROM audit_events WHERE event_type LIKE 'roadmap.%' AND detail->>'taskId'=$1 ORDER BY occurred_at DESC LIMIT 100`,[taskId]),
    db.query<any>(`SELECT t.id,t.milestone_id,t.title,t.status FROM roadmap_tasks t JOIN roadmap_milestones m ON m.id=t.milestone_id WHERE m.project_id=$1 AND t.id<>$2 ORDER BY m.sort_order,t.sort_order`,[projectId,taskId]),
  ]);
  const countRow = await db.query<TaskRow>(`SELECT t.*,(SELECT count(*) FROM task_acceptance_criteria c WHERE c.task_id=t.id AND NOT c.is_completed) incomplete_acceptance_count,(SELECT count(*) FROM task_dependencies d JOIN roadmap_tasks dep ON dep.id=d.depends_on_task_id WHERE d.task_id=t.id AND dep.status<>'done') unresolved_dependency_count FROM roadmap_tasks t WHERE t.id=$1`,[taskId]);
  return { task:mapTask(countRow.rows[0]!), criteria:criteria.map((r:any)=>({id:r.id,taskId:r.task_id,text:r.text,position:r.sort_order,isCompleted:r.is_completed,completedAt:iso(r.completed_at),completedBy:r.completed_by,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()})), dependencies:dependencies.map((r:any)=>({taskId:r.task_id,dependsOnTaskId:r.depends_on_task_id,title:r.title,status:r.status,resolved:r.resolved,createdAt:r.created_at.toISOString()})), notes:notes.map((r:any)=>({id:r.id,taskId:r.task_id,body:r.body,createdBy:r.created_by,createdAt:r.created_at.toISOString(),updatedAt:r.updated_at.toISOString()})), activity:activity.map((r:any)=>({id:String(r.id),occurredAt:r.occurred_at.toISOString(),eventType:r.event_type,label:activityLabel(r.event_type,r.detail),outcome:r.outcome,actorUserId:r.actor_user_id})), dependencyCandidates:candidates.map((r:any)=>({id:r.id,milestoneId:r.milestone_id,title:r.title,status:r.status})) };
}

function activityLabel(eventType:string,detail:Record<string,unknown>):string {
  const labels:Record<string,string>={
    'roadmap.milestone.created':'Milestone created','roadmap.milestone.updated':'Milestone updated','roadmap.milestone.reordered':'Milestone reordered','roadmap.milestone.archived':'Milestone archived','roadmap.milestone.reactivated':'Milestone reactivated','roadmap.task.created':'Task created','roadmap.task.updated':'Task updated','roadmap.task.reordered':'Task reordered','roadmap.task.started':'Task started','roadmap.task.blocked':'Task blocked','roadmap.task.unblocked':'Task unblocked','roadmap.task.completed':'Task completed','roadmap.task.reopened':'Task reopened','roadmap.task.cancelled':'Task cancelled','roadmap.acceptance.created':'Acceptance criterion created','roadmap.acceptance.updated':'Acceptance criterion updated','roadmap.acceptance.completed':'Acceptance criterion completed','roadmap.acceptance.reopened':'Acceptance criterion reopened','roadmap.acceptance.reordered':'Acceptance criterion reordered','roadmap.acceptance.deleted':'Acceptance criterion deleted','roadmap.dependency.added':'Dependency added','roadmap.dependency.removed':'Dependency removed','roadmap.dependency.override':'Incomplete dependency acknowledged','roadmap.note.created':'Note created','roadmap.note.updated':'Note updated','roadmap.note.deleted':'Note deleted',
  };
  if((eventType==='roadmap.task.blocked'||eventType==='roadmap.milestone.blocked')&&typeof detail['blockedReason']==='string')return `${eventType==='roadmap.task.blocked'?'Task':'Milestone'} blocked: ${detail['blockedReason']}`;
  if(eventType.endsWith('.status_changed')&&typeof detail['from']==='string'&&typeof detail['to']==='string')return `Status changed ${detail['from']} → ${detail['to']}`;
  return labels[eventType]??'Roadmap updated';
}

export async function loadRoadmapActivity(db:Executor,projectId:string){
  await getProjectGuard(db,projectId);
  const {rows}=await db.query<any>(`SELECT id,occurred_at,event_type,outcome,actor_user_id,detail FROM audit_events WHERE event_type LIKE 'roadmap.%' AND detail->>'projectId'=$1 ORDER BY occurred_at DESC LIMIT 100`,[projectId]);
  return rows.map((r:any)=>({id:String(r.id),occurredAt:r.occurred_at.toISOString(),eventType:r.event_type,label:activityLabel(r.event_type,r.detail),outcome:r.outcome,actorUserId:r.actor_user_id}));
}

export async function addCriterion(db:Db,projectId:string,taskId:string,actorId:string,text:string,audit:MutationAudit):Promise<string>{return withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const id=randomUUID();await client.query(`INSERT INTO task_acceptance_criteria(id,task_id,text,sort_order) VALUES($1,$2,$3,(SELECT count(*) FROM task_acceptance_criteria WHERE task_id=$2))`,[id,taskId,text]);await audit(client,'roadmap.acceptance.created',{projectId,milestoneId:task.milestone_id,taskId,criterionId:id});return id;});}
export async function updateCriterion(db:Db,projectId:string,taskId:string,criterionId:string,text:string,audit:MutationAudit):Promise<void>{await withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const result=await client.query('UPDATE task_acceptance_criteria SET text=$1 WHERE id=$2 AND task_id=$3',[text,criterionId,taskId]);if(!result.rowCount)throw notFound('Acceptance criterion not found.');await audit(client,'roadmap.acceptance.updated',{projectId,milestoneId:task.milestone_id,taskId,criterionId});});}
export async function completeCriterion(db:Db,projectId:string,taskId:string,criterionId:string,completed:boolean,actorId:string,audit:MutationAudit):Promise<void>{await withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const current=await client.query<{is_completed:boolean}>('SELECT is_completed FROM task_acceptance_criteria WHERE id=$1 AND task_id=$2 FOR UPDATE',[criterionId,taskId]);if(!current.rows[0])throw notFound('Acceptance criterion not found.');if(current.rows[0].is_completed===completed)return;await client.query(`UPDATE task_acceptance_criteria SET is_completed=$1,completed_at=CASE WHEN $1 THEN now() ELSE NULL END,completed_by=CASE WHEN $1 THEN $4::uuid ELSE NULL END WHERE id=$2 AND task_id=$3`,[completed,criterionId,taskId,actorId]);await audit(client,completed?'roadmap.acceptance.completed':'roadmap.acceptance.reopened',{projectId,milestoneId:task.milestone_id,taskId,criterionId});});}
export async function reorderCriterion(db:Db,projectId:string,taskId:string,criterionId:string,direction:'up'|'down',audit:MutationAudit):Promise<boolean>{return withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const moved=await reorderRows(client,'task_acceptance_criteria','task_id',taskId,criterionId,direction);if(moved)await audit(client,'roadmap.acceptance.reordered',{projectId,milestoneId:task.milestone_id,taskId,criterionId,direction});return moved;});}
export async function deleteCriterion(db:Db,projectId:string,taskId:string,criterionId:string,audit:MutationAudit):Promise<void>{await withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const result=await client.query('DELETE FROM task_acceptance_criteria WHERE id=$1 AND task_id=$2',[criterionId,taskId]);if(!result.rowCount)throw notFound('Acceptance criterion not found.');const {rows}=await client.query<{id:string}>('SELECT id FROM task_acceptance_criteria WHERE task_id=$1 ORDER BY sort_order,created_at FOR UPDATE',[taskId]);for(let i=0;i<rows.length;i+=1)await client.query('UPDATE task_acceptance_criteria SET sort_order=$1 WHERE id=$2',[i,rows[i]!.id]);await audit(client,'roadmap.acceptance.deleted',{projectId,milestoneId:task.milestone_id,taskId,criterionId});});}

export async function addDependency(db:Db,projectId:string,taskId:string,dependsOnTaskId:string,actorId:string,audit:MutationAudit):Promise<void>{await withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const dependency=await getTask(client,projectId,dependsOnTaskId,true);if(taskId===dependsOnTaskId)throw new AppError('conflict','A task cannot depend on itself.');const cycle=await client.query(`WITH RECURSIVE chain(id) AS (SELECT depends_on_task_id FROM task_dependencies WHERE task_id=$1 UNION SELECT d.depends_on_task_id FROM task_dependencies d JOIN chain c ON d.task_id=c.id) SELECT 1 FROM chain WHERE id=$2 LIMIT 1`,[dependsOnTaskId,taskId]);if(cycle.rowCount)throw new AppError('conflict','This dependency would create a cycle.');try{await client.query('INSERT INTO task_dependencies(task_id,depends_on_task_id,created_by) VALUES($1,$2,$3)',[taskId,dependsOnTaskId,actorId]);}catch(error:any){if(error?.code==='23505')throw new AppError('conflict','This dependency already exists.');throw error;}await audit(client,'roadmap.dependency.added',{projectId,milestoneId:task.milestone_id,taskId,dependsOnTaskId,dependencyMilestoneId:dependency.milestone_id});});}
export async function removeDependency(db:Db,projectId:string,taskId:string,dependsOnTaskId:string,audit:MutationAudit):Promise<void>{await withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const result=await client.query('DELETE FROM task_dependencies WHERE task_id=$1 AND depends_on_task_id=$2',[taskId,dependsOnTaskId]);if(!result.rowCount)throw notFound('Dependency not found.');await audit(client,'roadmap.dependency.removed',{projectId,milestoneId:task.milestone_id,taskId,dependsOnTaskId});});}

export async function addNote(db:Db,projectId:string,taskId:string,actorId:string,body:string,audit:MutationAudit):Promise<string>{return withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const id=randomUUID();await client.query('INSERT INTO task_notes(id,task_id,body,created_by) VALUES($1,$2,$3,$4)',[id,taskId,body,actorId]);await audit(client,'roadmap.note.created',{projectId,milestoneId:task.milestone_id,taskId,noteId:id});return id;});}
export async function updateNote(db:Db,projectId:string,taskId:string,noteId:string,body:string,audit:MutationAudit):Promise<void>{await withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const result=await client.query('UPDATE task_notes SET body=$1 WHERE id=$2 AND task_id=$3 AND deleted_at IS NULL',[body,noteId,taskId]);if(!result.rowCount)throw notFound('Note not found.');await audit(client,'roadmap.note.updated',{projectId,milestoneId:task.milestone_id,taskId,noteId});});}
export async function deleteNote(db:Db,projectId:string,taskId:string,noteId:string,actorId:string,audit:MutationAudit):Promise<void>{await withTransaction(db,async(client)=>{assertProjectMutable(await getProjectGuard(client,projectId,true));const task=await getTask(client,projectId,taskId,true);assertTaskContainerMutable(task);const result=await client.query('UPDATE task_notes SET deleted_at=now(),deleted_by=$1 WHERE id=$2 AND task_id=$3 AND deleted_at IS NULL',[actorId,noteId,taskId]);if(!result.rowCount)throw notFound('Note not found.');await audit(client,'roadmap.note.deleted',{projectId,milestoneId:task.milestone_id,taskId,noteId});});}
