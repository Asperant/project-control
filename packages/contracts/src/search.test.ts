import { describe, expect, it } from 'vitest';
import { searchQuerySchema, searchResponseSchema, searchResultSchema } from './index.js';

const projectId = '00000000-0000-4000-8000-000000000001';
const entityId = '00000000-0000-4000-8000-000000000002';

describe('searchQuerySchema', () => {
  it('accepts a bare query and defaults limit', () => {
    const result = searchQuerySchema.parse({ q: 'deployment' });
    expect(result.limit).toBe(20);
  });

  it('rejects an empty query', () => {
    expect(searchQuerySchema.safeParse({ q: '' }).success).toBe(false);
    expect(searchQuerySchema.safeParse({ q: '   ' }).success).toBe(false);
  });

  it('rejects an unknown entity type filter', () => {
    expect(searchQuerySchema.safeParse({ q: 'x', type: 'widget' }).success).toBe(false);
  });

  it('rejects a limit above the ceiling', () => {
    expect(searchQuerySchema.safeParse({ q: 'x', limit: 51 }).success).toBe(false);
  });
});

describe('searchResultSchema', () => {
  it('accepts a project-scoped result with a segmented snippet', () => {
    expect(
      searchResultSchema.safeParse({
        entityType: 'memory', entityId, projectId, projectName: 'Timeline Rollout',
        title: 'Deployment restriction',
        snippet: [{ text: 'No deploys after 5pm on ', matched: false }, { text: 'Fridays', matched: true }, { text: '.', matched: false }],
      }).success,
    ).toBe(true);
  });

  it('rejects a snippet carrying a raw HTML string instead of segments', () => {
    expect(
      searchResultSchema.safeParse({
        entityType: 'memory', entityId, projectId: null, projectName: null,
        title: 'x', snippet: '<b>Fridays</b>',
      }).success,
    ).toBe(false);
  });

  it('rejects a snippet over the segment-count cap', () => {
    expect(
      searchResultSchema.safeParse({
        entityType: 'memory', entityId, projectId: null, projectName: null,
        title: 'x', snippet: Array.from({ length: 41 }, () => ({ text: 'x', matched: false })),
      }).success,
    ).toBe(false);
  });
});

describe('searchResponseSchema', () => {
  it('accepts an empty result set', () => {
    expect(searchResponseSchema.safeParse({ query: 'nothing', results: [] }).success).toBe(true);
  });
});
