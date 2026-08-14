import {
  applyRescanResponseSchema,
  artifactSelfTestResponseSchema,
  authSessionResponseSchema,
  deletedResponseSchema,
  errorResponseSchema,
  listProjectsResponseSchema,
  logoutResponseSchema,
  projectActivityResponseSchema,
  projectCommandResponseSchema,
  projectInspectionResponseSchema,
  projectResponseSchema,
  projectRuleResponseSchema,
  projectTechnologyResponseSchema,
  rescanProjectResponseSchema,
  projectRoadmapResponseSchema,
  taskDetailMutationResponseSchema,
  roadmapActivityResponseSchema,
  systemStatusResponseSchema,
  memoryListResponseSchema,
  memoryEntryResponseSchema,
  supersedeMemoryEntryResponseSchema,
  checkpointListResponseSchema,
  checkpointDetailResponseSchema,
  checkpointSummaryResponseSchema,
  projectContextResponseSchema,
  agentRunListResponseSchema,
  agentRunResponseSchema,
  agentRunPromptResponseSchema,
  sendAgentRunPromptResponseSchema,
  agentReportListResponseSchema,
  agentReportResponseSchema,
  finalizeAgentReportResponseSchema,
  agentRunTimelineResponseSchema,
  duplicateAgentRunResponseSchema,
  type AgentRunListResponse,
  type AgentRunResponse,
  type AgentRunPromptResponse,
  type SendAgentRunPromptResponse,
  type AgentReportListResponse,
  type AgentReportResponse,
  type FinalizeAgentReportResponse,
  type AgentRunTimelineResponse,
  type DuplicateAgentRunResponse,
  type AgentRunListQuery,
  type CreateAgentRunRequest,
  type UpdateAgentRunRequest,
  type SetAgentRunStatusRequest,
  type UpsertAgentRunPromptRequest,
  type CreateAgentReportRequest,
  type UpdateAgentReportRequest,
  type UpdateAgentRunValidationRequest,
  type MemoryListResponse,
  type MemoryEntryResponse,
  type SupersedeMemoryEntryResponse,
  type CheckpointListResponse,
  type CheckpointDetailResponse,
  type CheckpointSummaryResponse,
  type ProjectContextResponse,
  type CreateMemoryEntryRequest,
  type UpdateMemoryEntryRequest,
  type SupersedeMemoryEntryRequest,
  type MemoryListQuery,
  type CreateCheckpointRequest,
  type ApplyRescanRequest,
  type ApplyRescanResponse,
  type ArtifactSelfTestResponse,
  type AuthSessionResponse,
  type CreateProjectCommandRequest,
  type CreateProjectRequest,
  type CreateProjectRuleRequest,
  type CreateProjectTechnologyRequest,
  type ErrorCode,
  type InspectProjectRequest,
  type ListProjectsQuery,
  type ListProjectsResponse,
  type ProjectActivityResponse,
  type ProjectInspectionResponse,
  type ProjectResponse,
  type RescanProjectResponse,
  type SystemStatusResponse,
  type ProjectRoadmapResponse,
  type TaskDetailResponse,
  type CreateMilestoneRequest,
  type UpdateMilestoneRequest,
  type ChangeMilestoneStatusRequest,
  type CreateTaskRequest,
  type UpdateTaskRequest,
  type ChangeTaskStatusRequest,
  type UpdateProjectCommandRequest,
  type UpdateProjectRequest,
  type UpdateProjectRuleRequest,
} from '@project-control/contracts';

/**
 * Control API client.
 *
 * Everything goes through `/api`, a same-origin path that Caddy proxies. There
 * is no configurable base URL and no cross-origin request anywhere in the panel:
 * the browser only ever talks to the host it loaded the page from, which is what
 * lets the session cookie be `SameSite=Strict`.
 *
 * Responses are parsed with the shared contract schemas rather than cast. A
 * backend that returns an unexpected shape produces a clean error here instead
 * of an undefined-property crash three components deep.
 */

