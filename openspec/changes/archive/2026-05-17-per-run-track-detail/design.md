## Context

Today `/runs` is a flat list. Each row carries summary counts (`items_synced`, `error_code`, etc.) but no per-track breakdown. The underlying Worker schema already tracks every track touched in a run — `matches.sync_run_id` is set when the ISRC/fuzzy/manual match lands, and the `tracks` cache has stable metadata — but no endpoint exposes that join and no SPA surface consumes it.

The `unmatched` table is the asymmetric gap: a track that landed unmatched during a specific run can be located only by its `last_attempt_at` timestamp falling between the run's `started_at` and `finished_at`. That's a fragile proxy when runs overlap or when the orchestrator retries the same track across multiple runs.

Constraints inherited from the existing system:

- Single-tenant Worker on Cloudflare Workers, 50-subrequest budget per invocation (the page-load itself is one read query, so well under budget).
- Authentication via CF Access JWT (browser) or Bearer JWT (cron + iOS). The new endpoint uses the same middleware.
- `tracks` PK = `spotify_id`. `matches` PK = `spotify_id`. `unmatched` PK = `spotify_id`. Invariant I-001: a `spotify_id` MUST NOT appear in both `matches` and `unmatched` simultaneously.
- The existing `/sync/runs` list endpoint is cached aggressively by TanStack Query on the SPA side; the new detail endpoint can use the same pattern (no realtime needed — sync runs are bounded events).

## Goals / Non-Goals

**Goals:**

- Let the operator drill into any run and see the per-track manifest: which Spotify tracks were touched, which matched, which didn't, and which Tidal id each matched track maps to.
- Surface the match method (`isrc` / `fuzzy` / `manual`) so the operator can spot patterns ("a lot of fuzzy matches in run X — worth a manual review").
- Filter the manifest by status and method without page reload (URL-synced).
- Degrade gracefully on mobile via the established `useMediaQuery` pattern.
- Close the symmetric-filter gap on `unmatched` so disabled-during-this-run rows are queryable by `sync_run_id`.

**Non-Goals:**

- Showing tracks that were *successfully matched in prior runs but are still in this run's working set* — those don't need re-display every run. The manifest is "what happened THIS run".
- Bulk re-match operations from the detail page (operator goes to `/unmatched` for that).
- A combined "all runs that touched this Spotify track" history view — interesting but out of scope.
- Per-track timing data (when in the run the match landed) — only outcome.
- Backfilling `unmatched.sync_run_id` for historical rows — they stay NULL with a documented meaning.

## Decisions

### D1: One endpoint, one shape, status discriminator inside the row

`GET /sync/runs/:run_id/tracks` returns a uniform array of rows. Each row has `status: "matched" | "unmatched"` plus the fields appropriate to that status:

```json
{
  "spotify_id": "abc123…",
  "title": "…", "artist": "…", "album": "…", "isrc": "USRC1…",
  "status": "matched",
  "tidal_id": "12345678",
  "method": "isrc",
  "confidence": 1.00
}
```

vs

```json
{
  "spotify_id": "abc124…",
  "title": "…", "artist": "…", "album": "…", "isrc": null,
  "status": "unmatched",
  "reason": "no_tidal_candidate"
}
```

**Alternatives considered:**

- **Two endpoints** (`/sync/runs/:id/matched` + `/sync/runs/:id/unmatched`): doubles the API surface, the SPA would always call both for a unified view anyway.
- **Embed the per-track data into `GET /sync/runs/:id`**: bloats the run-list payload for the common case where the operator only wants the summary.

### D2: Pagination via `limit` + `offset`, default `limit=50`

Same convention as `/sync/runs` and `/captures`. Hard ceiling of `200` to bound the response.

**Alternatives considered:**

- Cursor pagination: overkill for a per-run set that's almost always under 100 rows.

### D3: Status + method filters at the SQL layer

`?status=matched|unmatched|all` and `?method=isrc|fuzzy|manual`. Both narrow the SQL `WHERE` clause; the SPA URL-syncs them. Default = both unspecified = `status=all`, all methods.

**Alternatives considered:**

- Client-side filtering: works fine on small datasets but breaks pagination (would have to fetch all then paginate locally).

### D4: `unmatched.sync_run_id` nullable; NULL means "predates this change"

NULL doesn't mean "unknown run" — it means "this row was written before the F-027 schema add and the orchestrator wasn't recording sync_run_id at that point". Documented in the spec and in `playlist_configs.ts` (or `unmatched.ts`) inline. The endpoint filters with `WHERE sync_run_id = $1` so NULL rows are excluded — they're inherently not part of any specific run anyway.

**Alternatives considered:**

- NOT NULL + backfill heuristic (`last_attempt_at` BETWEEN run.started_at AND run.finished_at): fragile when runs overlap and the heuristic produces false matches for retries.
- Wipe `unmatched` on migration: data loss, unacceptable.

