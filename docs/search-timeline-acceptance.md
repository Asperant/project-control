# Search, timeline, and navigation acceptance

Covers the feature added by migrations `0019`-`0021`
(`timeline_events`, its role grants, and full-text search indexes), the new
`TimelineLog`/search backend, the `/api/timeline`, `/api/projects/:id/timeline`
and `/api/search` routes, and the frontend router/global-search/activity-feed
work in `apps/web`.

This document has two parts. Part 1 is already done — a full pre-deployment
verification that touched nothing on the live host. Part 2 is the runbook for
actually shipping this to the live host, written but **not yet run**; it
follows the same "no update/migration on the host outside its own numbered
step" discipline as `docs/automation-acceptance.md`.

---

## Part 1 — Pre-deployment verification (done, 2026-09-10)

Everything in this section ran against disposable, throwaway infrastructure —
a Postgres container and a `control-api`/`vite` instance started specifically
for this check and torn down afterward. Nothing here touched
`/srv/project-control` or its data.

### 1.1 Automated checks

```
pnpm --filter @project-control/contracts build && pnpm --filter @project-control/contracts typecheck && pnpm --filter @project-control/contracts test
pnpm --filter @project-control/control-api typecheck && pnpm --filter @project-control/control-api test
pnpm --filter @project-control/web typecheck && pnpm --filter @project-control/web test && pnpm --filter @project-control/web build
```

All green: contracts 107/107, control-api 442/442 (against a real, disposable
PostgreSQL — nothing mocked), web 68/68, and both production builds succeed.

### 1.2 Migration correctness, against a real Postgres

Ran `migrations/0001` through `0021` in order, as `control_migrator`, against
a disposable container using the exact pinned image
(`infra/versions.lock.env`'s `PC_POSTGRES_IMAGE`). Confirmed, as `control_app`:

- `INSERT`/`SELECT` on `timeline_events` succeed; `UPDATE`/`DELETE` fail with
  `permission denied` (not a syntax error) — the append-only guarantee holds.
- `backup_reader` can read `timeline_events` and every search-indexed table.
- Full-text search actually finds seeded rows via `search_vector`, with
  correct `ts_rank` ordering and `ts_headline`-derived match highlighting.

### 1.3 Full backend + frontend walkthrough, real browser

Booted a real `control-api` (the actual `src/index.ts` entrypoint, not a
test harness) against the disposable Postgres, ran the real migration runner
on boot (21/21 applied), started the real `vite` dev server, and drove a
headless Chrome instance over the DevTools Protocol through:

1. Login → lands on `/projects` (real route, not local state).
2. `/timeline` (global activity feed) renders seeded entries with correct
   entity badges, timestamps, and summaries.
3. **Hard reload** directly on `/timeline` (not a client-side navigation) —
   confirms this is a real, bookmarkable route, not SPA-only state.
4. Global search: typing "timeline" returns the two matching entities
   (a project and a memory entry) with highlighted snippets; clicking a
   result navigates to the correct deep-linked tab
   (`/projects/:id/memory`).
5. Project switcher → project detail → the new **Timeline** tab renders the
   same project's activity, correctly scoped.
6. Zero console errors or warnings across the whole walkthrough.

**A real bug was found and fixed by this step, not by the 617 automated
tests above:** `timeline_events.id` (a `BIGINT` identity) is parsed by this
project's shared `pg` pool as a JS `number`
(`apps/control-api/src/db/pool.ts`'s `INT8` type-parser override), but
`timelineEntrySchema` declared it as `z.string()`. Every automated test was
internally self-consistent (each side of the contract agreed with itself)
so none of them caught it; only checking the real HTTP response against the
real schema did. The frontend failed closed — `alert-error` with "The
server response did not match the expected shape" — rather than rendering
garbage, but it was still a genuine bug. Fixed in
`packages/contracts/src/timeline.ts` (`id: z.number().int().positive()`,
both on the entry and on `nextCursor`), with matching type fixes in
`apps/control-api/src/timeline.ts` and `apps/web/src/components/timeline/TimelineFeed.tsx`.
Re-ran the full walkthrough after the fix; all steps passed.

### 1.4 A security fix made along the way

`ts_headline` (used to build search snippets) does not HTML-escape the
surrounding text, so a raw string from it embedded via
`dangerouslySetInnerHTML` would let arbitrary user-authored content (a
memory body, a task description) reach the browser's HTML parser through a
search result — a stored-XSS path. Fixed before any frontend code rendered
it: `search/store.ts` uses control-character match markers instead of
`<b>`/`</b>`, parses the result into `{ text, matched }` segments
server-side, and the contract (`SearchSnippetSegment`) only ever carries
those segments — never an HTML string. The frontend renders them as plain
React text nodes. Verified live: a search hit's snippet segments contain
none of the marker characters, and the matched segment is correctly
identified.

### 1.5 What this part does not cover

- The live host itself — see Part 2.
- Accessibility and responsive-breakpoint review, a full security-checklist
  pass, and disaster-recovery drills are explicitly out of scope for this
  feature (see the hardening/production-readiness work planned separately).
- `roadmap_task`/`roadmap_milestone`/`checkpoint`/`agent_run` timeline
  entries were exercised via direct seeding and the read APIs, not by
  driving every mutation route through the browser one by one — the write
  side is covered instead by `apps/control-api/test/integration/timeline.test.ts`
  and the store-level wiring itself (every instrumented call site is a
  small, reviewable diff next to its existing `audit(...)` call).

---

## Part 2 — Live host rollout (not yet run)

Run this in order, on the real host, when the feature is actually being
shipped. Same constraints as every other runbook in this repository:

- No `update`/migration on the host outside this runbook's own step.
- No commit or push as part of running this runbook.
- Stop and report if any step's actual result doesn't match its expected
  result — do not improvise a fix under this runbook.

### 2.1 Backup

```bash
sudo ./pcctl backup
```

**Expected:** exits 0; a fresh restic snapshot exists.

### 2.2 Update (applies migrations 0019-0021)

```bash
sudo ./pcctl update
```

**Expected:** exits 0. `sudo ./pcctl status` shows `schema: 21 migration(s)
applied`. `control-api`, `caddy`, `web` all healthy.

### 2.3 Verify

```bash
sudo ./pcctl verify
sudo ./pcctl verify-security
```

**Expected:** both exit 0, no new findings introduced by this feature (in
particular: `timeline_events` append-only grants hold, every search-indexed
table's existing grants are unchanged).

### 2.4 Live functional walkthrough

1. Sign in as an existing operator account.
2. Open a real project, create a memory entry — confirm it appears in that
   project's Timeline tab within a few seconds and in the global Activity
   feed.
3. Use the header search for a word known to be in that memory entry's
   body — confirm it is found, with a sensible highlighted snippet, and
   that clicking it opens the Memory tab of the right project.
4. Copy the URL of the project's Roadmap tab, open it in a new private
   window while signed out — confirm it redirects to login, then lands
   back on that same tab after authenticating (bookmarkable-URL check).
5. Confirm the existing tabs (Overview, Resume, Development, Roadmap,
   Memory, Agent Runs) all still work exactly as before the router
   conversion — this is the regression check for a large, previously
   local-state-only navigation tree being moved onto real routes.

### 2.5 Sign-off

Record the date this part was actually run, and anything it surfaced, at
the top of this document — the same way `docs/automation-acceptance.md`
does for its own feature.
