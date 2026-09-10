import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSecretFile, trimTrailingWhitespace } from './secrets.js';

describe('trimTrailingWhitespace', () => {
  it('strips a single trailing newline', () => {
    expect(trimTrailingWhitespace('secret-value\n')).toBe('secret-value');
  });

  it('strips a trailing CRLF', () => {
    expect(trimTrailingWhitespace('secret-value\r\n')).toBe('secret-value');
  });

  it('strips multiple trailing newlines', () => {
    expect(trimTrailingWhitespace('secret-value\n\n\n')).toBe('secret-value');
  });

  it('strips trailing spaces and tabs', () => {
    expect(trimTrailingWhitespace('secret-value   ')).toBe('secret-value');
    expect(trimTrailingWhitespace('secret-value\t')).toBe('secret-value');
  });

  it('strips a mix of trailing whitespace characters', () => {
    expect(trimTrailingWhitespace('secret-value \t\n \n')).toBe('secret-value');
  });

  it('is a no-op on an already-clean value', () => {
    expect(trimTrailingWhitespace('secret-value')).toBe('secret-value');
  });

  it('never touches leading whitespace', () => {
    expect(trimTrailingWhitespace('  secret-value')).toBe('  secret-value');
    expect(trimTrailingWhitespace('\nsecret-value')).toBe('\nsecret-value');
  });

  it('never touches whitespace in the middle of the value', () => {
    // A passphrase-shaped manual secret legitimately contains internal
    // spaces; only trailing whitespace is ever this function's business.
    expect(trimTrailingWhitespace('correct horse battery staple')).toBe(
      'correct horse battery staple',
    );
    expect(trimTrailingWhitespace('correct horse battery staple\n')).toBe(
      'correct horse battery staple',
    );
  });

  it('never removes a meaningful character from a base64url-shaped token', () => {
    // The alphabet this platform's own tokens are drawn from (see
    // auth/tokens.ts, auth/service-tokens.ts) contains no whitespace at
    // all, so trimming can only ever remove bytes that were never part of
    // the token to begin with.
    const token = 'pcs_AbCdEf01234567890-_ABCDEFghijklmnopqrstuvwxyzZZZZZZZZZ';
    expect(trimTrailingWhitespace(`${token}\n`)).toBe(token);
    expect(trimTrailingWhitespace(token)).toBe(token);
  });

  it('reduces an all-whitespace value to empty', () => {
    expect(trimTrailingWhitespace('\n\n  \t')).toBe('');
  });
});

describe('readSecretFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'pc-secrets-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a clean secret unchanged', () => {
    const file = path.join(dir, 'clean');
    writeFileSync(file, 'a-clean-secret-value');
    expect(readSecretFile(file, 'test secret')).toBe('a-clean-secret-value');
  });

  it('trims a trailing newline a legacy write path or a text editor added', () => {
    const file = path.join(dir, 'trailing-newline');
    writeFileSync(file, 'a-legacy-secret-value\n');
    expect(readSecretFile(file, 'test secret')).toBe('a-legacy-secret-value');
  });

  it('trims a trailing CRLF', () => {
    const file = path.join(dir, 'trailing-crlf');
    writeFileSync(file, 'a-legacy-secret-value\r\n');
    expect(readSecretFile(file, 'test secret')).toBe('a-legacy-secret-value');
  });

  it('throws a descriptive error for a missing file', () => {
    expect(() => readSecretFile(path.join(dir, 'does-not-exist'), 'missing secret')).toThrow(
      /Unable to read missing secret/,
    );
  });

  it('throws for a file that is empty after trimming', () => {
    const file = path.join(dir, 'empty');
    writeFileSync(file, '\n\n  ');
    expect(() => readSecretFile(file, 'empty secret')).toThrow(/empty secret at .* is empty/);
  });

  it('never truncates a multi-line manual secret to its first line', () => {
    // Trimming is trailing-only: a secret that legitimately spans lines (not
    // used today, but nothing here should assume single-line) keeps its
    // internal newlines.
    const file = path.join(dir, 'multiline');
    writeFileSync(file, 'line-one\nline-two\n');
    expect(readSecretFile(file, 'test secret')).toBe('line-one\nline-two');
  });
});