### D5: SPA caches per-run results indefinitely

`['run-tracks', run_id, filters]` query keys. Once a run completes, its manifest is immutable — `gcTime: Infinity` is appropriate. The detail page invalidates nothing.

**Alternatives considered:**

- Default TanStack Query gcTime (5 min): triggers needless refetches when the operator clicks between recent runs.

### D6: UI routing — `/runs/:run_id/tracks`, NOT `/runs/:run_id`

The plain `/runs/:run_id` would suggest "a summary view of the run" — but the operator already has the summary on `/runs`. The path makes the intent explicit: this is the *tracks* manifest for the run.

**Alternatives considered:**

- `/runs/:run_id` (summary + tracks combined): mixes two surfaces. The summary cards on `/runs` already serve that need.

### D7: Mobile = stacked cards via `useMediaQuery`

Same pattern UI-PHASE-10 introduced for `RunsTable` and `CapturesTable`. Each card surfaces all the same fields the desktop table cell does.

**Alternatives considered:**

- CSS-only responsive table (rows → `display: block` below md): we already learned this is brittle in UI-PHASE-10 retrospective.

### D8: Tidal id is a link, opens in a new tab

When `tidal_id` is present, the cell renders a `<a href="https://tidal.com/track/<id>" target="_blank" rel="noopener noreferrer">` with the monospace id as the link text. Same pattern as the Spotify id link on `CapturesTable.tsx`.

**Alternatives considered:**

- Embed the Tidal player: privacy + auth complications, no clear win over a deep-link.

## Risks / Trade-offs

- **Endpoint payload size for runs that processed many tracks** — a backfill run could carry hundreds of rows → Mitigation: hard ceiling at `limit=200`, default `50`, paginate via `offset`.
- **Historical `unmatched` rows with `sync_run_id = NULL`** — the detail page for an old run can't surface them → Documented behavior. The operator can still see them on `/unmatched`. No data lost.
- **Two NEW endpoints could feel like one too many** — `/sync/runs/:id/tracks` + the existing `/sync/runs` → Acceptable. They serve clearly distinct purposes (list vs detail) and the SPA's drill-down navigation maps 1:1.
- **Unbounded retention** — `tracks` × `matches` × `unmatched` for a run lives forever → Acceptable. Tracks are deduplicated by spotify_id; the row count grows linearly with unique tracks, not with runs. Worst case is a few thousand rows after a year, well within Neon free-tier.
- **Click target on `/runs` row becomes a navigation surface** — accessibility risk if not done right → Mitigation: wrap the row in `<Link>` with `aria-label`, keep the existing keyboard-focus behavior (`tabIndex={0}` already on rows).

## Migration Plan

1. **Worker repo, F-027** (single feature, all-or-nothing):
   1. Migration: `ALTER TABLE unmatched ADD COLUMN IF NOT EXISTS sync_run_id UUID REFERENCES sync_runs(run_id);` plus index `idx_unmatched_sync_run_id`. Apply on Neon prod + dev via the same temp-branch verify cycle used for F-026a.
   2. Update the unmatched write helper (currently in `src/db/unmatched.ts` or similar) to accept and persist `sync_run_id`. Orchestrator passes the current `runId`.
   3. TDD: tests for the new `GET /sync/runs/:run_id/tracks` endpoint — all 6 scenarios from `specs/per-run-track-detail/spec.md`.
   4. Implement the route handler joining `tracks` ⋈ (`matches` ∪ `unmatched`) filtered by `sync_run_id`. Apply status + method filters at SQL.
   5. PR, merge, `wrangler deploy`.
2. **UI repo, UI-PHASE-14** (after Worker is live):
   1. Add `UI-PHASE-14` to `.harness/features.json`.
   2. New page + table component + hook + mocks + tests.
   3. Update `RunsTable` to wrap each row in `<Link to={`/runs/${run.id}/tracks`}>`.
   4. Run gates, PR, merge, deploy.

**Rollback**:

- Worker side: revert the route + helper. The column stays in place (no harm — defaults to NULL on existing rows). Orchestrator change reverts cleanly.
- UI side: revert the PR. `/runs` reverts to the flat list. No SPA dependency on the new endpoint elsewhere.

## Open Questions

- Should the detail page surface **the orchestrator's per-track timing** (when in the run the match landed)? Not in this change — the schema doesn't carry per-track timestamps anyway. Revisit if the operator asks for it.
- Should we add a **"this run's score distribution"** chart (histogram of fuzzy-match confidence)? Out of scope; can be a follow-up that consumes the same endpoint.
- Should `/runs/:run_id` (without `/tracks`) redirect to the detail page rather than 404? Probably yes — small UX touch. In tasks for the UI side.
