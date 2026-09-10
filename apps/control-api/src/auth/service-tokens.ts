import { generateToken, hashToken } from './tokens.js';

/**
 * Service token format: `pcs_<43-char base64url random>`.
 *
 * Deliberately the same shape as a session token (see tokens.ts) — 256 bits of
 * opaque randomness, hashed with SHA-256 for storage, looked up by hash. The
 * `pcs_` prefix exists only so a token is recognisable at a glance (in an n8n
 * credential field, in a curl command) and so `looksLikeServiceToken` can tell
 * a Bearer header apart from garbage without touching the database.
 */
const TOKEN_PREFIX = 'pcs_';

/** Characters of the full token (prefix included) kept in the DB for display. */
const DISPLAY_PREFIX_LENGTH = 12;

export type GeneratedServiceToken = {
  /** Returned to the caller exactly once — never stored. */
  token: string;
  tokenHash: string;
  /** e.g. 'pcs_ab12cd34' — for operator identification only, no entropy. */
  prefix: string;
};

export function generateServiceToken(): GeneratedServiceToken {
  const token = `${TOKEN_PREFIX}${generateToken()}`;
  return {
    token,
    tokenHash: hashToken(token),
    prefix: token.slice(0, DISPLAY_PREFIX_LENGTH),
  };
}

/** Cheap shape check so callers can route to service-token resolution without hashing garbage. */
export function looksLikeServiceToken(value: string): boolean {
  return value.startsWith(TOKEN_PREFIX) && value.length <= 256;
}