export class ApiError extends Error {
  constructor(
    readonly code: ErrorCode | 'network_error' | 'malformed_response',
    message: string,
    readonly status?: number,
    readonly requestId?: string,
    readonly confirmation?: { kind: 'incomplete_acceptance' | 'incomplete_dependencies'; count: number },
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** True when the user needs to sign in again. */
  get isAuthFailure(): boolean {
    return this.code === 'unauthorized';
  }

  /** True when the API could not be reached at all (Caddy or API down). */
  get isConnectivityFailure(): boolean {
    return this.code === 'network_error' || this.code === 'service_unavailable';
  }
}

/**
 * The CSRF token lives in a module variable, not localStorage or sessionStorage.
 *
 * Web storage is readable by any script on the origin, which would hand the
 * token to an XSS payload — exactly the attack the token is meant to survive.
 * Keeping it in memory means a page reload loses it, so the panel re-fetches it
 * from `/api/auth/me` on mount.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

export function getCsrfToken(): string | null {
  return csrfToken;
}

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
};

async function request<T>(
  path: string,
  schema: { parse: (v: unknown) => T },
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = { accept: 'application/json' };

  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  // Only state-changing requests carry the token; sending it on GETs would put
  // it in more places than necessary for no benefit.
  if (method !== 'GET' && csrfToken) {
    headers['x-csrf-token'] = csrfToken;
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      // Required for the session cookie on same-origin requests when the
      // request is issued by fetch rather than by navigation.
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError(
      'network_error',
      'Cannot reach the Control API. The backend may be starting, stopped, or unreachable through Caddy.',
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      'malformed_response',
      `The server returned a non-JSON response (HTTP ${response.status}).`,
      response.status,
    );
  }

  if (!response.ok) {
    const parsed = errorResponseSchema.safeParse(payload);
    if (parsed.success) {
      throw new ApiError(
        parsed.data.error.code,
        parsed.data.error.message,
        response.status,
        parsed.data.requestId,
        parsed.data.error.confirmation,
      );
    }
    throw new ApiError(
      'malformed_response',
      `Request failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  try {
    return schema.parse(payload);
  } catch {
    throw new ApiError(
      'malformed_response',
      'The server response did not match the expected shape.',
      response.status,
    );
  }
}

export const api = {
  async login(email: string, password: string): Promise<AuthSessionResponse> {
    const session = await request('/api/auth/login', authSessionResponseSchema, {
      method: 'POST',
      body: { email, password },
    });
    setCsrfToken(session.csrfToken);
    return session;
  },

  async me(signal?: AbortSignal): Promise<AuthSessionResponse> {
    const session = await request(
      '/api/auth/me',
      authSessionResponseSchema,
      signal ? { signal } : {},
    );
    // `/me` mints a fresh CSRF token on every call, which is how the panel
    // recovers a usable token after a reload.
    setCsrfToken(session.csrfToken);
    return session;
  },

  async logout(): Promise<void> {
    try {
      await request('/api/auth/logout', logoutResponseSchema, { method: 'POST' });
    } finally {
      // The local token is discarded even if the server call failed, so the UI
      // cannot be left believing it still holds a valid session.
      setCsrfToken(null);
    }
  },

  systemStatus(signal?: AbortSignal): Promise<SystemStatusResponse> {
    return request('/api/system/status', systemStatusResponseSchema, signal ? { signal } : {});
  },

  artifactSelfTest(): Promise<ArtifactSelfTestResponse> {
    return request('/api/artifacts/self-test', artifactSelfTestResponseSchema, { method: 'POST' });
  },

  // --- Projects --------------------------------------------------------------

  inspectProject(body: InspectProjectRequest): Promise<ProjectInspectionResponse> {
    return request('/api/projects/inspections', projectInspectionResponseSchema, { method: 'POST', body });
  },

  getInspection(inspectionId: string): Promise<ProjectInspectionResponse> {
    return request(`/api/projects/inspections/${inspectionId}`, projectInspectionResponseSchema);
  },

  createProject(body: CreateProjectRequest): Promise<ProjectResponse> {
    return request('/api/projects', projectResponseSchema, { method: 'POST', body });
  },

  listProjects(query: Partial<ListProjectsQuery> = {}, signal?: AbortSignal): Promise<ListProjectsResponse> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return request(`/api/projects${qs ? `?${qs}` : ''}`, listProjectsResponseSchema, signal ? { signal } : {});
  },

  getProject(id: string, signal?: AbortSignal): Promise<ProjectResponse> {
    return request(`/api/projects/${id}`, projectResponseSchema, signal ? { signal } : {});
  },

  updateProject(id: string, body: UpdateProjectRequest): Promise<ProjectResponse> {
    return request(`/api/projects/${id}`, projectResponseSchema, { method: 'PATCH', body });
  },

  archiveProject(id: string): Promise<ProjectResponse> {
    return request(`/api/projects/${id}/archive`, projectResponseSchema, { method: 'POST' });
  },

  reactivateProject(id: string): Promise<ProjectResponse> {
    return request(`/api/projects/${id}/reactivate`, projectResponseSchema, { method: 'POST' });
  },

  getProjectActivity(id: string): Promise<ProjectActivityResponse> {
    return request(`/api/projects/${id}/activity`, projectActivityResponseSchema);
  },

  addProjectRule(id: string, body: CreateProjectRuleRequest) {
    return request(`/api/projects/${id}/rules`, projectRuleResponseSchema, { method: 'POST', body });
  },

  updateProjectRule(id: string, ruleId: string, body: UpdateProjectRuleRequest) {
    return request(`/api/projects/${id}/rules/${ruleId}`, projectRuleResponseSchema, { method: 'PATCH', body });
  },

  deleteProjectRule(id: string, ruleId: string) {
    return request(`/api/projects/${id}/rules/${ruleId}`, deletedResponseSchema, { method: 'DELETE' });
  },

  addProjectTechnology(id: string, body: CreateProjectTechnologyRequest) {
    return request(`/api/projects/${id}/technologies`, projectTechnologyResponseSchema, { method: 'POST', body });
  },

  deleteProjectTechnology(id: string, technologyId: string) {
    return request(`/api/projects/${id}/technologies/${technologyId}`, deletedResponseSchema, { method: 'DELETE' });
  },

  addProjectCommand(id: string, body: CreateProjectCommandRequest) {
    return request(`/api/projects/${id}/commands`, projectCommandResponseSchema, { method: 'POST', body });
  },

  updateProjectCommand(id: string, commandId: string, body: UpdateProjectCommandRequest) {
    return request(`/api/projects/${id}/commands/${commandId}`, projectCommandResponseSchema, { method: 'PATCH', body });
  },

  deleteProjectCommand(id: string, commandId: string) {
    return request(`/api/projects/${id}/commands/${commandId}`, deletedResponseSchema, { method: 'DELETE' });
  },

  rescanProject(id: string): Promise<RescanProjectResponse> {
    return request(`/api/projects/${id}/rescan`, rescanProjectResponseSchema, { method: 'POST' });
  },

  applyRescan(id: string, body: ApplyRescanRequest): Promise<ApplyRescanResponse> {
    return request(`/api/projects/${id}/rescan/apply`, applyRescanResponseSchema, { method: 'POST', body });
  },

  getRoadmap(projectId:string,signal?:AbortSignal):Promise<ProjectRoadmapResponse>{return request(`/api/projects/${projectId}/roadmap`,projectRoadmapResponseSchema,signal?{signal}:{});},
  getRoadmapActivity(projectId:string){return request(`/api/projects/${projectId}/roadmap/activity`,roadmapActivityResponseSchema);},
  createMilestone(projectId:string,body:CreateMilestoneRequest){return request(`/api/projects/${projectId}/roadmap/milestones`,projectRoadmapResponseSchema,{method:'POST',body});},
  updateMilestone(projectId:string,milestoneId:string,body:UpdateMilestoneRequest){return request(`/api/projects/${projectId}/roadmap/milestones/${milestoneId}`,projectRoadmapResponseSchema,{method:'PATCH',body});},
  changeMilestoneStatus(projectId:string,milestoneId:string,body:ChangeMilestoneStatusRequest){return request(`/api/projects/${projectId}/roadmap/milestones/${milestoneId}/status`,projectRoadmapResponseSchema,{method:'POST',body});},
  reorderMilestone(projectId:string,milestoneId:string,direction:'up'|'down'){return request(`/api/projects/${projectId}/roadmap/milestones/${milestoneId}/reorder`,projectRoadmapResponseSchema,{method:'POST',body:{direction}});},
  archiveMilestone(projectId:string,milestoneId:string){return request(`/api/projects/${projectId}/roadmap/milestones/${milestoneId}/archive`,projectRoadmapResponseSchema,{method:'POST'});},
  reactivateMilestone(projectId:string,milestoneId:string){return request(`/api/projects/${projectId}/roadmap/milestones/${milestoneId}/reactivate`,projectRoadmapResponseSchema,{method:'POST'});},
  createRoadmapTask(projectId:string,milestoneId:string,body:CreateTaskRequest){return request(`/api/projects/${projectId}/roadmap/milestones/${milestoneId}/tasks`,taskDetailMutationResponseSchema,{method:'POST',body});},
  getRoadmapTask(projectId:string,taskId:string,signal?:AbortSignal):Promise<{detail:TaskDetailResponse}>{return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}`,taskDetailMutationResponseSchema,signal?{signal}:{});},
  updateRoadmapTask(projectId:string,taskId:string,body:UpdateTaskRequest){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}`,taskDetailMutationResponseSchema,{method:'PATCH',body});},
  changeRoadmapTaskStatus(projectId:string,taskId:string,body:ChangeTaskStatusRequest){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/status`,taskDetailMutationResponseSchema,{method:'POST',body});},
  reorderRoadmapTask(projectId:string,taskId:string,direction:'up'|'down'){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/reorder`,projectRoadmapResponseSchema,{method:'POST',body:{direction}});},
  addCriterion(projectId:string,taskId:string,text:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/criteria`,taskDetailMutationResponseSchema,{method:'POST',body:{text}});},
  updateCriterion(projectId:string,taskId:string,criterionId:string,text:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/criteria/${criterionId}`,taskDetailMutationResponseSchema,{method:'PATCH',body:{text}});},
  completeCriterion(projectId:string,taskId:string,criterionId:string,isCompleted:boolean){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/criteria/${criterionId}/completion`,taskDetailMutationResponseSchema,{method:'POST',body:{isCompleted}});},
  reorderCriterion(projectId:string,taskId:string,criterionId:string,direction:'up'|'down'){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/criteria/${criterionId}/reorder`,taskDetailMutationResponseSchema,{method:'POST',body:{direction}});},
  deleteCriterion(projectId:string,taskId:string,criterionId:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/criteria/${criterionId}`,taskDetailMutationResponseSchema,{method:'DELETE'});},
  addDependency(projectId:string,taskId:string,dependsOnTaskId:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/dependencies`,taskDetailMutationResponseSchema,{method:'POST',body:{dependsOnTaskId}});},
  removeDependency(projectId:string,taskId:string,dependsOnTaskId:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/dependencies/${dependsOnTaskId}`,taskDetailMutationResponseSchema,{method:'DELETE'});},
  addNote(projectId:string,taskId:string,body:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/notes`,taskDetailMutationResponseSchema,{method:'POST',body:{body}});},
  updateNote(projectId:string,taskId:string,noteId:string,body:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/notes/${noteId}`,taskDetailMutationResponseSchema,{method:'PATCH',body:{body}});},
  deleteNote(projectId:string,taskId:string,noteId:string){return request(`/api/projects/${projectId}/roadmap/tasks/${taskId}/notes/${noteId}`,taskDetailMutationResponseSchema,{method:'DELETE'});},

  // --- Memory ------------------------------------------------------------------
  listMemory(projectId:string,query:Partial<MemoryListQuery> = {},signal?:AbortSignal):Promise<MemoryListResponse>{
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(query)){if(value===undefined||value==='')continue;params.set(key,String(value));}
    const qs=params.toString();
    return request(`/api/projects/${projectId}/memory${qs?`?${qs}`:''}`,memoryListResponseSchema,signal?{signal}:{});
  },
  getMemoryEntry(projectId:string,entryId:string):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/memory/${entryId}`,memoryEntryResponseSchema);},
  createMemoryEntry(projectId:string,body:CreateMemoryEntryRequest):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/memory`,memoryEntryResponseSchema,{method:'POST',body});},
  updateMemoryEntry(projectId:string,entryId:string,body:UpdateMemoryEntryRequest):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/memory/${entryId}`,memoryEntryResponseSchema,{method:'PATCH',body});},
  pinMemoryEntry(projectId:string,entryId:string):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/memory/${entryId}/pin`,memoryEntryResponseSchema,{method:'POST'});},
  unpinMemoryEntry(projectId:string,entryId:string):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/memory/${entryId}/unpin`,memoryEntryResponseSchema,{method:'POST'});},
  archiveMemoryEntry(projectId:string,entryId:string):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/memory/${entryId}/archive`,memoryEntryResponseSchema,{method:'POST'});},
  reactivateMemoryEntry(projectId:string,entryId:string):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/memory/${entryId}/reactivate`,memoryEntryResponseSchema,{method:'POST'});},
  supersedeMemoryEntry(projectId:string,entryId:string,body:SupersedeMemoryEntryRequest):Promise<SupersedeMemoryEntryResponse>{return request(`/api/projects/${projectId}/memory/${entryId}/supersede`,supersedeMemoryEntryResponseSchema,{method:'POST',body});},

  // --- Checkpoints ---------------------------------------------------------------
  listCheckpoints(projectId:string,archived=false,signal?:AbortSignal):Promise<CheckpointListResponse>{return request(`/api/projects/${projectId}/checkpoints${archived?'?archived=true':''}`,checkpointListResponseSchema,signal?{signal}:{});},
  getCheckpoint(projectId:string,checkpointId:string):Promise<CheckpointDetailResponse>{return request(`/api/projects/${projectId}/checkpoints/${checkpointId}`,checkpointDetailResponseSchema);},
  createCheckpoint(projectId:string,body:CreateCheckpointRequest):Promise<CheckpointDetailResponse>{return request(`/api/projects/${projectId}/checkpoints`,checkpointDetailResponseSchema,{method:'POST',body});},
  archiveCheckpoint(projectId:string,checkpointId:string):Promise<CheckpointSummaryResponse>{return request(`/api/projects/${projectId}/checkpoints/${checkpointId}/archive`,checkpointSummaryResponseSchema,{method:'POST'});},

  // --- Current context / "Where was I?" -------------------------------------------
  getProjectContext(projectId:string,signal?:AbortSignal):Promise<ProjectContextResponse>{return request(`/api/projects/${projectId}/context`,projectContextResponseSchema,signal?{signal}:{});},

  // --- Agent Runs ----------------------------------------------------------------
  listAgentRuns(projectId:string,query:Partial<AgentRunListQuery> = {},signal?:AbortSignal):Promise<AgentRunListResponse>{
    const params=new URLSearchParams();
    for(const [key,value] of Object.entries(query)){if(value===undefined||value==='')continue;params.set(key,String(value));}
    const qs=params.toString();
    return request(`/api/projects/${projectId}/agent-runs${qs?`?${qs}`:''}`,agentRunListResponseSchema,signal?{signal}:{});
  },
  getAgentRun(projectId:string,runId:string,signal?:AbortSignal):Promise<AgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}`,agentRunResponseSchema,signal?{signal}:{});},
  createAgentRun(projectId:string,body:CreateAgentRunRequest):Promise<AgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs`,agentRunResponseSchema,{method:'POST',body});},
  updateAgentRun(projectId:string,runId:string,body:UpdateAgentRunRequest):Promise<AgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}`,agentRunResponseSchema,{method:'PATCH',body});},
  setAgentRunStatus(projectId:string,runId:string,body:SetAgentRunStatusRequest):Promise<AgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/status`,agentRunResponseSchema,{method:'POST',body});},
  archiveAgentRun(projectId:string,runId:string):Promise<AgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/archive`,agentRunResponseSchema,{method:'POST'});},
  reactivateAgentRun(projectId:string,runId:string):Promise<AgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/reactivate`,agentRunResponseSchema,{method:'POST'});},
  duplicateAgentRun(projectId:string,runId:string):Promise<DuplicateAgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/duplicate`,duplicateAgentRunResponseSchema,{method:'POST'});},

  getAgentRunPrompt(projectId:string,runId:string,signal?:AbortSignal):Promise<AgentRunPromptResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/prompt`,agentRunPromptResponseSchema,signal?{signal}:{});},
  updateAgentRunPrompt(projectId:string,runId:string,body:UpsertAgentRunPromptRequest):Promise<AgentRunPromptResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/prompt`,agentRunPromptResponseSchema,{method:'PATCH',body});},
  sendAgentRunPrompt(projectId:string,runId:string):Promise<SendAgentRunPromptResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/prompt/send`,sendAgentRunPromptResponseSchema,{method:'POST'});},

  listAgentReports(projectId:string,runId:string,signal?:AbortSignal):Promise<AgentReportListResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/reports`,agentReportListResponseSchema,signal?{signal}:{});},
  createAgentReport(projectId:string,runId:string,body:CreateAgentReportRequest):Promise<AgentReportResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/reports`,agentReportResponseSchema,{method:'POST',body});},
  updateAgentReport(projectId:string,runId:string,reportId:string,body:UpdateAgentReportRequest):Promise<AgentReportResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/reports/${reportId}`,agentReportResponseSchema,{method:'PATCH',body});},
  finalizeAgentReport(projectId:string,runId:string,reportId:string):Promise<FinalizeAgentReportResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/reports/${reportId}/finalize`,finalizeAgentReportResponseSchema,{method:'POST'});},

  updateAgentRunValidation(projectId:string,runId:string,body:UpdateAgentRunValidationRequest):Promise<AgentRunResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/validation`,agentRunResponseSchema,{method:'PATCH',body});},

  getAgentRunTimeline(projectId:string,runId:string,signal?:AbortSignal):Promise<AgentRunTimelineResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/timeline`,agentRunTimelineResponseSchema,signal?{signal}:{});},
  getRelatedMemory(projectId:string,runId:string,signal?:AbortSignal):Promise<MemoryListResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/related-memory`,memoryListResponseSchema,signal?{signal}:{});},
  promoteAgentRunToMemory(projectId:string,runId:string,body:CreateMemoryEntryRequest):Promise<MemoryEntryResponse>{return request(`/api/projects/${projectId}/agent-runs/${runId}/promote-memory`,memoryEntryResponseSchema,{method:'POST',body});},
};
