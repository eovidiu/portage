## 1. Worker repo (`portage`) — `unmatched.sync_run_id` schema + orchestrator wiring

- [ ] 1.1 Add `F-027 per-run-track-detail` entry to Worker `.harness/features.json` with `scope: ["db/schema.sql", "src/db/unmatched.ts", "src/sync/orchestrator.ts", "src/routes/sync.ts", "tests/routes/sync.test.ts", "tests/sync/orchestrator.test.ts"]`, `depends_on: []`, `priority: 13`.
- [ ] 1.2 Author `docs/specs/F-027-per-run-track-detail.md` and `docs/specs/T-027-per-run-track-detail.md` mirroring `specs/per-run-track-detail/spec.md` from this change.
- [ ] 1.3 Live DDL via Neon MCP on prod main + dev branches: `ALTER TABLE unmatched ADD COLUMN IF NOT EXISTS sync_run_id UUID REFERENCES sync_runs(run_id); CREATE INDEX IF NOT EXISTS idx_unmatched_sync_run_id ON unmatched(sync_run_id);`. Apply via the temp-branch verify cycle used for F-026a.
- [ ] 1.4 Update `db/schema.sql` to declare the new column + index. Project pattern: declarative file kept in sync with live DDL.
- [ ] 1.5 Update the unmatched DB write helper (in `src/db/unmatched.ts` or wherever today's unmatched INSERT lives) to accept an optional `sync_run_id` parameter and write it.
- [ ] 1.6 TDD: extend `tests/sync/orchestrator.test.ts` with a scenario asserting that an unmatched row written during a run carries `sync_run_id` equal to that run's id.
- [ ] 1.7 Update the orchestrator's unmatched write path (`src/sync/orchestrator.ts` — likely inside `matchByFuzzy` / the post-match unmatched-insert) to pass the current `runId` through.
- [ ] 1.8 Confirm 5-stage TaskCompleted hook green.

## 2. Worker repo (`portage`) — `GET /sync/runs/:run_id/tracks` endpoint

- [ ] 2.1 TDD: write failing tests in `tests/routes/sync.test.ts` for the 9 scenarios in `specs/per-run-track-detail/spec.md` — matched-only, mixed, status filter, method filter, pagination, limit ceiling, unknown run id 404, run with zero tracks, unauthenticated 401.
- [ ] 2.2 Add a DB query helper (e.g. `listRunTracks(sql, runId, filters)`) in `src/db/sync_runs.ts` (or a new `src/db/run_tracks.ts`). Joins `tracks` ⋈ `matches` for matched + `tracks` ⋈ `unmatched` for unmatched, both filtered by `sync_run_id`, then UNION ALL with `total` from a parallel count query. Apply `status` + `method` + `limit/offset` at SQL.
- [ ] 2.3 Implement the `GET /sync/runs/:run_id/tracks` route handler in `src/routes/sync.ts` (or wherever the existing `/sync/runs` lives). Validate `:run_id` is a UUID; return 404 `run_not_found` when no `sync_runs` row matches. Clamp `limit` to 200. Return `{ total, items }`.
- [ ] 2.4 Mount the route — should be picked up automatically if `/sync/runs` is already mounted on a `sync` Hono app (param routes nest under their parent). Verify by listing routes.
- [ ] 2.5 Confirm 5-stage TaskCompleted hook green; manual smoke `curl -H "Authorization: Bearer <jwt>" https://portage.eovidiu.co.uk/api/sync/runs/<a-real-run-id>/tracks` against the dev branch.
- [ ] 2.6 Open and merge PR `feat(F-027): per-run track detail (GET /sync/runs/:id/tracks + unmatched.sync_run_id)`. Confirm `wrangler deploy` succeeds.

## 3. UI repo (`portage-ui`) — Hook + mocks

- [ ] 3.1 Add `UI-PHASE-14 per-run-track-detail` entry to `.harness/features.json` with `scope: ["src/pages/RunTracksPage.tsx", "src/components/RunTracksTable.tsx", "src/hooks/useRunTracks.ts", "src/App.tsx", "src/components/RunsTable.tsx", "tests/pages/RunTracksPage.test.tsx", "tests/components/RunTracksTable.mobile.test.tsx", "tests/hooks/useRunTracks.test.tsx", "tests/mocks/operator.ts"]`, `depends_on: ["UI-PHASE-3"]`.
- [ ] 3.2 Extend `tests/mocks/operator.ts` with `runTracksHandlers` — `matchedOnly`, `mixed`, `unmatchedOnly`, `empty`, `notFound`. Each returns `{ total, items: [...] }` matching the Worker contract.
- [ ] 3.3 TDD: write failing tests in `tests/hooks/useRunTracks.test.tsx` covering matched-only / mixed / empty / 404 paths. `gcTime: Infinity` so cache persists between drill-in clicks.
- [ ] 3.4 Implement `src/hooks/useRunTracks.ts` — TanStack Query keyed on `['run-tracks', runId, { status, method, page, page_size }]`. `gcTime: Infinity` for completed runs.

## 4. UI repo (`portage-ui`) — Detail page + table component

- [ ] 4.1 TDD: write failing tests in `tests/pages/RunTracksPage.test.tsx` covering the 5 scenarios in `specs/web-ui-operator/spec.md` Requirement "Run detail page" — direct nav matched + unmatched, status filter, method filter, unknown run 404 empty-state, mobile cards via mocked `matchMedia`.
- [ ] 4.2 TDD: write failing tests in `tests/components/RunTracksTable.mobile.test.tsx` for the mobile-card fallback — each card surfaces Spotify / Status / Method / Tidal / Confidence; Tidal id renders as an external link when populated.
- [ ] 4.3 Implement `src/components/RunTracksTable.tsx` with `useMediaQuery('(min-width: 768px)')` selecting between the desktop `<table>` and the mobile `<ul>` of `<article>` cards. Mirror the visual structure of `CapturesTable.tsx`.
- [ ] 4.4 Implement `src/pages/RunTracksPage.tsx` — summary header, filter dropdowns, table, pagination. URL-synced filters via `useSearchParams` like `RunsPage.tsx`. Empty-state for the 404 path.

## 5. UI repo (`portage-ui`) — Wire into navigation

- [ ] 5.1 Add the new lazy-loaded route `/runs/:run_id/tracks` in `src/App.tsx`.
- [ ] 5.2 TDD: extend `tests/pages/RunsPage.test.tsx` with a test asserting clicking a run row navigates to `/runs/<id>/tracks` and Enter on a focused row does the same.
- [ ] 5.3 Update `src/components/RunsTable.tsx` so each row wraps its content in a `<Link to={`/runs/${run.id}/tracks`}>`. Preserve existing `tabIndex` and keyboard focus.

## 6. UI repo (`portage-ui`) — Ship

- [ ] 6.1 Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:coverage` — all clean, branches ≥ 95 %.
- [ ] 6.2 Flip `UI-PHASE-14` status to `passing` in `.harness/features.json` with coverage notes and `approaches_tried`.
- [ ] 6.3 Update `.harness/context_summary.md` Active Context.
- [ ] 6.4 Open PR `feat(ui): per-run track detail page (UI-PHASE-14)` referencing `openspec/changes/per-run-track-detail/`.
- [ ] 6.5 CI green, squash-merge. Confirm Deploy ships the new bundle. Click a run row on `https://app.portage.eovidiu.co.uk/runs` and verify the manifest renders.

## 7. Cross-cutting verification (every PR in this change)

- [ ] 7.1 `npm test` green (UI) / 5-stage TaskCompleted hook green (Worker).
- [ ] 7.2 `npm run typecheck` clean.
- [ ] 7.3 `npm run lint` zero warnings.
- [ ] 7.4 `npm run test:a11y` (vitest-axe) passes on the detail page, desktop + mobile.
- [ ] 7.5 `npm run build` succeeds with no warnings.
- [ ] 7.6 Local end-to-end on the staging deploy: `curl` the new endpoint with a Bearer JWT against the latest run id; confirm the SPA's drill-in shows the same manifest.
- [ ] 7.7 Full vitest suite green (no regressions in UI-PHASE-0..13).
- [ ] 7.8 PR description references `openspec/changes/per-run-track-detail/` and the two affected capability specs.
