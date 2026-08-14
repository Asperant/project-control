import { z } from 'zod';
import { requestIdSchema } from './common.js';

/**
 * Closed set of error codes. The API never returns a free-form error string as
 * the primary signal, so the client can branch on `code` safely and the message
 * can be changed without breaking anything.
 */
export const errorCodeSchema = z.enum([
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'csrf_failed',
  'not_found',
  'conflict',
  'confirmation_required',
  'payload_too_large',
  'rate_limited',
  'internal_error',
  'service_unavailable',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Uniform error envelope for every non-2xx response.
 *
 * `message` is deliberately generic for auth failures: the API must not reveal
 * whether an email exists, so `unauthorized` always reads the same way whether
 * the user is unknown or the password was wrong.
 */
export const errorResponseSchema = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string().min(1).max(500),
    /** Field-level detail, only ever populated for `validation_failed`. */
    fields: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
    confirmation: z.object({
      kind: z.enum(['incomplete_acceptance', 'incomplete_dependencies']),
      count: z.number().int().positive(),
    }).optional(),
  }),
  requestId: requestIdSchema,
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

/** HTTP status paired with each error code. Used by the API's error serialiser. */
export const errorCodeStatus: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 422,
  unauthorized: 401,
  forbidden: 403,
  csrf_failed: 403,
  not_found: 404,
  conflict: 409,
  confirmation_required: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
};
