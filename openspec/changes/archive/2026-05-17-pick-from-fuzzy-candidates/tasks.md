## 1. Worker repo (`portage`) — schema + orchestrator persistence

- [ ] 1.1 Add `F-027a fuzzy-candidates-replay` entry to Worker `.harness/features.json` with `scope: ["db/schema.sql", "src/db/unmatched.ts", "src/match/fuzzy.ts", "src/db/sync_runs.ts", "src/routes/unmatched.ts", "tests/match/fuzzy.test.ts", "tests/routes/sync/runs.test.ts", "tests/routes/unmatched.test.ts"]`, `depends_on: ["F-027"]`, `priority: 12`.
- [ ] 1.2 Author `docs/specs/F-027a-fuzzy-candidates-replay.md` and `docs/specs/T-027a-fuzzy-candidates-replay.md` mirroring `specs/per-run-track-detail/spec.md` from this change.
- [ ] 1.3 Live DDL via Neon MCP on prod main + dev branches: `ALTER TABLE unmatched ADD COLUMN IF NOT EXISTS candidates JSONB`. Verify on temp branch, then apply.
- [ ] 1.4 Update `db/schema.sql` to declare the new column.
- [ ] 1.5 Update `src/db/unmatched.ts`: `UnmatchedRow` gains an optional `candidates` field; `upsertUnmatched` writes it on INSERT + on ON CONFLICT UPDATE.

## 2. Worker repo (`portage`) — fuzzy match wiring

- [ ] 2.1 TDD: extend `tests/match/fuzzy.test.ts` with a scenario asserting that the `fuzzy_below_threshold` branch persists `candidates` (top 3, sorted by score descending, fields `tidal_id`/`title`/`artist`/`album`/`score`). Plus a scenario asserting `no_candidates` writes NULL for `candidates`.
- [ ] 2.2 Update `src/match/fuzzy.ts`: in the `top.score < ACCEPT_THRESHOLD` branch, project `ranked.slice(0, 3)` onto the JSONB shape and pass as `candidates` to `upsertUnmatched`. The `no_candidates` branch keeps `candidates: undefined` (omitted from the row).
- [ ] 2.3 Confirm 5-stage TaskCompleted hook green.

## 3. Worker repo (`portage`) — GET projection + POST extension

- [ ] 3.1 TDD: extend `tests/routes/sync/runs.test.ts` with two scenarios — "unmatched row with persisted candidates surfaces a candidates array on the response" and "unmatched row with NULL candidates omits the field from the response". Plus a scenario asserting matched rows never carry a candidates field.
- [ ] 3.2 Update `RunTrackUnmatchedRow` in `src/db/sync_runs.ts` to include `candidates?: Array<{tidal_id; title; artist; album; score}>`. Update the SELECT in `listRunTracks` to project the JSONB column.
- [ ] 3.3 Update the row mapper in `listRunTracks` to attach `candidates` to the unmatched row only when the column is non-null; omit the key when null.
- [ ] 3.4 TDD: extend `tests/routes/unmatched.test.ts` with the three scenarios from `specs/per-run-track-detail/spec.md` Requirement "POST /unmatched/:spotify_id/match accepts sync_run_id" — manual match without sync_run_id, manual match with sync_run_id, malformed sync_run_id is ignored.
- [ ] 3.5 Update the `POST /unmatched/:spotify_id/match` handler to read an optional `sync_run_id` from the body. Validate as UUID; pass through to `insertMatch` if valid, NULL otherwise.
- [ ] 3.6 Update the `insertMatch` helper signature (or its caller in the route) to accept `sync_run_id: string | null`.
- [ ] 3.7 Confirm 5-stage TaskCompleted hook green.
- [ ] 3.8 Open and merge PR `feat(F-027a): persist fuzzy candidates + extend manual-match endpoint`. Confirm `wrangler deploy` succeeds.

## 4. UI repo (`portage-ui`) — types + mutation hook + mocks

