import { z } from 'zod';
import { componentReportSchema, timestampSchema } from './common.js';

/** `GET /health/live` — process liveness only; never touches a dependency. */
export const livenessResponseSchema = z.object({
  status: z.literal('live'),
  uptimeSeconds: z.number().nonnegative(),
});
export type LivenessResponse = z.infer<typeof livenessResponseSchema>;

/**
 * `GET /health/ready` — readiness, i.e. "can this process serve traffic".
 * Returns 503 with `status: 'not_ready'` when a hard dependency is unavailable.
 */
export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  checks: z.array(
    z.object({
      name: z.string(),
      ok: z.boolean(),
      detail: z.string().max(300),
    }),
  ),
});
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;

/**
 * `GET /api/system/status` — the dashboard payload.
 *
 * Every component the web panel renders a card for appears in
 * `components`, including ones that are not yet configured; those report
 * `manual_configuration_required` rather than being omitted, so the operator can
 * see what is still pending instead of seeing nothing.
 */
export const systemStatusResponseSchema = z.object({
  stackVersion: z.string(),
  environment: z.enum(['production', 'development', 'test']),
  generatedAt: timestampSchema,
  /** Worst status across `components`, rolled up for the header badge. */
  overall: z.enum(['ok', 'degraded', 'down']),
  components: z.array(componentReportSchema),
});
export type SystemStatusResponse = z.infer<typeof systemStatusResponseSchema>;

/** Component ids the platform always reports on. */
export const CORE_COMPONENT_IDS = [
  'postgres',
  'n8n',
  'artifact_store',
  'runner',
  'backup',
  'tailscale',
] as const;
export type CoreComponentId = (typeof CORE_COMPONENT_IDS)[number];
