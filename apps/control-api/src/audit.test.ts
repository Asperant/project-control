import { describe, expect, it } from 'vitest';
import { sanitiseDetail } from './audit.js';

describe('audit detail sanitisation', () => {
  it('redacts obviously secret keys', () => {
    const out = sanitiseDetail({
      password: 'hunter2',
      passwordHash: '$argon2id$...',
      token: 'abc',
      csrfToken: 'def',
      secret: 'shh',
      api_key: 'k',
      cookie: 'pc_session=xyz',
      authorization: 'Bearer xyz',
    });

    for (const value of Object.values(out)) {
      expect(value).toBe('[redacted]');
    }
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('argon2id');
  });

  it('redacts secret keys regardless of casing or separators', () => {
    const out = sanitiseDetail({
      PASSWORD: 'x',
      'Password-Hash': 'y',
      session_token: 'z',
      EncryptionKey: 'w',
    });
    expect(Object.values(out).every((v) => v === '[redacted]')).toBe(true);
  });

  it('preserves benign structured context', () => {
    const out = sanitiseDetail({
      sessionId: '0d5f2c1e',
      consecutiveFailures: 3,
      locked: true,
      reason: 'bad_password',
      missing: null,
    });
    expect(out).toEqual({
      sessionId: '0d5f2c1e',
      consecutiveFailures: 3,
      locked: true,
      reason: 'bad_password',
      missing: null,
    });
  });

  it('recurses into nested objects', () => {
    const out = sanitiseDetail({ outer: { inner: { password: 'leak', keep: 'ok' } } });
    const outer = out['outer'] as Record<string, unknown>;
    const inner = outer['inner'] as Record<string, unknown>;
    expect(inner['password']).toBe('[redacted]');
    expect(inner['keep']).toBe('ok');
  });

  it('truncates long strings so one event cannot bloat the table', () => {
    const out = sanitiseDetail({ note: 'x'.repeat(5000) });
    expect(String(out['note']).length).toBeLessThanOrEqual(513);
  });

  it('caps array length and recursion depth', () => {
    const out = sanitiseDetail({ items: Array.from({ length: 100 }, (_, i) => i) });
    expect((out['items'] as unknown[]).length).toBe(20);

    let deep: Record<string, unknown> = { password: 'leak' };
    for (let i = 0; i < 10; i += 1) deep = { nested: deep };
    const sanitised = JSON.stringify(sanitiseDetail(deep));
    expect(sanitised).not.toContain('leak');
  });

  it('stringifies unexpected value types rather than dropping them', () => {
    const out = sanitiseDetail({ when: 12345n as unknown as number });
    expect(typeof out['when']).toBe('string');
  });
});