- [ ] 4.1 Add `UI-PHASE-15 fuzzy-candidates-picker` entry to `.harness/features.json` with `scope: ["src/components/RunTracksTable.tsx", "src/components/RunTrackCandidates.tsx", "src/hooks/useRunTracks.ts", "src/hooks/useMatchFromRun.ts", "src/pages/RunTracksPage.tsx", "tests/components/RunTrackCandidates.test.tsx", "tests/pages/RunTracksPage.test.tsx", "tests/hooks/useMatchFromRun.test.tsx", "tests/mocks/operator.ts"]`, `depends_on: ["UI-PHASE-14"]`.
- [ ] 4.2 Update `RunTrackUnmatched` in `src/hooks/useRunTracks.ts` to include optional `candidates: Array<{ tidal_id: string; title: string; artist: string; album: string | null; score: number }>`.
- [ ] 4.3 Extend `tests/mocks/operator.ts` with `runTracksHandlers.fuzzyBelowThresholdWithCandidates` (returns one unmatched row carrying 3 candidates) and `manualMatchHandlers.successWithRunId` (asserts the body's `sync_run_id` and returns the matched row).
- [ ] 4.4 TDD: write failing tests in `tests/hooks/useMatchFromRun.test.tsx` covering optimistic update + rollback + cache-invalidation behavior.
- [ ] 4.5 Implement `src/hooks/useMatchFromRun.ts` — TanStack Query mutation that POSTs `/unmatched/:spotify_id/match` with `{ tidal_id, sync_run_id }`, optimistically updates the `['run-tracks', runId, filters]` cache, rolls back on error, invalidates on settle. Sonner toast on failure.

## 5. UI repo (`portage-ui`) — RunTrackCandidates component

- [ ] 5.1 TDD: write failing tests in `tests/components/RunTrackCandidates.test.tsx` covering — disclosure visible only for `fuzzy_below_threshold` rows with candidates, each candidate shows title/artist/album/score, rank-1 carries a badge, "Use this" fires the manual-match mutation with the correct payload, disclosure auto-collapses on success, mobile full-width touch targets.
- [ ] 5.2 Implement `src/components/RunTrackCandidates.tsx` using semantic `<details>`/`<summary>` for the disclosure. Each candidate renders inside a list item with a "Use this" `<Button>` wired to `useMatchFromRun`. Mobile-stack via responsive classes; desktop horizontal layout.

## 6. UI repo (`portage-ui`) — wire into RunTracksTable + page

- [ ] 6.1 TDD: extend `tests/pages/RunTracksPage.test.tsx` with — "unmatched row with fuzzy_below_threshold + candidates renders a disclosure", "no disclosure for no_candidates reason", "clicking Use this PATCHes and refetches", "mobile branch surfaces the same disclosure in the stacked card", axe a11y pass with disclosure expanded.
- [ ] 6.2 Update `src/components/RunTracksTable.tsx`: in the desktop table's reason cell, render `<RunTrackCandidates>` when the row is unmatched with candidates; otherwise the bare reason text. Mirror the same wiring in the mobile-card branch's reason field.
- [ ] 6.3 No change to `RunTracksPage.tsx` — the candidates affordance lives inside the table component.
- [ ] 6.4 Run `npm run typecheck`, `npm run lint`, `npm run build`, `npm run test:coverage` — all clean, branches ≥ 95 %.

## 7. UI repo (`portage-ui`) — ship

- [ ] 7.1 Flip `UI-PHASE-15` status to `passing` in `.harness/features.json` with coverage notes and `approaches_tried`.
- [ ] 7.2 Update `.harness/context_summary.md` Active Context.
- [ ] 7.3 Open PR `feat(ui): pick from fuzzy candidates inline on run-detail page (UI-PHASE-15)` referencing this OpenSpec change.
- [ ] 7.4 CI green, squash-merge. Confirm Deploy ships the new bundle. Open the production run-detail page that prompted this change and verify candidates expand + "Use this" works end-to-end.

## 8. Cross-cutting verification (run before each PR in this change)

- [ ] 8.1 `npm test` (UI) / 5-stage TaskCompleted hook (Worker) green.
- [ ] 8.2 `npm run typecheck` clean.
- [ ] 8.3 `npm run lint` zero warnings.
- [ ] 8.4 `npm run test:a11y` (vitest-axe) passes on `/runs/:id/tracks` with disclosure expanded, desktop + mobile.
- [ ] 8.5 `npm run build` succeeds with no warnings.
- [ ] 8.6 Post-deploy: navigate to a real run with `fuzzy_below_threshold` rows; verify the disclosure renders 3 candidates with scores; pick one; confirm the row transitions to matched method=manual; refresh and confirm persistence.
- [ ] 8.7 Full vitest suite green (no regressions in UI-PHASE-0..14).
- [ ] 8.8 PR description references `openspec/changes/pick-from-fuzzy-candidates/` and the two affected capability specs.
