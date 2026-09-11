/**
 * Synthetic-data scale + pagination-correctness check.
 *
 * NOT a vitest test (deliberately not named *.test.ts, so `pnpm test` never
 * picks it up) — a standalone, throwaway script run directly with `tsx`
 * against a disposable Postgres + the real control-api HTTP server (real
 * `buildApp()`, listening on a real loopback port, driven with plain
 * `fetch()` — not `app.inject()`). Seeds 1000-5000 rows per table across the
 * four keyset-paginated endpoints (listMemory, listAgentRuns,
 * listCheckpoints, listWorkSessions), deliberately including large batches
 * of rows that share an identical timestamp within one INSERT statement
 * (the same adversarial condition — `now()` is transaction-constant — that
 * caused the original cursor-precision bug), then walks every endpoint's
 * cursor to completion and asserts every row comes back exactly once.
 *
 * Run: apps/control-api$ node_modules/.bin/tsx test/integration/scale-pagination.ts
 * Requires: a usable `docker` (same as the vitest integration suite).
 */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createHarness, dockerAvailable } from './helpers.js';
import { hashPassword } from '../../src/auth/password.js';

const ROWS_PER_TABLE = 2000;

// Tie-batch sizes (rows sharing one identical JS-supplied timestamp per
// batch) deliberately including sizes both smaller and larger than every
// page size tested below, plus a batch built with a single SQL `now()`
// evaluated once per INSERT statement (the literal real-world scenario:
// several rows written in the same transaction).
const JS_TIE_SIZES = [150, 100, 80, 50, 40, 30, 20, 15, 10, 5];
const NOW_TIE_SIZE = 200;
const PAGE_SIZES_TO_WALK = [50, 33, 7];

