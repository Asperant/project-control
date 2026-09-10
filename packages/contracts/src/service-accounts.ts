import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common.js';

/**
 * Service identity: scoped, non-human (machine) principals.
 *
 * A service token authenticates a machine caller (n8n, in the first
 * consumer) over `Authorization: Bearer`, never a cookie. It is minted only
 * by `pcctl create-service-token`, never by an HTTP route — the panel can
 * list and revoke a token, but cannot create one. See
 * apps/control-api/src/auth/middleware.ts and docs/service-accounts.md.
 *
 * The scope vocabulary below is intentionally closed and intentionally
 * narrow: nothing here can execute, apply, archive or delete. A machine
 * principal proposes and reads; only a user principal (session cookie) can
 * confirm a mutation. That split is enforced by `requirePrincipalKind`, not
 * by scope alone — see the routes that gate on it.
 */
export const serviceScopeSchema = z.enum([
  'automation:run',
  'project:read',
  'project:rescan',
  'action:plan',
  'system:read',
  'report:write',
]);
export type ServiceScope = z.infer<typeof serviceScopeSchema>;

export const serviceAccountStatusSchema = z.enum(['active', 'disabled']);
export type ServiceAccountStatus = z.infer<typeof serviceAccountStatusSchema>;

/** Never includes the token value — that exists only once, in CLI output at mint time. */
export const serviceTokenSummarySchema = z.object({
  id: uuidSchema,
  accountId: uuidSchema,
  accountKey: z.string().min(1).max(64),
  /** 'pcs_' plus the token's public id-part, for operator identification only. */
  prefix: z.string().regex(/^pcs_[A-Za-z0-9_-]{6,32}$/),
  scopes: z.array(serviceScopeSchema).min(1),
  expiresAt: timestampSchema,
  lastUsedAt: timestampSchema.nullable(),
  revokedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
}).strict();
export type ServiceTokenSummary = z.infer<typeof serviceTokenSummarySchema>;

export const serviceTokenListResponseSchema = z.object({
  tokens: z.array(serviceTokenSummarySchema),
});
export type ServiceTokenListResponse = z.infer<typeof serviceTokenListResponseSchema>;

export const revokeServiceTokenResponseSchema = z.object({
  token: serviceTokenSummarySchema,
});
export type RevokeServiceTokenResponse = z.infer<typeof revokeServiceTokenResponseSchema>;
