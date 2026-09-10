import type { SearchQuery, SearchResponse, SearchSnippetSegment } from '@project-control/contracts';
import type { Executor } from '../projects/guard.js';

/**
 * U+0001/U+0002 stand in for ts_headline's match markers instead of the
 * default <b>/</b>: ts_headline does not HTML-escape the surrounding text,
 * so returning real HTML here (then rendering it on the client) would let
 * arbitrary user-authored content — a memory body, a task description —
 * reach the browser's HTML parser through a search result. Control
 * characters can't occur in any indexed column (all are plain operator-
 * authored text) and are parsed back into safe {text, matched} segments by
 * toSnippetSegments() below, never re-assembled into a markup string. See
 * packages/contracts/src/search.ts's SearchSnippetSegment doc.
 */
const MATCH_START = '';
const MATCH_END = '';
const HEADLINE_OPTIONS = `MaxWords=25, MinWords=10, ShortWord=3, MaxFragments=1, HighlightAll=false, StartSel=${MATCH_START}, StopSel=${MATCH_END}`;

function toSnippetSegments(headline: string): SearchSnippetSegment[] {
  const segments: SearchSnippetSegment[] = [];
  let cursor = 0;
  while (cursor < headline.length) {
    const start = headline.indexOf(MATCH_START, cursor);
    if (start === -1) {
      segments.push({ text: headline.slice(cursor), matched: false });
      break;
    }
    if (start > cursor) segments.push({ text: headline.slice(cursor, start), matched: false });
    const end = headline.indexOf(MATCH_END, start + 1);
    if (end === -1) {
      // Unterminated marker (should not happen from a well-formed
      // ts_headline result) — treat the remainder as unmatched rather than
      // silently dropping it.
      segments.push({ text: headline.slice(start + 1), matched: false });
      break;
    }
    segments.push({ text: headline.slice(start + 1, end), matched: true });
    cursor = end + 1;
  }
  return segments.filter((segment) => segment.text.length > 0).slice(0, 40);
}

/**
 * Full-text search across every table 0021_search_indexes_schema.sql
 * indexed. Each source table (or, for agent_run_prompts/agent_reports, each
 * table joined back to its parent) contributes one branch of a UNION ALL;
 * `ts_headline` re-derives a short, bounded excerpt around the actual match
 * rather than returning raw column content. A DISTINCT ON collapses the rare
 * case where one Agent Run matches on both its title and its prompt/report
 * body into a single result, keeping the highest-ranked snippet.
 */
const SEARCH_SQL = `
WITH q AS (SELECT websearch_to_tsquery('english', $1) AS tsq),
matches AS (
  SELECT 'project'::text entity_type, p.id entity_id, p.id project_id, p.name project_name,
         p.name title,
         ts_headline('english', coalesce(p.description,'') || ' ' || coalesce(p.purpose,'') || ' ' || coalesce(p.product_goal,''), q.tsq, '${HEADLINE_OPTIONS}') snippet,
         ts_rank(p.search_vector, q.tsq) rank
  FROM projects p, q WHERE p.search_vector @@ q.tsq

  UNION ALL
  SELECT 'roadmap_milestone', m.id, m.project_id, pr.name,
         m.title,
         ts_headline('english', coalesce(m.description,''), q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(m.search_vector, q.tsq)
  FROM roadmap_milestones m JOIN projects pr ON pr.id = m.project_id, q WHERE m.search_vector @@ q.tsq

  UNION ALL
  SELECT 'roadmap_task', t.id, mi.project_id, pr.name,
         t.title,
         ts_headline('english', coalesce(t.description,'') || ' ' || coalesce(t.next_action,''), q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(t.search_vector, q.tsq)
  FROM roadmap_tasks t
    JOIN roadmap_milestones mi ON mi.id = t.milestone_id
    JOIN projects pr ON pr.id = mi.project_id, q
  WHERE t.search_vector @@ q.tsq

  UNION ALL
  SELECT 'memory', e.id, e.project_id, pr.name,
         e.title,
         ts_headline('english', coalesce(e.body,''), q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(e.search_vector, q.tsq)
  FROM project_memory_entries e JOIN projects pr ON pr.id = e.project_id, q WHERE e.search_vector @@ q.tsq

  UNION ALL
  SELECT 'checkpoint', c.id, c.project_id, pr.name,
         'Checkpoint — ' || to_char(c.created_at, 'YYYY-MM-DD HH24:MI'),
         ts_headline('english', coalesce(c.session_note,''), q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(c.search_vector, q.tsq)
  FROM project_checkpoints c JOIN projects pr ON pr.id = c.project_id, q WHERE c.search_vector @@ q.tsq

  UNION ALL
  SELECT 'agent_run', r.id, r.project_id, pr.name,
         r.title,
         ts_headline('english', r.title, q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(r.search_vector, q.tsq)
  FROM agent_runs r JOIN projects pr ON pr.id = r.project_id, q WHERE r.search_vector @@ q.tsq

  UNION ALL
  SELECT 'agent_run', r.id, r.project_id, pr.name,
         r.title,
         ts_headline('english', coalesce(pmt.body,''), q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(pmt.search_vector, q.tsq)
  FROM agent_run_prompts pmt
    JOIN agent_runs r ON r.id = pmt.agent_run_id
    JOIN projects pr ON pr.id = r.project_id, q
  WHERE pmt.search_vector @@ q.tsq

  UNION ALL
  SELECT 'agent_run', r.id, r.project_id, pr.name,
         r.title,
         ts_headline('english', coalesce(rpt.body,''), q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(rpt.search_vector, q.tsq)
  FROM agent_reports rpt
    JOIN agent_runs r ON r.id = rpt.agent_run_id
    JOIN projects pr ON pr.id = r.project_id, q
  WHERE rpt.search_vector @@ q.tsq

  UNION ALL
  SELECT 'work_session', w.id, w.project_id, pr.name,
         left(w.goal, 100),
         ts_headline('english', coalesce(w.outcome_summary,'') || ' ' || coalesce(w.blockers,'') || ' ' || coalesce(w.next_action,''), q.tsq, '${HEADLINE_OPTIONS}'),
         ts_rank(w.search_vector, q.tsq)
  FROM work_sessions w JOIN projects pr ON pr.id = w.project_id, q WHERE w.search_vector @@ q.tsq
),
deduped AS (
  SELECT DISTINCT ON (entity_type, entity_id) *
  FROM matches
  WHERE ($2::text IS NULL OR entity_type = $2) AND ($3::uuid IS NULL OR project_id = $3)
  ORDER BY entity_type, entity_id, rank DESC
)
SELECT * FROM deduped ORDER BY rank DESC LIMIT $4;
`;

type SearchRow = {
  entity_type: string;
  entity_id: string;
  project_id: string | null;
  project_name: string | null;
  title: string;
  snippet: string;
};

export async function search(db: Executor, query: SearchQuery): Promise<SearchResponse> {
  const { rows } = await db.query<SearchRow>(SEARCH_SQL, [
    query.q,
    query.type ?? null,
    query.projectId ?? null,
    query.limit,
  ]);
  return {
    query: query.q,
    results: rows.map((row) => ({
      entityType: row.entity_type as SearchResponse['results'][number]['entityType'],
      entityId: row.entity_id,
      projectId: row.project_id,
      projectName: row.project_name,
      title: row.title,
      snippet: toSnippetSegments(row.snippet),
    })),
  };
}
