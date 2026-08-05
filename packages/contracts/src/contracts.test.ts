import { describe, expect, it } from 'vitest';
import {
  artifactSelfTestResponseSchema,
  errorCodeStatus,
  errorResponseSchema,
  loginRequestSchema,
  sha256Schema,
  systemStatusResponseSchema,
} from './index.js';

describe('sha256Schema', () => {
  it('accepts a lowercase 64-char hex digest', () => {
    expect(sha256Schema.parse('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('rejects uppercase hex so path derivation stays canonical', () => {
    expect(sha256Schema.safeParse('A'.repeat(64)).success).toBe(false);
  });

  it.each([63, 65])('rejects a digest of length %i', (len) => {
    expect(sha256Schema.safeParse('a'.repeat(len)).success).toBe(false);
  });

  it('rejects path separators smuggled into a digest', () => {
    expect(sha256Schema.safeParse(`../${'a'.repeat(61)}`).success).toBe(false);
  });
});

describe('loginRequestSchema', () => {
  it('normalises the email to lowercase and trims whitespace', () => {
    const parsed = loginRequestSchema.parse({
      email: '  Admin@Example.COM ',
      password: 'correct horse battery staple',
    });
    expect(parsed.email).toBe('admin@example.com');
  });

  it('caps password length to bound Argon2id work per request', () => {
    const result = loginRequestSchema.safeParse({
      email: 'a@b.co',
      password: 'x'.repeat(1025),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing password rather than defaulting it', () => {
    expect(loginRequestSchema.safeParse({ email: 'a@b.co' }).success).toBe(false);
  });
});

describe('errorResponseSchema', () => {
  it('round-trips a validation error with field detail', () => {
    const payload = {
      error: {
        code: 'validation_failed' as const,
        message: 'Request body failed validation.',
        fields: [{ path: 'email', message: 'Invalid email' }],
      },
      requestId: 'req_12345678',
    };
    expect(errorResponseSchema.parse(payload)).toEqual(payload);
  });

  it('maps every error code to an HTTP status', () => {
    for (const code of Object.keys(errorCodeStatus)) {
      expect(errorCodeStatus[code as keyof typeof errorCodeStatus]).toBeGreaterThanOrEqual(400);
    }
  });
});

describe('systemStatusResponseSchema', () => {
  it('accepts a manual_configuration_required component', () => {
    const parsed = systemStatusResponseSchema.parse({
      stackVersion: '1.0.0',
      environment: 'production',
      generatedAt: '2026-08-04T12:00:00.000Z',
      overall: 'degraded',
      components: [
        {
          id: 'backup',
          label: 'Backup',
          status: 'manual_configuration_required',
          detail: 'Google Drive OAuth not completed.',
          checkedAt: '2026-08-04T12:00:00.000Z',
        },
      ],
    });
    expect(parsed.components[0]?.status).toBe('manual_configuration_required');
  });
});

describe('artifactSelfTestResponseSchema', () => {
  it('requires a digest even on a failed run', () => {
    const result = artifactSelfTestResponseSchema.safeParse({
      ok: false,
      sizeBytes: 0,
      deduplicated: false,
      steps: [],
      totalDurationMs: 1,
    });
    expect(result.success).toBe(false);
  });
});
