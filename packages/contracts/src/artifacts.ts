import { z } from 'zod';
import { sha256Schema, timestampSchema, uuidSchema } from './common.js';

/**
 * Metadata row for a stored artifact. The bytes themselves live on the host
 * filesystem under a content-addressed path; PostgreSQL only ever holds this
 * record. `sha256` is the join key between the two.
 */
export const artifactObjectSchema = z.object({
  id: uuidSchema,
  sha256: sha256Schema,
  /**
   * Caller-supplied display name. Never used to build a filesystem path — the
   * storage layer derives the path from `sha256` alone, which is what makes
   * path traversal via a crafted filename structurally impossible.
   */
  filename: z.string().min(1).max(255),
  contentType: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  createdBy: uuidSchema.nullable(),
  /**
   * Soft-archive marker. Artifact bytes are immutable and are never unlinked by
   * the application; archiving only hides the metadata row.
   */
  archivedAt: timestampSchema.nullable(),
});
export type ArtifactObject = z.infer<typeof artifactObjectSchema>;

/** One stage of the round-trip self-test. */
export const selfTestStepSchema = z.object({
  step: z.string().min(1).max(80),
  ok: z.boolean(),
  detail: z.string().max(400),
  durationMs: z.number().nonnegative(),
});
export type SelfTestStep = z.infer<typeof selfTestStepSchema>;

/**
 * `POST /api/artifacts/self-test` — writes a small random payload through the
 * real storage path, reads it back, verifies the digest, proves deduplication
 * and proves that traversal attempts are rejected. Leaves no live data behind
 * beyond one content-addressed test object.
 */
export const artifactSelfTestResponseSchema = z.object({
  ok: z.boolean(),
  sha256: sha256Schema,
  sizeBytes: z.number().int().nonnegative(),
  deduplicated: z.boolean(),
  steps: z.array(selfTestStepSchema),
  totalDurationMs: z.number().nonnegative(),
});
export type ArtifactSelfTestResponse = z.infer<typeof artifactSelfTestResponseSchema>;
