import { describe, expect, it } from 'vitest';
import {
  revokeServiceTokenResponseSchema,
  serviceScopeSchema,
  serviceTokenListResponseSchema,
  serviceTokenSummarySchema,
} from './index.js';

const accountId = '00000000-0000-4000-8000-000000000001';
const tokenId = '00000000-0000-4000-8000-000000000002';
const now = '2026-08-16T10:00:00.000Z';

function summary(overrides: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...overrides };
}

function base() {
  return {
    id: tokenId,
    accountId,
    accountKey: 'n8n-automation',
    prefix: 'pcs_ab12cd34',
    scopes: ['automation:run', 'project:read'] as const,
    expiresAt: now,
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
  };
}

describe('service scope', () => {
  it('accepts every declared scope', () => {
    for (const scope of [
      'automation:run', 'project:read', 'project:rescan', 'action:plan', 'system:read', 'report:write',
    ]) {
      expect(serviceScopeSchema.safeParse(scope).success).toBe(true);
    }
  });

  it('rejects an unknown scope', () => {
    expect(serviceScopeSchema.safeParse('action:execute').success).toBe(false);
    expect(serviceScopeSchema.safeParse('*:apply').success).toBe(false);
  });
});

describe('service token summary', () => {
  it('accepts a well-formed summary', () => {
    expect(serviceTokenSummarySchema.safeParse(summary()).success).toBe(true);
  });

  it('accepts a revoked token', () => {
    expect(serviceTokenSummarySchema.safeParse(summary({ revokedAt: now })).success).toBe(true);
  });

  it('rejects a prefix without the pcs_ shape', () => {
    expect(serviceTokenSummarySchema.safeParse(summary({ prefix: 'session_abc' })).success).toBe(false);
  });

  it('rejects an empty scopes array', () => {
    expect(serviceTokenSummarySchema.safeParse(summary({ scopes: [] })).success).toBe(false);
  });

  it('never has a field for the token value itself', () => {
    const parsed = summary() as Record<string, unknown>;
    expect(parsed['token']).toBeUndefined();
    expect(parsed['value']).toBeUndefined();
    expect(parsed['secret']).toBeUndefined();
  });

  it('rejects an unknown extra field (strict)', () => {
    expect(serviceTokenSummarySchema.safeParse({ ...summary(), extra: 'nope' }).success).toBe(false);
  });
});

describe('service token list/revoke responses', () => {
  it('accepts a list of summaries', () => {
    expect(serviceTokenListResponseSchema.safeParse({ tokens: [summary(), summary({ id: accountId })] }).success).toBe(true);
  });

  it('accepts an empty list', () => {
    expect(serviceTokenListResponseSchema.safeParse({ tokens: [] }).success).toBe(true);
  });

  it('accepts a revoke response', () => {
    expect(revokeServiceTokenResponseSchema.safeParse({ token: summary({ revokedAt: now }) }).success).toBe(true);
  });
});
