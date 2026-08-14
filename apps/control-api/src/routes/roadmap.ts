import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  acceptanceCriterionSchema, changeMilestoneStatusRequestSchema, changeTaskStatusRequestSchema,
  createMilestoneRequestSchema, createTaskRequestSchema, criterionCompletionRequestSchema,
  criterionRequestSchema, dependencyRequestSchema, directionRequestSchema, noteRequestSchema,
  taskDetailResponseSchema, updateMilestoneRequestSchema, updateTaskRequestSchema, uuidSchema,
} from '@project-control/contracts';
import type { AppContext } from '../context.js';
import type { AuditEventType } from '../audit.js';
import { AppError, badRequest } from '../errors.js';
import { createRequireAuth, requireRole } from '../auth/middleware.js';
import {
  addCriterion, addDependency, addNote, changeMilestoneStatus, changeTaskStatus, completeCriterion,
  createMilestone, createTask, deleteCriterion, deleteNote, loadRoadmap, loadRoadmapActivity,
  loadTaskDetail, removeDependency, reorderCriterion, reorderMilestone, reorderTask,
  setMilestoneArchived, updateCriterion, updateMilestone, updateNote, updateTask,
  type MutationAudit,
} from '../roadmap/store.js';

function parse<T>(schema:{safeParse:(v:unknown)=>{success:boolean;data?:T;error?:z.ZodError}},value:unknown):T{
  const result=schema.safeParse(value);if(!result.success)throw new AppError('validation_failed','Request body failed validation.',{fields:(result.error?.issues??[]).map((i)=>({path:i.path.join('.'),message:i.message}))});return result.data as T;
}
function ids(request:FastifyRequest):Record<string,string>{
  const values=request.params as Record<string,string>;for(const [name,value] of Object.entries(values)){if(!uuidSchema.safeParse(value).success)throw badRequest(`${name} must be a UUID.`);}return values;
}

