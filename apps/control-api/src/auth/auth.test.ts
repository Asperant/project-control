import { describe, expect, it } from 'vitest';

import {
  hashPassword,
  needsRehash,
  validatePasswordStrength,
  verifyPassword,
  verifyPasswordDummy,
  MIN_PASSWORD_LENGTH,
} from './password.js';
import { generateToken, hashToken, safeEqual, fingerprint } from './tokens.js';
import { assertCsrf, assertOrigin, isSafeMethod, CSRF_HEADER } from './csrf.js';
import { AppError } from '../errors.js';

describe('password hashing', () => {
  it('produces an Argon2id PHC string, never the plaintext', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('correct horse');
  });

  it('produces a different hash each time (unique salt)', async () => {
    const [a, b] = await Promise.all([hashPassword('same-password'), hashPassword('same-password')]);
    expect(a).not.toBe(b);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const hash = await hashPassword('s3cure-passphrase-value');
    expect(await verifyPassword('s3cure-passphrase-value', hash)).toBe(true);
    expect(await verifyPassword('s3cure-passphrase-valuf', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('returns false instead of throwing on a corrupt stored hash', async () => {
    expect(await verifyPassword('anything', 'not-a-phc-string')).toBe(false);
    expect(await verifyPassword('anything', '')).toBe(false);
  });

  it('refuses to hash an empty password', async () => {
    await expect(hashPassword('')).rejects.toThrow();
  });

  it('uses parameters at least as strong as the OWASP Argon2id baseline', async () => {
    const hash = await hashPassword('parameter-check');
    const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(19_456);
    expect(Number(match?.[2])).toBeGreaterThanOrEqual(2);
  });

  it('always returns false from the dummy verifier used for unknown accounts', async () => {
    expect(await verifyPasswordDummy('whatever')).toBe(false);
  });

  it('flags hashes weaker than current policy for rehashing', () => {
    expect(needsRehash('$argon2id$v=19$m=4096,t=1,p=1$abc$def')).toBe(true);
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$abc$def')).toBe(false);
    expect(needsRehash('$2b$12$notargon')).toBe(true);
  });
});

describe('password policy', () => {
  it(`requires at least ${MIN_PASSWORD_LENGTH} characters`, () => {
    expect(validatePasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
    expect(validatePasswordStrength('x'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
  });

  it('rejects an all-whitespace password', () => {
    expect(validatePasswordStrength(' '.repeat(20)).ok).toBe(false);
  });

  it('rejects an absurdly long password to bound hashing cost', () => {
    expect(validatePasswordStrength('x'.repeat(2000)).ok).toBe(false);
  });
});

describe('tokens', () => {
  it('generates high-entropy, url-safe, non-repeating tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateToken()));
    expect(tokens.size).toBe(500);
    for (const t of tokens) {
      expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(t.length).toBeGreaterThanOrEqual(43);
    }
  });

  it('hashes deterministically and does not reveal the token', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });

  it('compares equal and unequal values correctly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    // Different lengths must not throw — the naive timingSafeEqual would.
    expect(safeEqual('short', 'considerably-longer-value')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('fingerprints a user agent irreversibly, or returns null', () => {
    expect(fingerprint(undefined)).toBeNull();
    const fp = fingerprint('Mozilla/5.0 Example');
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
    expect(fp).not.toContain('Mozilla');
  });
});

describe('CSRF', () => {
  const csrfToken = generateToken();
  const sessionCsrfHash = hashToken(csrfToken);

  it('treats GET/HEAD/OPTIONS as safe', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(isSafeMethod(m)).toBe(true);
    }
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isSafeMethod(m)).toBe(false);
    }
  });

  it('allows a safe method with no token at all', () => {
    expect(() =>
      assertCsrf({ method: 'GET', headerValue: undefined, sessionCsrfHash }),
    ).not.toThrow();
  });

  it('accepts a state-changing request carrying the matching token', () => {
    expect(() =>
      assertCsrf({ method: 'POST', headerValue: csrfToken, sessionCsrfHash }),
    ).not.toThrow();
  });

  it('rejects a state-changing request with no token', () => {
    expect(() => assertCsrf({ method: 'POST', headerValue: undefined, sessionCsrfHash })).toThrow(
      AppError,
    );
  });

  it('rejects a token belonging to a different session', () => {
    const otherToken = generateToken();
    expect(() =>
      assertCsrf({ method: 'POST', headerValue: otherToken, sessionCsrfHash }),
    ).toThrow(AppError);
  });

  it('rejects an oversized token instead of hashing it', () => {
    expect(() =>
      assertCsrf({ method: 'DELETE', headerValue: 'x'.repeat(5000), sessionCsrfHash }),
    ).toThrow(AppError);
  });

  it('reports csrf_failed as the error code', () => {
    try {
      assertCsrf({ method: 'POST', headerValue: 'wrong', sessionCsrfHash });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe('csrf_failed');
      expect((error as AppError).statusCode).toBe(403);
    }
  });

  it('names the required header in the missing-header message', () => {
    try {
      assertCsrf({ method: 'POST', headerValue: undefined, sessionCsrfHash });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as AppError).message).toContain(CSRF_HEADER);
    }
  });
});

describe('origin checking', () => {
  it('ignores Origin on safe methods', () => {
    expect(() =>
      assertOrigin({ method: 'GET', origin: 'https://evil.example', host: 'portal.ts.net' }),
    ).not.toThrow();
  });

  it('allows a request with no Origin header (non-browser client)', () => {
    expect(() =>
      assertOrigin({ method: 'POST', origin: undefined, host: 'portal.ts.net' }),
    ).not.toThrow();
  });

  it('allows a same-origin state-changing request', () => {
    expect(() =>
      assertOrigin({ method: 'POST', origin: 'https://portal.ts.net', host: 'portal.ts.net' }),
    ).not.toThrow();
  });

  it('rejects a cross-origin state-changing request', () => {
    expect(() =>
      assertOrigin({ method: 'POST', origin: 'https://evil.example', host: 'portal.ts.net' }),
    ).toThrow(AppError);
  });

  it('rejects a malformed Origin header', () => {
    expect(() =>
      assertOrigin({ method: 'POST', origin: 'not a url', host: 'portal.ts.net' }),
    ).toThrow(AppError);
  });
});
