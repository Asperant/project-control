import { describe, expect, it } from 'vitest';
import { generateServiceToken, looksLikeServiceToken } from './service-tokens.js';

describe('service tokens', () => {
  it('generates high-entropy, prefixed, non-repeating tokens', () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateServiceToken().token));
    expect(tokens.size).toBe(500);
    for (const t of tokens) {
      expect(t.startsWith('pcs_')).toBe(true);
      expect(t).toMatch(/^pcs_[A-Za-z0-9_-]+$/);
    }
  });

  it('hashes deterministically and never reveals the token', () => {
    const generated = generateServiceToken();
    expect(generated.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(generated.tokenHash).not.toContain(generated.token);
  });

  it('derives a short display prefix that does not carry the full token', () => {
    const generated = generateServiceToken();
    expect(generated.prefix.startsWith('pcs_')).toBe(true);
    expect(generated.prefix.length).toBeLessThan(generated.token.length);
    expect(generated.token.startsWith(generated.prefix)).toBe(true);
  });

  it('recognises the pcs_ shape without touching the database', () => {
    expect(looksLikeServiceToken('pcs_abc123')).toBe(true);
    expect(looksLikeServiceToken('pc_session_cookie_value')).toBe(false);
    expect(looksLikeServiceToken('')).toBe(false);
    expect(looksLikeServiceToken(`pcs_${'x'.repeat(300)}`)).toBe(false);
  });
});
