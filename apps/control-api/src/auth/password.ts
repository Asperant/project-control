import { hash, verify } from '@node-rs/argon2';

/**
 * `Algorithm.Argon2id` from @node-rs/argon2.
 *
 * The package declares `Algorithm` as an *ambient const enum*, which cannot be
 * imported as a value under `verbatimModuleSyntax`/`isolatedModules` (there is
 * no runtime object to import — the compiler is expected to inline it). The
 * numeric value is part of the package's public API and is asserted in
 * auth.test.ts by checking that the produced PHC string is `$argon2id$`.
 */
const ARGON2_ID = 2;

/**
 * Argon2id parameters.
 *
 * Chosen from the OWASP Password Storage Cheat Sheet's Argon2id recommendation
 * (m=19456 KiB, t=2, p=1), which is the configuration tuned to resist GPU
 * cracking while staying under ~100 ms on server hardware. Memory cost is the
 * parameter that actually hurts attackers, so it is raised rather than the
 * iteration count.
 *
 * These values are embedded in the resulting PHC string, so raising them later
 * does not invalidate existing hashes — `verify` reads the parameters from the
 * stored hash. `needsRehash` detects the drift.
 */
export const ARGON2_OPTIONS = {
  algorithm: ARGON2_ID,
  memoryCost: 19_456, // KiB
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
} as const;

/**
 * A precomputed hash of an unguessable value.
 *
 * Used to burn equivalent CPU time when the supplied email matches no account.
 * Without it, "unknown user" returns in microseconds while "wrong password"
 * takes ~50 ms, and that timing gap is a reliable account-enumeration oracle
 * even though both paths return an identical HTTP response.
 */
let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hash(
    'a-value-that-is-never-a-real-password-0d5f2c1e8b7a4936',
    ARGON2_OPTIONS,
  );
  return dummyHashPromise;
}

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length === 0) {
    throw new Error('Refusing to hash an empty password.');
  }
  return hash(plaintext, ARGON2_OPTIONS);
}

/**
 * Verifies a password against a stored PHC hash.
 *
 * Returns `false` rather than throwing on a malformed hash: a corrupt row must
 * deny access, not crash the login route.
 */
export async function verifyPassword(plaintext: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, plaintext, ARGON2_OPTIONS);
  } catch {
    return false;
  }
}

/**
 * Spends the same work as a real verification, for the no-such-user path.
 * Always returns false.
 */
export async function verifyPasswordDummy(plaintext: string): Promise<false> {
  try {
    await verify(await dummyHash(), plaintext, ARGON2_OPTIONS);
  } catch {
    // Expected: the password never matches. Swallowed so the caller's timing
    // profile matches the real path exactly.
  }
  return false;
}

/** True when a stored hash was produced with weaker parameters than current policy. */
export function needsRehash(storedHash: string): boolean {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!match) return true;
  const [, m, t, p] = match;
  return (
    Number(m) < ARGON2_OPTIONS.memoryCost ||
    Number(t) < ARGON2_OPTIONS.timeCost ||
    Number(p) < ARGON2_OPTIONS.parallelism
  );
}

/**
 * Minimum password policy for the bootstrap admin.
 *
 * Length is the only hard requirement. Composition rules ("one uppercase, one
 * symbol") measurably push users toward predictable patterns, so they are not
 * imposed; a 12-character floor plus the Argon2id cost is the stronger control.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 1024;

export function validatePasswordStrength(password: string): { ok: true } | { ok: false; reason: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, reason: `Password must be at most ${MAX_PASSWORD_LENGTH} characters.` };
  }
  if (/^\s+$/.test(password)) {
    return { ok: false, reason: 'Password must not be entirely whitespace.' };
  }
  return { ok: true };
}
