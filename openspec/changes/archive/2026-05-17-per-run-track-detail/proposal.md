## Why

The `/runs` page tells the operator a run synced N tracks but never which tracks. When a sync run lands as `succeeded` with `items_synced: 47`, the operator has no way to see *which* 47 Spotify tracks got matched, *how* (ISRC vs fuzzy vs manual), or which Tidal tracks they map to. The same gap exists for `partial` and `failed` runs — the operator can see error counts but cannot drill in to find the specific tracks that didn't match and why.

This change closes that loop. After every sync, the operator can click a run row and see a per-track manifest: new Spotify tracks identified that run, their match outcomes (ISRC, fuzzy, manual, or unmatched), and direct links to the Tidal counterparts when matched.

## What Changes

- **New Worker endpoint** `GET /sync/runs/:run_id/tracks` returning a paginated, filterable manifest of every track the orchestrator touched during the run. Each row contains the Spotify track metadata (id, title, artist, album, isrc), the match outcome (`matched` / `unmatched`), and — when matched — the Tidal id, match method (`isrc` / `fuzzy` / `manual`), and confidence. When unmatched: the reason.
- **Worker schema add**: `unmatched.sync_run_id UUID REFERENCES sync_runs(run_id)` so unmatched-during-this-run can be filtered symmetrically with matches. Backfill: existing rows take `NULL` (means "unmatched, but the run that produced this is unknown — predates the schema add"); future rows get the orchestrator's runId.
- **Worker orchestrator wiring**: when a track lands in `unmatched` during a run, write the `sync_run_id` alongside `reason`, `attempts`, and `last_attempt_at`. The existing match path already writes `sync_run_id` to the `matches` row.
- **New UI route** `/runs/:run_id/tracks` (linked from each row on `/runs`) showing a run summary header plus the per-track manifest. Filters: `status` (matched / unmatched / all), `method` (isrc / fuzzy / manual / —). URL-synced filters like `/runs` and `/captures` (per UI-PHASE-3 / UI-PHASE-5 convention).
- **Mobile responsive**: below `md` the manifest collapses to a stacked-card list via `useMediaQuery`, same pattern UI-PHASE-10 introduced for `RunsTable` and `CapturesTable`.

## Capabilities

### New Capabilities

- `per-run-track-detail`: Worker endpoint `GET /sync/runs/:run_id/tracks` + the `unmatched.sync_run_id` column + the orchestrator's symmetric-write behavior. The contract for *what a per-run manifest looks like* lives here.

### Modified Capabilities

- `web-ui-operator`: the existing requirement "Runs history page" already promises each row links to "a detail view" — this change fulfills that promise. Adds a new requirement for the `/runs/:run_id/tracks` route plus the detail UX (filters, mobile stacked-card variant, Tidal id links).

## Impact

**Worker repo (`portage`):**
- DB migration: `ALTER TABLE unmatched ADD COLUMN sync_run_id UUID REFERENCES sync_runs(run_id);`. Index on `sync_run_id`. Existing rows backfill to `NULL`.
- `src/routes/sync.ts` (or wherever `/sync/runs` lives): new handler for `GET /sync/runs/:run_id/tracks`. Wraps a join of `tracks` × (`matches` UNION `unmatched`) filtered on `sync_run_id`. Pagination via `limit` + `offset`. Filtering via `status` and `method`.
- `src/sync/orchestrator.ts`: when writing an unmatched row, also write the current `runId`. The match path already does this.
- `src/db/unmatched.ts` (or equivalent): write helper accepts a `sync_run_id` parameter.
- Tests under `tests/routes/sync.test.ts` and `tests/sync/orchestrator.test.ts`.
- New Worker harness feature: `F-027 per-run-track-detail`.

**UI repo (`portage-ui`, this repo):**
- New route `/runs/:run_id/tracks` in `src/App.tsx` (lazy-loaded like other pages).
- New page `src/pages/RunTracksPage.tsx` rendering the summary + the manifest table.
- New component `src/components/RunTracksTable.tsx` with desktop `<table>` and mobile `<ul>` of `<article>` cards via `useMediaQuery`.
- New hook `src/hooks/useRunTracks.ts` — TanStack Query against the new Worker endpoint.
- `src/components/RunsTable.tsx` rows become clickable / wrap a `<Link to={`/runs/${run.id}/tracks`}>`.
- `tests/mocks/operator.ts` extended with per-run-tracks handlers (matched-only, mixed, empty).
- `tests/pages/RunTracksPage.test.tsx` (new) + `tests/components/RunTracksTable.mobile.test.tsx` (new).
- New UI harness feature: `UI-PHASE-14`.

**Cross-repo sequencing:**
- Worker side ships first (F-027). Until production carries the endpoint + schema add, the SPA call would 404.
- UI side can pre-ship against MSW mocks, same model used for UI-PHASE-13.
