import { describe, expect, it } from 'vitest';
import {
  createProjectRequestSchema,
  inspectProjectRequestSchema,
  listProjectsQuerySchema,
  updateProjectRequestSchema,
} from './index.js';

describe('inspectProjectRequestSchema', () => {
  it('accepts an absolute-looking path', () => {
    const parsed = inspectProjectRequestSchema.parse({ path: '/home/asrin/Desktop/workspace/demo' });
    expect(parsed.path).toBe('/home/asrin/Desktop/workspace/demo');
  });

  it('rejects an empty path rather than defaulting it', () => {
    expect(inspectProjectRequestSchema.safeParse({ path: '' }).success).toBe(false);
  });

  it('rejects a missing path', () => {
    expect(inspectProjectRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('createProjectRequestSchema', () => {
  const base = { inspectionId: '11111111-1111-4111-8111-111111111111', name: 'Demo' };

  it('accepts a minimal request', () => {
    expect(createProjectRequestSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a well-formed short code', () => {
    const parsed = createProjectRequestSchema.parse({ ...base, shortCode: 'demo-01' });
    expect(parsed.shortCode).toBe('demo-01');
  });

  it('rejects a short code with an uppercase letter', () => {
    expect(createProjectRequestSchema.safeParse({ ...base, shortCode: 'Demo' }).success).toBe(false);
  });

  it('rejects a short code starting with a hyphen', () => {
    expect(createProjectRequestSchema.safeParse({ ...base, shortCode: '-demo' }).success).toBe(false);
  });

  it('rejects status=archived — that transition is a dedicated endpoint', () => {
    expect(createProjectRequestSchema.safeParse({ ...base, status: 'archived' }).success).toBe(false);
  });

  it('rejects a non-uuid inspectionId', () => {
    expect(createProjectRequestSchema.safeParse({ ...base, inspectionId: 'not-a-uuid' }).success).toBe(false);
  });
});

describe('updateProjectRequestSchema', () => {
  it('rejects status=archived — archiving is a dedicated endpoint', () => {
    expect(updateProjectRequestSchema.safeParse({ status: 'archived' }).success).toBe(false);
  });

  it('accepts a partial update with no fields', () => {
    expect(updateProjectRequestSchema.safeParse({}).success).toBe(true);
  });
});

describe('listProjectsQuerySchema', () => {
  it('applies defaults for an empty query', () => {
    const parsed = listProjectsQuerySchema.parse({});
    expect(parsed).toMatchObject({
      includeArchived: false,
      sort: 'updatedAt',
      order: 'desc',
      page: 1,
      pageSize: 20,
    });
  });

  it('coerces string page/pageSize from query-string values', () => {
    const parsed = listProjectsQuerySchema.parse({ page: '3', pageSize: '50' });
    expect(parsed.page).toBe(3);
    expect(parsed.pageSize).toBe(50);
  });

  it('rejects a page size above the cap, closing off an unbounded-scan vector', () => {
    expect(listProjectsQuerySchema.safeParse({ pageSize: '10000' }).success).toBe(false);
  });

  it('rejects a sort field outside the allowlist', () => {
    expect(listProjectsQuerySchema.safeParse({ sort: 'password_hash' }).success).toBe(false);
  });
});
