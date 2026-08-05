import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque token generation and comparison.
 *
 * Session and CSRF tokens are random bytes, not signed/structured values. There
 * is nothing to forge because there is nothing to parse: a token is valid iff
 * its hash is present in the `sessions` table.
 */

/** 256 bits of entropy, base64url-encoded to 43 characters. */
const TOKEN_BYTES = 32;

export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Hashes a token for storage.
 *
 * Plain SHA-256 (not Argon2) is correct here: the input is already 256 bits of
 * uniform randomness, so there is no dictionary to attack and no benefit from a
 * slow KDF — only a per-request cost on the hot session-lookup path.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time string comparison.
 *
 * Guards the CSRF header check: a byte-by-byte early-exit comparison leaks the
 * matching prefix length, which is enough to reconstruct a token given enough
 * attempts.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Hashing both sides first makes the compared buffers a fixed 32 bytes.
  const digestA = createHash('sha256').update(bufA).digest();
  const digestB = createHash('sha256').update(bufB).digest();
  return timingSafeEqual(digestA, digestB);
}

/** Coarse, non-reversible client fingerprint stored on the session row. */
export function fingerprint(value: string | undefined): string | null {
  if (!value) return null;
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32);
}
