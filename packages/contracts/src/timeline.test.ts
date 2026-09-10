import { describe, expect, it } from 'vitest';
import { timelineEntrySchema, timelineListQuerySchema, timelineListResponseSchema } from './index.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const now = '2026-09-10T10:00:00.000Z';

function entry(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    projectId,
    entityType: 'memory',
    entityId: '00000000-0000-4000-8000-000000000002',
    eventType: 'memory.created',
    summary: 'Memory created: "Deployment restriction"',
    occurredAt: now,
    actorUserId: '00000000-0000-4000-8000-000000000003',
    actorKind: 'user',
    ...overrides,
  };
}

describe('timelineEntrySchema', () => {
  it('accepts a well-formed entry', () => {
    expect(timelineEntrySchema.safeParse(entry()).success).toBe(true);
  });

  it('accepts a project-less, entity-less system entry', () => {
    expect(
      timelineEntrySchema.safeParse(entry({ projectId: null, entityId: null, actorUserId: null, actorKind: 'system' })).success,
    ).toBe(true);
  });

  it('rejects an unknown entityType', () => {
    expect(timelineEntrySchema.safeParse(entry({ entityType: 'widget' })).success).toBe(false);
  });

  it('rejects an unknown eventType', () => {
    expect(timelineEntrySchema.safeParse(entry({ eventType: 'memory.deleted' })).success).toBe(false);
  });

  it('rejects an oversized summary', () => {
    expect(timelineEntrySchema.safeParse(entry({ summary: 'x'.repeat(301) })).success).toBe(false);
  });
});

describe('timelineListQuerySchema', () => {
  it('defaults pageSize and allows no cursor', () => {
    const result = timelineListQuerySchema.parse({});
    expect(result.pageSize).toBe(50);
    expect(result.beforeOccurredAt).toBeUndefined();
  });

  it('accepts a matched before pair', () => {
    expect(
      timelineListQuerySchema.safeParse({ beforeOccurredAt: now, beforeId: '5' }).success,
    ).toBe(true);
  });

  it('rejects a half-supplied cursor', () => {
    expect(timelineListQuerySchema.safeParse({ beforeOccurredAt: now }).success).toBe(false);
    expect(timelineListQuerySchema.safeParse({ beforeId: '5' }).success).toBe(false);
  });
});

describe('timelineListResponseSchema', () => {
  it('accepts an empty page with a null cursor', () => {
    expect(timelineListResponseSchema.safeParse({ entries: [], pageSize: 50, nextCursor: null }).success).toBe(true);
  });

  it('accepts a full page with a cursor', () => {
    expect(
      timelineListResponseSchema.safeParse({
        entries: [entry()], pageSize: 50, nextCursor: { occurredAt: now, id: 42 },
      }).success,
    ).toBe(true);
  });
});
