import { describe, expect, it } from 'vitest';
import { rateLimitKey } from './rate-limit-key.js';

describe('rateLimitKey', () => {
  it('keys a Bearer caller by its token, not its IP', () => {
    const a = rateLimitKey({ headers: { authorization: 'Bearer pcs_sometoken' }, ip: '10.0.0.1' });
    const b = rateLimitKey({ headers: { authorization: 'Bearer pcs_sometoken' }, ip: '10.0.0.99' });
    expect(a).toBe(b);
  });

  it('gives two different tokens two different, independent keys', () => {
    const a = rateLimitKey({ headers: { authorization: 'Bearer pcs_tokenA' }, ip: '10.0.0.1' });
    const b = rateLimitKey({ headers: { authorization: 'Bearer pcs_tokenB' }, ip: '10.0.0.1' });
    expect(a).not.toBe(b);
  });

  it('falls back to req.ip when there is no Authorization header', () => {
    expect(rateLimitKey({ headers: {}, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });

  it('falls back to req.ip for a non-Bearer Authorization header', () => {
    expect(rateLimitKey({ headers: { authorization: 'Basic dXNlcjpwYXNz' }, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });

  it('falls back to req.ip for an empty Bearer value', () => {
    expect(rateLimitKey({ headers: { authorization: 'Bearer ' }, ip: '10.0.0.1' })).toBe('10.0.0.1');
    expect(rateLimitKey({ headers: { authorization: 'Bearer    ' }, ip: '10.0.0.1' })).toBe('10.0.0.1');
  });

  it('never returns the raw token value — only a hash', () => {
    const key = rateLimitKey({ headers: { authorization: 'Bearer pcs_a-very-distinctive-value' }, ip: '10.0.0.1' });
    expect(key).not.toContain('pcs_a-very-distinctive-value');
    expect(key).toMatch(/^svc:[0-9a-f]{64}$/);
  });

  it('is stable across calls (deterministic hash)', () => {
    const first = rateLimitKey({ headers: { authorization: 'Bearer pcs_stable' }, ip: '10.0.0.1' });
    const second = rateLimitKey({ headers: { authorization: 'Bearer pcs_stable' }, ip: '10.0.0.1' });
    expect(first).toBe(second);
  });

  it('tolerates trailing whitespace on the token the same way resolvePrincipal does', () => {
    const clean = rateLimitKey({ headers: { authorization: 'Bearer pcs_x' }, ip: '10.0.0.1' });
    const withNewline = rateLimitKey({ headers: { authorization: 'Bearer pcs_x\n' }, ip: '10.0.0.1' });
    expect(withNewline).toBe(clean);
  });
});
