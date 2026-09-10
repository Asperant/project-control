import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * Full-text search over existing content — see migrations/0021_search_indexes_schema.sql
 * and apps/control-api/src/routes/search.ts. Deliberately a different, smaller
 * set of entity types than timeline.ts's TimelineEntityType: a search result
 * always resolves to one concrete, navigable screen, so a match inside an
 * Agent Run's prompt or report body is attributed to the agent_run entity
 * (the thing a person would actually open), not surfaced as its own kind.
 */
export const searchEntityTypeSchema = z.enum([
  'project',
  'roadmap_milestone',
  'roadmap_task',
  'memory',
  'checkpoint',
  'agent_run',
  'work_session',
]);
export type SearchEntityType = z.infer<typeof searchEntityTypeSchema>;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1).max(200),
  type: searchEntityTypeSchema.optional(),
  projectId: uuidSchema.optional(),
  // No `before*` cursor / nextCursor here, unlike timeline.ts and the other
  // list endpoints: this is a ranked UNION across several tables, and
  // relevance drops off sharply past the first screen, so a real pagination
  // continuation would be low-value complexity for a feature nobody scrolls
  // deep into. A hard cap is the right shape for this one.
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
}).strict();
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * A snippet is a sequence of plain-text segments, each flagged as matched or
 * not — never an HTML string. `ts_headline` (the Postgres function that
 * builds these) does not escape the surrounding text, so a raw string here
 * would let arbitrary user-authored content (a memory body, a task
 * description) reach the browser's HTML parser through a search result.
 * Splitting on ts_headline's StartSel/StopSel markers up front, server-side,
 * means the client only ever renders text nodes — see
 * apps/control-api/src/search/store.ts and GlobalSearch.tsx.
 */
export const searchSnippetSegmentSchema = z.object({
  text: z.string(),
  matched: z.boolean(),
}).strict();
export type SearchSnippetSegment = z.infer<typeof searchSnippetSegmentSchema>;

export const searchResultSchema = z.object({
  entityType: searchEntityTypeSchema,
  entityId: uuidSchema,
  projectId: uuidSchema.nullable(),
  projectName: z.string().nullable(),
  title: z.string(),
  /** A short, bounded excerpt around the match, as plain-text segments. */
  snippet: z.array(searchSnippetSegmentSchema).max(40),
}).strict();
export type SearchResult = z.infer<typeof searchResultSchema>;

export const searchResponseSchema = z.object({
  query: z.string(),
  results: z.array(searchResultSchema),
}).strict();
export type SearchResponse = z.infer<typeof searchResponseSchema>;
