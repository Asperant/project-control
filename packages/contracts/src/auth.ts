import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common.js';

/**
 * Login credentials.
 *
 * The email bound is generous (320 = RFC 5321 maximum) and the password bound is
 * capped at 1024 characters. The cap matters: Argon2id cost is proportional to
 * input length, so an unbounded password field is a cheap CPU-exhaustion vector.
 */
export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(1024),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const userRoleSchema = z.enum(['admin', 'operator', 'viewer']);
export type UserRole = z.infer<typeof userRoleSchema>;

/**
 * The public projection of a user. Deliberately has no password hash field at
 * all, so a hash cannot leak through this type even by accident.
 */
export const userSchema = z.object({
  id: uuidSchema,
  email: z.string().email(),
  displayName: z.string().min(1).max(120),
  role: userRoleSchema,
  createdAt: timestampSchema,
  lastLoginAt: timestampSchema.nullable(),
});
export type User = z.infer<typeof userSchema>;

export const sessionInfoSchema = z.object({
  id: uuidSchema,
  createdAt: timestampSchema,
  expiresAt: timestampSchema,
  /** Seconds of inactivity after which the session is dropped. */
  idleTimeoutSeconds: z.number().int().positive(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

/**
 * Response to a successful login and to `GET /api/auth/me`.
 *
 * `csrfToken` is returned in the body rather than only in a cookie: the browser
 * echoes it in the `x-csrf-token` header, which is what makes the double-submit
 * check meaningful (a cross-origin attacker can send the cookie but cannot read
 * it to construct the header).
 */
export const authSessionResponseSchema = z.object({
  user: userSchema,
  session: sessionInfoSchema,
  csrfToken: z.string().min(32).max(128),
});
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;

export const logoutResponseSchema = z.object({
  loggedOut: z.literal(true),
});
export type LogoutResponse = z.infer<typeof logoutResponseSchema>;