export const roadmapRoutes=(ctx:AppContext):FastifyPluginAsync=>async(app)=>{
  const requireAuth=createRequireAuth(ctx);const requireWriter=[requireAuth,requireRole('admin','operator')];
  const auditFor=(request:FastifyRequest):MutationAudit=>async(client,eventType,detail)=>ctx.audit.recordRequired({eventType:eventType as AuditEventType,outcome:'success',actorUserId:request.auth!.user.id,requestId:request.id,subject:`project:${String(detail['projectId'])}`,detail},client);
  const roadmapReply=async(projectId:string)=>loadRoadmap(ctx.db,projectId);
  const detailReply=async(projectId:string,taskId:string)=>({detail:await loadTaskDetail(ctx.db,projectId,taskId)});

  app.get('/api/projects/:projectId/roadmap',{preHandler:requireAuth},async(request,reply)=>{const {projectId}=ids(request);return reply.code(200).send(await roadmapReply(projectId!));});
  app.get('/api/projects/:projectId/roadmap/activity',{preHandler:requireAuth},async(request,reply)=>{const {projectId}=ids(request);return reply.code(200).send({entries:await loadRoadmapActivity(ctx.db,projectId!)});});
  app.post('/api/projects/:projectId/roadmap/milestones',{preHandler:requireWriter},async(request,reply)=>{const {projectId}=ids(request);await createMilestone(ctx.db,projectId!,request.auth!.user.id,parse(createMilestoneRequestSchema,request.body),auditFor(request));return reply.code(201).send(await roadmapReply(projectId!));});
  app.patch('/api/projects/:projectId/roadmap/milestones/:milestoneId',{preHandler:requireWriter},async(request,reply)=>{const {projectId,milestoneId}=ids(request);await updateMilestone(ctx.db,projectId!,milestoneId!,parse(updateMilestoneRequestSchema,request.body),auditFor(request));return reply.send(await roadmapReply(projectId!));});
  app.post('/api/projects/:projectId/roadmap/milestones/:milestoneId/status',{preHandler:requireWriter},async(request,reply)=>{const {projectId,milestoneId}=ids(request);await changeMilestoneStatus(ctx.db,projectId!,milestoneId!,parse(changeMilestoneStatusRequestSchema,request.body),auditFor(request));return reply.send(await roadmapReply(projectId!));});
  app.post('/api/projects/:projectId/roadmap/milestones/:milestoneId/reorder',{preHandler:requireWriter},async(request,reply)=>{const {projectId,milestoneId}=ids(request);const body=parse(directionRequestSchema,request.body);await reorderMilestone(ctx.db,projectId!,milestoneId!,body.direction,auditFor(request));return reply.send(await roadmapReply(projectId!));});
  app.post('/api/projects/:projectId/roadmap/milestones/:milestoneId/archive',{preHandler:requireWriter},async(request,reply)=>{const {projectId,milestoneId}=ids(request);await setMilestoneArchived(ctx.db,projectId!,milestoneId!,true,auditFor(request));return reply.send(await roadmapReply(projectId!));});
  app.post('/api/projects/:projectId/roadmap/milestones/:milestoneId/reactivate',{preHandler:requireWriter},async(request,reply)=>{const {projectId,milestoneId}=ids(request);await setMilestoneArchived(ctx.db,projectId!,milestoneId!,false,auditFor(request));return reply.send(await roadmapReply(projectId!));});
  app.post('/api/projects/:projectId/roadmap/milestones/:milestoneId/tasks',{preHandler:requireWriter},async(request,reply)=>{const {projectId,milestoneId}=ids(request);const taskId=await createTask(ctx.db,projectId!,milestoneId!,request.auth!.user.id,parse(createTaskRequestSchema,request.body),auditFor(request));return reply.code(201).send(await detailReply(projectId!,taskId));});

  app.get('/api/projects/:projectId/roadmap/tasks/:taskId',{preHandler:requireAuth},async(request,reply)=>{const {projectId,taskId}=ids(request);return reply.send(await detailReply(projectId!,taskId!));});
  app.patch('/api/projects/:projectId/roadmap/tasks/:taskId',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId}=ids(request);await updateTask(ctx.db,projectId!,taskId!,parse(updateTaskRequestSchema,request.body),auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});
  app.post('/api/projects/:projectId/roadmap/tasks/:taskId/status',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId}=ids(request);await changeTaskStatus(ctx.db,projectId!,taskId!,parse(changeTaskStatusRequestSchema,request.body),auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});
  app.post('/api/projects/:projectId/roadmap/tasks/:taskId/reorder',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId}=ids(request);const body=parse(directionRequestSchema,request.body);await reorderTask(ctx.db,projectId!,taskId!,body.direction,auditFor(request));return reply.send(await roadmapReply(projectId!));});

  app.post('/api/projects/:projectId/roadmap/tasks/:taskId/criteria',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId}=ids(request);const body=parse(criterionRequestSchema,request.body);await addCriterion(ctx.db,projectId!,taskId!,request.auth!.user.id,body.text,auditFor(request));return reply.code(201).send(await detailReply(projectId!,taskId!));});
  app.patch('/api/projects/:projectId/roadmap/tasks/:taskId/criteria/:criterionId',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId,criterionId}=ids(request);const body=parse(criterionRequestSchema,request.body);await updateCriterion(ctx.db,projectId!,taskId!,criterionId!,body.text,auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});
  app.post('/api/projects/:projectId/roadmap/tasks/:taskId/criteria/:criterionId/completion',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId,criterionId}=ids(request);const body=parse(criterionCompletionRequestSchema,request.body);await completeCriterion(ctx.db,projectId!,taskId!,criterionId!,body.isCompleted,request.auth!.user.id,auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});
  app.post('/api/projects/:projectId/roadmap/tasks/:taskId/criteria/:criterionId/reorder',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId,criterionId}=ids(request);const body=parse(directionRequestSchema,request.body);await reorderCriterion(ctx.db,projectId!,taskId!,criterionId!,body.direction,auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});
  app.delete('/api/projects/:projectId/roadmap/tasks/:taskId/criteria/:criterionId',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId,criterionId}=ids(request);await deleteCriterion(ctx.db,projectId!,taskId!,criterionId!,auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});

  app.post('/api/projects/:projectId/roadmap/tasks/:taskId/dependencies',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId}=ids(request);const body=parse(dependencyRequestSchema,request.body);await addDependency(ctx.db,projectId!,taskId!,body.dependsOnTaskId,request.auth!.user.id,auditFor(request));return reply.code(201).send(await detailReply(projectId!,taskId!));});
  app.delete('/api/projects/:projectId/roadmap/tasks/:taskId/dependencies/:dependsOnTaskId',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId,dependsOnTaskId}=ids(request);await removeDependency(ctx.db,projectId!,taskId!,dependsOnTaskId!,auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});

  app.post('/api/projects/:projectId/roadmap/tasks/:taskId/notes',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId}=ids(request);const body=parse(noteRequestSchema,request.body);await addNote(ctx.db,projectId!,taskId!,request.auth!.user.id,body.body,auditFor(request));return reply.code(201).send(await detailReply(projectId!,taskId!));});
  app.patch('/api/projects/:projectId/roadmap/tasks/:taskId/notes/:noteId',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId,noteId}=ids(request);const body=parse(noteRequestSchema,request.body);await updateNote(ctx.db,projectId!,taskId!,noteId!,body.body,auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});
  app.delete('/api/projects/:projectId/roadmap/tasks/:taskId/notes/:noteId',{preHandler:requireWriter},async(request,reply)=>{const {projectId,taskId,noteId}=ids(request);await deleteNote(ctx.db,projectId!,taskId!,noteId!,request.auth!.user.id,auditFor(request));return reply.send(await detailReply(projectId!,taskId!));});
};
