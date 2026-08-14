import { describe, expect, it } from 'vitest';
import { createMilestoneRequestSchema, createTaskRequestSchema, projectRoadmapResponseSchema, updateMilestoneRequestSchema } from './roadmap.js';

describe('roadmap contracts', () => {
  it('requires a reason when a milestone starts blocked', () => {
    expect(createMilestoneRequestSchema.safeParse({ title: 'M', status: 'blocked' }).success).toBe(false);
    expect(createMilestoneRequestSchema.safeParse({ title: 'M', status: 'blocked', blockedReason: 'Waiting' }).success).toBe(true);
  });
  it('does not allow creating a blocked task without the dedicated status flow', () => {
    expect(createTaskRequestSchema.safeParse({ title: 'T', status: 'blocked' }).success).toBe(false);
  });
  it('does not inject create defaults into a partial milestone update', () => {
    expect(updateMilestoneRequestSchema.parse({ title: 'Renamed' })).toEqual({ title: 'Renamed' });
  });
  it('accepts a safe zero-task progress response', () => {
    expect(projectRoadmapResponseSchema.safeParse({ projectId:'00000000-0000-4000-8000-000000000001',readOnly:false,progress:{completed:0,total:0,percentage:0},milestones:[] }).success).toBe(true);
  });
});