function fail(message: string): never {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

type SeedPlan = { createdAt: Date; pinned: boolean }[];

/** Builds a deterministic set of timestamps: JS-Date tie batches (older,
 *  spaced an hour apart) followed by ROWS_PER_TABLE - ties - NOW_TIE_SIZE
 *  individually unique timestamps (1s apart), oldest of all. The `now()`
 *  batch is inserted separately, directly in SQL. */
function buildJsTimestamps(baseTime: Date): Date[] {
  const out: Date[] = [];
  let cursor = baseTime.getTime();
  for (const size of JS_TIE_SIZES) {
    cursor -= 3_600_000;
    const ts = new Date(cursor);
    for (let i = 0; i < size; i++) out.push(ts);
  }
  const remaining = ROWS_PER_TABLE - NOW_TIE_SIZE - out.length;
  for (let i = 0; i < remaining; i++) {
    cursor -= 1_000;
    out.push(new Date(cursor));
  }
  return out;
}

function withPinned(timestamps: Date[]): SeedPlan {
  return timestamps.map((createdAt, i) => ({ createdAt, pinned: i % 6 === 0 }));
}

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

async function seedMemory(db: import('../../src/db/pool.js').Db, projectId: string, plan: SeedPlan): Promise<void> {
  const ids = plan.map(() => randomUUID());
  const titles = plan.map((_, i) => `Synthetic memory ${i}`);
  const bodies = plan.map((_, i) => `Synthetic memory body ${i}`);
  const pinned = plan.map((r) => r.pinned);
  const createdAts = plan.map((r) => r.createdAt);
  await db.query(
    `INSERT INTO project_memory_entries (id, project_id, type, title, body, importance, is_pinned, created_at, updated_at)
     SELECT id, $2, 'context', title, body, 'normal', pinned, ts, ts
     FROM unnest($1::uuid[], $3::text[], $4::text[], $5::boolean[], $6::timestamptz[]) AS u(id, title, body, pinned, ts)`,
    [ids, projectId, titles, bodies, pinned, createdAts],
  );
  await db.query(
    `INSERT INTO project_memory_entries (id, project_id, type, title, body, importance, is_pinned, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'context', 'Synthetic memory (now-tie) ' || g, 'Synthetic memory body (now-tie) ' || g, 'normal', (g % 6 = 0), now(), now()
     FROM generate_series(1, $2) AS g`,
    [projectId, NOW_TIE_SIZE],
  );
}

async function seedAgentRuns(db: import('../../src/db/pool.js').Db, projectId: string, plan: SeedPlan): Promise<void> {
  const ids = plan.map(() => randomUUID());
  const titles = plan.map((_, i) => `Synthetic run ${i}`);
  const createdAts = plan.map((r) => r.createdAt);
  await db.query(
    `INSERT INTO agent_runs (id, project_id, title, agent_name, created_at, updated_at)
     SELECT id, $2, title, 'synthetic-agent', ts, ts
     FROM unnest($1::uuid[], $3::text[], $4::timestamptz[]) AS u(id, title, ts)`,
    [ids, projectId, titles, createdAts],
  );
  await db.query(
    `INSERT INTO agent_runs (id, project_id, title, agent_name, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'Synthetic run (now-tie) ' || g, 'synthetic-agent', now(), now()
     FROM generate_series(1, $2) AS g`,
    [projectId, NOW_TIE_SIZE],
  );
}

async function seedCheckpoints(db: import('../../src/db/pool.js').Db, projectId: string, plan: SeedPlan): Promise<void> {
  const ids = plan.map(() => randomUUID());
  const createdAts = plan.map((r) => r.createdAt);
  await db.query(
    `INSERT INTO project_checkpoints (id, project_id, snapshot_version, snapshot_json, created_at)
     SELECT id, $2, 1, '{}'::jsonb, ts
     FROM unnest($1::uuid[], $3::timestamptz[]) AS u(id, ts)`,
    [ids, projectId, createdAts],
  );
  await db.query(
    `INSERT INTO project_checkpoints (id, project_id, snapshot_version, snapshot_json, created_at)
     SELECT gen_random_uuid(), $1, 1, '{}'::jsonb, now()
     FROM generate_series(1, $2) AS g`,
    [projectId, NOW_TIE_SIZE],
  );
}

async function seedWorkSessions(db: import('../../src/db/pool.js').Db, projectId: string, plan: SeedPlan): Promise<void> {
  const ids = plan.map(() => randomUUID());
  const goals = plan.map((_, i) => `Synthetic session ${i}`);
  const startedAts = plan.map((r) => r.createdAt);
  await db.query(
    `INSERT INTO work_sessions (id, project_id, goal, status, started_at, ended_at, outcome_summary, created_at, updated_at)
     SELECT id, $2, goal, 'closed', ts, ts + interval '5 minutes', 'Synthetic outcome', ts, ts
     FROM unnest($1::uuid[], $3::text[], $4::timestamptz[]) AS u(id, goal, ts)`,
    [ids, projectId, goals, startedAts],
  );
  await db.query(
    `INSERT INTO work_sessions (id, project_id, goal, status, started_at, ended_at, outcome_summary, created_at, updated_at)
     SELECT gen_random_uuid(), $1, 'Synthetic session (now-tie) ' || g, 'closed', now(), now() + interval '5 minutes', 'Synthetic outcome', now(), now()
     FROM generate_series(1, $2) AS g`,
    [projectId, NOW_TIE_SIZE],
  );
}

// ---------------------------------------------------------------------------
// HTTP client (plain fetch against the real, listening control-api)
// ---------------------------------------------------------------------------

type Client = {
  get: (path: string) => Promise<{ status: number; json: any; ms: number }>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The app registers a permissive global rate limiter (300 req/60s per key —
 * see app.ts) to stop a runaway client. This synthetic-data walk legitimately
 * issues more than that in under a minute, so a real client hitting it would
 * back off and retry — which is what this does, honouring `retry-after`
 * rather than working around the limiter. Latency reporting below only
 * counts the eventual successful request, not time spent waiting out a 429.
 */
function makeClient(base: string, sessionToken: string, csrfToken: string): Client {
  return {
    get: async (path: string) => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const t0 = performance.now();
        const res = await fetch(`${base}${path}`, {
          headers: { cookie: `pc_session=${sessionToken}`, 'x-csrf-token': csrfToken },
        });
        const ms = performance.now() - t0;
        if (res.status === 429) {
          const retryAfterHeader = res.headers.get('retry-after');
          const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 2000;
          await res.json().catch(() => undefined);
          await sleep(Number.isFinite(retryAfterMs) ? retryAfterMs + 250 : 2250);
          continue;
        }
        const json = await res.json();
        return { status: res.status, json, ms };
      }
      throw new Error(`${path}: exceeded retry budget against the rate limiter`);
    },
  };
}

function parseSessionCookie(res: Response): string {
  const raw = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() as string[] : [];
  for (const header of raw) {
    const match = /(?:^|;\s*)pc_session=([^;]*)/.exec(header);
    if (match) return decodeURIComponent(match[1]!);
  }
  throw new Error('pc_session cookie not found in login response');
}

// ---------------------------------------------------------------------------
// Generic keyset walker + exactly-once assertion
// ---------------------------------------------------------------------------

type WalkResult = { totalReturned: number; uniqueIds: number; duplicates: number; pages: number; latenciesMs: number[] };

