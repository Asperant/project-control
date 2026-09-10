import { readFileSync } from 'node:fs';

/**
 * Strips trailing whitespace from a secret file's contents — never anything
 * from the start or the middle.
 *
 * `write_secret` (scripts/lib/common.sh) writes a secret's exact bytes with
 * `printf '%s'`, which appends nothing; that has been true since this
 * repository's first commit (verified against its git history while
 * investigating the n8n startup warnings this function exists to make
 * harmless — see docs/service-accounts.md's note on `SEC-006`). A secret
 * file is nonetheless not this platform's own to assume clean: one written
 * before that guarantee existed, or edited by hand outside it, can still
 * carry a trailing newline or space. Trimming defensively here costs
 * nothing when the file is already clean, and quietly fixes the case where
 * it is not — a single trailing `\n`, a `\r\n`, or several of either, not
 * just the one newline byte a plain `echo` would add.
 *
 * `\s` inside a `$`-anchored pattern can only ever match trailing
 * characters, so a secret whose meaningful value legitimately ends in a
 * space is not a real concern this code needs to special-case: none of
 * this platform's own secrets (random tokens, which never contain
 * whitespace at all — see auth/tokens.ts and auth/service-tokens.ts — or
 * the handful of manually entered ones) rely on trailing whitespace being
 * part of their value.
 */
export function trimTrailingWhitespace(value: string): string {
  return value.replace(/\s+$/, '');
}

/** Reads a secret from a file, trimming trailing whitespace. Throws if missing, unreadable, or empty after trimming. */
export function readSecretFile(path: string, label: string): string {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new Error(
      `Unable to read ${label} from ${path}. Ensure the secret exists and is readable by this process.`,
      { cause },
    );
  }
  const value = trimTrailingWhitespace(raw);
  if (value.length === 0) {
    throw new Error(`${label} at ${path} is empty.`);
  }
  return value;
}