async function walkKeyset(
  client: Client,
  basePath: string,
  pageSize: number,
  expectedTotal: number,
  buildCursorQuery: (cursor: any) => string,
  extractItems: (json: any) => { id: string }[],
  extractNextCursor: (json: any) => any,
): Promise<WalkResult> {
  const seen = new Map<string, number>();
  let cursor: any = null;
  let pages = 0;
  const latenciesMs: number[] = [];
  const maxPages = Math.ceil(expectedTotal / pageSize) * 3 + 50; // generous infinite-loop guard
  while (true) {
    const query = buildCursorQuery(cursor);
    const { status, json, ms } = await client.get(`${basePath}?pageSize=${pageSize}${query}`);
    if (status !== 200) fail(`${basePath}: unexpected status ${status}: ${JSON.stringify(json)}`);
    latenciesMs.push(ms);
    pages++;
    if (pages > maxPages) fail(`${basePath} pageSize=${pageSize}: exceeded ${maxPages} pages — likely infinite loop`);
    const items = extractItems(json);
    for (const item of items) seen.set(item.id, (seen.get(item.id) ?? 0) + 1);
    const nextCursor = extractNextCursor(json);
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  const totalReturned = [...seen.values()].reduce((a, b) => a + b, 0);
  const duplicates = [...seen.values()].filter((c) => c > 1).length;
  return { totalReturned, uniqueIds: seen.size, duplicates, pages, latenciesMs };
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function reportLatency(label: string, latenciesMs: number[]): void {
  const p50 = percentile(latenciesMs, 50);
  const p95 = percentile(latenciesMs, 95);
  const max = Math.max(...latenciesMs);
  console.log(`    latency (${label}, n=${latenciesMs.length}): p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms max=${max.toFixed(1)}ms`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!(await dockerAvailable())) {
    console.error('Docker is not available in this environment — cannot run the scale-pagination check.');
    process.exit(1);
  }

  console.log(`Seeding target: ${ROWS_PER_TABLE} rows per table (memory, agent_runs, checkpoints, work_sessions).`);
  console.log(`  JS-Date tie batches (sizes): [${JS_TIE_SIZES.join(', ')}] = ${JS_TIE_SIZES.reduce((a, b) => a + b, 0)} rows`);
  console.log(`  SQL now()-tie batch: ${NOW_TIE_SIZE} rows (single INSERT...SELECT, now() constant across the whole statement)`);
  console.log(`  Remaining rows: individually unique timestamps, 1s apart.`);

  const harness = await createHarness();
  let address = '';
  try {
    address = await harness.app.listen({ port: 0, host: '127.0.0.1' });
    console.log(`Real control-api listening at ${address}`);

    const email = 'scale-pagination@example.test';
    const password = 'regression-test-only';
    await harness.ctx.db.query(
      "INSERT INTO users(email,display_name,password_hash,role) VALUES($1,$2,$3,'admin')",
      [email, 'Scale Pagination Tester', await hashPassword(password)],
    );

    const loginRes = await fetch(`${address}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (loginRes.status !== 200) fail(`login failed: ${loginRes.status} ${await loginRes.text()}`);
    const sessionToken = parseSessionCookie(loginRes);
    const loginJson: any = await loginRes.json();
    const csrfToken = loginJson.csrfToken as string;
    const client = makeClient(address, sessionToken, csrfToken);

    const projectId = randomUUID();
    await harness.ctx.db.query(
      `INSERT INTO projects(id,name,status,archived_at,location_input_path,location_canonical_path,location_allowed_root,created_by)
       VALUES ($1,$2,'active',NULL,$3,$3,'/tmp',NULL)`,
      [projectId, 'Scale Pagination Test Project', `/tmp/${projectId}`],
    );
    console.log(`Seeded project ${projectId}`);

    const baseTime = new Date(Date.now() - 24 * 3_600_000); // 24h in the past; SQL now()-batches sort newest
    const jsTimestamps = buildJsTimestamps(baseTime);
    const memoryPlan = withPinned(jsTimestamps);
    const agentRunsPlan = withPinned(jsTimestamps);
    const checkpointsPlan = withPinned(jsTimestamps);
    const workSessionsPlan = withPinned(jsTimestamps);

    const t0 = performance.now();
    await seedMemory(harness.ctx.db, projectId, memoryPlan);
    await seedAgentRuns(harness.ctx.db, projectId, agentRunsPlan);
    await seedCheckpoints(harness.ctx.db, projectId, checkpointsPlan);
    await seedWorkSessions(harness.ctx.db, projectId, workSessionsPlan);
    console.log(`Seeding complete in ${(performance.now() - t0).toFixed(0)}ms\n`);

    // Verify DB-side row counts before touching the API, so a pagination
    // failure can never be confused with a seeding failure.
    for (const [table, col] of [
      ['project_memory_entries', 'project_id'],
      ['agent_runs', 'project_id'],
      ['project_checkpoints', 'project_id'],
      ['work_sessions', 'project_id'],
    ]) {
      const { rows } = await harness.ctx.db.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE ${col}=$1`, [projectId]);
      const count = Number(rows[0]!.count);
      if (count !== ROWS_PER_TABLE) fail(`${table}: expected ${ROWS_PER_TABLE} seeded rows, DB has ${count}`);
      console.log(`DB row count check: ${table} = ${count} (OK)`);
    }
    console.log();

    let anyFailure = false;

    // --- listMemory -----------------------------------------------------
    for (const pageSize of PAGE_SIZES_TO_WALK) {
      const result = await walkKeyset(
        client, `/api/projects/${projectId}/memory`, pageSize, ROWS_PER_TABLE,
        (cursor) => (cursor ? `&beforeIsPinned=${cursor.isPinned}&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}` : ''),
        (json) => json.entries,
        (json) => json.nextCursor,
      );
      const ok = result.totalReturned === ROWS_PER_TABLE && result.uniqueIds === ROWS_PER_TABLE && result.duplicates === 0;
      console.log(`listMemory pageSize=${pageSize}: pages=${result.pages} returned=${result.totalReturned} unique=${result.uniqueIds} duplicates=${result.duplicates} -> ${ok ? 'PASS' : 'FAIL'}`);
      reportLatency(`listMemory pageSize=${pageSize}`, result.latenciesMs);
      if (!ok) anyFailure = true;
    }
    console.log();

    // --- listAgentRuns ----------------------------------------------------
    for (const pageSize of PAGE_SIZES_TO_WALK) {
      const result = await walkKeyset(
        client, `/api/projects/${projectId}/agent-runs`, pageSize, ROWS_PER_TABLE,
        (cursor) => (cursor ? `&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}` : ''),
        (json) => json.agentRuns,
        (json) => json.nextCursor,
      );
      const ok = result.totalReturned === ROWS_PER_TABLE && result.uniqueIds === ROWS_PER_TABLE && result.duplicates === 0;
      console.log(`listAgentRuns pageSize=${pageSize}: pages=${result.pages} returned=${result.totalReturned} unique=${result.uniqueIds} duplicates=${result.duplicates} -> ${ok ? 'PASS' : 'FAIL'}`);
      reportLatency(`listAgentRuns pageSize=${pageSize}`, result.latenciesMs);
      if (!ok) anyFailure = true;
    }
    console.log();

    // --- listCheckpoints ----------------------------------------------------
    for (const pageSize of PAGE_SIZES_TO_WALK) {
      const result = await walkKeyset(
        client, `/api/projects/${projectId}/checkpoints`, pageSize, ROWS_PER_TABLE,
        (cursor) => (cursor ? `&beforeCreatedAt=${encodeURIComponent(cursor.createdAt)}&beforeId=${cursor.id}` : ''),
        (json) => json.checkpoints,
        (json) => json.nextCursor,
      );
      const ok = result.totalReturned === ROWS_PER_TABLE && result.uniqueIds === ROWS_PER_TABLE && result.duplicates === 0;
      console.log(`listCheckpoints pageSize=${pageSize}: pages=${result.pages} returned=${result.totalReturned} unique=${result.uniqueIds} duplicates=${result.duplicates} -> ${ok ? 'PASS' : 'FAIL'}`);
      reportLatency(`listCheckpoints pageSize=${pageSize}`, result.latenciesMs);
      if (!ok) anyFailure = true;
    }
    console.log();

    // --- listWorkSessions ----------------------------------------------------
    for (const pageSize of PAGE_SIZES_TO_WALK) {
      const result = await walkKeyset(
        client, `/api/projects/${projectId}/work-sessions`, pageSize, ROWS_PER_TABLE,
        (cursor) => (cursor ? `&beforeStartedAt=${encodeURIComponent(cursor.startedAt)}&beforeId=${cursor.id}` : ''),
        (json) => json.workSessions,
        (json) => json.nextCursor,
      );
      const ok = result.totalReturned === ROWS_PER_TABLE && result.uniqueIds === ROWS_PER_TABLE && result.duplicates === 0;
      console.log(`listWorkSessions pageSize=${pageSize}: pages=${result.pages} returned=${result.totalReturned} unique=${result.uniqueIds} duplicates=${result.duplicates} -> ${ok ? 'PASS' : 'FAIL'}`);
      reportLatency(`listWorkSessions pageSize=${pageSize}`, result.latenciesMs);
      if (!ok) anyFailure = true;
    }
    console.log();

    if (anyFailure) {
      console.error('RESULT: at least one endpoint FAILED the exactly-once property.');
      process.exitCode = 1;
    } else {
      console.log('RESULT: all four endpoints, all page sizes — every row returned exactly once. PASS.');
    }
  } finally {
    await harness.teardown();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
